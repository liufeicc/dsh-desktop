#!/usr/bin/env bash
# 把 DSH 桌面版注册成系统里的一个正常应用：
#   1. 生成图标；
#   2. 安装图标到 ~/.local/share/icons/hicolor（启动器、任务栏、Alt+Tab 都用它）；
#   3. 写入 ~/.local/share/applications/dsh-desktop.desktop（应用列表 + 可拖到桌面/收藏夹）；
#   4. 在桌面目录放一个「DSH 桌面版」启动图标（如果桌面目录存在且可写）。
#
# 重复执行是安全的（幂等）：图标覆盖、desktop 文件重写。
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="${APP_DIR}/bin/dsh-desktop"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
ICON_ROOT="${DATA_HOME}/icons/hicolor"
APPLICATIONS_DIR="${DATA_HOME}/applications"
DESKTOP_FILE="${APPLICATIONS_DIR}/dsh-desktop.desktop"

echo "==> 生成图标"
python3 "${APP_DIR}/tools/make-icons.py"

echo "==> 安装图标到 ${ICON_ROOT}"
for dir in "${APP_DIR}"/assets/icons/hicolor/*/apps; do
  size_dir="$(basename "$(dirname "${dir}")")"
  mkdir -p "${ICON_ROOT}/${size_dir}/apps"
  cp -f "${dir}/dsh-desktop.png" "${ICON_ROOT}/${size_dir}/apps/dsh-desktop.png"
done

echo "==> 写入 ${DESKTOP_FILE}"
mkdir -p "${APPLICATIONS_DIR}"
cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=DSH
Name[zh_CN]=DSH 桌面版
GenericName=DeepSeek Harness Desktop
GenericName[zh_CN]=DeepSeek Harness 桌面版
Comment=DeepSeek Harness desktop client (the server stops when the last window is closed)
Comment[zh_CN]=DeepSeek Harness 桌面客户端（最后一个窗口关闭时才停掉后台服务）
Exec=${LAUNCHER} %U
Icon=dsh-desktop
Terminal=false
Categories=Development;Utility;
Keywords=dsh;deepseek;harness;ai;
StartupNotify=true
# 必须与 Electron 实际设置的 WM_CLASS 一致（来自 app.setName('Dsh Desktop')），
# 否则 GNOME 无法把窗口与这个启动图标归到一起，任务栏会显示成另一个应用。
StartupWMClass=Dsh Desktop
EOF

# 刷新系统缓存，失败也不影响使用（有些精简系统没有这些命令）
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "${APPLICATIONS_DIR}" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "${ICON_ROOT}" >/dev/null 2>&1 || true

echo "==> 在桌面放置启动图标"
for desktop_dir in "${HOME}/桌面" "${HOME}/Desktop"; do
  if [[ -d "${desktop_dir}" ]]; then
    cp -f "${DESKTOP_FILE}" "${desktop_dir}/dsh-desktop.desktop"
    chmod +x "${desktop_dir}/dsh-desktop.desktop" || true
    # GNOME 默认需要显式信任桌面文件才允许双击启动
    command -v gio >/dev/null 2>&1 && gio set "${desktop_dir}/dsh-desktop.desktop" metadata::trusted true >/dev/null 2>&1 || true
    echo "    已放置：${desktop_dir}/dsh-desktop.desktop"
  fi
done

echo
echo "完成。现在可以："
echo "  - 在应用列表里搜索 \`DSH\` 启动；"
echo "  - 或直接运行：${LAUNCHER}"
