#!/usr/bin/env bash
#
# DSH 桌面版「多窗口」真实环境验证（用真的 dsh web，不是假脚本）。
#
# 与 e2e-multi-window-test.sh 的区别：
#   那个用假 dsh，跑得快，验证壳的复用逻辑；
#   这个用真 dsh，慢（要装配整个 profile），验证「第二个窗口加载真页面会不会失败」。
#
# 隔离方式：
#   DSH_DESKTOP_APP_DIR  指向 /tmp 下的独立数据目录
#   DSH_HOME             指向独立 harness home，避免和用户正在用的会话/配置互相干扰
#   --user-data-dir      一份独立的 Chromium 用户数据（两个壳共用，复现真实情形）
#
# 注意：DSH_HOME 是空的，所以这次启动的 profile 是最原始的（没有用户插件）。
# 我们要验证的是「传输层能不能两个窗口同时看一个地址」，与装了哪些插件无关。

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${E2E_ROOT:-/tmp/dsh-desktop-real-multi}"
ELECTRON="$REPO_DIR/node_modules/electron/dist/electron"

PASS=0
FAIL=0
log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m✘\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

alive() { kill -0 "$1" 2>/dev/null; }

wait_until() {
  local timeout="$1"
  local cmd="$2"
  local end=$((SECONDS + timeout))
  while (( SECONDS < end )); do
    if eval "$cmd"; then return 0; fi
    sleep 0.5
  done
  return 1
}

PIDS=()
cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && alive "$pid" && kill -TERM "$pid" 2>/dev/null
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && alive "$pid" && kill -KILL "$pid" 2>/dev/null
  done
}
trap cleanup EXIT

rm -rf "$ROOT"
# 两个壳共用同一个 userData：这才复现「用户点两次图标」的真实情形（单实例锁挂在 userData 上）
mkdir -p "$ROOT/app" "$ROOT/home" "$ROOT/ud1"

run_shell() {
  local ud="$1"
  DSH_DESKTOP_APP_DIR="$ROOT/app" \
  DSH_HOME="$ROOT/home" \
  "$ELECTRON" --no-sandbox --user-data-dir="$ud" "$REPO_DIR" >/dev/null 2>&1 &
  echo $!
}

log "启动第一个壳（真实 dsh，冷启动可能要点时间）"
PID1="$(run_shell "$ROOT/ud1")"
PIDS+=("$PID1")
info "壳1 pid=$PID1"

if wait_until 120 "[[ -s '$ROOT/app/endpoint.json' ]]"; then
  ok "第一个壳写出了 endpoint.json"
  REAL_URL="$(grep -o '"url": *"[^"]*"' "$ROOT/app/endpoint.json" | sed 's/"url": *"//; s/"$//')"
  info "真实服务地址：$(echo "$REAL_URL" | sed 's/token=.*/token=***/')"

  # 用 curl 验证这个地址真的能返回页面（证明壳写进公告的是可用地址，不是假的）
  PORT="$(echo "$REAL_URL" | sed -E 's#.*:([0-9]+)/.*#\1#')"
  TOKEN="$(echo "$REAL_URL" | sed -E 's/.*token=//')"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/?token=${TOKEN}")"
  if [[ "$CODE" == "303" ]]; then
    ok "公告地址可用：token 换取 cookie 返回 303"
  else
    bad "公告地址不可用：HTTP $CODE"
  fi
else
  bad "第一个壳没有写出 endpoint.json（超时 120s）——真实 dsh 启动是否失败？见 $ROOT/app/app.log"
  tail -5 "$ROOT/app/app.log" | sed 's/^/      /'
fi

log "启动第二个壳（应复用同一个真实服务）"
PID2="$(run_shell "$ROOT/ud1")"   # 与壳1 共用 userData，必然拿不到单实例锁
PIDS+=("$PID2")
info "壳2 pid=$PID2"

# 匹配串用「本窗口不再启动服务器」：锁失败那行日志也含「复用已有实例的服务器」，
# 用它做条件会立刻命中，断言将跑在真正接上之前。
if wait_until 40 "grep -q '本窗口不再启动服务器' '$ROOT/app/app.log'"; then
  ok "第二个壳走了复用分支"
else
  bad "第二个壳没有走复用分支"
fi

# 关键验证：第二个壳有没有加载失败（真页面加载失败会记进日志）
sleep 12
if grep -qiE 'ERR_CONNECTION|加载.*失败|did-fail-load|ERR_FAILED' "$ROOT/app/app.log"; then
  bad "第二个壳加载页面失败："
  grep -iE 'ERR_CONNECTION|加载.*失败|did-fail-load|ERR_FAILED' "$ROOT/app/app.log" | tail -3 | sed 's/^/      /'
else
  ok "第二个壳没有页面加载失败记录"
fi

# 只应有一个 dsh web 在跑
COUNT="$(pgrep -fc 'bin/dsh web' 2>/dev/null || echo 0)"
info "当前 dsh web 进程数（含用户正在用的那个）：$COUNT"
if [[ "$COUNT" -le 2 ]]; then
  ok "第二个壳没有额外再起一个 dsh web"
else
  bad "疑似多起了 dsh web 进程（总数为 $COUNT）"
  pgrep -af 'bin/dsh web' | sed 's/^/      /'
fi

# 两个壳都不该出现未捕获异常
if grep -q '未捕获异常' "$ROOT/app/app.log"; then
  bad "日志里有未捕获异常："
  grep '未捕获异常' "$ROOT/app/app.log" | tail -3 | sed 's/^/      /'
else
  ok "没有未捕获异常"
fi

log "验证「同一个 token 能被第二个窗口重复换取 cookie」"
if [[ -n "${REAL_URL:-}" ]]; then
  PORT="$(echo "$REAL_URL" | sed -E 's#.*:([0-9]+)/.*#\1#')"
  TOKEN="$(echo "$REAL_URL" | sed -E 's/.*token=//')"
  C1="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/?token=${TOKEN}")"
  C2="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/?token=${TOKEN}")"
  if [[ "$C1" == "303" && "$C2" == "303" ]]; then
    ok "token 可重复使用（两次都返回 303）"
  else
    bad "token 重复使用时返回异常：$C1 / $C2"
  fi
fi

log "收尾：关掉两个壳"
kill -TERM "$PID2" 2>/dev/null
sleep 3
if alive "$PID1"; then ok "关掉副壳后主壳仍在"; else bad "主壳被带走了"; fi

kill -TERM "$PID1" 2>/dev/null
if wait_until 25 "! kill -0 $PID1 2>/dev/null"; then
  ok "主壳已退出"
else
  bad "主壳未退出"
fi
sleep 2
if pgrep -f "$ROOT/home" >/dev/null 2>&1; then
  bad "仍有属于本次测试的 dsh 进程残留"
  pgrep -af "$ROOT/home" | sed 's/^/      /'
else
  ok "测试用的 dsh 服务已回收"
fi

printf '\n\033[1m结果：%d 通过，%d 失败\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
