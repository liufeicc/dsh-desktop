/**
 * lib/endpoint.js 的行为验证。
 *
 * 覆盖六件事：写入与读回、文件权限、属主核对删除、失效判断（进程死 / 版本不符 / 地址非法 / JSON 损坏）。
 * 跑法：node tools/endpoint-selftest.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { publishEndpoint, readReusableEndpoint, clearEndpoint } = require('../lib/endpoint');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-selftest-'));
const FILE = path.join(DIR, 'endpoint.json');
let pass = 0;
let fail = 0;

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

console.log('== endpoint.js 自检 ==');

check('写入后能读回同一个地址', () => {
  publishEndpoint(FILE, { url: 'http://127.0.0.1:41234/?token=abc', port: 41234, shellPid: process.pid });
  const read = readReusableEndpoint(FILE);
  assert.ok(read, '应当读到可用端点');
  assert.strictEqual(read.url, 'http://127.0.0.1:41234/?token=abc');
  assert.strictEqual(read.port, 41234);
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

check('公告属主不是自己时，clearEndpoint 不删（副壳不许删主壳的公告）', () => {
  const removed = clearEndpoint(FILE, process.pid + 1);
  assert.strictEqual(removed, false, '不该删除');
  assert.ok(fs.existsSync(FILE), '文件应当还在');
});

check('属主是自己时，clearEndpoint 正常删除', () => {
  const removed = clearEndpoint(FILE, process.pid);
  assert.strictEqual(removed, true, '应当删除');
  assert.ok(!fs.existsSync(FILE), '文件应当已删除');
});

check('文件不存在时读取返回 null（而不是抛错）', () => {
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('写公告的壳已经退出 → 视为不可用（避免连死地址）', () => {
  publishEndpoint(FILE, { url: 'http://127.0.0.1:1/?token=x', port: 1, shellPid: deadPid() });
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('JSON 损坏 → 视为不可用', () => {
  fs.writeFileSync(FILE, '{ 这不是 JSON');
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('版本号不匹配 → 视为不可用（字段语义可能已变）', () => {
  fs.writeFileSync(FILE, JSON.stringify({ version: 999, url: 'http://127.0.0.1:1/', shellPid: process.pid }));
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('地址不是 http(s) → 视为不可用', () => {
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, url: 'file:///etc/passwd', shellPid: process.pid }));
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('地址字段缺失 → 视为不可用', () => {
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, shellPid: process.pid }));
  assert.strictEqual(readReusableEndpoint(FILE), null);
});

check('目录不存在时写入会自动建目录', () => {
  const nested = path.join(DIR, 'a', 'b', 'endpoint.json');
  const written = publishEndpoint(nested, { url: 'http://127.0.0.1:9/?token=y', port: 9, shellPid: process.pid });
  assert.strictEqual(written, true);
  assert.ok(fs.existsSync(nested));
});

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
