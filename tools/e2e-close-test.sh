#!/usr/bin/env bash
#
# DSH 桌面版「关闭即退出」端到端验证。
#
# 为什么要这么测，而不是直接关一次真实窗口：
#   当前你正在用的那个桌面壳，它托管的 dsh web 就是承载着对话会话的服务器；
#   拿它做实验会直接把会话打断。所以这里全程用隔离环境：
#     - DSH_DESKTOP_APP_DIR  指向 /tmp 下的独立数据目录（日志、pid 记录都隔离）；
#     - DSH_DESKTOP_DSH_BIN  指向一个「假 dsh」脚本（真监听端口 + 打印 dsh 风格的就绪行）；
#     - --user-data-dir      另开一份 Chromium 用户数据，绕开单实例锁，不影响真壳。
#
# 三个场景（对应三条收尾路径）：
#   1. 点窗口 ×（WM_DELETE_WINDOW）→ 壳与后台服务都应消失；
#   2. 给壳发 SIGTERM（等价注销/关机/终端 kill）→ 壳与后台服务都应消失；
#   3. kill -9 硬杀壳（复现「壳没了、服务还在」）→ 下次启动壳时必须把残留清掉。
#
# 测试用的窗口会短暂出现在当前桌面上（DISPLAY 与真实桌面相同），
# 关闭时一律按「窗口 pid」精确定位，绝不用标题子串匹配。

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${E2E_ROOT:-/tmp/dsh-desktop-e2e}"
ELECTRON="$REPO_DIR/node_modules/electron/dist/electron"
FAKE_DSH="$ROOT/fake-dsh"

# 场景里用到的全局状态
APP_DATA=""
USER_DATA=""
SHELL_PID=""
SERVER_PID=""
# 测试产生、需要在退出时清掉的 pid
TRACKED_PIDS=()

PASS=0
FAIL=0

log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m✘\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

alive() { kill -0 "$1" 2>/dev/null; }

# 等一个 pid 消失
wait_gone() {
  local pid="$1"
  local timeout="${2:-12}"
  local end=$((SECONDS + timeout))
  while alive "$pid"; do
    if (( SECONDS >= end )); then return 1; fi
    sleep 0.2
  done
  return 0
}

cleanup() {
  local pid
  for pid in "${TRACKED_PIDS[@]}"; do
    if alive "$pid"; then kill -TERM "$pid" 2>/dev/null; fi
  done
  sleep 0.5
  for pid in "${TRACKED_PIDS[@]}"; do
    if alive "$pid"; then kill -KILL "$pid" 2>/dev/null; fi
  done
}
trap cleanup EXIT

# 生成假 dsh：行为对齐真实的 `dsh web`
prepare_fake_dsh() {
  mkdir -p "$ROOT"
  cat > "$FAKE_DSH" <<'FAKE'
#!/usr/bin/env bash
# 假 dsh，仅用于端到端测试。模拟 `dsh web` 的三件关键行为：
#   1. 真的监听一个 HTTP 端口（否则桌面壳 loadURL 会因连接被拒而报错）；
#   2. 把带 token 的就绪地址打到 stdout（桌面壳就是靠这一行拿到地址）；
#   3. 打完那一行后长眠不动，等壳来收尸。
PORT="${FAKE_DSH_PORT:-47811}"
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
http_pid=$!
for _ in $(seq 1 50); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then exec 3>&-; break; fi
  sleep 0.1
done
echo "dsh web: http://127.0.0.1:$PORT/?token=e2e-token (LAN: http://127.0.0.1:$PORT/?token=e2e-token)"
wait "$http_pid"
FAKE
  chmod +x "$FAKE_DSH"
}

# 准备隔离目录：prepare_dirs <场景名>
prepare_dirs() {
  rm -rf "$ROOT/$1"
  APP_DATA="$ROOT/$1/app"
  USER_DATA="$ROOT/$1/userdata"
  mkdir -p "$APP_DATA" "$USER_DATA"
}

# 用当前的 APP_DATA / USER_DATA 启动一个桌面壳实例：launch_shell <说明> <假 dsh 端口>
launch_shell() {
  local name="$1" port="$2"
  mkdir -p "$ROOT/$name"
  # 刻意直接调 electron 而不是 bin/dsh-desktop：--user-data-dir 必须出现在应用路径之前，
  # 位置不对 Chromium 有可能不认，那样就会撞上真实实例的单实例锁。
  FAKE_DSH_PORT="$port" \
  DSH_DESKTOP_APP_DIR="$APP_DATA" \
  DSH_DESKTOP_DSH_BIN="$FAKE_DSH" \
  DISPLAY="${DISPLAY:-:1}" \
    "$ELECTRON" --no-sandbox "--user-data-dir=$USER_DATA" "$REPO_DIR" \
    >"$ROOT/$name/launch.log" 2>&1 &
  SHELL_PID=$!
  TRACKED_PIDS+=("$SHELL_PID")
  info "壳已启动 pid=$SHELL_PID（$name）"
}

# 清空目录后启动：start_shell <场景名> <假 dsh 端口>
start_shell() {
  prepare_dirs "$1"
  launch_shell "$1" "$2"
}

count_ready() {
  local n
  n="$(grep -c "服务器就绪" "$APP_DATA/app.log" 2>/dev/null)"
  echo "${n:-0}"
}

# 等服务器就绪：wait_ready <期望的「服务器就绪」出现次数>
wait_ready() {
  local want="$1" end=$((SECONDS + 40))
  while (( SECONDS < end )); do
    if [[ -f "$APP_DATA/server.pid" ]] && [[ "$(count_ready)" -ge "$want" ]]; then
      SERVER_PID="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['pid'])" "$APP_DATA/server.pid" 2>/dev/null)"
      [[ -n "$SERVER_PID" ]] && return 0
    fi
    sleep 0.2
  done
  return 1
}

# 取窗口 id：按 pid 精确匹配（wmctrl -lp 的第 3 列就是 _NET_WM_PID）
window_of_pid() { wmctrl -lp | awk -v p="$1" '$3 == p { print $1; exit }'; }

wait_window() {
  local end=$((SECONDS + 20)) wid=""
  while (( SECONDS < end )); do
    wid="$(window_of_pid "$SHELL_PID")"
    [[ -n "$wid" ]] && { echo "$wid"; return 0; }
    sleep 0.2
  done
  return 1
}

# ────────────────────────────── 三个场景 ──────────────────────────────

scenario_close_window() {
  log "场景 1：点窗口 × → 壳与后台服务一起消失"
  start_shell close-window 47811
  if ! wait_ready 1; then bad "服务器未就绪，无法继续"; return; fi
  ok "服务器就绪 pid=$SERVER_PID"
  TRACKED_PIDS+=("$SERVER_PID")

  local wid
  if ! wid="$(wait_window)"; then bad "没找到测试窗口（pid=$SHELL_PID）"; return; fi
  info "窗口 id=$wid"

  # 用 wmctrl -i -c <窗口id> 发 WM_DELETE_WINDOW，等价于点标题栏的 ×
  wmctrl -i -c "$wid"

  if wait_gone "$SHELL_PID" 15; then ok "壳进程已退出"; else bad "壳进程仍在（pid=$SHELL_PID）"; fi
  if wait_gone "$SERVER_PID" 15; then ok "后台 dsh 服务已一并退出"; else bad "后台服务仍在（pid=$SERVER_PID）"; fi
  if [[ -f "$APP_DATA/server.pid" ]]; then bad "server.pid 未清理"; else ok "server.pid 已清理"; fi
}

scenario_sigterm() {
  log "场景 2：给壳发 SIGTERM（注销/关机/终端 kill）→ 壳与后台服务一起消失"
  start_shell sigterm 47812
  if ! wait_ready 1; then bad "服务器未就绪，无法继续"; return; fi
  ok "服务器就绪 pid=$SERVER_PID"
  TRACKED_PIDS+=("$SERVER_PID")

  kill -TERM "$SHELL_PID"

  if wait_gone "$SHELL_PID" 15; then ok "壳进程已退出"; else bad "壳进程仍在（pid=$SHELL_PID）"; fi
  if wait_gone "$SERVER_PID" 15; then ok "后台 dsh 服务已一并退出"; else bad "后台服务仍在（pid=$SERVER_PID）"; fi
}

scenario_hard_kill_then_reap() {
  log "场景 3：kill -9 硬杀壳（复现原问题）→ 下次启动壳时清理残留"
  start_shell hard-kill 47813
  if ! wait_ready 1; then bad "服务器未就绪，无法继续"; return; fi
  local old_server="$SERVER_PID"
  ok "服务器就绪 pid=$old_server"
  TRACKED_PIDS+=("$old_server")

  kill -KILL "$SHELL_PID"
  wait "$SHELL_PID" 2>/dev/null # 回收一下，避免 bash 打出「已杀死」的任务通知
  if wait_gone "$SHELL_PID" 10; then ok "壳已被硬杀"; else bad "壳没死（pid=$SHELL_PID）"; fi
  sleep 1
  if alive "$old_server"; then
    ok "确认原问题现场：壳没了，后台服务仍在跑（pid=$old_server）"
  else
    bad "后台服务不该在这时消失，场景 3 失去意义"
    return
  fi

  # 用同一个数据目录（APP_DATA/USER_DATA 不变）再启动一次，模拟用户重新打开桌面版。
  # 这里要等第 2 条「服务器就绪」日志：第 1 条是上一任壳写的，拿它当就绪信号会误判。
  info "重新启动壳，观察是否清理残留"
  launch_shell hard-kill-restart 47813
  if ! wait_ready 2; then bad "重启后服务器未就绪"; return; fi
  ok "新服务器就绪 pid=$SERVER_PID"

  if wait_gone "$old_server" 15; then
    ok "上次残留的服务器已被清理（pid=$old_server）"
  else
    bad "残留服务器没被清理（pid=$old_server）"
  fi
  if [[ "$SERVER_PID" != "$old_server" ]]; then ok "新服务器是另一个进程，端口复用正常"; else bad "pid 没变化，可疑"; fi
  # 残留清理是服务器生命周期事件，写在 dsh-server.log 里（也就是应用菜单「查看服务器日志」指向的那份）
  if grep -q "清理上次残留的服务器" "$APP_DATA/dsh-server.log"; then ok "服务器日志里有清理记录"; else bad "服务器日志里没有清理记录"; fi
  if [[ -f "$APP_DATA/server.pid" ]] && \
     [[ "$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['pid'])" "$APP_DATA/server.pid")" == "$SERVER_PID" ]]; then
    ok "server.pid 已更新为新服务器"
  else
    bad "server.pid 内容不对"
  fi
}

# ────────────────────────────── 主流程 ──────────────────────────────

if [[ ! -x "$ELECTRON" ]]; then
  echo "找不到 Electron：$ELECTRON（先在 $REPO_DIR 里 npm install）" >&2
  exit 2
fi
if [[ -z "${DISPLAY:-}" ]]; then
  echo "没有 DISPLAY，无法做窗口级验证" >&2
  exit 2
fi

mkdir -p "$ROOT"
prepare_fake_dsh
info "隔离根目录：$ROOT"
info "假 dsh：$FAKE_DSH"

scenario_close_window
scenario_sigterm
scenario_hard_kill_then_reap

log "结果"
printf '  通过 %d 项，失败 %d 项\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
