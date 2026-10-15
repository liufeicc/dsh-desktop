'use strict';

/**
 * 客户端登记表 —— 回答「现在还有几个桌面壳在用这台服务器」。
 *
 * 为什么需要它（第四版修复的核心）：
 *   后台服务器是被多个窗口共用的。过去「它该不该停」看的是「主壳退没退」，
 *   于是主壳一关就把副窗口正在用的服务器带走了。真正要回答的问题其实是
 *   「还有没有窗口在用」——那就需要一份「谁在用」的名单：
 *   每个壳启动时登记自己，退出时注销；谁退出时发现名单上再没有别人，谁负责把服务器收掉
 *   （最后一个走的人关灯）。名单为空 = 后台服务不该继续存在。
 *
 * 为什么是「一个壳一个文件」而不是一份 JSON 名单：
 *   一份 JSON 要跨进程「读-改-写」，两个壳同时启动或退出就会互相覆盖，还得引锁。
 *   一个 pid 一个文件是各写各的，天然没有竞争；读取时扫一遍目录即可。
 *
 * 目录：<APP_DIR>/clients/<pid>.json，内容 {version, pid, startedAt}，权限 0600。
 *
 * 失效判断（判错方向的代价不对称，所以偏保守）：
 *   · 把「活着的壳」误判成死的 → 可能把别人正在用的服务器杀掉（严重）；
 *   · 把「死掉的壳」误判成活的 → 只是晚一点回收服务器（轻微，下次启动会清）。
 *   因此：pid 活着、但命令行读不出来（非 Linux、权限不足）时，一律按「活着」算。
 *
 * 顺带说明为什么登记表要能容忍残留文件：
 *   壳被 kill -9 时没机会注销，文件会留下。所以读取时必须过滤死 pid，
 *   并在过滤的同时把那些文件删掉（清理只删「确认已死」的，绝不动活着的）。
 */

const fs = require('node:fs');
const path = require('node:path');

const { isProcessAlive, readProcessCmdline, looksLikeDesktopShell } = require('./procinfo');

/** 登记文件的格式版本；字段不兼容时递增，读到别的版本按「不认识」处理。 */
const CLIENT_VERSION = 1;

/** 登记文件名：`<pid>.json`。 */
const CLIENT_FILE_PATTERN = /^(\d+)\.json$/;
/** 写入过程中的临时文件名：`<pid>.json.tmp`（同一个 pid 只会用到自己那一个）。 */
const CLIENT_TEMP_PATTERN = /^(\d+)\.json\.tmp$/;

/**
 * 某个 pid 是否是一个「活着的桌面壳」。
 *
 * 两道判断：
 *   ① pid 还活着（信号 0 探测）；
 *   ② 命令行确实像 Electron 主进程 —— 防的是 pid 被系统复用：壳崩溃后留下的登记文件，
 *      过一阵子可能被别的无关进程占用同一个 pid，光看 ① 就会以为那个壳还在。
 *
 * @param {number} pid - 待检查的 pid。
 * @returns {boolean} true 表示按「活着」处理。
 */
function isClientAlive(pid) {
  if (!isProcessAlive(pid)) return false;
  const command = readProcessCmdline(pid);
  // 读不到命令行时不下结论：宁可多算一个活着的壳，也不误杀服务器
  if (command === null) return true;
  return looksLikeDesktopShell(command);
}

/**
 * 登记本壳，表示「我正在使用这台服务器」。
 *
 * 写入方式与公告文件一致：先写临时文件，再 rename 成目标名（rename 是原子的），
 * 这样别的壳扫描目录时永远不会读到写了一半的 JSON。
 *
 * @param {string} dir - 登记表目录。
 * @param {number} pid - 本壳 pid。
 * @returns {boolean} true 表示登记成功（失败只记日志、不抛错，不影响主流程）。
 */
function registerClient(dir, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const file = path.join(dir, `${pid}.json`);
  const temporary = `${file}.tmp`;
  const payload = { version: CLIENT_VERSION, pid, startedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 上次若在本步之后被强杀，会留下同名的临时文件；先删掉以保证权限被重新应用
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
      // 清理失败不影响主流程
    }
    return false;
  }
}

/**
 * 注销本壳（退出流程调用）。
 *
 * 只删自己的那份，不碰别人的：即便删除失败也不抛错 ——
 * 退出流程绝不能因为一个清理动作卡住，留下的死文件下次扫描时会被过滤掉。
 *
 * @param {string} dir - 登记表目录。
 * @param {number} pid - 本壳 pid。
 * @returns {boolean} true 表示确实删除了。
 */
function unregisterClient(dir, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    fs.unlinkSync(path.join(dir, `${pid}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出「此刻还有哪些壳活着」。
 *
 * 扫描过程中顺手清理两类垃圾，避免目录无限增长：
 *   · 死 pid 留下的 `.json`（壳被 kill -9）；
 *   · 死 pid 留下的 `.tmp`（写到一半被杀）。
 * 注意只清理「确认已死」的条目，活着的壳正在写的临时文件绝不碰。
 *
 * @param {string} dir - 登记表目录。
 * @param {{excludePid?: number}} [options] - 需要排除的 pid（通常是自己：判断「还有没有别人」）。
 * @returns {number[]} 活着的壳 pid 列表（升序）。
 */
function listLiveClients(dir, { excludePid } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // 目录还不存在（从未有多窗口启动过）就是「没有别人」
  }

  const live = [];
  for (const name of names) {
    const clientMatch = CLIENT_FILE_PATTERN.exec(name);
    if (clientMatch) {
      const pid = Number(clientMatch[1]);
      if (isClientAlive(pid)) {
        if (pid !== excludePid) live.push(pid);
        continue;
      }
      removeQuietly(path.join(dir, name));
      continue;
    }

    const tempMatch = CLIENT_TEMP_PATTERN.exec(name);
    if (tempMatch && !isProcessAlive(Number(tempMatch[1]))) removeQuietly(path.join(dir, name));
  }

  return live.sort((a, b) => a - b);
}

/**
 * 数一数「除自己之外还有几个壳活着」。
 *
 * 退出流程里的那句判断就是它：结果为 0 表示自己是最后一个使用者，该关灯了。
 *
 * @param {string} dir - 登记表目录。
 * @param {{excludePid?: number}} [options] - 需要排除的 pid。
 * @returns {number} 其余活着的壳数量。
 */
function countOtherClients(dir, { excludePid } = {}) {
  return listLiveClients(dir, { excludePid }).length;
}

/**
 * 删除一个文件，失败就算了（清理动作不该影响主流程）。
 *
 * @param {string} file - 文件路径。
 */
function removeQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // 已经被别人删掉了，正常
  }
}

module.exports = {
  CLIENT_VERSION,
  registerClient,
  unregisterClient,
  listLiveClients,
  countOtherClients,
  isClientAlive
};
