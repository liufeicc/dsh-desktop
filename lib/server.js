'use strict';

/**
 * DshServer —— 托管一个 `dsh web` 子进程。
 *
 * 为什么这么设计（关键前提，改代码前请先读）：
 *
 * 1. `dsh web` 监听成功后，会把「带一次性 token 的访问地址」打到 stdout，形如：
 *      dsh web: http://127.0.0.1:41234/?token=xxxxx (LAN: http://192.168.1.5:41234/?token=xxxxx)
 *    dsh 的网页端有防蹭用校验：浏览器必须先拿 token 换一个签名 cookie（默认 30 天有效），
 *    否则直接访问 127.0.0.1:<port> 只会得到 401。所以桌面壳必须把 stdout 里这一行抓出来，
 *    用这个地址去加载窗口 —— 这是「套壳能直接用」的关键，也是不能自己拼 URL 的原因。
 *
 * 2. 端口交给操作系统挑（`--port 0`）。用户机器上经常已经跑着一个 dsh web（例如 3080），
 *    固定端口会撞车；动态端口让桌面程序拥有自己独占的服务器，退出时能干净回收，
 *    不会误杀用户手动启动的那个实例。
 *
 * 3. 子进程用 detached: true 自成进程组。dsh 干活时会派生 bash 等子进程，
 *    停止时按进程组（-pid）杀，才不会留下孤儿进程。
 *
 * 3b. 子进程的 stdout/stderr **不接管道，直接接日志文件**（第四版改，别再改回管道）。
 *    原因是一次实测：管道是「壳 → 服务器」之间的一根管子，壳退出时管子断了，
 *    服务器下一次往 stdout 写东西就会拿到 EPIPE —— 而 Node 里未处理的 EPIPE 会直接
 *    结束进程。也就是说：壳退出后，只要服务器打一行日志（哪怕一个警告），它自己就死了，
 *    副窗口当场失去后端。这与「主壳退出后服务要留着」直接冲突，所以：
 *      · spawn 时把 stdout/stderr 指向 dsh-server.log（追加模式）；
 *      · 就绪地址改成「读这个文件」取得（原来是读 stdout 管道）；
 *      · 服务器的输出由它自己落盘，壳退出后不再有任何东西牵着它。
 *
 * 4. `--no-open` 阻止 dsh 自己再去拉起系统浏览器（否则会出现两个窗口）。
 *
 * 5. 子进程 pid 会写进 pidFile（默认 ~/.dsh-desktop/server.pid）。这个文件有两个用途：
 *    ① 清理残留：上面那套「按进程组杀」只在壳自己有机会执行收尾时有效。壳被 kill -9、崩溃、
 *       或者注销时没来得及收尾，detached 的子进程就会被 init 收养、永久留在后台 ——
 *       用户看到的正是「壳关了，后台服务还在跑」。所以每次启动前先读这个文件，
 *       确认那确实是「上一任壳留下的 dsh web」之后，把它收拾干净。
 *    ② 让「不是自己起的」那个壳也能停它：多窗口时服务器由第一个壳起，最后退出的却可能是
 *       另一个壳（它没有子进程句柄），只能靠这份记录找到服务器并停掉（stopRecordedServer）。
 *       所以「主的壳退出但服务器要留着」时，pidFile 必须原样保留，不能随手删。
 *
 * 6. 服务器的寿命由调用方（main.js）按「还有没有窗口在用」决定，不由本文件决定：
 *    本文件只提供两种停法 —— 停自己起的子进程（stop）、按记录停别人的（stopRecordedServer）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isProcessAlive, readProcessCmdline, looksLikeManagedDshWeb } = require('./procinfo');

/** stdout 中访问地址行的固定前缀。 */
const URL_PATTERN = /\bdsh web:\s+(https?:\/\/\S+)/;
/** 从拉起进程到打印出访问地址的等待上限。首次冷启动要装配整个 profile，给足时间。 */
const DEFAULT_START_TIMEOUT_MS = 90_000;
/** 先礼貌 SIGTERM，超时再 SIGKILL。 */
const DEFAULT_STOP_GRACE_MS = 4_000;
/** 日志文件超过该体积就在进程启动时截断重来，避免无限增长。 */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** 轮询服务器输出文件的间隔。150ms：够快（用户感觉不到延迟），又不至于把磁盘打热。 */
const OUTPUT_POLL_INTERVAL_MS = 150;
/** 单次最多读取的字节数，避免一次性读入超大输出。 */
const OUTPUT_READ_CHUNK_BYTES = 64 * 1024;

/**
 * 找到可执行的 dsh 启动脚本。
 *
 * 为什么要自己找：从 .desktop 启动的图形程序，PATH 只有
 * /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:...，并不包含 npm 全局 bin 目录
 * （本机是 ~/.npm-global/bin），直接 spawn('dsh') 会 ENOENT。
 *
 * @returns {string} dsh 可执行文件的绝对路径；实在找不到时退回裸名交给 PATH 解析。
 */
function resolveDshBinary() {
  const candidates = [];
  if (process.env.DSH_DESKTOP_DSH_BIN) candidates.push(process.env.DSH_DESKTOP_DSH_BIN);
  candidates.push(
    path.join(os.homedir(), '.npm-global', 'bin', 'dsh'),
    path.join(os.homedir(), '.local', 'bin', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh'
  );
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续试下一个候选路径
    }
  }
  return 'dsh';
}

/**
 * 找出包含 node 可执行文件的目录。
 *
 * dsh 启动脚本的 shebang 是 `#!/usr/bin/env node`，所以子进程的 PATH 里必须有 node。
 * 这里先看当前 PATH，再兜底常见目录。
 *
 * @returns {string | undefined} 目录路径，找不到时返回 undefined。
 */
function findNodeDir() {
  const dirs = [...(process.env.PATH ?? '').split(':'), '/usr/bin', '/usr/local/bin'].filter(Boolean);
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, 'node'), fs.constants.X_OK);
      return dir;
    } catch {
      // 继续找
    }
  }
  return undefined;
}

/**
 * 构造子进程环境变量：在继承当前环境的基础上，把 dsh 所在目录和 node 所在目录补进 PATH。
 *
 * @param {string} dshBinary - resolveDshBinary() 的结果。
 * @returns {NodeJS.ProcessEnv} 供 spawn 使用的环境变量副本。
 */
function buildChildEnv(dshBinary) {
  const extra = [];
  if (dshBinary.includes(path.sep)) extra.push(path.dirname(dshBinary));
  const nodeDir = findNodeDir();
  if (nodeDir) extra.push(nodeDir);
  const merged = [...extra, ...(process.env.PATH ?? '').split(':')].filter(Boolean);
  return { ...process.env, PATH: [...new Set(merged)].join(':') };
}

/**
 * 向「整个进程组」发信号，而不是只发给直接子进程，避免 dsh 派生的孙进程变成孤儿。
 *
 * @param {number} pid - 子进程 pid（detached 启动时它也是进程组组长）。
 * @param {NodeJS.Signals} signal - 要发送的信号。
 */
function signalProcessGroup(pid, signal) {
  // spawn 失败时 pid 可能是 undefined，这里挡一下，免得 process.kill(NaN) 抛错
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 进程可能已经退出，忽略
    }
  }
}

/**
 * 判断一个 pid 是否还活着、读它的命令行、核对它像不像本程序托管的 dsh web ——
 * 这三件事都由 lib/procinfo.js 提供（客户端登记表与公告模块也要用，三处必须同一套语义）。
 */

/**
 * 读取 pid 记录文件。
 *
 * 返回的是「当时那一份记录」的快照。调用方要停服务器时应当**只认这份快照**，
 * 不要中途再读一次文件：文件可能已经被新起的壳改写，再读一次就会去停别人刚起的服务。
 *
 * @param {string} pidFile - pid 记录文件路径。
 * @returns {{pid: number, shellPid: number, command: string, startedAt: string}|null} 记录内容；读不到或格式不对返回 null。
 */
function readServerRecord(pidFile) {
  try {
    const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    const pid = Number(record?.pid);
    if (!Number.isInteger(pid) || pid <= 1) return null;
    return {
      pid,
      shellPid: Number(record?.shellPid),
      command: typeof record?.command === 'string' ? record.command : '',
      startedAt: typeof record?.startedAt === 'string' ? record.startedAt : ''
    };
  } catch {
    return null;
  }
}

/**
 * 删除 pid 记录文件 —— 但只删「里面记的还是这个 pid」的那一份。
 *
 * 为什么要核对：记录文件是会被后来的壳覆盖重写的（它起了新服务器就会写自己的 pid）。
 * 无条件删除会把别人刚写的那份抹掉，那份记录是它退出时用来回收服务器的依据。
 *
 * @param {string} pidFile - pid 记录文件路径。
 * @param {number} pid - 期望文件里记录的 pid。
 * @returns {boolean} true 表示确实删除了。
 */
function removePidFileIfOwned(pidFile, pid) {
  try {
    const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    if (Number(record?.pid) !== pid) return false;
    fs.unlinkSync(pidFile);
    return true;
  } catch {
    return false; // 文件不在、坏了、或被别人改过：都不该影响主流程
  }
}

/**
 * 轮询等待某个 pid 消失。
 *
 * @param {number} pid - 进程号。
 * @param {number} timeoutMs - 最长等待时间。
 * @returns {Promise<boolean>} 已消失为 true，超时为 false。
 */
async function waitForProcessGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 按 pid 记录把一台「不是本进程起的」服务器停掉。
 *
 * 谁需要它：多窗口时，服务器是第一个壳起的，但最后退出的可能是另一个壳。
 * 那个壳手里没有子进程句柄，只能靠 pid 记录找到这台服务器 —— 也就是「最后一个走的人关灯」。
 *
 * 传入的是**已经读好的记录快照**，不是文件路径：从「决定要停它」到「真的动手」之间可能
 * 过去几秒（SIGTERM 宽限期），这期间可能已经有新壳起了自己的服务器并改写了记录文件；
 * 若那时再读一次文件，就会把别人刚起的服务杀掉。锁定目标只认快照。
 *
 * 安全闸门与残留清理一致：先核对命令行确实是本程序托管的 `dsh web`（防 pid 复用后误杀）。
 *
 * @param {{pid: number}} record - readServerRecord() 的结果。
 * @param {{pidFile?: string, writeLog?: (line: string) => void, graceMs?: number}} [options] - pid 记录路径、日志回调、SIGTERM 宽限期。
 * @returns {Promise<number | null>} 被停掉的 pid；没有可停的返回 null。
 */
async function stopRecordedServer(record, { pidFile, writeLog, graceMs = DEFAULT_STOP_GRACE_MS } = {}) {
  if (!record) return null;

  if (!isProcessAlive(record.pid)) {
    // 记录里的进程早没了：这份文件是垃圾，清掉即可
    if (pidFile) removePidFileIfOwned(pidFile, record.pid);
    return null;
  }

  const command = readProcessCmdline(record.pid);
  if (!looksLikeManagedDshWeb(command)) {
    writeLog?.(`pid 记录里的 ${record.pid} 不是本程序起的 dsh web，忽略（cmdline=${String(command)}）`);
    if (pidFile) removePidFileIfOwned(pidFile, record.pid);
    return null;
  }

  await terminateServer(record.pid, command, { pidFile, writeLog, graceMs });
  return record.pid;
}

/**
 * 停掉一个已核对身份的服务器进程组，并删掉它的 pid 记录。
 *
 * 先 SIGTERM 给机会优雅退出（dsh 要收尾自己的子进程），宽限期内没退再 SIGKILL。
 *
 * @param {number} pid - 服务器进程 pid（detached 启动，它也是进程组组长）。
 * @param {string | null} command - 已核对过的命令行（只用于日志）。
 * @param {{pidFile?: string, writeLog?: (line: string) => void, graceMs: number}} options - 日志回调与宽限期。
 * @returns {Promise<void>} 停止流程结束（无论进程是否真的退出都不抛错）。
 */
async function terminateServer(pid, command, { pidFile, writeLog, graceMs }) {
  writeLog?.(`停止服务器进程组 pid=${pid}（${String(command)}）：发送 SIGTERM`);
  signalProcessGroup(pid, 'SIGTERM');
  if (!(await waitForProcessGone(pid, graceMs))) {
    writeLog?.(`服务器 ${pid} 未在 ${graceMs} ms 内退出，改用 SIGKILL`);
    signalProcessGroup(pid, 'SIGKILL');
    await waitForProcessGone(pid, 2_000);
  }
  if (pidFile) removePidFileIfOwned(pidFile, pid);
}

/**
 * 「最后一刻」的兜底：同步把记录里的那台服务器杀掉（进程已经在退出流程里，没机会等待）。
 *
 * 什么时候用得上：最后一个窗口退出时，正常路径会给服务器发 SIGTERM 并等它收尾；
 * 但如果进程因为超时被强制结束（before-quit 里的强制定时器）或异常直接走到 exit，
 * 那次优雅停止就断了。此时只能补一记 SIGKILL，否则服务器会永久留在后台。
 *
 * 与 stopRecordedServer 一样只认快照，不重读文件 —— 理由同上（别杀掉别人刚起的服务）。
 *
 * @param {{pid: number}|null} record - readServerRecord() 的结果。
 * @param {{writeLog?: (line: string) => void}} [options] - 日志回调。
 * @returns {number | null} 被强杀的 pid；没有可杀的返回 null。
 */
function killRecordedServerSync(record, { writeLog } = {}) {
  if (!record || !isProcessAlive(record.pid)) return null;
  const command = readProcessCmdline(record.pid);
  if (!looksLikeManagedDshWeb(command)) return null;
  writeLog?.(`强制回收 pid 记录里的服务器进程组 ${record.pid}`);
  signalProcessGroup(record.pid, 'SIGKILL');
  return record.pid;
}

/**
 * 清理上一任桌面壳留下的服务器进程（启动时调用）。
 *
 * 四道闸门，缺一不可，目的是「宁可漏清，绝不误杀」：
 *   ① pid 记录里的进程还活着；
 *   ② 它的命令行确实是本程序起的 `dsh web ... --no-open ...`（排除 pid 被复用）；
 *   ③ 起它的那个壳（shellPid）已经不在了 —— 旧版记录的兼容闸门；
 *   ④ 登记表里没有别的活着的壳 —— 第四版新增，也是真正该问的问题：
 *      「还有没有窗口在用这台服务器」。有就绝不能碰（哪怕起它的壳已经退出）。
 *
 * 第 ④ 条为什么要单独存在：主壳退出后服务器会被有意保留（副窗口还在用），
 * 此时若公告文件被删掉或损坏，新开的壳会以为「没有可用服务器」而重新起一个，
 * 顺手把副窗口正在用的那台当残留清掉 —— 那就把多窗口的修复又打回去了。
 *
 * @param {string} pidFile - pid 记录文件路径。
 * @param {{writeLog?: (line: string) => void, graceMs?: number, hasOtherClients?: boolean}} [options]
 *   日志回调、SIGTERM 宽限期，以及「除自己之外还有没有活着的壳」（由调用方查登记表后传入）。
 * @returns {Promise<number | null>} 被清理掉的 pid；没有需要清理的返回 null。
 */
async function reapStaleServer(pidFile, { writeLog, graceMs = DEFAULT_STOP_GRACE_MS, hasOtherClients = false } = {}) {
  const record = readServerRecord(pidFile);
  if (!record) return null; // 没有记录文件（首次运行），或文件坏了：都没什么可清的

  const pid = record.pid;
  if (!isProcessAlive(pid)) {
    removePidFileIfOwned(pidFile, pid);
    return null;
  }

  const command = readProcessCmdline(pid);
  if (!looksLikeManagedDshWeb(command)) {
    writeLog?.(`pid 记录里的 ${pid} 不是本程序起的 dsh web，忽略（cmdline=${String(command)}）`);
    removePidFileIfOwned(pidFile, pid);
    return null;
  }

  if (isProcessAlive(record.shellPid)) {
    writeLog?.(`pid 记录属于仍在运行的壳（shellPid=${record.shellPid}），跳过清理`);
    return null;
  }

  if (hasOtherClients) {
    writeLog?.('还有别的窗口在使用这台服务器，跳过清理');
    return null;
  }

  writeLog?.(`清理上次残留的服务器进程组 pid=${pid}（${String(command)}）`);
  await terminateServer(pid, command, { pidFile, writeLog, graceMs });
  return pid;
}

/**
 * 等待子进程真正退出。
 *
 * @param {import('node:child_process').ChildProcess} child - 子进程。
 * @param {number} timeoutMs - 最长等待时间。
 * @returns {Promise<boolean>} 已退出为 true，超时为 false。
 */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

class DshServer {
  /**
   * @param {object} options - 构造参数。
   * @param {number} [options.port] - 监听端口；0 表示交给系统挑一个空闲端口。
   * @param {string} [options.profile] - dsh profile 名；缺省用 `web`。
   * @param {string} [options.logFile] - 服务器输出追加写入的日志文件。
   * @param {string} [options.pidFile] - 记录子进程 pid 的文件，用于下次启动清理残留、以及「最后一个窗口」按记录停服务器。
   * @param {() => boolean} [options.hasOtherClients] - 除本壳之外还有没有别的壳在用服务器（查登记表）。
   *   缺省 `() => true`：拿不准时按「有别人在用」处理 —— 漏清一次残留只是多占一份内存，
   *   误杀别人正在用的服务器却会让用户正在看的窗口直接失效，两者代价不对等。
   * @param {(line: string) => void} [options.onLog] - 每收到一行输出时的回调（用于主进程日志）。
   * @param {(pid: number) => void} [options.onSpawn] - 子进程刚 fork 出来时的回调（此时 pid 已可用）。
   * @param {(info: {code: number|null, signal: string|null, expected: boolean}) => void} [options.onExit] - 退出回调。
   */
  constructor({ port = 0, profile, logFile, pidFile, hasOtherClients, onLog, onSpawn, onExit } = {}) {
    this.port = port;
    this.profile = profile;
    this.logFile = logFile;
    this.pidFile = pidFile;
    this.hasOtherClients = typeof hasOtherClients === 'function' ? hasOtherClients : () => true;
    this.onLog = onLog;
    this.onSpawn = onSpawn;
    this.onExit = onExit;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {string | null} 浏览器可直接使用、携带 token 的地址。 */
    this.url = null;
    /** 停止流程中的标记，用来区分「我们主动关的」和「它自己崩了」。 */
    this.expectedExit = false;
    /** 当前 pid 文件里记的是哪个 pid，删除时用来确认「这文件是我写的」。 */
    this.pidFilePid = null;
    /** 读取服务器输出用的文件描述符（poll 用），null 表示没在监听。 */
    this.watchReadFd = null;
    /** 已经读到输出文件的哪个字节位置。 */
    this.watchOffset = 0;
    /** 尚未拼成完整一行的尾部内容（输出可能被读操作从中间截断）。 */
    this.watchBuffer = '';
    /** 轮询输出文件的定时器。 */
    this.watchTimer = null;
    /** 服务器的输出文件是否就是主日志文件（不是的话，解析到的行要抄一份进主日志）。 */
    this.sinkIsLogFile = false;
  }

  /** @returns {boolean} 服务器是否正在运行。 */
  get running() {
    return this.child !== null && this.child.exitCode === null;
  }

  /** @returns {number | null} 服务器进程 pid。 */
  get pid() {
    return this.child?.pid ?? null;
  }

  /**
   * 启动 `dsh web`，并等到它输出可访问地址。
   *
   * @param {{timeoutMs?: number}} [options] - 覆盖默认等待上限（测试用）。
   * @returns {Promise<string>} 携带 token 的浏览器访问地址。
   */
  async start({ timeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
    if (this.child) throw new Error('dsh 服务器已在运行，不能重复启动');

    // 起新的之前，先把上一任壳被强杀时留下的残留清掉（正常退出时这里无事可做）。
    // 「还有没有别的窗口在用」由登记表回答，交给回收逻辑当闸门用。
    await reapStaleServer(this.pidFile, {
      writeLog: (line) => this.writeLog(line),
      hasOtherClients: this.hasOtherClients()
    });

    const dshBinary = resolveDshBinary();
    const args = this.profile
      ? ['--profile', this.profile, '--no-open', '--port', String(this.port)]
      : ['web', '--no-open', '--port', String(this.port)];
    this.expectedExit = false;
    this.rotateLogIfNeeded();

    // 服务器的输出直接落到文件（不再接管道）。理由见文件头第 3b 条：
    // 管道会在壳退出时断裂，服务器下次写 stdout 就 EPIPE 自杀，副窗口随之断连。
    const sink = this.openOutputSink();

    const child = spawn(dshBinary, args, {
      cwd: os.homedir(),
      env: buildChildEnv(dshBinary),
      detached: true,
      // stdin 断开：避免 dsh 误以为是交互式终端而改变行为；
      // stdout/stderr 直接写日志文件：壳退出后服务器不再被任何管道牵着。
      stdio: ['ignore', sink.fd, sink.fd]
    });
    // 子进程已经拿到自己的文件描述符副本，父进程这份不再需要（否则每起一次漏一个 fd）
    try {
      fs.closeSync(sink.fd);
    } catch {
      // 关不掉也无所谓
    }
    this.child = child;
    this.pidFilePid = child.pid ?? null;
    this.writePidFile(child.pid, [dshBinary, ...args].join(' '));
    this.writeLog(`启动 dsh 服务器：${dshBinary} ${args.join(' ')}（pid=${child.pid ?? '未知'}）`);
    this.onSpawn?.(child.pid);

    // 就绪地址从输出文件里读（等价于原来「读 stdout」的活，换了个不会断的载体）
    this.watchOutput(sink);

    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {NodeJS.Timeout | undefined} 就绪等待定时器，稍后赋值。 */
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };

      timer = setTimeout(() => {
        this.writeLog(`等待服务器就绪超时（${timeoutMs} ms），放弃启动`);
        void this.stop();
        finish(new Error(`等待 dsh 服务器就绪超时（${timeoutMs} ms）`));
      }, timeoutMs);

      // 地址行在 stdout 处理里被解析出来后，通过这个回调交付结果
      this.pendingResolve = (url) => finish(undefined, url);
      this.pendingReject = (error) => finish(error);

      child.once('error', (error) => {
        this.writeLog(`无法启动 dsh：${error.message}`);
        this.child = null;
        this.clearPidFile();
        this.pendingReject?.(new Error(`无法启动 dsh（${dshBinary}）：${error.message}`));
      });

      child.once('exit', (code, signal) => {
        const expected = this.expectedExit;
        this.writeLog(`服务器进程退出（code=${String(code)} signal=${String(signal)} expected=${String(expected)}）`);
        this.child = null;
        this.url = null;
        this.clearPidFile();
        this.stopWatchingOutput();
        this.pendingReject?.(new Error(`dsh 服务器在就绪前退出（code=${String(code)} signal=${String(signal)}）`));
        this.onExit?.({ code, signal, expected });
      });
    });
  }

  /**
   * 打开「服务器输出落盘」的目标文件。
   *
   * 首选日志文件（就是应用菜单「查看服务器日志」打开的那份，用户点开就能看到服务器自己的输出）。
   * 万一它不可写（磁盘满、权限异常），退回系统临时目录下的一份文件 ——
   * 关键是**绝不能退回管道**：宁可日志写到别处，也不能让服务器被壳的生死牵着。
   *
   * @returns {{fd: number, file: string|null, offset: number}} 文件描述符、路径（退回临时文件时会不同）、起始偏移。
   */
  openOutputSink() {
    /** @type {string[]} */
    const candidates = [];
    if (this.logFile) candidates.push(this.logFile);
    candidates.push(path.join(os.tmpdir(), `dsh-desktop-server-${process.pid}.log`));

    for (const file of candidates) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = fs.openSync(file, 'a', 0o600);
        const offset = fs.fstatSync(fd).size;
        this.sinkIsLogFile = Boolean(this.logFile) && file === this.logFile;
        if (!this.sinkIsLogFile) this.writeLog(`服务器输出改写到备用文件：${file}`);
        return { fd, file, offset };
      } catch {
        // 换下一个候选
      }
    }

    // 两个都打不开：只能丢弃输出（此时也拿不到就绪地址，会在超时后报错退出，属于极端故障）
    this.writeLog('无法打开服务器输出文件，本次服务器输出将被丢弃');
    return { fd: fs.openSync(os.devNull, 'a'), file: null, offset: 0 };
  }

  /**
   * 开始监听服务器输出文件，从中解析就绪地址。
   *
   * 用轮询而不是 fs.watch：watch 在不同文件系统/编辑器场景下会漏事件或重复触发，
   * 而这里只需要「启动后几十秒内看到一行」，150ms 轮询简单、可预测、跨平台一致。
   *
   * @param {{fd: number, file: string|null, offset: number}} sink - openOutputSink() 的结果。
   */
  watchOutput(sink) {
    if (!sink.file) return;
    try {
      this.watchReadFd = fs.openSync(sink.file, 'r');
    } catch (error) {
      this.writeLog(`无法读取服务器输出文件：${String(error)}`);
      return;
    }
    this.watchOffset = sink.offset;
    this.watchBuffer = '';
    // unref：这个定时器只是「顺便读读日志」，绝不该拖住应用退出
    this.watchTimer = setInterval(() => this.drainOutput(), OUTPUT_POLL_INTERVAL_MS);
    this.watchTimer.unref?.();
  }

  /**
   * 读一次输出文件的增量，按行交给 handleOutputLine。
   *
   * 三种情况都要照顾到：
   *   · 没有新内容 → 直接返回（绝大多数轮次都是这样）；
   *   · 读到半行 → 拼到缓冲区里，等下一轮补全（不能把半行当一行解析）；
   *   · 文件被截断（日志轮转）→ offset 已经超过文件大小，重置到 0 重新读。
   */
  drainOutput() {
    const fd = this.watchReadFd;
    if (fd === null) return;
    try {
      const size = fs.fstatSync(fd).size;
      if (size < this.watchOffset) {
        this.watchOffset = 0;
        this.watchBuffer = '';
      }
      if (size <= this.watchOffset) return;

      const length = Math.min(size - this.watchOffset, OUTPUT_READ_CHUNK_BYTES);
      const buffer = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buffer, 0, length, this.watchOffset);
      this.watchOffset += read;
      this.watchBuffer += buffer.subarray(0, read).toString('utf8');

      let index = this.watchBuffer.indexOf('\n');
      while (index >= 0) {
        const line = this.watchBuffer.slice(0, index).replace(/\r$/, '');
        this.watchBuffer = this.watchBuffer.slice(index + 1);
        this.handleOutputLine(line);
        index = this.watchBuffer.indexOf('\n');
      }

      // 万一服务器吐了一行超长内容（没有换行），别让它把内存撑起来
      if (this.watchBuffer.length > OUTPUT_READ_CHUNK_BYTES) {
        this.watchBuffer = this.watchBuffer.slice(-4096);
      }
    } catch {
      // 读失败就先不管，下一轮再试（文件可能正被截断或临时不可读）
    }
  }

  /** 停止监听输出文件并释放资源（停止服务器、进程退出时调用）。 */
  stopWatchingOutput() {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watchReadFd !== null) {
      try {
        fs.closeSync(this.watchReadFd);
      } catch {
        // 关不掉也无所谓
      }
      this.watchReadFd = null;
    }
    this.watchBuffer = '';
  }

  /**
   * 停掉服务器：先 SIGTERM 整个进程组，宽限期过后 SIGKILL。
   *
   * @param {{graceMs?: number}} [options] - 覆盖宽限期（测试用）。
   * @returns {Promise<void>} 停止流程结束（无论进程是否真的退出都不抛错）。
   */
  async stop({ graceMs = DEFAULT_STOP_GRACE_MS } = {}) {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;
    this.writeLog(`停止服务器（pid=${child.pid ?? '未知'}）：发送 SIGTERM`);
    signalProcessGroup(child.pid, 'SIGTERM');
    const exited = await waitForExit(child, graceMs);
    if (!exited) {
      this.writeLog(`服务器 ${graceMs} ms 内未退出，改用 SIGKILL 强制结束`);
      signalProcessGroup(child.pid, 'SIGKILL');
      await waitForExit(child, 2_000);
    }
    this.child = null;
    this.clearPidFile();
    this.stopWatchingOutput();
  }

  /**
   * 处理一行服务器输出：尝试解析访问地址（顺便转发给 onLog 消费者）。
   *
   * 注意这里**不再把原始行写进日志**：第四版起服务器的 stdout/stderr 本来就指向日志文件，
   * 输出是它自己写进去的；这里再写一遍就会每行重复两次。
   * 只有「输出被迫改到备用文件」时才需要抄一份进主日志，方便用户在一个地方看全。
   *
   * @param {string} line - 原始输出行。
   */
  handleOutputLine(line) {
    if (!this.sinkIsLogFile) this.writeLog(line);
    this.onLog?.(line);
    const match = URL_PATTERN.exec(line);
    if (!match || this.url) return;
    this.url = match[1];
    this.writeLog(`已获得访问地址：${this.url.replace(/token=[^&]+/, 'token=***')}`);
    const resolvePending = this.pendingResolve;
    this.pendingResolve = undefined;
    this.pendingReject = undefined;
    resolvePending?.(this.url);
  }

  /**
   * 写 pid 记录文件。
   *
   * 除了子进程 pid，还记下壳自己的 pid：下次启动清理残留时用它判断
   * 「拥有这个服务器的壳是否还在」，避免把并行运行的另一个壳的服务器杀掉。
   *
   * @param {number | undefined} pid - 子进程 pid。
   * @param {string} command - 实际执行的完整命令行（清理时用来核对身份）。
   */
  writePidFile(pid, command) {
    if (!this.pidFile || !Number.isInteger(pid)) return;
    try {
      fs.mkdirSync(path.dirname(this.pidFile), { recursive: true });
      const record = {
        version: 1,
        pid,
        shellPid: process.pid,
        command,
        startedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.pidFile, `${JSON.stringify(record, null, 2)}\n`);
    } catch (error) {
      this.writeLog(`写 pid 记录失败：${String(error)}`);
    }
  }

  /**
   * 删除 pid 记录文件。
   * 只删「确实是自己写的那份」：否则可能把接管期间另一个实例的记录抹掉。
   */
  clearPidFile() {
    if (!this.pidFile || this.pidFilePid === null) return;
    try {
      const record = JSON.parse(fs.readFileSync(this.pidFile, 'utf8'));
      if (Number(record?.pid) !== this.pidFilePid) return;
      fs.unlinkSync(this.pidFile);
    } catch {
      // 文件不在了、或被别人改了：都不该影响主流程
    }
    this.pidFilePid = null;
  }

  /**
   * 写服务器日志文件；文件过大时先截断，保证日志长期可用又不会撑爆磁盘。
   *
   * @param {string} text - 日志正文。
   */
  writeLog(text) {
    if (!this.logFile) return;
    try {
      const stamp = new Date().toISOString();
      fs.appendFileSync(this.logFile, `[${stamp}] ${text}\n`);
    } catch {
      // 日志写不进去不能影响主流程
    }
  }

  /** 进程启动前检查日志体积，超过阈值就清空重来。 */
  rotateLogIfNeeded() {
    if (!this.logFile) return;
    try {
      const stat = fs.statSync(this.logFile);
      if (stat.size > LOG_ROTATE_BYTES) fs.truncateSync(this.logFile, 0);
    } catch {
      // 文件不存在是正常情况
    }
  }
}

module.exports = {
  DshServer,
  resolveDshBinary,
  URL_PATTERN,
  signalProcessGroup,
  reapStaleServer,
  readServerRecord,
  removePidFileIfOwned,
  stopRecordedServer,
  killRecordedServerSync
};
