#!/usr/bin/env bash
#
# 验证「主实例还在冷启动时，用户又点了一次图标」这条竞态路径。
#
# 为什么需要单独测：
#   单实例锁只能告诉我们「已经有个壳在跑」，但那一刻它的 dsh web 可能还没就绪、
#   还没写出公告文件。如果第二个壳看一眼没公告就自己起服务，两个壳就会各起一个
#   dsh —— 白占内存，两块屏看起来也像两个不相干的程序。
#   用户的真实节奏恰恰是「点了没反应，再点一次」，所以这个窗口期必须处理。
#
# 怎么造这个场景：
#   1. 启动壳A（假 dsh，秒级就绪）并等它写出公告；
#   2. 把公告删掉并记下日志行数基线 —— 壳A 的服务还在跑，但第二个壳此刻「看不到」它；
#   3. 启动壳B（共用 userData，所以拿不到锁）→ 它应该进入等待；
#   4. 12 秒后把公告放回去（模拟壳A 终于冷启动完）；
#   5. 断言壳B 复用了那个地址、且**确实等待过**（等待时长从日志里验证）。
#
# 断言的写法说明（踩过的坑）：
#   不要用固定的 sleep 去卡时间窗，也不要依赖 shell 的 $SECONDS 做时序判断 ——
#   一旦两者错位，断言就会在「逻辑其实正确」的情况下误报失败。
#   这里改成从日志内容推导：把「壳B 启动时刻」与「拿到地址时刻」都从日志里读出来，
#   用它们的时间差判断它到底等了多久。日志是唯一权威事实。

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${E2E_ROOT:-/tmp/dsh-desktop-reuse-wait}"
ELECTRON="$REPO_DIR/node_modules/electron/dist/electron"
NODE_BIN="$(command -v node)"

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
}
trap cleanup EXIT

rm -rf "$ROOT"
mkdir -p "$ROOT/app" "$ROOT/ud"

# 两个壳各用一个假 dsh：各自写自己的启动记录，谁起过服务一目了然
make_fake_dsh() {
  local path="$1"
  local record="$2"
  cat > "$path" <<FAKE
#!${NODE_BIN}
const http = require('node:http');
const fs = require('node:fs');
let port = 0;
const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
if (i >= 0) port = Number(argv[i + 1]) || 0;
fs.appendFileSync('${record}', 'pid=' + process.pid + '\n');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body>fake</body></html>');
});
server.listen(port, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=FAKE');
});
process.on('SIGTERM', () => process.exit(0));
FAKE
  chmod +x "$path"
}
make_fake_dsh "$ROOT/fake-dsh-a" "$ROOT/starts-a.log"
make_fake_dsh "$ROOT/fake-dsh-b" "$ROOT/starts-b.log"

# 启动一个壳，把它的 pid 打到 stdout
run_shell() {
  local dsh="$1"
  DSH_DESKTOP_APP_DIR="$ROOT/app" DSH_DESKTOP_DSH_BIN="$dsh" \
    "$ELECTRON" --no-sandbox --user-data-dir="$ROOT/ud" "$REPO_DIR" >/dev/null 2>&1 &
  echo $!
}

log "步骤 1：启动壳A 并等它公告地址"
PID_A="$(run_shell "$ROOT/fake-dsh-a")"
PIDS+=("$PID_A")
info "壳A pid=$PID_A"

if wait_until 60 "[[ -s '$ROOT/app/endpoint.json' ]]"; then
  ok "壳A 写出了公告"
  SAVED_ENDPOINT="$(cat "$ROOT/app/endpoint.json")"
  info "公告内容：$(echo "$SAVED_ENDPOINT" | tr -d '\n ')"
else
  bad "壳A 没有写出公告，测试无法继续"
  printf '\n\033[1m结果：%d 通过，%d 失败\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi

log "步骤 2：删掉公告（模拟「壳A 还在冷启动、公告还没写出来」）"
rm -f "$ROOT/app/endpoint.json"
if [[ ! -f "$ROOT/app/endpoint.json" ]]; then
  ok "公告已移除，此刻新壳看不到可复用的地址"
fi
# 记下日志行数：后面只分析壳B 启动之后新增的行，免得把壳A 的日志算进来
LOG_BASELINE="$(wc -l < "$ROOT/app/app.log")"
info "日志基线行数=$LOG_BASELINE"

log "步骤 3：启动壳B（共用 userData → 拿不到锁 → 应进入等待）"
PID_B="$(run_shell "$ROOT/fake-dsh-b")"
PIDS+=("$PID_B")
info "壳B pid=$PID_B"

# 等壳B 明确报告「未抢到锁」，说明它已经走到模式判定这一步
if wait_until 30 "tail -n +$((LOG_BASELINE + 1)) '$ROOT/app/app.log' | grep -q '未抢到单实例锁'"; then
  ok "壳B 确认自己没拿到锁（已进入复用判定）"
else
  bad "壳B 没有记录「未抢到单实例锁」"
fi

# 此刻公告仍不存在，壳B 必须处于等待状态：既不能复用，也不能自起服务。
# 注意匹配串的选择：锁失败那行日志里也含「复用已有实例的服务器」这几个字
# （「本次启动将复用已有实例的服务器（不是错误…）」），直接匹配它会把「还没接上」
# 误判成「已经接上」。所以改用只有真正接上时才会打印的短语「本窗口不再启动服务器」。
if [[ ! -f "$ROOT/starts-b.log" ]]; then
  ok "壳B 没有急着自起服务（正在等待公告）"
else
  bad "壳B 在等待期内就自起了服务"
fi
if tail -n +"$((LOG_BASELINE + 1))" "$ROOT/app/app.log" | grep -q '本窗口不再启动服务器'; then
  bad "壳B 在公告恢复前就已经接上了地址，说明等待逻辑没被测到"
else
  ok "壳B 仍在等待（尚未接上地址）"
fi

log "步骤 4：把公告放回去（模拟壳A 终于冷启动完）"
sleep 12   # 让壳B 确实等上一段时间，这样「等待时长」才有可验证的量
printf '%s\n' "$SAVED_ENDPOINT" > "$ROOT/app/endpoint.json"
info "公告已放回（$(date +%H:%M:%S)）"

log "步骤 5：断言壳B 复用地址且确实等待过"
# 同步点用「本窗口不再启动服务器」这个短语，而不是「复用已有实例的服务器」。
# 原因：后者在锁失败那行日志里也出现（「本次启动将复用已有实例的服务器（不是错误…）」），
# 用它做条件会在第一毫秒就命中，导致断言跑在壳B 真正接上之前。
if wait_until 40 "grep -q '本窗口不再启动服务器' '$ROOT/app/app.log'"; then
  ok "壳B 接上了壳A 的地址"
  grep '本窗口不再启动服务器' "$ROOT/app/app.log" | tail -1 | sed 's/^/      /'
else
  bad "壳B 没有接上地址"
  tail -10 "$ROOT/app/app.log" | sed 's/^/      /'
fi

# 核心断言：必须存在「等待 N 秒后拿到了可复用的地址」这句日志。
# 它只在「先等待、后拿到」这条路径上才会打印，是等待逻辑生效的直接证据。
WAITED_NOTE="$(grep -o '等待 [0-9]* 秒后拿到了可复用的地址' "$ROOT/app/app.log" | tail -1)"
# 从「等待 12 秒后…」里取出那个 12（只取该句中的数字，避免误取时间戳里的数字）
WAITED_SECONDS="$(printf '%s' "$WAITED_NOTE" | sed -E 's/^等待 ([0-9]+) 秒.*$/\1/')"
if [[ -n "$WAITED_NOTE" ]]; then
  ok "壳B 确实等待后才复用：$WAITED_NOTE"
else
  bad "没有「等待后拿到地址」的日志，等待逻辑可能没生效"
  tail -8 "$ROOT/app/app.log" | sed 's/^/      /'
fi
# 等待时长必须接近注入的 12 秒（±6 秒容差）：太短说明它其实没等，
# 太长说明轮询间隔或超时算错了。
if [[ "$WAITED_SECONDS" =~ ^[0-9]+$ ]]; then
  if (( WAITED_SECONDS >= 6 && WAITED_SECONDS <= 18 )); then
    ok "等待时长 ${WAITED_SECONDS}s 与注入的 12s 吻合"
  else
    bad "等待时长 ${WAITED_SECONDS}s 与预期的 12s 不符（容差 6~18s）"
  fi
fi

sleep 2
if [[ ! -f "$ROOT/starts-b.log" ]]; then
  ok "壳B 全程没有自起服务（starts-b.log 不存在）"
else
  bad "壳B 自起了服务：$(cat "$ROOT/starts-b.log")"
fi
if [[ "$(wc -l < "$ROOT/starts-a.log")" -eq 1 ]]; then
  ok "壳A 只起了一个服务（没有被壳B 顶掉重来）"
else
  bad "壳A 的服务启动次数异常：$(wc -l < "$ROOT/starts-a.log")"
fi
if alive "$PID_A" && alive "$PID_B"; then
  ok "两个壳都活着（壳B 不是靠抢走壳A 的位置实现的）"
else
  bad "有壳意外退出"
fi

# 收尾：关掉壳B，确认不动壳A
kill -TERM "$PID_B" 2>/dev/null
sleep 3
if alive "$PID_A"; then ok "关掉壳B 后壳A 仍在运行"; else bad "壳A 被壳B 的退出带走了"; fi
if [[ -s "$ROOT/app/endpoint.json" ]]; then
  ok "公告仍在（壳B 没有误删主实例的公告）"
else
  bad "公告被壳B 误删了"
fi

printf '\n\033[1m结果：%d 通过，%d 失败\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
