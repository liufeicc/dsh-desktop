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
 *
 * ── 多窗口（2026-10-14 第三版，按用户明确要求改）─────────────────────────
 * 用户有两块屏，需要在两个屏幕上都操作 DSH，原来的行为是「第二次点图标只把已有窗口
 * 叫到前台」——因为 requestSingleInstanceLock() 拿不到锁就退出。现在改成「复用优先」：
 *
 *   第一个壳：照旧拉起自己的 dsh web，并把访问地址公告到 ~/.dsh-desktop/endpoint.json；
 *   后续的壳：读到公告且那台服务器确实还活着 → 直接加载同一个地址，自己不起服务器。
 *
 * 于是第二个窗口和第一个窗口是同一个后端（正如「两个浏览器窗口看同一个页面」），
 * 不额外占用一个 node 服务进程。对应的差异必须守住，否则会互相伤害：
 *   - 复用模式的壳不写 server.pid，也没有「重启服务器」菜单项（重启会换端口，把别人的窗口甩掉）；
 *   - 复用模式的窗口位置单独记在 window-state.secondary.json，免得两个窗口互相覆盖。
 *
 * ── 服务器寿命：最后一个窗口退出才停（2026-10-15 第四版，按用户明确要求改）────
 * 第三版留下的坑：服务器的生死被绑在「起它的那个壳」身上 —— 主窗口一关就 stopServer()，
 * 副窗口正在用的后端当场消失。用户的原话是「主的关闭了，后台服务不要关闭；只有所有
 * 启动的 DSH 桌面版都关闭了，才关闭后台服务」。所以第四版把判据整个换掉：
 *
 *   服务器该不该停，只看一件事：还有没有窗口在用它（lib/clients.js 的登记表）。
 *     还有别的壳  → 服务器、地址公告、pid 记录原样保留，本次退出什么都不碰；
 *     一个都不剩  → 先撤公告（免得后来者连死地址），再停服务器：
 *                   自己起的直接停子进程；不是自己起的（副本当最后一个）按 pid 记录停。
 *
 * 与它配套的两处判据也要跟着换，否则会出现「留着一台没人用的服务」或「误杀别人在用的服务」：
 *   ① 公告是否可复用（lib/endpoint.js）：看「公告里的服务器进程还活着」，
 *      不再看「写公告的壳还活着」——主壳退出后公告依然有效，后来者仍能复用；
 *   ② 启动时是否清理残留（lib/server.js reapStaleServer）：看「还有没有别的活壳」，
 *      不再只看「起它的壳在不在」——有窗口在用时绝不碰那台服务器。
 *
 * 一句话总结这一版的心智模型：**服务器不属于任何窗口，它属于「当前打开着的这些窗口」**。
 *
 * ── 代码分工（第四版拆分，main.js 只做 Electron 接线）────────────────────
 *   lib/quit-flow.js     退出判定与收尾（第四版核心：还有没有窗口在用、该不该回收、怎么回收）
 *   lib/clients.js       「谁在用服务器」的登记表
 *   lib/endpoint.js      运行中服务器地址的公告板（含有效性判据）
 *   lib/server.js        dsh web 子进程的托管（启动 / 解析地址 / 按进程组停止 / 残留清理）
 *   lib/procinfo.js      进程存活与身份判定（上面三个模块共用，避免语义漂移）
 *   lib/window-state.js  窗口几何记忆
 *   lib/menu.js          应用菜单（含「副窗口不能重启服务器」这类模式分支）
 * 本文件只保留：Electron 事件接线、窗口创建、启动顺序、以及把上面这些模块串起来。
 */

const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DshServer } = require('./lib/server');
const { publishEndpoint, readReusableEndpoint } = require('./lib/endpoint');
const { countOtherClients } = require('./lib/clients');
const { QuitFlow } = require('./lib/quit-flow');
const { buildAppMenu } = require('./lib/menu');
const { windowStateFile, loadWindowState, saveWindowState } = require('./lib/window-state');

/**
 * 用户级数据目录：日志、窗口状态、服务器 pid 记录、服务器地址公告都放这里。
 * 允许用 DSH_DESKTOP_APP_DIR 覆盖 —— 端到端测试要在隔离目录里跑，不能碰真实数据。
 */
const APP_DIR = process.env.DSH_DESKTOP_APP_DIR
  ? path.resolve(process.env.DSH_DESKTOP_APP_DIR)
  : path.join(os.homedir(), '.dsh-desktop');
/** 服务器原始输出日志，出问题时第一时间看它。 */
const LOG_FILE = path.join(APP_DIR, 'dsh-server.log');
/** 桌面壳自身的诊断日志（启动顺序、窗口事件、退出流程等）。 */
const APP_LOG_FILE = path.join(APP_DIR, 'app.log');
/** 当前托管服务器的 pid 记录，用于「壳被强杀」后清理残留。 */
const SERVER_PID_FILE = path.join(APP_DIR, 'server.pid');
/**
 * 运行中服务器地址的公告文件，供后启动的壳复用（详见 lib/endpoint.js）。
 * 里面带访问 token，所以以 0600 权限写入。
 */
const ENDPOINT_FILE = path.join(APP_DIR, 'endpoint.json');
/**
 * 客户端登记表目录：谁正在使用这台服务器（详见 lib/clients.js）。
 *
 * 第四版新增，是本次「最后一个窗口退出才停服务」的判据来源：
 * 每个壳启动时写一份 `<pid>.json`，退出时删掉；退出前数一数还剩几个，
 * 一个都不剩才轮到自己去停服务器。
 */
const CLIENTS_DIR = path.join(APP_DIR, 'clients');
/**
 * 退出收尾的硬上限。
 * 正常收尾最坏情况是 4s（SIGTERM 宽限）+ 2s（SIGKILL 后等待），这里留足余量；
 * 真卡住了也必须退，否则用户会看到一个关不掉的窗口。
 */
const SHUTDOWN_TIMEOUT_MS = 12_000;
/**
 * 没抢到锁时，等第一个壳公告出可复用地址的上限。
 *
 * 为什么是 30 秒：第一个壳的冷启动最坏情况就是十几秒（装配整个 profile），
 * 加上它自己写文件的时间，30 秒足够覆盖；再长就让用户等得不耐烦了。
 */
const REUSE_WAIT_TIMEOUT_MS = 30_000;
/** 轮询公告文件的间隔。取 500ms：够快，又不至于把磁盘打热。 */
const REUSE_WAIT_INTERVAL_MS = 500;

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

/** @type {DshServer | null} 当前托管的服务器实例（复用模式下始终为 null）。 */
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
 * 本壳是否复用了别的壳已经在跑的服务器（true 时自己不起服务器、菜单里也没有「重启服务器」）。
 *
 * 注意它**不再**意味着「不许停别人的服务」：如果本壳是最后一个使用者，
 * 它会按 pid 记录把那台不属于自己的服务器停掉（第四版，「最后一个走的人关灯」）。
 */
let reusingExistingServer = false;
/**
 * 退出判定与收尾（第四版核心逻辑都封在这里，见 lib/quit-flow.js）。
 *
 * 它需要知道三件只有 main.js 才知道的事，所以用回调注入：
 *   ① 本壳现在有没有托管着一台服务器；
 *   ② 怎么停掉它；
 *   ③ 本壳是不是「复用别人服务器」的模式。
 */
const quitFlow = new QuitFlow({
  clientsDir: CLIENTS_DIR,
  endpointFile: ENDPOINT_FILE,
  serverPidFile: SERVER_PID_FILE,
  log,
  hasOwnedServer: () => server !== null && server.running,
  stopOwnedServer: () => stopServer(),
  getLastServerPid: () => lastServerPid,
  isReplica: () => reusingExistingServer
});

/**
 * 窗口几何记忆文件：主窗口与副窗口分开存（读写逻辑在 lib/window-state.js）。
 *
 * 不分开会怎样：两块屏上的窗口大小/位置不同，共用一个文件就会互相覆盖，
 * 每次打开都得重新拖窗口——这正是多开时最容易踩的坑。
 *
 * @returns {string} 当前窗口模式对应的状态文件路径。
 */
function currentWindowStateFile() {
  return windowStateFile(APP_DIR, reusingExistingServer);
}

/**
 * 保存当前窗口的几何信息（每次移动/缩放/关闭窗口都会被调用，所以这里保持简洁）。
 *
 * @param {BrowserWindow | null} window - 要记录的窗口。
 */
function persistWindowState(window) {
  saveWindowState(currentWindowStateFile(), window, log);
}

/**
 * 显示并聚焦主窗口。
 *
 * 三处用到：应用菜单的「显示窗口」、Electron 的 activate/second-instance 事件，
 * 以及复用模式下页面加载完成后的首次露面（那时窗口还是隐藏的）。
 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
 * 启动一个由本壳托管的服务器，并把就绪后的访问地址公告出去。
 *
 * 这里刻意不加载窗口：加载统一由 boot() 收口，这样「自己起服务」和「复用别人的服务」
 * 两条路的窗口行为完全一致，不会一边漏了过渡页、一边漏了日志。
 *
 * @returns {Promise<void>} 启动完成（或已弹窗提示失败）。
 */
async function startServer() {
  server = new DshServer({
    port: 0, // 交给系统挑空闲端口，避免与用户手动跑的 dsh web 撞车
    logFile: LOG_FILE,
    pidFile: SERVER_PID_FILE,
    // 清理残留前先问登记表：还有别的窗口在用服务器时，绝不能把那台当残留清掉。
    // 注意要排除自己 —— 本壳已经登记过了，不排除的话「永远有别人在用」，残留就再也清不掉了。
    hasOtherClients: () => countOtherClients(CLIENTS_DIR, { excludePid: process.pid }) > 0,
    // 子进程一 fork 出来就先记下 pid：万一本进程随后被强杀，exit 兜底还有得可用
    onSpawn: (pid) => {
      lastServerPid = Number.isInteger(pid) ? pid : null;
    },
    onExit: (info) => {
      lastServerPid = null;
      // 用户自己正在退出，或者这是我们主动停的，都不算「意外」
      if (quitRequested || info.expected) return;
      // 复用模式的壳没有服务器，走到这里说明是主实例的服务挂了；此时不能弹「重启服务器」，
      // 因为重启出来的是本进程自己的服务，会和主实例抢同一个端口区间、也让用户困惑。
      if (reusingExistingServer) {
        log(`复用的服务器已停止：code=${String(info.code)} signal=${String(info.signal)}`);
        return;
      }
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

  // 注意 server.port 是「请求的端口」，这里传的是 0（让系统挑），所以不能直接用它。
  // 实际端口要从就绪地址里解析。
  //
  // serverPid 是第四版加的关键字段：公告的有效性从此看它（服务器还活着吗），
  // 而不是看 shellPid（起服务器的壳还活着吗）—— 主壳退出后公告必须继续有效。
  publishEndpoint(ENDPOINT_FILE, {
    url,
    port: parsePort(url),
    serverPid: server.pid,
    shellPid: process.pid
  });
  log(`已公告服务器地址（serverPid=${String(server.pid)}），后续启动的窗口将复用它`);
}

/**
 * 从访问地址里解析出实际监听端口。
 *
 * @param {string} url - `dsh web` 打印的就绪地址。
 * @returns {number|null} 端口号；解析不出来时为 null（只影响日志可读性，不影响复用）。
 */
function parsePort(url) {
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * 是否已经有一个活着的、可以复用的服务器在跑。
 *
 * 两个条件都要满足（第四版）：
 *   ① 公告指向的服务器进程确实还活着（判据在 lib/endpoint.js，含命令行身份核对）；
 *   ② 除自己之外还有别的壳活着 —— 也就是「真的有人在用它」。
 *
 * 为什么要加 ②：如果所有窗口都退干净了、只留下一台没人用的服务器（所有壳都被 kill -9
 * 时会发生），那台服务按本程序的语义就该被回收，而不是被下一个窗口捡起来接着用。
 * 加上这一条，「没有窗口在跑 ⇒ 后台服务不该存在」这个不变量在启动流程里也成立。
 *
 * @returns {boolean} true 表示可以复用现成的服务器地址。
 */
function hasReusableEndpoint() {
  if (!readReusableEndpoint(ENDPOINT_FILE)) return false;
  return countOtherClients(CLIENTS_DIR, { excludePid: process.pid }) > 0;
}

/**
 * 等第一个壳公告出可复用的地址。
 *
 * 为什么必须等：单实例锁告诉我们「已经有一个壳在跑」，但那个壳可能还在冷启动
 * （首次装配整个 profile 要十几秒），此刻公告文件还没写出来。如果不等就退回主模式，
 * 两个壳会各起一个 dsh 服务 —— 既白占一份内存，也让两块屏看着像两个不相干的程序。
 * 用户的真实操作节奏正是「点了图标没反应，再点一次」，所以这个窗口期一点都不罕见。
 *
 * @param {number} [timeoutMs] - 最长等待时间。
 * @returns {Promise<boolean>} true 表示等到了可复用的地址。
 */
async function waitForReusableEndpoint(timeoutMs = REUSE_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let waited = 0;
  while (Date.now() < deadline) {
    if (hasReusableEndpoint()) {
      if (waited > 0) log(`等待 ${Math.round(waited / 1000)} 秒后拿到了可复用的地址`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, REUSE_WAIT_INTERVAL_MS));
    waited += REUSE_WAIT_INTERVAL_MS;
  }
  return hasReusableEndpoint();
}

/**
 * 把窗口接到另一个壳已经在跑的服务器上。
 *
 * 调用前 hasReusableEndpoint() 必须已经为真；这里再读一次是为了拿到地址本身
 * （中间隔了一次窗口创建，理论上公告可能已被撤下，所以要处理读不到的情况）。
 *
 * @returns {Promise<void>} 窗口已指向该地址（或已记录失败原因）。
 */
async function attachToExistingServer() {
  const endpoint = readReusableEndpoint(ENDPOINT_FILE);
  if (!endpoint) {
    // 竞态窗口：判定可用之后、真正连接之前，那台服务器被回收了
    // （最后一个窗口在这几百毫秒里退出了，公告与服务器一起收掉）。
    // 此时窗口是隐藏的，用户会以为程序没启动 —— 所以显式报出来并让用户决定。
    log('复用地址在连接前消失（其他窗口可能刚好全部退出）');
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindow();
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'DSH 服务器已不可用',
        message: '刚才检测到的 DSH 服务器已经停止。',
        detail: '所有窗口都关闭时，后台服务会被一并回收。请重新打开 DSH。',
        buttons: ['退出']
      });
    }
    app.quit();
    return;
  }

  log(
    `复用已有实例的服务器（serverPid=${String(endpoint.serverPid)}，起它的壳 pid=${String(endpoint.shellPid)}，` +
      `端口 ${String(endpoint.port)}），本窗口不再启动服务器`
  );
  if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(endpoint.url);
}

/**
 * 启动序列：准备数据目录、开窗口，然后「复用优先」地接入服务器。
 *
 * 顺序上先开窗口再连服务器，是为了让用户马上看到窗口和过渡页，
 * 而不是对着一个还没出现的窗口等服务器冷启动。
 *
 * @returns {Promise<void>} 启动流程结束（失败时可能已弹窗并请求退出）。
 */
async function boot() {
  fs.mkdirSync(APP_DIR, { recursive: true });
  log(`应用启动（electron ${process.versions.electron}，${reusingExistingServer ? '未持锁' : '持锁'}）`);

  // 第一件事：把自己登记进「谁在用后台服务」的名单（lib/quit-flow.js → lib/clients.js）。
  // 必须早于任何退出判定：此刻可能正有别的窗口在退出，它按这份名单决定服务器留不留；
  // 我们晚登记一步，就会被它当成「没人用了」，把服务器连同我们即将加载的地址一起收走。
  const registered = quitFlow.registerSelf();
  log(
    registered
      ? `已登记本窗口（pid=${process.pid}），当前另有 ${quitFlow.countOthers()} 个窗口在用后台服务`
      : '登记本窗口失败（不影响本窗口使用，但别的窗口退出时可能看不到我们，从而提前回收服务）'
  );

  // 窗口建出来之后，模式（主 / 副）就不能再变了：菜单、窗口标题、窗口几何状态文件
  // 都按模式分两套，建好了再改就会出现「菜单是主窗口的、窗口是副窗口的」这种错配。
  // 所以窗口只建一次，之前先把模式定下来（锁的结果 + 有没有可复用的地址）。
  if (reusingExistingServer) {
    // 没抢到锁：只在「确实有活着的、别人在用的服务器」时才当副窗口。
    // 注意这里要「等」而不是「看一眼就决定」—— 主实例可能还在冷启动（见函数注释）。
    if (await waitForReusableEndpoint()) {
      log('检测到可复用的服务器地址');
    } else {
      reusingExistingServer = false;
      log(`等待 ${REUSE_WAIT_TIMEOUT_MS / 1000} 秒仍未拿到可复用地址，退回主窗口（自己起服务器）`);
    }
  } else if (hasReusableEndpoint()) {
    // 抢到锁却又发现有活着的服务器：极罕见（例如持有它的窗口刚崩、锁已释放但服务还在，
    // 而另一个窗口正在用它）。能省一个 node 服务进程就省，接上它即可。
    reusingExistingServer = true;
    log('持锁但检测到可复用的服务器地址，改用复用模式');
  }

  installAppMenu();
  mainWindow = createWindow();

  try {
    if (reusingExistingServer) {
      await attachToExistingServer();
      // 复用模式下窗口是隐藏建的（见 createWindow），页面就绪后再露面，
      // 免得用户先看到一块空白背景。showMainWindow 同时负责日志与几何落盘。
      if (mainWindow && !mainWindow.isDestroyed()) {
        showMainWindow();
        persistWindowState(mainWindow);
      }
      return;
    }

    await startServer();
    if (server && mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(server.url);
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
 * 判断一个加载错误是不是「导航被后一次导航取代」造成的。
 *
 * 为什么必须区分：`win.loadFile()` / `win.loadURL()` 返回的 promise 在当前导航被
 * 另一次导航打断时，会以 `ERR_ABORTED (-3)` reject。这在本程序里是**正常流程** ——
 * 启动时先摆过渡页，服务器就绪后立刻 `loadURL` 换成真页面，过渡页那次加载必然被打断。
 * 把它当失败记进日志，只会让真正的加载失败被噪音淹没（真实故障是
 * ERR_FILE_NOT_FOUND / ERR_CONNECTION_REFUSED 这类，错误码完全不同）。
 *
 * @param {unknown} error - loadFile/loadURL 抛出的错误。
 * @returns {boolean} true 表示是被取代的导航，可以安全忽略。
 */
function isNavigationSuperseded(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  return code === 'ERR_ABORTED' || /ERR_ABORTED\s*\(-3\)/.test(message);
}

/**
 * 加载启动过渡页（服务器就绪前的占位界面）。
 *
 * @param {BrowserWindow} window - 主窗口。
 * @returns {Promise<boolean>} true 表示加载已发起（失败已按需记日志）。
 */
async function loadLoadingPage(window) {
  if (!window || window.isDestroyed()) return false;
  try {
    await window.loadFile(path.join(__dirname, 'loading.html'));
    return true;
  } catch (error) {
    // 过渡页只是占位：被后一次导航取代属正常，只有真的读不到文件才值得记一笔
    if (!isNavigationSuperseded(error)) log(`加载过渡页失败：${String(error)}`);
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
  await loadLoadingPage(window);
}

/**
 * 创建主窗口。
 *
 * @returns {BrowserWindow} 新建的窗口。
 */
function createWindow() {
  const state = loadWindowState(currentWindowStateFile());
  // 两块屏上会同时出现两个窗口，标题里区分一下，任务栏/窗口列表里才分得清谁是谁。
  // 这个值在本函数里被两处用到：构造参数，以及 page-title-updated 里把标题钉回去。
  const windowTitle = reusingExistingServer ? 'DSH（副窗口）' : 'DSH';
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
    title: windowTitle,
    webPreferences: {
      // 加载的是本机回环页面，不需要给它任何 Node 能力
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  });

  if (state.maximized) window.maximize();

  // 主模式：过渡页一就绪就显示，让用户马上看到反馈（服务器冷启动要十几秒）。
  // 复用模式跳过这一步 —— 它没有过渡页可显示，由 boot() 在 loadURL 成功后调用
  // showMainWindow()，避免先闪一段空白背景。
  if (!reusingExistingServer) {
    window.once('ready-to-show', () => {
      showMainWindow();
      // 立刻落一次盘：resize/move/close 只在用户动过窗口、或走到关闭流程时才触发；
      // 如果窗口建好后一直没被动过就被强杀（kill -9 / 崩溃），几何信息就丢了。
      // 这里先写一次，保证「第一次打开」的位置也被记住。
      persistWindowState(window);
    });
  }

  // 关窗口就是退出：这里不拦截，只在窗口销毁前把几何信息落盘。
  // 真正的收尾（停服务器）由下面的 before-quit 统一负责。
  window.on('close', () => persistWindowState(window));
  window.on('closed', () => {
    mainWindow = null;
  });

  window.on('resize', () => persistWindowState(window));
  window.on('move', () => persistWindowState(window));

  // 标题由本程序独占决定，不允许页面改。
  // 为什么：dsh 网页端在加载完成后会设置 document.title（实测窗口标题会变成
  // 「DeepSeek Harness」），把 BrowserWindow 的 title 顶掉。而两块屏上会同时开着
  // 主窗口和副窗口，标题被页面统一改掉之后就再也分不清谁是谁了。
  // preventDefault 让窗口标题稳定在 windowTitle 上（它定义在本函数开头）。
  window.on('page-title-updated', (event) => {
    event.preventDefault();
    if (window.getTitle() !== windowTitle) window.setTitle(windowTitle);
  });

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

  // 过渡页只在「需要等服务器冷启动」时才有意义。
  // 复用模式（另一个壳的服务器已经在跑）下地址是现成的，boot() 会紧接着 loadURL，
  // 先摆过渡页只会让这次导航立刻被打断 —— 所以直接跳过。
  if (!reusingExistingServer) {
    void loadLoadingPage(window);
  } else {
    log('复用模式：跳过过渡页，直接等 boot() 加载已有地址');
  }

  return window;
}

/**
 * 取当前窗口正在访问的地址。
 *
 * 主模式直接用自己服务器的地址；复用模式没有 server 对象，就再去读一次公告 ——
 * 这样主实例重启服务器（换了端口）之后，副窗口的菜单仍然指得对。
 *
 * @returns {string|null} 可用地址；拿不到时为 null。
 */
function currentAccessUrl() {
  if (server?.url) return server.url;
  return readReusableEndpoint(ENDPOINT_FILE)?.url ?? null;
}

/**
 * 安装应用菜单（菜单内容与模式分支都在 lib/menu.js 里）。
 *
 * 放在启动早期调用，让用户一打开窗口就能看到菜单，而不是先看一段空白。
 */
function installAppMenu() {
  buildAppMenu({
    replica: reusingExistingServer,
    appDir: APP_DIR,
    logFile: LOG_FILE,
    log,
    actions: {
      showWindow: showMainWindow,
      currentAccessUrl,
      restartServer,
      reloadWindow: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
      },
      quit: () => app.quit()
    }
  });
}

/**
 * 本进程是否抢到了 Electron 的单实例锁。
 *
 * 语义澄清（实测确认，别按直觉改）：
 *   锁失败**不会**让 Electron 终止本进程 —— 拿到 `false` 之后代码照常往下跑，
 *   退不退出完全由应用自己决定。所以「多开」的关键不是绕开这个锁，
 *   而是拿到 false 时不要 quit，转而去复用第一个壳已经跑着的服务器。
 *
 * 锁失败同时还意味着：本进程启动时，第一个壳会收到一次 second-instance。
 * 因此那个事件里只能「把已有窗口叫到前台」，绝不能抢用户的焦点去做别的事。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log('未抢到单实例锁：本次启动将复用已有实例的服务器（不是错误，是多窗口的常规路径）');
  reusingExistingServer = true; // 先标记，好让 createWindow() 一开始就用副窗口的标题与几何
}

app.on('second-instance', () => {
  // 走到这里说明有第三个壳在并发启动。把已有窗口叫到前台即可：
  // 不必替它开窗口 —— 它自己会走复用分支。
  log('收到 second-instance：把已有窗口叫到前台');
  showMainWindow();
});

app.whenReady().then(() => {
  void boot();
});

// 窗口没了就退出本进程。注意「退出本进程」不等于「停掉后台服务」：
// 是否回收服务器由 before-quit 按「还有没有别的窗口在用」决定，这里不预判。
app.on('window-all-closed', () => {
  log('所有窗口已关闭，退出进程（服务器是否回收由「还有没有别的窗口」决定）');
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

// 统一退出流程：先判定「还有没有窗口在用这台服务器」，再决定留还是收。
// 判定与收尾的细节都在 lib/quit-flow.js，这里只负责 Electron 的生命周期与兜底超时。
app.on('before-quit', (event) => {
  if (quitReady) return; // 收尾已完成，放行
  event.preventDefault(); // 还没收尾，先别退
  if (quitRequested) return; // 收尾进行中，重复的退出请求忽略
  quitRequested = true;
  log('开始退出流程');
  persistWindowState(mainWindow);

  // 兜底：服务器万一赖着不走，也不能让窗口关不掉
  const forceTimer = setTimeout(() => {
    log(`退出收尾超过 ${SHUTDOWN_TIMEOUT_MS} ms，强制结束`);
    app.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);

  void quitFlow
    .run()
    .catch((error) => log(`退出收尾出错：${String(error)}`))
    .finally(() => {
      clearTimeout(forceTimer);
      quitReady = true;
      log('退出流程结束');
      app.quit();
    });
});

/**
 * 最后一层保险：进程直接走到 exit（before-quit 没跑完的异常路径）时，同步把服务器收掉。
 * 判据与正常路径完全一致（还有别的窗口在用就什么都不碰），细节见 lib/quit-flow.js。
 */
process.on('exit', () => {
  quitFlow.runSyncFallback();
});

process.on('uncaughtException', (error) => {
  log(`未捕获异常：${error?.stack ?? String(error)}`);
});
