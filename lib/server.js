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
 * 4. `--no-open` 阻止 dsh 自己再去拉起系统浏览器（否则会出现两个窗口）。
 *
 * 5. 子进程 pid 会写进 pidFile（默认 ~/.dsh-desktop/server.pid）。为什么需要它：
 *    上面那套「按进程组杀」只在壳自己有机会执行收尾时有效。壳被 kill -9、崩溃、
 *    或者注销时没来得及收尾，detached 的子进程就会被 init 收养、永久留在后台 ——
 *    用户看到的正是「壳关了，后台服务还在跑」。所以每次启动前先读这个文件，
 *    确认那确实是「上一任壳留下的 dsh web」之后，把它收拾干净。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

/** stdout 中访问地址行的固定前缀。 */
const URL_PATTERN = /\bdsh web:\s+(https?:\/\/\S+)/;
/** 从拉起进程到打印出访问地址的等待上限。首次冷启动要装配整个 profile，给足时间。 */
const DEFAULT_START_TIMEOUT_MS = 90_000;
/** 先礼貌 SIGTERM，超时再 SIGKILL。 */
const DEFAULT_STOP_GRACE_MS = 4_000;
/** 日志文件超过该体积就在进程启动时截断重来，避免无限增长。 */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

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
 * 判断一个 pid 是否还活着。
 *
 * @param {number} pid - 进程号。
 * @returns {boolean} 存活（含僵尸态与无权限探测）为 true。
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在、只是没权限给它发信号；ESRCH 才是真的没了
    return error?.code === 'EPERM';
  }
}

/**
 * 读取进程的命令行。Linux 下 /proc/<pid>/cmdline 用 \0 分隔参数。
 *
 * @param {number} pid - 进程号。
 * @returns {string | null} 以空格连接的完整命令行；读不到返回 null。
 */
function readProcessCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return null;
  }
}

/**
 * 命令行是否长得像「本程序托管的 dsh web」。
 * 这是清理残留时的安全闸门：pid 会被系统复用，光看 pid 就动手可能误杀别人的进程。
 *
 * @param {string | null} command - 完整命令行。
 * @returns {boolean} 是的话才允许清理。
 */
function looksLikeManagedDshWeb(command) {
  if (!command) return false;
  return command.includes('dsh') && command.includes('--no-open') && /\bweb\b/.test(command);
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

/** 删除 pid 记录文件（不存在也无所谓）。 */
function removePidFile(pidFile) {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // 文件本来就不在，正常
  }
}

/**
 * 清理上一任桌面壳留下的服务器进程（启动时调用）。
 *
 * 三道闸门，缺一不可，目的是「宁可漏清，绝不误杀」：
 *   ① pid 记录里的进程还活着；
 *   ② 它的命令行确实是本程序起的 `dsh web ... --no-open ...`（排除 pid 被复用）；
 *   ③ 记录里的壳进程已经不在了（壳还在就说明那是它在用的服务器，不能碰）。
 *
 * @param {string} pidFile - pid 记录文件路径。
 * @param {{writeLog?: (line: string) => void, graceMs?: number}} [options] - 日志回调与 SIGTERM 宽限期。
 * @returns {Promise<number | null>} 被清理掉的 pid；没有需要清理的返回 null。
 */
async function reapStaleServer(pidFile, { writeLog, graceMs = DEFAULT_STOP_GRACE_MS } = {}) {
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  } catch {
    return null; // 没有记录文件（首次运行），或文件坏了：都没什么可清的
  }

  const pid = Number(record?.pid);
  const shellPid = Number(record?.shellPid);
  if (!isProcessAlive(pid)) {
    removePidFile(pidFile);
    return null;
  }

  const command = readProcessCmdline(pid);
  if (!looksLikeManagedDshWeb(command)) {
    writeLog?.(`pid 记录里的 ${pid} 不是本程序起的 dsh web，忽略（cmdline=${String(command)}）`);
    removePidFile(pidFile);
    return null;
  }

  if (isProcessAlive(shellPid)) {
    writeLog?.(`pid 记录属于仍在运行的壳（shellPid=${shellPid}），跳过清理`);
    return null;
  }

  writeLog?.(`清理上次残留的服务器进程组 pid=${pid}（${String(command)}）`);
  signalProcessGroup(pid, 'SIGTERM');
  if (!(await waitForProcessGone(pid, graceMs))) {
    writeLog?.(`残留进程 ${pid} 未在 ${graceMs} ms 内退出，改用 SIGKILL`);
    signalProcessGroup(pid, 'SIGKILL');
    await waitForProcessGone(pid, 2_000);
  }
  removePidFile(pidFile);
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
   * @param {string} [options.pidFile] - 记录子进程 pid 的文件，用于下次启动清理残留。
   * @param {(line: string) => void} [options.onLog] - 每收到一行输出时的回调（用于主进程日志）。
   * @param {(pid: number) => void} [options.onSpawn] - 子进程刚 fork 出来时的回调（此时 pid 已可用）。
   * @param {(info: {code: number|null, signal: string|null, expected: boolean}) => void} [options.onExit] - 退出回调。
   */
  constructor({ port = 0, profile, logFile, pidFile, onLog, onSpawn, onExit } = {}) {
    this.port = port;
    this.profile = profile;
    this.logFile = logFile;
    this.pidFile = pidFile;
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
   * 启动 `dsh web`，并等到它打印出可访问地址。
   *
   * @param {{timeoutMs?: number}} [options] - 覆盖默认等待上限（测试用）。
   * @returns {Promise<string>} 携带 token 的浏览器访问地址。
   */
  async start({ timeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
    if (this.child) throw new Error('dsh 服务器已在运行，不能重复启动');

    // 起新的之前，先把上一任壳被强杀时留下的残留清掉（正常退出时这里无事可做）
    await reapStaleServer(this.pidFile, { writeLog: (line) => this.writeLog(line) });

    const dshBinary = resolveDshBinary();
    const args = this.profile
      ? ['--profile', this.profile, '--no-open', '--port', String(this.port)]
      : ['web', '--no-open', '--port', String(this.port)];
    this.expectedExit = false;
    this.rotateLogIfNeeded();

    const child = spawn(dshBinary, args, {
      cwd: os.homedir(),
      env: buildChildEnv(dshBinary),
      detached: true,
      // stdin 断开：避免 dsh 误以为是交互式终端而改变行为
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    this.pidFilePid = child.pid ?? null;
    this.writePidFile(child.pid, [dshBinary, ...args].join(' '));
    this.writeLog(`启动 dsh 服务器：${dshBinary} ${args.join(' ')}（pid=${child.pid ?? '未知'}）`);
    this.onSpawn?.(child.pid);

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on('line', (line) => this.handleOutputLine(line));
    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on('line', (line) => this.handleOutputLine(line));

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
        this.pendingReject?.(new Error(`dsh 服务器在就绪前退出（code=${String(code)} signal=${String(signal)}）`));
        this.onExit?.({ code, signal, expected });
      });
    });
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
  }

  /**
   * 处理一行服务器输出：写日志，并尝试解析访问地址。
   *
   * @param {string} line - 原始输出行。
   */
  handleOutputLine(line) {
    this.writeLog(line);
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

module.exports = { DshServer, resolveDshBinary, URL_PATTERN, signalProcessGroup, reapStaleServer };
