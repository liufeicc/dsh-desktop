#!/usr/bin/env bash
#
# DSH 桌面版「先关主的窗口」端到端验证 —— 第四版修复的那个问题。
#
# 复现的用户场景（原话）：
#   「有个问题，现在 DSH 桌面版可以启动多个，有一个是主的，其他是副本，连接同一个后台服务。
#     问题是如果我关闭了主的，后台服务就被关闭了，副本就不能用了。
#     我觉得应该是主的关闭了，后台服务不要关闭。只有等所有启动的 DSH 桌面版都关闭了，
#     才关闭后台服务。」
#
# 所以本脚本刻意把关闭顺序反过来（既有测试都是先关副的）：
#   壳1（主，起服务的那个）先关 → 服务必须活着、公告必须留着、副本必须还能用；
#   中途再开第三个窗口 → 必须复用同一台服务，不许另起；
#   最后关掉副本 → 这时才允许回收服务、撤公告、清记录。
#
# 隔离方式与既有 e2e 一致：独立数据目录 + 假 dsh + 独立 userData，全程不碰 ~/.dsh-desktop，
# 更不会碰到用户正在使用的那台 dsh 服务。
#
# 覆盖的断言：
#   1. 两个壳都登记进了 clients/（第四版新增的「谁在用」名单）；
#   2. 关掉主壳后：主壳退出，但**假 dsh 仍活着**、endpoint.json 与 server.pid 都还在；
#   3. 关掉主壳后：公告里的地址仍然可用（curl 得到 200），副本窗口仍在；
#   4. 主壳退出时日志写的是「保留服务器」而不是停服务；
#   5. 主壳退出后再开第三个窗口：仍然复用同一台服务（假 dsh 启动次数始终为 1）；
#   6. 关掉第三个窗口（还有副本在用）：服务继续保留；
#   7. 关掉最后一个窗口：假 dsh 被回收、公告与 pid 记录都被清掉、无残留进程、名单清空。

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${E2E_ROOT:-/tmp/dsh-desktop-owner-first}"
ELECTRON="$REPO_DIR/node_modules/electron/dist/electron"
NODE_BIN="$(command -v node)"

PASS=0
FAIL=0
log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m✘\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

alive() { kill -0 "$1" 2>/dev/null; }

# 等一个文件出现（非空）。
wait_file() {
  local file="$1"
  local timeout="${2:-20}"
  local end=$((SECONDS + timeout))
  while (( SECONDS < end )); do
    [[ -s "$file" ]] && return 0
    sleep 0.3
  done
  return 1
}

# 轮询直到条件成立（条件以字符串命令传入）
wait_until() {
  local timeout="$1"
  local cmd="$2"
  local end=$((SECONDS + timeout))
  while (( SECONDS < end )); do
    if eval "$cmd"; then return 0; fi
    sleep 0.3
  done
  return 1
}

PIDS=()
cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && alive "$pid" && kill -TERM "$pid" 2>/dev/null
  done
  sleep 0.5
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && alive "$pid" && kill -KILL "$pid" 2>/dev/null
  done
  # 假 dsh 若因断言失败留了下来，也一并收掉，别污染后续测试
  pkill -f "$ROOT/fake-dsh" 2>/dev/null
}
trap cleanup EXIT

# ── 准备隔离环境 ─────────────────────────────────────────────
rm -rf "$ROOT"
# 三个壳共用同一个 userData：这才复现「用户点多次图标」的真实情形（单实例锁挂在 userData 上）
mkdir -p "$ROOT/app" "$ROOT/ud1"

cat > "$ROOT/fake-dsh" <<FAKE
#!${NODE_BIN}
// 假 dsh：监听端口 + 打印 dsh 风格的访问地址行 + 一直活着。
// 页面里带自己的 pid，方便断言「两个窗口连的是同一台服务」。
const http = require('node:http');
const fs = require('node:fs');
let port = 0;
const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
if (i >= 0) port = Number(argv[i + 1]) || 0;
fs.appendFileSync('${ROOT}/fake-starts.log', \`pid=\${process.pid} port=\${port}\n\`);

// ★ 关键设计：持续往 stdout / stderr 写东西，用来验证「壳退出后服务器不会因管道断裂而自杀」。
// 第四版之前服务器的 stdout 是接在壳上的管道，壳一退出管道就断，服务器下次写 stdout
// 就会拿到 EPIPE —— Node 里未处理的 EPIPE 直接结束进程，于是「主壳退出、服务留着」
// 这件事会在几十秒内悄悄失效（实测：心跳在壳退出的那一刻就停了）。
// 现在服务器的输出直接写日志文件，壳退出后再没有任何管子牵着它。
let beats = 0;
setInterval(() => {
  beats += 1;
  fs.appendFileSync('${ROOT}/heartbeats.log', 'out ' + beats + '\n');
  process.stdout.write('heartbeat ' + beats + '\n');
}, 500);
setInterval(() => {
  fs.appendFileSync('${ROOT}/heartbeats.log', 'err\n');
  process.stderr.write('stderr heartbeat\n');
}, 700);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>FAKE DSH</title><body>fake-dsh-pid=' + process.pid + '</body>');
});
server.listen(port, '127.0.0.1', () => {
  console.log(\`dsh web: http://127.0.0.1:\${server.address().port}/?token=FAKETOKEN\`);
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); });
}
FAKE
chmod +x "$ROOT/fake-dsh"

run_shell() {
  DSH_DESKTOP_APP_DIR="$ROOT/app" \
  DSH_DESKTOP_DSH_BIN="$ROOT/fake-dsh" \
  "$ELECTRON" --no-sandbox --user-data-dir="$ROOT/ud1" "$REPO_DIR" >/dev/null 2>&1 &
  echo $!
}

# 读公告里的某个数字字段
endpoint_field() {
  grep -o "\"$1\": *[0-9]*" "$ROOT/app/endpoint.json" 2>/dev/null | grep -o '[0-9]*' | head -1
}

starts_count() {
  wc -l < "$ROOT/fake-starts.log" 2>/dev/null || echo 0
}

# ── 起主壳与副本 ────────────────────────────────────────────
log "启动壳1（主：自起服务器并公告地址）"
PID1="$(run_shell)"
PIDS+=("$PID1")
info "壳1 pid=$PID1"

if wait_file "$ROOT/app/endpoint.json" 30; then
  ok "壳1 写出了 endpoint.json"
else
  bad "壳1 没有写出 endpoint.json（超时 30s）"
  tail -5 "$ROOT/app/app.log" 2>/dev/null | sed 's/^/      /'
fi
SERVER_PID="$(endpoint_field serverPid)"
info "公告里的 serverPid=$SERVER_PID"
if [[ -n "$SERVER_PID" ]] && alive "$SERVER_PID"; then
  ok "公告记录了服务器 pid，且进程确实活着（第四版新增字段）"
else
  bad "公告里的 serverPid 无效：${SERVER_PID:-空}"
fi

log "启动壳2（副本：复用壳1 的服务器）"
PID2="$(run_shell)"
PIDS+=("$PID2")
info "壳2 pid=$PID2"
if wait_until 25 "grep -q '本窗口不再启动服务器' '$ROOT/app/app.log'"; then
  ok "壳2 走了复用分支"
else
  bad "壳2 没有走复用分支"
fi

sleep 2
STARTS="$(starts_count)"
if [[ "$STARTS" -eq 1 ]]; then
  ok "全程只起了一台服务（假 dsh 启动次数=$STARTS）"
else
  bad "服务启动次数应为 1，实际 $STARTS"
  sed 's/^/      /' "$ROOT/fake-starts.log" 2>/dev/null
fi

# 断言 1：两个壳都登记进了 clients/
CLIENT_FILES="$(ls "$ROOT/app/clients" 2>/dev/null | grep -c '\.json$' || true)"
if [[ "$CLIENT_FILES" -eq 2 ]]; then
  ok "两个窗口都登记进了 clients/（$(ls "$ROOT/app/clients" | tr '\n' ' ')）"
else
  bad "clients/ 里应有 2 个登记文件，实际 $CLIENT_FILES"
  ls -la "$ROOT/app/clients" 2>/dev/null | sed 's/^/      /'
fi
if [[ -f "$ROOT/app/clients/$PID1.json" && -f "$ROOT/app/clients/$PID2.json" ]]; then
  ok "登记文件与两个壳的 pid 对得上"
else
  bad "登记文件与壳 pid 对不上"
fi

# ── 关键场景：先关掉「主的」 ─────────────────────────────────
log "关闭壳1（主窗口）——按用户要求，此时后台服务必须继续运行"
# 先记下服务器的心跳次数：壳退出后它还要继续跳，才说明它没被管道断裂带走
BEATS_BEFORE="$(grep -c '^out ' "$ROOT/heartbeats.log" 2>/dev/null || echo 0)"
info "壳退出前服务器心跳次数=$BEATS_BEFORE"

kill -TERM "$PID1" 2>/dev/null
if wait_until 20 "! kill -0 $PID1 2>/dev/null"; then
  ok "壳1 已退出"
else
  bad "壳1 未退出"
fi
sleep 3

if alive "$SERVER_PID"; then
  ok "★ 主壳退出后，后台服务（假 dsh pid=$SERVER_PID）仍然活着"
else
  bad "★ 主壳退出把后台服务带走了 —— 这正是本次要修的问题"
fi

# ★ 心跳断言：服务器在壳退出后仍能正常往 stdout/stderr 写东西。
# 这条专门防「管道断裂」这个隐蔽故障：早先 stdout 接的是壳的管道，
# 壳一退管道就断，服务器下一次写 stdout 会拿到未处理的 EPIPE 而直接结束进程
# （实测心跳会在壳退出的那一刻停住）。所以这里既看进程活着，也看它还在写。
BEATS_AFTER="$(grep -c '^out ' "$ROOT/heartbeats.log" 2>/dev/null || echo 0)"
ERR_AFTER="$(grep -c '^err$' "$ROOT/heartbeats.log" 2>/dev/null || echo 0)"
if (( BEATS_AFTER > BEATS_BEFORE )); then
  ok "★ 主壳退出后服务器仍在正常写 stdout（心跳 $BEATS_BEFORE → $BEATS_AFTER，stderr $ERR_AFTER 次）"
else
  bad "★ 主壳退出后服务器不再写 stdout（心跳停在 $BEATS_BEFORE）——像被管道断裂(EPIPE)带走了"
fi
if grep -q '^heartbeat ' "$ROOT/app/dsh-server.log" 2>/dev/null; then
  ok "服务器的输出直接落在 dsh-server.log 里（不再经过壳的管道）"
else
  bad "dsh-server.log 里看不到服务器自己写的输出"
fi

if [[ -s "$ROOT/app/endpoint.json" ]]; then
  ok "地址公告仍然存在（后来启动的窗口还能复用）"
else
  bad "地址公告被撤掉了（后续窗口会以为没有可用服务器）"
fi
if [[ -s "$ROOT/app/server.pid" ]]; then
  ok "server.pid 仍然保留（最后一个窗口要按它回收服务）"
else
  bad "server.pid 被删了（最后一个窗口将无法回收这台服务）"
fi
if grep -q '退出判定：另有 1 个窗口在使用后台服务，保留服务器' "$ROOT/app/app.log"; then
  ok "主壳的退出判定是「保留服务器」"
else
  bad "主壳的退出判定不对，日志见下："
  grep '退出判定' "$ROOT/app/app.log" | sed 's/^/      /'
fi
if alive "$PID2"; then
  ok "副本窗口仍然存活"
else
  bad "副本窗口意外退出了"
fi

# 副本的后端是否真的还在服务：直接访问公告里的地址
URL="$(grep -o '"url": *"[^"]*"' "$ROOT/app/endpoint.json" | sed 's/"url": *"//; s/"$//')"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null)"
if [[ "$CODE" == "200" ]]; then
  ok "★ 公告地址仍然可用（curl 得到 200），副本的后端没断"
else
  bad "★ 公告地址已不可用（HTTP ${CODE:-无响应}）——副本会白屏"
fi

# ── 主壳退出后再开第三个窗口：必须复用同一台服务 ─────────────
log "启动壳3（主壳已退出，应复用同一台服务而不是另起一台）"
PID3="$(run_shell)"
PIDS+=("$PID3")
info "壳3 pid=$PID3"
BEFORE_STARTS="$(starts_count)"
if wait_until 25 "grep -q '本窗口不再启动服务器' '$ROOT/app/app.log'"; then
  ok "壳3 也走了复用分支"
else
  bad "壳3 没有复用，可能自己起了一台新服务"
fi
sleep 2
AFTER_STARTS="$(starts_count)"
if [[ "$AFTER_STARTS" -eq "$BEFORE_STARTS" && "$AFTER_STARTS" -eq 1 ]]; then
  ok "壳3 没有另起服务（启动次数仍为 $AFTER_STARTS）"
else
  bad "服务启动次数从 $BEFORE_STARTS 变成了 $AFTER_STARTS"
fi
if alive "$SERVER_PID"; then
  ok "后台服务依旧是原来那台（pid=$SERVER_PID）"
else
  bad "原来的服务没了"
fi

# ── 关掉壳3：还有副本在用，服务继续保留 ─────────────────────
log "关闭壳3（还有壳2 在用，服务应继续保留）"
kill -TERM "$PID3" 2>/dev/null
wait_until 15 "! kill -0 $PID3 2>/dev/null" && ok "壳3 已退出" || bad "壳3 未退出"
sleep 2
if alive "$SERVER_PID"; then
  ok "壳3 退出后服务仍在（还有副本在用）"
else
  bad "壳3 退出把服务带走了（副本还在用！）"
fi
if alive "$PID2"; then
  ok "副本仍然存活"
else
  bad "副本意外退出"
fi

# ── 关掉最后一个窗口：这时才该回收 ──────────────────────────
log "关闭壳2（最后一个使用者）——此时才允许回收后台服务"
kill -TERM "$PID2" 2>/dev/null
if wait_until 25 "! kill -0 $PID2 2>/dev/null"; then
  ok "壳2 已退出"
else
  bad "壳2 未退出"
fi
sleep 2

if pgrep -f "$ROOT/fake-dsh" >/dev/null 2>&1; then
  bad "★ 所有窗口都关了，后台服务却还在跑（残留）"
  pgrep -af "$ROOT/fake-dsh" | sed 's/^/      /'
else
  ok "★ 最后一个窗口退出后，后台服务被回收，无残留"
fi
if [[ -f "$ROOT/app/endpoint.json" ]]; then
  bad "所有窗口关闭后公告仍然存在"
else
  ok "地址公告已撤下"
fi
if [[ -f "$ROOT/app/server.pid" ]]; then
  bad "pid 记录仍然存在（下次启动会把它当残留再清理一遍）"
else
  ok "pid 记录已清理"
fi
LEFT="$(ls "$ROOT/app/clients" 2>/dev/null | grep -c '\.json$' || true)"
if [[ "$LEFT" -eq 0 ]]; then
  ok "客户端登记表已清空（没有留下死文件）"
else
  bad "客户端登记表里还剩 $LEFT 个文件"
  ls -la "$ROOT/app/clients" | sed 's/^/      /'
fi
if grep -q '退出判定：本窗口是最后一个使用者，回收后台服务' "$ROOT/app/app.log"; then
  ok "最后一个窗口的退出判定是「回收后台服务」"
else
  bad "最后一个窗口的退出判定不对"
fi
if grep -qE '未捕获异常' "$ROOT/app/app.log"; then
  bad "日志里出现未捕获异常："
  grep '未捕获异常' "$ROOT/app/app.log" | head -3 | sed 's/^/      /'
else
  ok "全程没有未捕获异常"
fi

printf '\n\033[1m结果：%d 通过，%d 失败\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
