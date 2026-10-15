/**
 * lib/quit-flow.js 的行为验证 —— 第四版「最后一个窗口退出才停后台服务」的核心判定。
 *
 * 为什么值得单独测（而不是只靠端到端）：
 *   这套判定里有几处「错了也不报错、只是行为悄悄不对」的地方：判定时忘了先注销自己、
 *   该保留时动了别人的服务器、回收时读到了别人刚写的 pid 记录。
 *   它们用单元测试覆盖成本极低，用端到端复现则很麻烦（要凑时间窗）。
 *
 * 覆盖：
 *   1. 启动登记 / 退出注销；
 *   2. 还有别的窗口在用 → 服务器、公告、pid 记录一律不动；
 *   3. 一个都不剩 + 服务器是自己起的 → 调停自己的服务器 + 撤公告；
 *   4. 一个都不剩 + 服务器是别人起的（复用者）→ 按 pid 记录把别人的服务器停掉；
 *   5. ★ 停止期间 pid 记录被别人改写（新壳起了自己的服务）→ 只停快照里那一台，不碰新的；
 *   6. 同步兜底 runSyncFallback：还有别人在用就什么都不动；没有别人时按各自情形补刀。
 *
 * 跑法：node tools/quit-flow-selftest.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { QuitFlow } = require('../lib/quit-flow');
const { registerClient } = require('../lib/clients');
const { publishEndpoint } = require('../lib/endpoint');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quit-flow-selftest-'));
const CLIENTS_DIR = path.join(DIR, 'clients');
const ENDPOINT_FILE = path.join(DIR, 'endpoint.json');
const PID_FILE = path.join(DIR, 'server.pid');
let pass = 0;
let fail = 0;

/** 本测试拉起来的假进程，结束时统一收掉。 */
const CHILDREN = [];

/**
 * 跑一个断言，成功打勾、失败打叉并记录。
 *
 * @param {string} name - 断言名称。
 * @param {() => (void|Promise<void>)} body - 断言体。
 * @returns {Promise<void>} 断言结束。
 */
async function check(name, body) {
  try {
    await body();
    pass += 1;
    console.log(`  \u2714 ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  \u2718 ${name}\n      ${error.message}`);
  }
}

/**
 * 等一个 pid 消失。
 *
 * @param {number} pid - 进程号。
 * @param {number} [timeoutMs] - 最长等待时间。
 * @returns {Promise<boolean>} 已消失为 true。
 */
async function waitGone(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * 造一个「像本程序托管的 dsh web」的假服务器进程（命令行里带 dsh / web / --no-open）。
 *
 * 返回前会等它把 SIGTERM 处理器装好 —— 这一步不能省：
 *   Node 启动要几十毫秒，在那之前发 SIGTERM 会被系统的默认动作直接杀掉，
 *   handler 根本不会执行。测试里「收到 SIGTERM 时改写 pid 记录」这条断言
 *   一开始就是这么误报的（文件没被改写，看起来像实现漏了竞态防护）。
 *
 * @param {{onTerm?: string}} [options] - onTerm 是一段「收到 SIGTERM 时执行」的代码，用来模拟停止期间的并发改写。
 * @returns {Promise<import('node:child_process').ChildProcess>} 已就绪的子进程。
 */
async function spawnFakeDsh({ onTerm = '' } = {}) {
  const ready = path.join(DIR, `ready-${process.pid}-${CHILDREN.length}.flag`);
  const script = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {
      ${onTerm}
      process.exit(0);
    });
    // 告诉测试：handler 已装好，可以安全地发 SIGTERM 了
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script, 'dsh', 'web', '--no-open'], { stdio: 'ignore' });
  CHILDREN.push(child);
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!fs.existsSync(ready)) throw new Error('假 dsh 未能在 5 秒内就绪');
  return child;
}

/** 造一份 pid 记录文件。 */
function writePidFile(pid, shellPid = 999999) {
  fs.writeFileSync(
    PID_FILE,
    `${JSON.stringify({ version: 1, pid, shellPid, command: 'dsh web --no-open', startedAt: new Date().toISOString() }, null, 2)}\n`
  );
}

/** 造一份可用的地址公告。 */
function writeEndpoint(serverPid) {
  publishEndpoint(ENDPOINT_FILE, {
    url: 'http://127.0.0.1:1/?token=x',
    port: 1,
    serverPid,
    shellPid: process.pid
  });
}

/**
 * 造一个 QuitFlow，并把「停自己服务器」的动作记在一个数组里（代替真实的 DshServer）。
 *
 * @param {{hasOwned?: boolean, lastServerPid?: number|null, replica?: boolean}} [options] - 本壳形态。
 * @returns {{flow: QuitFlow, stopped: string[]}} 判定器与调用记录。
 */
function makeFlow({ hasOwned = false, lastServerPid = null, replica = false } = {}) {
  const stopped = [];
  const flow = new QuitFlow({
    clientsDir: CLIENTS_DIR,
    endpointFile: ENDPOINT_FILE,
    serverPidFile: PID_FILE,
    log: () => {},
    hasOwnedServer: () => hasOwned,
    stopOwnedServer: async () => {
      stopped.push('owned');
    },
    getLastServerPid: () => lastServerPid,
    isReplica: () => replica
  });
  return { flow, stopped };
}

/** 造一个「另一个活着的桌面壳」的登记（命令行带 electron 才能通过身份核对）。 */
function anotherShellPid() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'electron'], { stdio: 'ignore' });
  CHILDREN.push(child);
  registerClient(CLIENTS_DIR, child.pid);
  return child.pid;
}

/**
 * 跑完全部断言。
 *
 * 之所以包一层 async main 而不是用顶层 await：本文件是 CommonJS（require + module.exports 那种写法），
 * Node 不允许同一个文件里既有 require 又有顶层 await，会直接报 ERR_AMBIGUOUS_MODULE_SYNTAX。
 *
 * @returns {Promise<void>} 全部断言结束。
 */
async function main() {
  console.log('== quit-flow.js 自检 ==');


  await check('登记后本壳在册，注销后消失', async () => {
    const { flow } = makeFlow();
    assert.strictEqual(flow.registerSelf(), true, '登记应当成功');
    assert.ok(fs.existsSync(path.join(CLIENTS_DIR, `${process.pid}.json`)), '应当写出登记文件');
    flow.unregisterSelf();
    assert.ok(!fs.existsSync(path.join(CLIENTS_DIR, `${process.pid}.json`)), '注销应当删掉登记文件');
    assert.strictEqual(flow.unregisterSelf(), false, '重复注销返回 false 而不是抛错');
  });

  await check('还有别的窗口在用 → 判定为「非最后一个」，且服务器、公告、pid 记录全都不动', async () => {
    const server = await spawnFakeDsh();
    writePidFile(server.pid);
    writeEndpoint(server.pid);
    const other = anotherShellPid();

    const { flow, stopped } = makeFlow();
    flow.registerSelf();
    const result = await flow.run();

    assert.strictEqual(result.isLastClient, false, '还有别人在用，不该判定为最后一个');
    assert.strictEqual(result.others, 1, `应当看到 1 个别的窗口，实际 ${result.others}`);
    assert.deepStrictEqual(stopped, [], '不该停自己的服务器');
    assert.ok(fs.existsSync(ENDPOINT_FILE), '公告必须保留（后来者还要复用）');
    assert.ok(fs.existsSync(PID_FILE), 'pid 记录必须保留（最后一个窗口还要用它回收）');
    assert.ok(server.pid > 0 && fs.existsSync(`/proc/${server.pid}`), '服务器必须还活着');

    fs.unlinkSync(path.join(CLIENTS_DIR, `${other}.json`));
    server.kill('SIGKILL');
    fs.rmSync(ENDPOINT_FILE, { force: true });
    fs.rmSync(PID_FILE, { force: true });
  });

  await check('最后一个使用者 + 服务器是自己起的 → 停自己的服务器并撤下公告', async () => {
    const { flow, stopped } = makeFlow({ hasOwned: true, lastServerPid: 12345 });
    flow.registerSelf();
    writeEndpoint(12345);
    const result = await flow.run();

    assert.strictEqual(result.isLastClient, true, '没有别人在用，应当判定为最后一个');
    assert.deepStrictEqual(stopped, ['owned'], '应当调用「停自己服务器」');
    assert.ok(!fs.existsSync(ENDPOINT_FILE), '公告应当被撤下');
  });

  await check('★ 最后一个使用者 + 服务器是别人起的 → 按 pid 记录把它停掉', async () => {
    const server = await spawnFakeDsh();
    writePidFile(server.pid);
    writeEndpoint(server.pid);

    const { flow, stopped } = makeFlow({ replica: true });
    flow.registerSelf();
    const result = await flow.run();

    assert.strictEqual(result.isLastClient, true, '应当判定为最后一个');
    assert.deepStrictEqual(stopped, [], '不是自己起的服务器，不该走「停自己服务器」那条路');
    assert.ok(await waitGone(server.pid), '记录里的服务器应当被停掉');
    assert.ok(!fs.existsSync(PID_FILE), 'pid 记录应当被清理');
    assert.ok(!fs.existsSync(ENDPOINT_FILE), '公告应当被撤下');
  });

  await check('★ 停止期间 pid 记录被新壳改写 → 只停快照里那一台，不碰新起的（竞态防护）', async () => {
    // 模拟：我们正在停旧服务器（它收到 SIGTERM 后要花点时间收尾），
    // 与此同时另一个窗口起了自己的服务器并改写了 pid 记录。
    const nextServer = await spawnFakeDsh();
    const oldServer = await spawnFakeDsh({
      onTerm: `fs.writeFileSync(${JSON.stringify(PID_FILE)}, JSON.stringify({
        version: 1, pid: ${nextServer.pid}, shellPid: 424242, command: 'dsh web --no-open'
      }));`
    });
    writePidFile(oldServer.pid);
    writeEndpoint(oldServer.pid);

    const { flow } = makeFlow({ replica: true });
    flow.registerSelf();
    await flow.run();

    assert.ok(await waitGone(oldServer.pid), '快照里那台旧服务器应当被停掉');
    assert.ok(fs.existsSync(`/proc/${nextServer.pid}`), '新壳刚起的服务器绝不能被误杀');
    assert.ok(fs.existsSync(PID_FILE), '新壳写下的 pid 记录也不能被误删');
    const record = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    assert.strictEqual(record.pid, nextServer.pid, 'pid 记录应当仍指向新服务器');

    nextServer.kill('SIGKILL');
    fs.rmSync(PID_FILE, { force: true });
    fs.rmSync(ENDPOINT_FILE, { force: true });
  });

  await check('同步兜底：还有别的窗口在用 → 什么都不动', async () => {
    const server = await spawnFakeDsh();
    writePidFile(server.pid);
    writeEndpoint(server.pid);
    const other = anotherShellPid();

    const { flow } = makeFlow({ replica: true, lastServerPid: null });
    flow.registerSelf();
    flow.runSyncFallback();

    assert.ok(fs.existsSync(ENDPOINT_FILE), '公告不该被撤');
    assert.ok(fs.existsSync(`/proc/${server.pid}`), '服务器不该被杀');

    fs.unlinkSync(path.join(CLIENTS_DIR, `${other}.json`));
    server.kill('SIGKILL');
    fs.rmSync(ENDPOINT_FILE, { force: true });
    fs.rmSync(PID_FILE, { force: true });
  });

  await check('同步兜底：自己起的服务器没停干净 → SIGKILL 进程组', async () => {
    const server = await spawnFakeDsh();
    const { flow } = makeFlow({ hasOwned: true, lastServerPid: server.pid });
    flow.registerSelf();
    flow.runSyncFallback();
    assert.ok(await waitGone(server.pid), '兜底应当把服务器强杀掉');
  });

  await check('同步兜底：复用者模式且没跑过判定 → 现读 pid 记录补刀', async () => {
    const server = await spawnFakeDsh();
    writePidFile(server.pid);
    const { flow } = makeFlow({ replica: true });
    flow.registerSelf();
    flow.runSyncFallback();
    assert.ok(await waitGone(server.pid), '判定没跑过时应当现读记录并把它杀掉');
    fs.rmSync(PID_FILE, { force: true });
  });

  for (const child of CHILDREN) child.kill('SIGKILL');
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

// 收尾必须写在 main() 里面：断言都是异步的，若在 main() 之后另起一段收尾，
// 它会抢在断言跑完之前执行，报告永远显示「0 通过 0 失败」。
void main();
