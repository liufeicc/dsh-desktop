'use strict';

/**
 * DSH 桌面版主进程。
 *
 * 它负责三件事：
 *   1. 拉起（并托管）一个专属的 `dsh web` 服务器进程 —— 端口由系统分配，退出时一并回收；
 *   2. 用 Electron 窗口加载 dsh 的网页端，用户看到的就是一个原生窗口；
 *   3. 记住窗口大小/位置，下次打开还原。
 *
 * ── 关闭语义（2026-10-10 第二版，按用户明确要求改）────────────────────────
 * 「关就是关」：关窗口 = 退出程序 = 后台 dsh 服务一并停掉。
 * 第一版把关闭拦成「隐藏到系统托盘」，结果是用户关掉窗口以后后台服务照旧在跑，
 * 只能自己去 ps 里找进程杀；这个语义已废弃，不再保留隐藏与托盘常驻。
 *
 * 于是收尾路径有四条，全部汇到同一个 `before-quit` 流程：
 *   a. 点窗口 × / Alt+F4 / 任务栏右键「退出」→ 窗口销毁 → window-all-closed → app.quit()；
 *   b. 应用菜单「退出」/ Ctrl+Q → app.quit()；
 *   c. 收到 SIGTERM / SIGINT / SIGHUP（注销、关机、终端里 kill）→ app.quit()；
 *   d. 上面都没走到、进程直接进入 exit → process.on('exit') 里同步补一刀。
 *
 * 万一连 exit 都没跑到（kill -9、崩溃），还有最后一层：lib/server.js 会把托管的
 * 服务器 pid 记在 ~/.dsh-desktop/server.pid，下次启动壳时先把这类残留收干净。
 * 这样「壳没了、后台服务还在跑」这件事在四条路径之外也不会发生。
 */

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DshServer, signalProcessGroup } = require('./lib/server');

/**
 * 用户级数据目录：日志、窗口状态、服务器 pid 记录都放这里。
 * 允许用 DSH_DESKTOP_APP_DIR 覆盖 —— 端到端测试要在隔离目录里跑，不能碰真实数据。
 */
const APP_DIR = process.env.DSH_DESKTOP_APP_DIR
  ? path.resolve(process.env.DSH_DESKTOP_APP_DIR)
  : path.join(os.homedir(), '.dsh-desktop');
/** 服务器原始输出日志，出问题时第一时间看它。 */
const LOG_FILE = path.join(APP_DIR, 'dsh-server.log');
/** 桌面壳自身的诊断日志（启动顺序、窗口事件、退出流程等）。 */
const APP_LOG_FILE = path.join(APP_DIR, 'app.log');
/** 窗口大小/位置记忆文件。 */
const WINDOW_STATE_FILE = path.join(APP_DIR, 'window-state.json');
/** 当前托管服务器的 pid 记录，用于「壳被强杀」后清理残留。 */
const SERVER_PID_FILE = path.join(APP_DIR, 'server.pid');
/**
 * 退出收尾的硬上限。
 * 正常收尾最坏情况是 4s（SIGTERM 宽限）+ 2s（SIGKILL 后等待），这里留足余量；
 * 真卡住了也必须退，否则用户会看到一个关不掉的窗口。
 */
const SHUTDOWN_TIMEOUT_MS = 12_000;

/**
 * 追加一行桌面壳日志。
 *
 * @param {string} text - 日志正文。
 */
function log(text) {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.appendFileSync(APP_LOG_FILE, `[${new Date().toISOString()}] ${text}\n`);
  } catch {
    // 日志失败不影响主流程
  }
}

/**
 * Linux 上 Electron 自带的 chrome-sandbox 需要 root:root + 4755 权限，
 * 普通用户安装的 node_modules 里显然不满足，直接启动会 FATAL。
 * 这里做一次探测：不可用就整体关掉 Chromium 沙箱（本程序只加载本机回环页面，风险可控）。
 *
 * 注意：必须在 app ready 之前调用。若希望保留沙箱，可让管理员执行：
 *   sudo chown root:root <dist>/chrome-sandbox && sudo chmod 4755 <dist>/chrome-sandbox
 *
 * @returns {boolean} 是否已改用 --no-sandbox。
 */
function disableSandboxWhenUnusable() {
  if (process.platform !== 'linux') return false;
  const helper = path.join(path.dirname(process.execPath), 'chrome-sandbox');
  let usable = false;
  try {
    const stat = fs.statSync(helper);
    usable = stat.uid === 0 && (stat.mode & 0o4000) !== 0;
  } catch {
    usable = false;
  }
  if (!usable) {
    app.commandLine.appendSwitch('no-sandbox');
    log('chrome-sandbox 不可用（需要 root:root + 4755），本次启动使用 --no-sandbox');
  }
  return !usable;
}

disableSandboxWhenUnusable();

/**
 * 让 GNOME 把窗口认成「Dsh Desktop」而不是「Electron」：设置应用名、WM_CLASS 与桌面文件名。
 * .desktop 文件里的 StartupWMClass 与本函数保持一致，图标/任务栏归组才不会错乱。
 */
function applyIdentity() {
  app.setName('Dsh Desktop');
  app.commandLine.appendSwitch('class', 'dsh-desktop');
  if (process.platform === 'linux') app.setDesktopName('dsh-desktop.desktop');
}

applyIdentity();

/** @type {DshServer | null} 当前托管的服务器实例。 */
let server = null;
/** @type {BrowserWindow | null} 主窗口。 */
let mainWindow = null;
/** 当前（或刚退出的）服务器 pid，退出兜底清理要用。 */
let lastServerPid = null;
/** 退出收尾已经启动（防止重复进入收尾流程）。 */
let quitRequested = false;
/** 退出收尾已经完成，此时再来的 before-quit 直接放行。 */
let quitReady = false;

/**
 * 读取上次的窗口几何信息。
 *
 * @returns {{width: number, height: number, x?: number, y?: number, maximized: boolean}} 窗口选项。
 */
function loadWindowState() {
  const fallback = { width: 1280, height: 900, maximized: false };
  try {
    const raw = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    const width = Number.isFinite(raw.width) ? Math.max(640, raw.width) : fallback.width;
    const height = Number.isFinite(raw.height) ? Math.max(480, raw.height) : fallback.height;
    const state = { width, height, maximized: raw.maximized === true };
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
 * 保存窗口几何信息；最大化时保留「还原后」的大小，避免下次打开就是全屏尺寸。
 *
 * @param {BrowserWindow | null} window - 主窗口。
 */
function saveWindowState(window) {
  if (!window || window.isDestroyed()) return;
  try {
    const bounds = window.getNormalBounds();
    const state = { ...bounds, maximized: window.isMaximized() };
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(WINDOW_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    log(`保存窗口状态失败：${String(error)}`);
  }
}

/** 显示并聚焦主窗口（第二次点击启动图标时用）。 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 用系统默认程序打开一个路径（日志、配置目录等）。
 *
 * @param {string} target - 文件或目录路径。
 */
function openExternally(target) {
  shell.openPath(target).then((error) => {
    if (error) log(`打开 ${target} 失败：${error}`);
  });
}

/** 重启服务器：停掉旧的，重新拉起并刷新窗口地址。 */
async function restartServer() {
  if (quitRequested) return;
  try {
    // 重启期间窗口先回到过渡页，让用户知道正在重新装配
    if (mainWindow && !mainWindow.isDestroyed()) await showLoadingPage(mainWindow);
    await stopServer();
    await startServer();
  } catch (error) {
    log(`重启服务器失败：${String(error)}`);
    if (quitRequested) return;
    dialog.showErrorBox('重启 DSH 服务器失败', String(error));
  }
}

/**
 * 启动服务器并把窗口指向它。
 *
 * @returns {Promise<void>} 启动完成（或已弹窗提示失败）。
 */
async function startServer() {
  server = new DshServer({
    port: 0, // 交给系统挑空闲端口，避免与用户手动跑的 dsh web 撞车
    logFile: LOG_FILE,
    pidFile: SERVER_PID_FILE,
    // 子进程一 fork 出来就先记下 pid：万一本进程随后被强杀，exit 兜底还有得可用
    onSpawn: (pid) => {
      lastServerPid = Number.isInteger(pid) ? pid : null;
    },
    onExit: (info) => {
      lastServerPid = null;
      // 用户自己正在退出，或者这是我们主动停的，都不算「意外」
      if (quitRequested || info.expected) return;
      log(`服务器异常退出：code=${String(info.code)} signal=${String(info.signal)}`);
      const options = {
        type: 'error',
        title: 'DSH 服务器已停止',
        message: '后台的 dsh 服务器进程意外退出了。',
        detail: `退出码：${String(info.code)}，信号：${String(info.signal)}\n日志：${LOG_FILE}`,
        buttons: ['重启服务器', '退出程序'],
        defaultId: 0,
        cancelId: 1
      };
      // 窗口可能已被销毁，按需选择是否带上父窗口（带上会变成模态对话框）
      const choice = mainWindow && !mainWindow.isDestroyed()
        ? dialog.showMessageBoxSync(mainWindow, options)
        : dialog.showMessageBoxSync(options);
      if (choice === 0) void restartServer();
      else app.quit();
    }
  });

  const url = await server.start();
  log(`服务器就绪：${url.replace(/token=[^&]+/, 'token=***')}`);
  if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(url);
}

/** 停止服务器（幂等；退出流程与「重启服务器」共用）。 */
async function stopServer() {
  const instance = server;
  if (!instance) return;
  // 先摘掉引用，避免收尾过程中被 restartServer/startServer 再拿到这个正在死的实例
  server = null;
  try {
    await instance.stop();
  } finally {
    lastServerPid = null;
  }
}

/**
 * 判断一个地址是否属于「桌面壳自己该打开的页面」。
 *
 * 该打开的有两类：
 *   - 本地过渡页（file:// 协议的 loading.html）；
 *   - 本次托管的 dsh 服务器同源地址（含带 token 的入口地址）。
 * 其余 http(s) 地址一律视为外部链接，交给系统浏览器，不在壳里导航。
 *
 * @param {string} url - 待判断的地址。
 * @returns {boolean} true 表示由窗口自己加载。
 */
function isInternalUrl(url) {
  if (url.startsWith('file://')) return true;
  if (!server?.url) return false;
  try {
    return new URL(url).origin === new URL(server.url).origin;
  } catch {
    return false;
  }
}

/**
 * 加载启动过渡页（服务器就绪前的占位界面）。
 *
 * @param {BrowserWindow} window - 主窗口。
 */
async function showLoadingPage(window) {
  if (!window || window.isDestroyed()) return;
  // 已经停在过渡页就不用再刷一次，免得闪一下
  if (window.webContents.getURL().startsWith('file://')) return;
  await window.loadFile(path.join(__dirname, 'loading.html'));
}

/**
 * 创建主窗口。
 *
 * @returns {BrowserWindow} 新建的窗口。
 */
function createWindow() {
  const state = loadWindowState();
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'DSH',
    webPreferences: {
      // 加载的是本机回环页面，不需要给它任何 Node 能力
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  });

  if (state.maximized) window.maximize();

  window.once('ready-to-show', () => {
    window.show();
    log('窗口已显示');
  });

  // 关窗口就是退出：这里不拦截，只在窗口销毁前把几何信息落盘。
  // 真正的收尾（停服务器）由下面的 before-quit 统一负责。
  window.on('close', () => saveWindowState(window));
  window.on('closed', () => {
    mainWindow = null;
  });

  window.on('resize', () => saveWindowState(window));
  window.on('move', () => saveWindowState(window));

  // 外部链接一律交给系统浏览器，不在桌面壳里开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    log(`渲染进程结束：${details.reason}`);
  });

  // 先摆上过渡页：dsh 服务器冷启动要十几秒，先给用户一个明确的反馈
  window.loadFile(path.join(__dirname, 'loading.html')).catch((error) => {
    log(`加载过渡页失败：${String(error)}`);
  });

  return window;
}

/**
 * 应用级菜单。
 *
 * 原来有一半功能挂在系统托盘菜单上，第二版去掉托盘后统一挪到这里：
 * 应用菜单在窗口标题栏下方（autoHideMenuBar 让 Linux 上按 Alt 也能唤出）。
 */
function buildAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'DSH',
        submenu: [
          { label: '显示窗口', accelerator: 'CmdOrCtrl+Shift+D', click: () => showMainWindow() },
          {
            label: '在浏览器中打开当前地址',
            enabled: true,
            click: () => {
              if (server?.url) void shell.openExternal(server.url);
            }
          },
          { label: '重启服务器', click: () => void restartServer() },
          { type: 'separator' },
          { label: '查看服务器日志', click: () => openExternally(LOG_FILE) },
          { label: '打开数据目录', click: () => openExternally(APP_DIR) },
          { type: 'separator' },
          { label: '退出（会一并停掉后台服务）', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
        ]
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' }
        ]
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载界面' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '重置缩放' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' }
        ]
      }
    ])
  );
}

// 只允许运行一个实例：第二次点击图标时把已有窗口叫到前台，而不是再起一套服务器
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log('已有实例在运行，本次启动退出');
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    fs.mkdirSync(APP_DIR, { recursive: true });
    log(`应用启动（electron ${process.versions.electron}）`);
    buildAppMenu();
    mainWindow = createWindow();
    try {
      await startServer();
    } catch (error) {
      log(`启动服务器失败：${String(error)}`);
      // 用户已经把窗口关掉、正在退出：这是预期内的中止，不要弹错误框
      if (quitRequested) return;
      dialog.showErrorBox(
        'DSH 启动失败',
        `无法启动 dsh 服务器。\n\n${String(error)}\n\n请确认命令行里可以正常运行 dsh，日志见：${LOG_FILE}`
      );
      app.quit();
    }
  });

  // 窗口没了就退出程序（第一版会留一个隐藏窗口 + 服务器在后台，正是这次要修的问题）
  app.on('window-all-closed', () => {
    log('所有窗口已关闭，退出程序');
    app.quit();
  });

  app.on('activate', () => showMainWindow());

  /**
   * 收到终止信号也要走正常收尾。
   *
   * 这是上一版最实的一个漏：注销、关机、终端里 `kill <壳pid>` 时 Electron 直接结束，
   * before-quit 根本不会执行，detached 的 dsh 子进程就永久留在后台了。
   */
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      log(`收到 ${signal}，按正常退出流程收尾`);
      app.quit();
    });
  }

  // 统一退出流程：先把服务器收干净，再真正退出
  app.on('before-quit', (event) => {
    if (quitReady) return; // 收尾已完成，放行
    event.preventDefault(); // 还没收尾，先别退
    if (quitRequested) return; // 收尾进行中，重复的退出请求忽略
    quitRequested = true;
    log('开始退出流程');
    saveWindowState(mainWindow);

    // 兜底：服务器万一赖着不走，也不能让窗口关不掉
    const forceTimer = setTimeout(() => {
      log(`退出收尾超过 ${SHUTDOWN_TIMEOUT_MS} ms，强制结束`);
      app.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);

    void stopServer()
      .catch((error) => log(`停止服务器时出错：${String(error)}`))
      .finally(() => {
        clearTimeout(forceTimer);
        quitReady = true;
        log('退出流程结束');
        app.quit();
      });
  });

  /**
   * 最后一层保险：进程直接走到 exit（before-quit 没跑完的异常路径）时，
   * 同步把服务器收掉。能走到这里的场景已经没机会优雅停机了，直接用 SIGKILL。
   */
  process.on('exit', () => {
    if (lastServerPid === null) return;
    log(`进程直接退出，强制回收服务器进程组 ${String(lastServerPid)}`);
    signalProcessGroup(lastServerPid, 'SIGKILL');
  });

  process.on('uncaughtException', (error) => {
    log(`未捕获异常：${error?.stack ?? String(error)}`);
  });
}
