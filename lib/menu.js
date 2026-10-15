'use strict';

/**
 * 应用菜单 —— 用户唯一能直接指挥「服务器」的地方。
 *
 * 为什么单独一个文件：
 *   菜单项**随窗口模式变化**：副窗口手里没有服务器（它的服务器是别的窗口起的），
 *   给它「重启服务器」只会另起一个属于它自己的服务 —— 换端口、换 token，
 *   把别的窗口脚下的地板抽走。这个「哪些项能给、哪些不能给」的分支值得集中放，
 *   也让 main.js 少一大块纯 UI 描述。
 *
 * 第四版顺带修正了退出项的文案：关掉一个窗口不再等于停掉后台服务，
 * 只有最后一个窗口退出时才回收，所以两种模式共用同一句文案（旧文案在新语义下是错的）。
 */

const { Menu, dialog, shell } = require('electron');

/**
 * 构建并安装应用菜单。
 *
 * @param {object} options - 构造参数。
 * @param {boolean} options.replica - 是否为「复用别人服务器」的副窗口。
 * @param {string} options.appDir - 数据目录（菜单里「打开数据目录」用）。
 * @param {string} options.logFile - 服务器日志文件路径（菜单里「查看服务器日志」用）。
 * @param {(text: string) => void} options.log - 写桌面壳日志的回调。
 * @param {object} options.actions - 菜单项要触发的动作。
 * @param {() => void} options.actions.showWindow - 显示并聚焦窗口。
 * @param {() => (string|null)} options.actions.currentAccessUrl - 取当前可访问地址。
 * @param {() => Promise<void>} options.actions.restartServer - 重启服务器（仅主窗口提供）。
 * @param {() => void} options.actions.reloadWindow - 重新加载本窗口界面（仅副窗口提供）。
 * @param {() => void} options.actions.quit - 退出本窗口。
 * @returns {void}
 */
function buildAppMenu({ replica, appDir, logFile, log, actions }) {
  /**
   * 用系统默认程序打开一个路径（日志、数据目录）。
   *
   * @param {string} target - 文件或目录路径。
   */
  const openExternally = (target) => {
    shell.openPath(target).then((error) => {
      if (error) log?.(`打开 ${target} 失败：${error}`);
    });
  };

  /** 在系统浏览器里打开当前服务器地址；服务器已停时给一句明确提示，而不是静默失败。 */
  const openInBrowser = () => {
    const url = actions.currentAccessUrl();
    if (url) {
      void shell.openExternal(url);
      return;
    }
    void dialog.showMessageBox({
      type: 'info',
      message: '服务器已停止，没有可打开的地址。',
      buttons: ['好']
    });
  };

  /** @type {Electron.MenuItemConstructorOptions[]} 与服务器相关的菜单项，两种模式不同。 */
  const serverItems = replica
    ? [
        { label: '在浏览器中打开当前地址', click: openInBrowser },
        // 副窗口的服务器是别人的：这里只能做「只作用于本窗口」的事
        { label: '重新加载界面', click: () => actions.reloadWindow() }
      ]
    : [
        { label: '在浏览器中打开当前地址', click: openInBrowser },
        { label: '重启服务器', click: () => void actions.restartServer() }
      ];

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'DSH',
        submenu: [
          { label: '显示窗口', accelerator: 'CmdOrCtrl+Shift+D', click: () => actions.showWindow() },
          ...serverItems,
          { type: 'separator' },
          { label: '查看服务器日志', click: () => openExternally(logFile) },
          { label: '打开数据目录', click: () => openExternally(appDir) },
          { type: 'separator' },
          {
            // 文案说明（第四版）：关掉本窗口不再等于停掉后台服务 —— 只要还有别的窗口在用，
            // 服务就继续跑；只有最后一个窗口退出时才回收。两种模式语义相同，所以不再分两套文案。
            label: '退出（最后一个窗口退出时才停后台服务）',
            accelerator: 'CmdOrCtrl+Q',
            click: () => actions.quit()
          }
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

module.exports = { buildAppMenu };
