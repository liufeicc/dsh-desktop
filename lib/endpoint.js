'use strict';

/**
 * Endpoint —— 「运行中的 DSH 服务器在哪里」的跨进程公告板。
 *
 * 为什么需要它：
 *   DSH 桌面版原本被 `requestSingleInstanceLock()` 限制成只能开一个窗口，第二次点图标
 *   只会把已有窗口叫到前台。但用户有两块屏，需要两个窗口。
 *
 *   最省资源的做法不是「再起一个后端」，而是让第二个窗口直接加载第一个窗口已经在用的
 *   那个地址 —— 也就是「两个浏览器窗口看同一个页面」。这需要第二个进程知道第一个进程
 *   的地址（含 token），于是有了这个文件。
 *
 * 文件里有什么（`~/.dsh-desktop/endpoint.json`）：
 *   {
 *     "version": 1,
 *     "url": "http://127.0.0.1:39201/?token=xxx",  ← 携带 token，第二个窗口直接用它加载
 *     "port": 39201,
 *     "serverPid": 10187,     ← 被公告的服务器进程 pid，判断「这个地址还活着吗」的唯一依据
 *     "shellPid": 10186,      ← 起这个服务器的壳进程 pid（只用于记录与排查，不再是有效性依据）
 *     "createdAt": "2026-10-14T00:05:12.622Z"
 *   }
 *
 * 安全考虑：url 里带访问 token，任何拿到它的本机用户都能操作 DSH。
 * 所以文件权限固定为 0600（仅属主可读写），目录由 main.js 保证是 0700 级别。
 *
 * 有效性判断（宁可重新起一个，也不要连到一个死地址）：
 *   ① 文件不存在 / JSON 坏了          → 不可用；
 *   ② url 字段缺失或不是 http(s) 地址 → 不可用；
 *   ③ serverPid 那个进程已经不在       → 不可用；
 *   ④ serverPid 还活着、但命令行不是本程序托管的 `dsh web` → 不可用（pid 被系统复用了）。
 *
 * 为什么判据是「服务器还活着」而不是「写公告的壳还活着」（第四版改，别再改回去）：
 *   服务器是被多个窗口共用的，它的寿命由「还有没有窗口在用」决定，与某一个壳的生死无关。
 *   早先版本把「写公告的壳还活着」当作「服务器可用」的替身，结果主壳一关，公告立刻失效，
 *   后面新开的窗口会以为没有可用服务器而另起一个（而副窗口还在用原来那个）。
 *
 * 注意这里**不做** HTTP 探活：探活会把启动拖慢（要等超时），而 pid + 命令行检查
 * 已经覆盖了绝大多数情况；真连不上时 Electron 会显示加载失败，用户重开一次即可。
 *
 * 「还有没有别的壳在用」这件事不在本文件里判断 —— 那是 lib/clients.js 的职责，
 * 由 main.js 把两个答案合起来决定「要不要复用」与「退出时要不要停服务器」。
 */

const fs = require('node:fs');
const path = require('node:path');

const { isProcessAlive, isManagedDshWebAlive } = require('./procinfo');

/** 公告文件的格式版本。字段不兼容时递增，读到别的版本一律当不可用。 */
const ENDPOINT_VERSION = 1;

/**
 * 判断一个地址是否是本程序能加载的 http(s) 地址。
 *
 * @param {unknown} url - 待检查的地址。
 * @returns {boolean} true 表示格式可用。
 */
function isHttpUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 把「当前服务器地址」公告出去，供后启动的壳复用。
 *
 * 写入方式：先写同目录下的临时文件，再 `rename` 成目标名。
 * rename 在同一文件系统上是原子的，这样第二个进程永远不会读到写了一半的 JSON。
 *
 * @param {string} file - 公告文件路径。
 * @param {{url: string, port?: number|null, serverPid?: number|null, shellPid: number}} info - 公告内容。
 *   serverPid 是被公告的服务器进程 pid（有效性判据）；shellPid 只是记录「谁起的」。
 * @returns {boolean} true 表示写入成功（失败只写日志、不抛错，不影响主流程）。
 */
function publishEndpoint(file, info) {
  const payload = {
    version: ENDPOINT_VERSION,
    url: info.url,
    port: Number.isInteger(info.port) ? info.port : null,
    serverPid: Number.isInteger(info.serverPid) ? info.serverPid : null,
    shellPid: info.shellPid,
    createdAt: new Date().toISOString()
  };
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // mode 只在文件新建时生效；若临时文件残留（上次崩溃），先删掉以保证权限被应用
    try {
      fs.unlinkSync(temporary);
    } catch {
      // 本来就不存在
    }
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // 清理失败无所谓
    }
    return false;
  }
}

/**
 * 读取公告并判断它是否还指向一个可用的、正在运行的服务器。
 *
 * @param {string} file - 公告文件路径。
 * @returns {{url: string, port: number|null, serverPid: number|null, shellPid: number, createdAt: string}|null}
 *   可用时返回公告内容；否则返回 null（调用方据此决定「自己起一个服务器」）。
 */
function readReusableEndpoint(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 不存在、读不了、JSON 坏了 —— 都按「没有可用实例」处理
  }

  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== ENDPOINT_VERSION) return null;
  if (!isHttpUrl(raw.url)) return null;

  const serverPid = Number(raw.serverPid);
  if (Number.isInteger(serverPid) && serverPid > 1) {
    // 判据：被公告的那台服务器还活着，且身份对得上（防 pid 复用后连到别的进程的端口）
    if (!isManagedDshWebAlive(serverPid)) return null;
  } else if (!isProcessAlive(Number(raw.shellPid))) {
    // 兼容旧版公告（第四版之前不写 serverPid）：那时只能靠「起服务器的壳还在不在」判断。
    // 这条分支只为「升级期间新旧版本并存」保留 —— 否则新壳会误判成没有可用服务器，
    // 转而去起一个新的，还会把旧壳正在用的那台当残留清掉。
    return null;
  }

  return {
    url: raw.url,
    port: Number.isInteger(raw.port) ? raw.port : null,
    serverPid: Number.isInteger(serverPid) && serverPid > 1 ? serverPid : null,
    shellPid: Number(raw.shellPid),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : ''
  };
}

/**
 * 撤下公告（最后一个使用者退出时调用）。
 *
 * 与早先版本的区别（别再改回去）：这里不再做「属主核对」。
 * 因为「该不该撤公告」已经由登记表回答了 —— 走到这里说明没有任何窗口在用了，
 * 公告指向的服务器马上也要被停掉；此时公告该无条件消失，谁最后走谁来撤。
 * （旧逻辑要求 shellPid 是自己，于是「主壳先退、副壳最后退」时公告会残留下来，
 *   指向一台已经被停掉的服务器。虽然读取端能识别出它失效，但留着终究是垃圾。）
 *
 * @param {string} file - 公告文件路径。
 * @returns {boolean} true 表示确实删除了（文件本来就不在时返回 false）。
 */
function removeEndpoint(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ENDPOINT_VERSION,
  isHttpUrl,
  publishEndpoint,
  readReusableEndpoint,
  removeEndpoint
};
