/**
 * lib/endpoint.js 的行为验证。
 *
 * 重点覆盖第四版改掉的那条判据：
 *   「公告还能不能用」看的是**公告里那台服务器进程还活着吗**，
 *   而不是「起服务器的那个壳还活着吗」。前者是本次修复的核心 ——
 *   主窗口退出后服务器会被保留，公告必须继续有效，后来者才能复用同一地址。
 *
 * 跑法：node tools/endpoint-selftest.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { publishEndpoint, readReusableEndpoint, removeEndpoint } = require('../lib/endpoint');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-selftest-'));
const FILE = path.join(DIR, 'endpoint.json');
let pass = 0;
let fail = 0;

/** 本测试拉起来的假进程，结束时统一收掉。 */
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

/** 造一个「已经死掉」的 pid：跑一个立刻退出的进程，拿它的 pid。 */
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return result.pid;
}

/**
 * 造一个活着的假进程。
 *
 * @param {string[]} extraArgs - 追加到命令行末尾的参数（用来伪造 dsh web 的身份）。
 * @returns {number} 进程 pid。
 */
function livePid(extraArgs = []) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ...extraArgs], { stdio: 'ignore' });
  CHILDREN.push(child);
  return child.pid;
}

/** 造一个「像本程序托管的 dsh web」的活进程（命令行里带 dsh / web / --no-open）。 */
function liveDshWebPid() {
  return livePid(['dsh', 'web', '--no-open']);
}

console.log('== endpoint.js 自检 ==');

check('写入后能读回同一个地址（含服务器 pid）', () => {
  const serverPid = liveDshWebPid();
  publishEndpoint(FILE, {
    url: 'http://127.0.0.1:41234/?token=abc',
    port: 41234,
    serverPid,
    shellPid: process.pid
  });
  const read = readReusableEndpoint(FILE);
  assert.ok(read, '应当读到可用端点');
  assert.strictEqual(read.url, 'http://127.0.0.1:41234/?token=abc');
  assert.strictEqual(read.port, 41234);
  assert.strictEqual(read.serverPid, serverPid);
  assert.strictEqual(read.shellPid, process.pid);
});

check('文件权限是 0600（里面带 token，不能让同机其他用户读到）', () => {
  const mode = fs.statSync(FILE).mode & 0o777;
  assert.strictEqual(mode.toString(8), '600', `实际权限 ${mode.toString(8)}`);
});

check('写入不留下临时文件', () => {
  const leftovers = fs.readdirSync(DIR).filter((name) => name.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], `残留：${leftovers.join(',')}`);
});

check('★ 服务器还活着、但起它的壳已退出 → 公告仍然可用（第四版核心语义）', () => {
  const serverPid = liveDshWebPid();
  publishEndpoint(FILE, {
    url: 'http://127.0.0.1:1/?token=x',
    port: 1,
    serverPid,
    shellPid: deadPid() // 起服务器的壳已经退出
  });
  const read = readReusableEndpoint(FILE);
  assert.ok(read, '主壳退出后公告必须继续有效，否则副窗口与新窗口都会以为没有可用服务器');
  assert.strictEqual(read.serverPid, serverPid);
});

check('服务器进程已经退出 → 视为不可用（避免连死地址）', () => {
  publishEndpoint(FILE, {
    url: 'http://127.0.0.1:1/?token=x',
    port: 1,
    serverPid: deadPid(),
    shellPid: process.pid
  });
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('serverPid 指向一个活着的、但不是 dsh web 的进程 → 视为不可用（防 pid 复用）', () => {
  publishEndpoint(FILE, {
    url: 'http://127.0.0.1:1/?token=x',
    port: 1,
    serverPid: livePid(), // 活着，但命令行不是本程序托管的 dsh web
    shellPid: process.pid
  });
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('旧版公告（没有 serverPid）且起它的壳还活着 → 仍可用（升级期新旧版本并存）', () => {
  fs.writeFileSync(
    FILE,
    JSON.stringify({ version: 1, url: 'http://127.0.0.1:1/?token=x', port: 1, shellPid: process.pid })
  );
  assert.ok(readReusableEndpoint(FILE), '旧版公告不该被判成失效，否则新壳会另起一个服务');
});

check('旧版公告（没有 serverPid）且起它的壳已退出 → 不可用', () => {
  fs.writeFileSync(
    FILE,
    JSON.stringify({ version: 1, url: 'http://127.0.0.1:1/?token=x', port: 1, shellPid: deadPid() })
  );
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('removeEndpoint 无条件删除（最后一个使用者退出时用）', () => {
  publishEndpoint(FILE, { url: 'http://127.0.0.1:1/?token=x', port: 1, serverPid: liveDshWebPid(), shellPid: deadPid() });
  assert.strictEqual(removeEndpoint(FILE), true, '应当删除');
  assert.ok(!fs.existsSync(FILE), '文件应当已删除');
  assert.strictEqual(removeEndpoint(FILE), false, '文件本来就不在时返回 false（不抛错）');
});

check('文件不存在时读取返回 null（而不是抛错）', () => {
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('JSON 损坏 → 视为不可用', () => {
  fs.writeFileSync(FILE, '{ 这不是 JSON');
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('版本号不匹配 → 视为不可用（字段语义可能已变）', () => {
  fs.writeFileSync(
    FILE,
    JSON.stringify({ version: 999, url: 'http://127.0.0.1:1/', serverPid: liveDshWebPid(), shellPid: process.pid })
  );
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('地址不是 http(s) → 视为不可用', () => {
  fs.writeFileSync(
    FILE,
    JSON.stringify({ version: 1, url: 'file:///etc/passwd', serverPid: liveDshWebPid(), shellPid: process.pid })
  );
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('地址字段缺失 → 视为不可用', () => {
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, serverPid: liveDshWebPid(), shellPid: process.pid }));
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('目录不存在时写入会自动建目录', () => {
  const nested = path.join(DIR, 'a', 'b', 'endpoint.json');
  const written = publishEndpoint(nested, {
    url: 'http://127.0.0.1:9/?token=y',
    port: 9,
    serverPid: liveDshWebPid(),
    shellPid: process.pid
  });
  assert.strictEqual(written, true);
  assert.ok(fs.existsSync(nested));
});

for (const child of CHILDREN) child.kill('SIGKILL');
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
