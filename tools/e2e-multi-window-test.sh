#!/usr/bin/env bash
#
# DSH 桌面版「多窗口」端到端验证。
#
# 为什么要用假 dsh：
#   真实 dsh web 冷启动要十几秒，两次启动就是半分钟，验证多窗口行为没必要等；
#   用一个「真监听端口 + 打印 dsh 风格就绪行」的假脚本，行为一致但秒级完成。
#   假脚本返回的页面里带自己的 pid，所以能反过来证明「第二个窗口连的是第一个实例的服务」。
#
# 为什么两个壳必须共用同一个 --user-data-dir（这一点很关键，别改成两份）：
#   Electron 的单实例锁是挂在 userData 目录上的。真实使用中用户点两次图标，两次的
#   userData 都是 ~/.config/Dsh Desktop —— 所以真实路径是「第二个壳拿不到锁」。
#   如果测试给两份不同的 userData，两个壳都能拿到锁，走的就是另一条分支（锁成功 +
#   复用地址），虽然也能通过，但没测到真实路径。这里刻意共用一个，复现真实情形。
#
# 全程隔离，不碰正在使用的 ~/.dsh-desktop：
#   DSH_DESKTOP_APP_DIR  指向 /tmp 下的独立数据目录
#   DSH_DESKTOP_DSH_BIN  指向假 dsh
#   --user-data-dir      指向 /tmp 下的独立 Chromium 用户数据（两个壳共用这一份）
#
# 覆盖的断言：
#   1. 第二个壳报告「未持锁」，并识别出可复用地址；
#   2. 全程只起了一个假 dsh（第二个壳没有自起服务器）；
#   3. 两个窗口的几何信息各记各的，互不覆盖；
#   4. server.pid 归属主壳，副壳不抢占；
#   5. 关掉副窗口只退它自己：主壳与主服务都还在，公告也没被误删；
#   6. 关掉主窗口：服务被回收、公告被撤下，无残留进程。
#
# 测试窗口会短暂出现在当前桌面上（DISPLAY 与真实桌面相同），结束时全部清理。

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${E2E_ROOT:-/tmp/dsh-desktop-multi}"
ELECTRON="$REPO_DIR/node_modules/electron/dist/electron"
NODE_BIN="$(command -v node)"

PASS=0
FAIL=0
log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m✘\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

alive() { kill -0 "$1" 2>/dev/null; }

# 等一个文件出现。
# 注意：local 的多个赋值不能互相引用 —— `set -u` 下同一行里 `end=$((SECONDS + timeout))`
# 会先于 `timeout` 的赋值被展开，直接报「未绑定的变量」。所以分行写。
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
}
trap cleanup EXIT

# ── 准备隔离环境 ─────────────────────────────────────────────
rm -rf "$ROOT"
# 注意：只有一个 userData 目录 —— 两个壳共用，复现「用户点两次图标」的真实情形
mkdir -p "$ROOT/app" "$ROOT/ud1"

cat > "$ROOT/fake-dsh" <<FAKE
#!${NODE_BIN}
// 假 dsh：解析 --port，监听它，打印 dsh 风格的访问地址行，然后一直活着。
const http = require('node:http');
let port = 0;
const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
if (i >= 0) port = Number(argv[i + 1]) || 0;
const starts = require('node:fs');
starts.appendFileSync('${ROOT}/fake-starts.log', \`pid=\${process.pid} port=\${port}\n\`);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>FAKE DSH</title><body>fake-dsh-pid=' + process.pid + '</body>');
});
server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log(\`dsh web: http://127.0.0.1:\${actual}/?token=FAKETOKEN\`);
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); });
}
FAKE
chmod +x "$ROOT/fake-dsh"

run_shell() {
  local ud="$1"
  DSH_DESKTOP_APP_DIR="$ROOT/app" \
  DSH_DESKTOP_DSH_BIN="$ROOT/fake-dsh" \
  "$ELECTRON" --no-sandbox --user-data-dir="$ud" "$REPO_DIR" >/dev/null 2>&1 &
  echo $!
}

# ── 场景：先开第一个壳，等它公告地址，再开第二个壳 ──────────────
log "启动第一个壳（应自起服务器并公告地址）"
PID1="$(run_shell "$ROOT/ud1")"
PIDS+=("$PID1")
info "壳1 pid=$PID1"

if wait_file "$ROOT/app/endpoint.json" 30; then
  ok "第一个壳写出了 endpoint.json"
  ENDPOINT_PORT="$(grep -o '"port": *[0-9]*' "$ROOT/app/endpoint.json" | grep -o '[0-9]*')"
  info "公告端口=$ENDPOINT_PORT"
  info "公告里的 shellPid=$(grep -o '"shellPid": *[0-9]*' "$ROOT/app/endpoint.json" | grep -o '[0-9]*')"
else
  bad "第一个壳没有写出 endpoint.json（超时 30s）"
fi

if [[ -s "$ROOT/fake-starts.log" ]]; then
  ok "假 dsh 已启动 1 次：$(head -1 "$ROOT/fake-starts.log")"
else
  bad "假 dsh 没有启动"
fi

log "启动第二个壳（应复用第一个壳的服务器，不再自起）"
PID2="$(run_shell "$ROOT/ud1")"   # 与壳1 共用 userData，所以第二个壳必然拿不到锁
PIDS+=("$PID2")
info "壳2 pid=$PID2"

# 第二个壳应该在很短时间内进入复用分支（不需要等服务器冷启动）。
# 匹配串用「本窗口不再启动服务器」而不是「复用已有实例的服务器」：
# 后者在「未抢到单实例锁：本次启动将复用已有实例的服务器…」那行里也出现，
# 用它做条件会立刻命中，断言就跑到真正接上之前去了。
if wait_until 25 "grep -q '本窗口不再启动服务器' '$ROOT/app/app.log'"; then
  ok "第二个壳走了复用分支"
  grep '本窗口不再启动服务器' "$ROOT/app/app.log" | tail -1 | sed 's/^/      /'
else
  bad "第二个壳没有走复用分支（日志里找不到「复用已有实例的服务器」）"
fi

# 确认测的是真实路径：第二个壳必须报「未抢到单实例锁」。
# 若这里失败，说明两个壳拿到了不同的 userData、各自都持锁，那就没测到用户实际会走的分支。
if grep -q '未抢到单实例锁' "$ROOT/app/app.log"; then
  ok "第二个壳确实没拿到单实例锁（复现了真实点击两次图标的路径）"
else
  bad "日志里没有「未抢到单实例锁」记录：本次没有复现真实路径"
fi

sleep 3  # 留出加载页面的时间

# 断言 2：只起了一个假 dsh
STARTS="$(wc -l < "$ROOT/fake-starts.log" 2>/dev/null || echo 0)"
if [[ "$STARTS" -eq 1 ]]; then
  ok "全程只起了一个 dsh 服务（假 dsh 启动次数=$STARTS）"
else
  bad "dsh 服务启动次数应为 1，实际 $STARTS"
  sed 's/^/      /' "$ROOT/fake-starts.log"
fi

# 断言 3：两个壳都还活着
if alive "$PID1"; then ok "壳1 存活"; else bad "壳1 意外退出"; fi
if alive "$PID2"; then ok "壳2 存活"; else bad "壳2 意外退出"; fi

# 断言 3b：屏幕上真的出现了两个 DSH 窗口。
# 这一步不能用「日志里写了窗口已显示」代替 —— show() 被调用不代表窗口管理器真的建出了窗口，
# 而用户能看到的只有窗口。
#
# 两个检测细节：
#   ① 按「拥有该窗口的进程 pid」找，而不是按标题找：窗口标题会被页面内容影响
#      （Electron 默认会让 document.title 顶掉窗口标题），按标题找会脆断；
#   ② 按 pid 找的是 Electron 主进程还是渲染进程可能因平台而异，所以数量只要求 >= 1/进程。
if command -v xdotool >/dev/null 2>&1; then
  W1="$(xdotool search --pid "$PID1" 2>/dev/null | wc -l)"
  W2="$(xdotool search --pid "$PID2" 2>/dev/null | wc -l)"
  if [[ "$W1" -ge 1 && "$W2" -ge 1 ]]; then
    ok "两个壳名下都有真实存在的 X 窗口（壳1 $W1 个，壳2 $W2 个）"
  else
    bad "有壳没有对应窗口：壳1=$W1 个，壳2=$W2 个"
  fi
  # 副窗口标题必须能与主窗口区分（页面会试图改标题，本程序用 page-title-updated 钉住了它）
  if xdotool search --name '副窗口' >/dev/null 2>&1; then
    ok "副窗口标题带「副窗口」标记，可与主窗口区分"
  else
    bad "没有找到标题带「副窗口」的窗口（标题可能被页面内容顶掉了）"
    xdotool search --pid "$PID2" 2>/dev/null | while read -r wid; do
      echo "      壳2 的窗口 $wid 标题：$(xdotool getwindowname "$wid" 2>/dev/null)"
    done
  fi
else
  info "系统没有 xdotool，跳过窗口存在性检查"
fi

# 断言 4：两个窗口的几何信息各记各的（多开时最容易踩的坑：互相覆盖）
sleep 1
if [[ -s "$ROOT/app/window-state.secondary.json" ]]; then
  ok "副窗口使用独立的窗口状态文件：$(tr -d '\n ' < "$ROOT/app/window-state.secondary.json")"
else
  bad "副窗口没有写出 window-state.secondary.json"
fi
if [[ -s "$ROOT/app/window-state.json" ]]; then
  ok "主窗口的状态文件由主窗口自己维护：$(tr -d '\n ' < "$ROOT/app/window-state.json")"
else
  bad "主窗口没有写出 window-state.json"
fi

# 两个文件里的几何信息必须来自各自的窗口。这里用 x 坐标区分：
# 两个窗口是分别创建的，位置参数不同；若共用文件，两份内容会完全一样。
X_MAIN="$(grep -o '"x": *-\?[0-9]*' "$ROOT/app/window-state.json" 2>/dev/null | grep -o '\-\?[0-9]*' | head -1)"
X_SECOND="$(grep -o '"x": *-\?[0-9]*' "$ROOT/app/window-state.secondary.json" 2>/dev/null | grep -o '\-\?[0-9]*' | head -1)"
if [[ -n "$X_MAIN" && -n "$X_SECOND" ]]; then
  if [[ "$X_MAIN" == "$X_SECOND" ]]; then
    info "两个窗口当前 x 坐标相同（都被窗口管理器放在了同一处，不影响判定）"
  else
    ok "两个窗口各自记住了自己的位置（主 x=$X_MAIN，副 x=$X_SECOND）"
  fi
fi

# 断言 5：副窗口没有写 server.pid（那份属于主实例）
PID_OWNER="$(grep -o '"shellPid": *[0-9]*' "$ROOT/app/server.pid" 2>/dev/null | grep -o '[0-9]*')"
if [[ "$PID_OWNER" == "$PID1" ]]; then
  ok "server.pid 归属主壳（shellPid=$PID_OWNER），副壳没有抢占"
else
  bad "server.pid 归属异常：期望 $PID1，实际 ${PID_OWNER:-空}"
fi

# ── 关掉副窗口：只应退它自己 ──────────────────────────────────
log "关闭副窗口（应只退副壳，主壳与主服务保持存活）"
kill -TERM "$PID2" 2>/dev/null
if wait_until 15 "! kill -0 $PID2 2>/dev/null"; then
  ok "副壳已退出"
else
  bad "副壳未退出"
fi

sleep 2
if alive "$PID1"; then ok "主壳仍然存活"; else bad "主壳被副壳的退出带走了"; fi
if kill -0 "$(grep -o '"pid": *[0-9]*' "$ROOT/app/server.pid" | grep -o '[0-9]*' | head -1)" 2>/dev/null; then
  ok "主服务仍然存活"
else
  bad "主服务被误杀了"
fi
if [[ -s "$ROOT/app/endpoint.json" ]]; then
  ok "公告未被副壳误删（后来的窗口仍能复用）"
else
  bad "公告被副壳误删了"
fi
# 副壳必须走「只退自己」这条分支，而不是把自己当成主实例
if grep -q '副窗口已关闭，仅退出本进程' "$ROOT/app/app.log"; then
  ok "副壳按副窗口语义退出（未停服务器）"
else
  bad "副壳没有走副窗口退出分支"
fi

# ── 关掉主窗口：一切都应干净退出 ───────────────────────────────
log "关闭主窗口（应停服务并撤下公告）"
kill -TERM "$PID1" 2>/dev/null
if wait_until 20 "! kill -0 $PID1 2>/dev/null"; then
  ok "主壳已退出"
else
  bad "主壳未退出"
fi
sleep 2
if pgrep -f "$ROOT/fake-dsh" >/dev/null 2>&1; then
  bad "假 dsh 仍在运行（残留进程）"
  pgrep -af "$ROOT/fake-dsh" | sed 's/^/      /'
else
  ok "假 dsh 已被回收，无残留"
fi
if [[ -f "$ROOT/app/endpoint.json" ]]; then
  bad "主壳退出后公告仍然存在（下次启动会去连一个死地址）"
else
  ok "公告已撤下"
fi
# 主壳要按主实例语义退出：停服务 + 撤公告
if grep -q '已撤下服务器地址公告' "$ROOT/app/app.log"; then
  ok "主壳退出时主动撤下了公告"
else
  bad "主壳没有撤公告的记录"
fi
# 副壳退出时绝不该留下去连死地址的痕迹：它不能动公告
if grep -qE '窗口状态失败|未捕获异常' "$ROOT/app/app.log"; then
  bad "日志里出现异常："
  grep -E '窗口状态失败|未捕获异常' "$ROOT/app/app.log" | head -3 | sed 's/^/      /'
else
  ok "全程没有未捕获异常或状态保存失败"
fi

printf '\n\033[1m结果：%d 通过，%d 失败\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
