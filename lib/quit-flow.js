'use strict';

/**
 * 退出判定与收尾 —— 第四版「最后一个窗口退出才停后台服务」的落点。
 *
 * 为什么单独一个文件：
 *   这套语义（谁在用服务器、该不该回收、怎么回收不是自己起的那台）是整个桌面壳里最容易改错、
 *   也最需要被反复阅读的一段。原先它散在 main.js 的 before-quit、process.on('exit') 两处，
 *   中间还夹着窗口状态保存、强制定时器等与「判定」无关的代码，读起来很费劲。
 *   抽出来之后，main.js 只负责把 Electron 的事件接过来，判定逻辑集中在这里。
 *
 * 本模块**不认识 Electron**，也不认识窗口与菜单，只依赖三样东西：
 *   · 客户端登记表（lib/clients.js）—— 回答「还有几个窗口在用」；
 *   · 地址公告（lib/endpoint.js）—— 最后一个窗口退出时要撤掉；
 *   · pid 记录与服务器停止（lib/server.js）—— 服务器是自己起的就停子进程，是别人起的就按记录停。
 *
 * 心智模型（第四版）：**服务器不属于任何窗口，它属于「当前打开着的这些窗口」**。
 *   · 还有别的窗口在用 → 服务器进程、地址公告、pid 记录一律不动；
 *   · 一个都不剩       → 先撤公告（免得后来者连死地址），再停服务器。
 *
 * 两个刻意为之的细节，改动前请先读：
 *   1. 判定前必须先把**自己**从登记表里摘掉，否则永远「还有别人在用」，最后一个窗口不肯关灯；
 *   2. 要回收的目标（pid 记录快照）在判定时读一次就锁定，之后不再重读文件 ——
 *      停止流程要等 SIGTERM 宽限期（最多 6 秒），中途可能有新壳起了自己的服务器并改写记录，
 *      重读就会把别人刚起的服务杀掉。
 */

const { registerClient, unregisterClient, countOtherClients } = require('./clients');
const { removeEndpoint } = require('./endpoint');
const {
  readServerRecord,
  stopRecordedServer,
  killRecordedServerSync,
  signalProcessGroup
} = require('./server');

class QuitFlow {
  /**
   * @param {object} options - 构造参数。
   * @param {string} options.clientsDir - 客户端登记表目录（谁在用服务器）。
   * @param {string} options.endpointFile - 服务器地址公告文件路径。
   * @param {string} options.serverPidFile - 服务器 pid 记录文件路径。
   * @param {(text: string) => void} options.log - 写桌面壳日志的回调。
   * @param {() => boolean} options.hasOwnedServer - 本壳是否正托管着一台服务器（有子进程句柄且在跑）。
   * @param {() => Promise<void>} options.stopOwnedServer - 停掉本壳托管的那台服务器。
   * @param {() => (number|null)} options.getLastServerPid - 本壳起的服务器 pid（同步兜底强杀时用）。
   * @param {() => boolean} options.isReplica - 本壳是否为「复用别人服务器」的模式（没有自己起的服务器）。
   */
  constructor({
    clientsDir,
    endpointFile,
    serverPidFile,
    log,
    hasOwnedServer,
    stopOwnedServer,
    getLastServerPid,
    isReplica
  }) {
    this.clientsDir = clientsDir;
    this.endpointFile = endpointFile;
    this.serverPidFile = serverPidFile;
    this.log = typeof log === 'function' ? log : () => {};
    this.hasOwnedServer = hasOwnedServer;
    this.stopOwnedServer = stopOwnedServer;
    this.getLastServerPid = getLastServerPid;
    this.isReplica = isReplica;
    /** 本壳 pid（登记表里的键）。 */
    this.pid = process.pid;
    /** 本壳是否还登记在册（避免重复注销）。 */
    this.registered = false;
    /** 退出判定是否已经跑过（决定同步兜底要不要重新读 pid 记录）。 */
    this.decided = false;
    /** 判定结果：本壳是不是最后一个使用者。 */
    this.isLastClient = false;
    /** 判定时锁定的回收目标（pid 记录快照），只在「最后一个使用者」时有值。 */
    this.targetRecord = null;
  }

  /**
   * 启动时登记「我在用这台服务器」。
   *
   * 必须早于任何退出判定：此刻可能正有别的窗口在退出，它按这份名单决定服务器留不留；
   * 晚登记一步，就会被它当成「没人用了」，把服务器连同我们即将加载的地址一起收走。
   *
   * @returns {boolean} true 表示登记成功（失败也继续跑，只是别的窗口可能提前回收服务）。
   */
  registerSelf() {
    this.registered = registerClient(this.clientsDir, this.pid);
    return this.registered;
  }

  /**
   * 摘掉自己的登记。重复调用无害（退出流程里可能被调用两次）。
   *
   * @returns {boolean} true 表示确实删掉了一份登记。
   */
  unregisterSelf() {
    if (!this.registered) return false;
    this.registered = false;
    return unregisterClient(this.clientsDir, this.pid);
  }

  /**
   * 除自己之外还有几个窗口在用服务器。
   *
   * 注意：只有当自己已经从登记表摘掉之后，这个数字才是「别人」的数量。
   *
   * @returns {number} 其余活着的窗口数量。
   */
  countOthers() {
    return countOtherClients(this.clientsDir, { excludePid: this.pid });
  }

  /**
   * 退出判定 + 收尾（before-quit 里调用）。
   *
   * @returns {Promise<{isLastClient: boolean, others: number}>} 判定结果（供日志与兜底路径参考）。
   */
  async run() {
    this.unregisterSelf();
    const others = this.countOthers();
    this.isLastClient = others === 0;
    this.decided = true;

    if (!this.isLastClient) {
      this.log(`退出判定：另有 ${others} 个窗口在使用后台服务，保留服务器（本窗口不再持有它）`);
      return { isLastClient: false, others };
    }

    this.log('退出判定：本窗口是最后一个使用者，回收后台服务');
    // 先撤公告再停服务器：反过来的话，公告会在服务器已死的窗口期里仍然指向那个地址，
    // 这时新开的壳会复用一个连不上的地址。
    if (removeEndpoint(this.endpointFile)) this.log('已撤下服务器地址公告');

    // 目标在这里读一次就固定下来（快照）。理由见文件头第 2 条。
    this.targetRecord = readServerRecord(this.serverPidFile);
    await this.stopTarget();
    return { isLastClient: true, others: 0 };
  }

  /**
   * 回收该回收的那台服务器。
   *
   * 两种情形：
   *   · 本壳托管着它 → 停子进程（pid 记录也随之清掉）；
   *   · 不是本壳起的（本壳只是复用了地址）→ 按 pid 记录核对身份后停进程组。
   *     第四版新增的能力：副本也可能成为最后一个使用者，那时它必须能关灯。
   *
   * @returns {Promise<void>} 收尾结束。
   */
  async stopTarget() {
    if (this.hasOwnedServer()) {
      await this.stopOwnedServer();
      return;
    }
    const stopped = await stopRecordedServer(this.targetRecord, {
      pidFile: this.serverPidFile,
      writeLog: (line) => this.log(`[服务器] ${line}`)
    });
    if (stopped !== null) this.log(`已按 pid 记录停掉非本窗口启动的服务器（pid=${stopped}）`);
  }

  /**
   * 同步兜底：进程直接走到 exit（before-quit 没跑完、被强制定时器砍掉）时把服务器收掉。
   *
   * 能走到这里的场景已经没机会优雅停机了，只能 SIGKILL。判据与 run() 完全一致 ——
   * 这一条很重要：若这里仍旧按「我是不是主实例」补刀，就会把「主壳退出、副本还在用」的服务再杀一次。
   *
   * @returns {void}
   */
  runSyncFallback() {
    this.unregisterSelf();

    if (this.countOthers() > 0) {
      this.log('进程退出：仍有其他窗口在使用后台服务，服务器与地址公告都保留');
      return;
    }

    // 公告也要撤：否则被 kill -9 的壳会留下一个指向死地址的公告，
    // 下一个壳读到它就会去连一个不存在的服务器。
    removeEndpoint(this.endpointFile);

    // 自己起的服务器：直接对进程组补一刀（stopOwnedServer 没跑完时的兜底）
    const lastServerPid = this.getLastServerPid();
    if (lastServerPid !== null) {
      this.log(`进程直接退出，强制回收服务器进程组 ${lastServerPid}`);
      signalProcessGroup(lastServerPid, 'SIGKILL');
      return;
    }

    // 复用者的兜底：服务器是别人起的，按 pid 记录动手。
    // 记录优先用判定时的快照；判定压根没跑过（进程异常直接退出）时现读一次。
    if (!this.isReplica()) return;
    const record = this.decided ? this.targetRecord : readServerRecord(this.serverPidFile);
    killRecordedServerSync(record, { writeLog: this.log });
  }
}

module.exports = { QuitFlow };
