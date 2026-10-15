'use strict';

/**
 * 窗口几何记忆 —— 让窗口下次打开时回到原来的位置和大小。
 *
 * 为什么单独一个文件：
 *   主窗口与副窗口各记一份（两块屏上两个窗口，共用一份会互相覆盖，每次打开都得重新拖窗口），
 *   而「该读哪一份」由窗口模式决定。把「路径怎么选」和「怎么读写」放在一起，
 *   main.js 里就只剩一行调用。
 *
 * 三个必须记住的点：
 *   1. 最大化时要保存「还原后」的大小（`getNormalBounds()`），否则下次打开就是全屏尺寸，
 *      用户再还原也回不到原来的窗口大小；
 *   2. 读到的宽高要兜底下限，避免配置文件被改坏后开出一个 10×10 的窗口；
 *   3. 读写失败绝不能影响主流程 —— 记不住窗口位置只是小烦恼，因此崩掉程序是不可接受的。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 窗口最小尺寸（与 index.html 里 BrowserWindow 的 minWidth/minHeight 保持一致）。 */
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
/** 没有任何历史记录时的默认窗口尺寸。 */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 900;

/**
 * 计算某个模式该用哪个状态文件。
 *
 * @param {string} appDir - 数据目录（`~/.dsh-desktop` 或测试用的隔离目录）。
 * @param {boolean} replica - 是否是复用别人服务器的副窗口。
 * @returns {string} 状态文件路径。
 */
function windowStateFile(appDir, replica) {
  return path.join(appDir, replica ? 'window-state.secondary.json' : 'window-state.json');
}

/**
 * 读取上次的窗口几何信息。
 *
 * @param {string} file - 状态文件路径（主/副窗口各有各的）。
 * @returns {{width: number, height: number, x?: number, y?: number, maximized: boolean}} 窗口选项。
 */
function loadWindowState(file) {
  const fallback = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const state = {
      width: Number.isFinite(raw.width) ? Math.max(MIN_WIDTH, raw.width) : fallback.width,
      height: Number.isFinite(raw.height) ? Math.max(MIN_HEIGHT, raw.height) : fallback.height,
      maximized: raw.maximized === true
    };
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      state.x = raw.x;
      state.y = raw.y;
    }
    return state;
  } catch {
    return fallback;
  }
}

/**
 * 保存窗口几何信息。
 *
 * @param {string} file - 状态文件路径。
 * @param {import('electron').BrowserWindow|null} window - 要记录的窗口。
 * @param {(text: string) => void} [log] - 失败时的日志回调。
 * @returns {void}
 */
function saveWindowState(file, window, log) {
  if (!window || window.isDestroyed()) return;
  try {
    const bounds = window.getNormalBounds();
    const state = { ...bounds, maximized: window.isMaximized() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    log?.(`保存窗口状态失败：${String(error)}`);
  }
}

module.exports = { windowStateFile, loadWindowState, saveWindowState, MIN_WIDTH, MIN_HEIGHT };
