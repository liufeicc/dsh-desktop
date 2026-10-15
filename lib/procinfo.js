'use strict';

/**
 * 进程信息查询 —— 回答「这个 pid 现在到底是什么」的共用工具。
 *
 * 为什么单独抽一个文件：
 *   桌面壳里有三处都要回答同一个问题，而且判错的代价都很高：
 *     · lib/clients.js  —— 还有几个壳活着（判错会误杀别人正在用的服务器）；
 *     · lib/endpoint.js —— 公告里的服务器进程还在不在（判错会连一个死地址）；
 *     · lib/server.js   —— pid 记录里的那个进程是不是本程序起的 dsh web（判错会误杀无关进程）。
 *   三处各写一份「pid 存活 + 命令行」的实现，迟早会漂移成三套语义，所以集中在这里。
 *
 * 一个必须记住的前提：
 *   pid 是会被系统复用的。光看「pid 还在」就认定「那还是原来那个进程」是错的，
 *   所以凡是清理/停止类动作，都要再过一道「命令行长得像不像」的身份核对。
 */

const fs = require('node:fs');

/**
 * 判断一个 pid 对应的进程是否还活着。
 *
 * 用信号 0 探测：不真的发信号，只做权限与存在性检查。
 *   - 进程在且属于自己 → 返回 true；
 *   - 进程不存在       → 抛 ESRCH；
 *   - 进程属于别人     → 抛 EPERM，说明进程是存在的（对「是否活着」而言答案是「活着」）。
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
    return error?.code === 'EPERM';
  }
}

/**
 * 读取进程的命令行。Linux 下 /proc/<pid>/cmdline 用 \0 分隔参数。
 *
 * @param {unknown} pid - 进程号。
 * @returns {string | null} 以空格连接的完整命令行；读不到（进程没了、没权限、非 Linux）返回 null。
 */
function readProcessCmdline(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return null;
  }
}

/**
 * 命令行是否长得像「本程序托管的 dsh web」。
 *
 * 这是清理残留、停止非自己起的服务器时的安全闸门：pid 会被系统复用，
 * 光看 pid 就动手可能误杀别人的进程。
 *
 * @param {string | null} command - 完整命令行。
 * @returns {boolean} true 才允许对它动手。
 */
function looksLikeManagedDshWeb(command) {
  if (!command) return false;
  return command.includes('dsh') && command.includes('--no-open') && /\bweb\b/.test(command);
}

/**
 * 判断「本程序托管的那台 dsh web」是否还活着。
 *
 * 两道判断：进程还在，且身份对得上。用途是决定「公告里的地址还能不能连」。
 *
 * 读不到命令行时按「活着」算，与 lib/clients.js 同一取向：
 *   把活着的服务器误判成死的 → 新窗口会另起一个服务并去清理「残留」，
 *   有可能把别的窗口正在用的那台杀掉（严重）；反过来只是让用户看到一次加载失败（轻微）。
 *
 * @param {unknown} pid - 服务器进程 pid。
 * @returns {boolean} true 表示可以认为这台服务器还在服务。
 */
function isManagedDshWebAlive(pid) {
  if (!isProcessAlive(pid)) return false;
  const command = readProcessCmdline(pid);
  if (command === null) return true;
  return looksLikeManagedDshWeb(command);
}

/**
 * 命令行是否长得像「DSH 桌面壳的主进程」。
 *
 * 用于客户端登记表的存活判断。判定规则刻意宽松（只要像 Electron 主进程就算），
 * 因为「把活着的壳误判成死的」会导致误杀服务器，代价远高于「把死的误判成活的」。
 *
 * 为什么要排除 `--type=`：
 *   一个 Electron 应用会派生出渲染进程、GPU 进程、工具进程……它们的命令行里同样带着
 *   Electron 可执行文件路径和应用路径，只按「含 electron」判断会把它们也数成一个个壳，
 *   于是「还有几个窗口在用」永远算不对。主进程是唯一不带 `--type=` 的那个。
 *
 * @param {string | null} command - 完整命令行。
 * @returns {boolean} true 表示像桌面壳主进程。
 */
function looksLikeDesktopShell(command) {
  if (!command) return false;
  return command.includes('electron') && !command.includes('--type=');
}

module.exports = {
  isProcessAlive,
  readProcessCmdline,
  looksLikeManagedDshWeb,
  isManagedDshWebAlive,
  looksLikeDesktopShell
};
