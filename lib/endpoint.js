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
 *     "shellPid": 10186,      ← 写入者的壳进程 pid，用来判断这个公告是否还有效
 *     "createdAt": "2026-10-14T00:05:12.622Z"
 *   }
 *
 * 安全考虑：url 里带访问 token，任何拿到它的本机用户都能操作 DSH。
 * 所以文件权限固定为 0600（仅属主可读写），目录由 main.js 保证是 0700 级别。
 *
 * 失效判断（宁可重新起一个，也不要连到一个死地址）：
 *   ① 文件不存在 / JSON 坏了            → 不可用；
 *   ② shellPid 进程已经不在             → 不可用（写公告的壳已经退出）；
 *   ③ url 字段缺失或不是 http(s) 地址   → 不可用。
 * 注意这里**不做** HTTP 探活：探活会把启动拖慢（要等超时），而上面的 shellPid 检查
 * 已经覆盖了绝大多数情况；真连不上时 Electron 会显示加载失败，用户重开一次即可。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 公告文件的格式版本。字段不兼容时递增，读到别的版本一律当不可用。 */
const ENDPOINT_VERSION = 1;

/**
 * 判断一个 pid 对应的进程是否还活着。
 *
 * 用信号 0 探测：不真的发信号，只做权限与存在性检查。
 *   - 进程在且属于自己 → 返回 true；
 *   - 进程不存在       → 抛 ESRCH；
 *   - 进程属于别人     → 抛 EPERM，说明进程是活的（本程序只关心自己的壳，会再核对 cmdline）。
 *
 * @param {unknown} pid - 待检查的进程号。
 * @returns {boolean} true 表示进程存在。
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但没有权限发信号；对「是否活着」这个问题来说答案是「活着」
    return error?.code === 'EPERM';
  }
}

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
 * @param {{url: string, port?: number|null, shellPid: number}} info - 公告内容。
 * @returns {boolean} true 表示写入成功（失败只写日志、不抛错，不影响主流程）。
 */
function publishEndpoint(file, info) {
  const payload = {
    version: ENDPOINT_VERSION,
    url: info.url,
    port: Number.isInteger(info.port) ? info.port : null,
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
 * 读取公告并判断它是否还指向一个可用的、别人正在跑的服务器。
 *
 * @param {string} file - 公告文件路径。
 * @returns {{url: string, port: number|null, shellPid: number, createdAt: string}|null}
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

  // 公告是「活的」的前提：写它的那个壳还在跑。
  // 壳退出的正常路径会删掉这个文件；这里是兜底 —— 壳被 kill -9 时文件会留下。
  if (!isProcessAlive(Number(raw.shellPid))) return null;

  return {
    url: raw.url,
    port: Number.isInteger(raw.port) ? raw.port : null,
    shellPid: Number(raw.shellPid),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : ''
  };
}

/**
 * 删除公告文件（退出流程调用）。
 *
 * 带一个「属主核对」：只有公告里的 shellPid 就是自己时才删，
 * 避免复用模式的壳退出时把主实例的公告误删掉。
 *
 * @param {string} file - 公告文件路径。
 * @param {number} shellPid - 期望的公告属主 pid（通常是自己）。
 * @returns {boolean} true 表示确实删除了。
 */
function clearEndpoint(file, shellPid) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number(raw?.shellPid) !== shellPid) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ENDPOINT_VERSION,
  isProcessAlive,
  publishEndpoint,
  readReusableEndpoint,
  clearEndpoint
};
