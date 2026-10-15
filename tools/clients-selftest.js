/**
 * lib/clients.js 的行为验证 —— 第四版新增的「谁在用后台服务」登记表。
 *
 * 这张表直接决定「退出时要不要停服务器」，判错两个方向代价不同：
 *   · 把活着的壳漏掉 → 服务器被提前回收，别人正在看的窗口当场失效；
 *   · 把死掉的壳多算一个 → 只是晚一点回收，下次启动会兜底清理。
 * 所以重点验证：死 pid 一定被过滤、可疑的 pid 一律按「活着」处理、自己的登记要能排除。
 *
 * 跑法：node tools/clients-selftest.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { registerClient, unregisterClient, listLiveClients, countOtherClients } = require('../lib/clients');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clients-selftest-'));
let pass = 0;
let fail = 0;

/** 本次测试拉起来的假进程，结束时统一收掉。 */
const CHILDREN = [];

/**
 * 跑一个断言，成功打勾、失败打叉并记录。
 *
 * @param {string} name - 断言名称。
 * @param {() => void} body - 断言体。
 */
function check(name, body) {
  try {
    body();
    pass += 1;
    console.log(`  \u2714 ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  \u2718 ${name}\n      ${error.message}`);
  }
}

/**
 * 造一个活着的假进程。
 *
 * @param {string[]} args - 追加的命令行参数，用来伪造不同的进程身份。
 * @returns {number} 进程 pid。
 */
function livePid(args = []) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ...args], { stdio: 'ignore' });
  CHILDREN.push(child);
  return child.pid;
}

/** 造一个「像 Electron 主进程」的活 pid（命令行含 electron、且不含 --type=）。 */
function liveShellPid() {
  return livePid(['electron']);
}

/** 造一个「像 Electron 子进程」的活 pid（命令行含 --type=）。 */
function liveRendererPid() {
  return livePid(['electron', '--type=renderer']);
}

/** 名单文件路径。 */
function clientFile(pid) {
  return path.join(DIR, `${pid}.json`);
}

/**
 * 代表「本壳自己」的 pid。
 *
 * 注意不能用 process.pid：跑测试的是个普通 node 进程，命令行里没有 electron，
 * 会被身份校验正确判定为「不是桌面壳」（这正是「pid 被复用」那条断言的场景）。
 * 排除自己的逻辑只按 pid 比较，所以拿一个假壳 pid 当自己即可。
 */
const SELF = liveShellPid();

console.log('== clients.js 自检 ==');

check('登记后能查到（且排除自己后为空）', () => {
  assert.strictEqual(registerClient(DIR, SELF), true, '登记应当成功');
  assert.ok(fs.existsSync(clientFile(SELF)), '应当写出 <pid>.json');
  assert.deepStrictEqual(listLiveClients(DIR), [SELF], '不排除时应当列到自己');
  assert.deepStrictEqual(listLiveClients(DIR, { excludePid: SELF }), [], '排除自己后应当为空');
  assert.strictEqual(countOtherClients(DIR, { excludePid: SELF }), 0);
});

check('登记文件权限是 0600', () => {
  const mode = fs.statSync(clientFile(SELF)).mode & 0o777;
  assert.strictEqual(mode.toString(8), '600', `实际权限 ${mode.toString(8)}`);
});

check('注销后名单为空，且重复注销不抛错', () => {
  assert.strictEqual(unregisterClient(DIR, SELF), true);
  assert.ok(!fs.existsSync(clientFile(SELF)));
  assert.strictEqual(unregisterClient(DIR, SELF), false, '第二次应当返回 false 而不是抛错');
  assert.deepStrictEqual(listLiveClients(DIR), []);
});

check('两个窗口：互相都算「别人」，各自排除自己后剩 1 个', () => {
  const a = liveShellPid();
  const b = liveShellPid();
  registerClient(DIR, a);
  registerClient(DIR, b);
  assert.strictEqual(countOtherClients(DIR, { excludePid: a }), 1, `a 应当看到 b：${listLiveClients(DIR, { excludePid: a })}`);
  assert.strictEqual(countOtherClients(DIR, { excludePid: b }), 1, `b 应当看到 a：${listLiveClients(DIR, { excludePid: b })}`);
  unregisterClient(DIR, a);
  unregisterClient(DIR, b);
});

check('★ 死 pid 的登记文件被过滤，并在扫描时顺手清掉', () => {
  const fake = path.join(DIR, '999999.json');
  fs.writeFileSync(fake, JSON.stringify({ version: 1, pid: 999999, startedAt: new Date().toISOString() }));
  assert.deepStrictEqual(listLiveClients(DIR), [], '死 pid 不该被算成活着的壳');
  assert.ok(!fs.existsSync(fake), '扫描时应当把这份垃圾文件删掉');
});

check('★ pid 被复用（登记文件还在，但那个 pid 已经不是桌面壳）→ 不算活着', () => {
  const reused = livePid(); // 活着，但命令行里没有 electron
  registerClient(DIR, reused);
  assert.deepStrictEqual(listLiveClients(DIR), [], '不能因为 pid 活着就认为那个壳还在');
  assert.ok(!fs.existsSync(clientFile(reused)), '这种登记文件也应当被清掉');
});

check('Electron 子进程（命令行带 --type=）不算一个窗口', () => {
  const renderer = liveRendererPid();
  registerClient(DIR, renderer);
  assert.deepStrictEqual(listLiveClients(DIR), [], '渲染进程不是独立窗口，算进去会让服务器永远回收不掉');
  unregisterClient(DIR, renderer);
});

check('目录不存在时返回空名单（首次启动、从未多开过）', () => {
  const missing = path.join(DIR, 'not-created-yet');
  assert.deepStrictEqual(listLiveClients(missing), []);
  assert.strictEqual(countOtherClients(missing, { excludePid: SELF }), 0);
  assert.strictEqual(unregisterClient(missing, SELF), false, '目录都没有时注销不该抛错');
});

check('目录不存在时登记会自动建目录', () => {
  const nested = path.join(DIR, 'x', 'y');
  const pid = liveShellPid();
  assert.strictEqual(registerClient(nested, pid), true);
  assert.deepStrictEqual(listLiveClients(nested), [pid]);
});

check('写入过程中的临时文件不会污染名单，死 pid 的残留会被清掉', () => {
  const deadTemp = path.join(DIR, '424242.json.tmp');
  fs.writeFileSync(deadTemp, '{ 写了一半');
  assert.deepStrictEqual(listLiveClients(DIR), [], '临时文件不该被当成一个壳');
  assert.ok(!fs.existsSync(deadTemp), '死 pid 留下的临时文件应当被清掉');
});

check('活 pid 正在写的临时文件不会被误删', () => {
  const alive = liveShellPid();
  const aliveTemp = path.join(DIR, `${alive}.json.tmp`);
  fs.writeFileSync(aliveTemp, '{ 正在写');
  listLiveClients(DIR);
  assert.ok(fs.existsSync(aliveTemp), '别人正在写的文件不能碰');
  fs.unlinkSync(aliveTemp);
});

for (const child of CHILDREN) child.kill('SIGKILL');
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
