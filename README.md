English | [中文](README.zh-CN.md)

# dsh-desktop —— Turn DSH into a Desktop Application

This project packs the dsh web UI into a native Electron window, and **closing every window = quitting the app and stopping the background dsh service**,
leaving no background residue behind — as long as any window is still using the shared background service, it keeps running.

> **Semantics change (2026-10-10, second version)**
> The first version was "closing the window = hiding to the system tray, the server keeps running". In real use, after the user closed the window
> the background `dsh web` was still running, and the only way out was to dig through `ps` and kill the process yourself — which is exactly the
> problem the second version fixes. There is no tray and no hiding now: **closed means closed**.

> **Semantics change (2026-10-15, fourth version)**
> The third version supported multiple windows (several windows sharing one background service), but the server's lifetime was tied to "the window
> that started it": closing the main window made the service the secondary window was using vanish on the spot. The fourth version replaces the
> criterion with **"is any window still using it"**: after the main window closes the service keeps running (the secondary window is unaffected and
> newly opened windows can still attach), and the service is only reclaimed when the last window quits. See sections 5 and 6.

## 1. What It Actually Does

```
┌──────────────────────────────────────────────┐
│  Dsh Desktop (Electron shell)                │
│  ┌────────────────────────────────┐          │
│  │  the dsh web UI                │          │  ← the window loads the original DSH UI
│  └────────────────────────────────┘          │
│         │ supervises (parent/child process)  │
│         ▼                                    │
│  dsh web --no-open --port 0                  │  ← the port is assigned by the OS and reclaimed when the shell exits
└──────────────────────────────────────────────┘
```

Four key points:

1. **It starts the server itself and reclaims it itself**: on launch the app starts a dedicated `dsh web` with `--port 0`, so the OS picks a free
   port and it never competes for a port with a `dsh web` you run manually in a terminal; on exit it reclaims by
   process group, leaving no orphan processes.
2. **It must resolve the URL that carries the token**: the DSH web UI has an anti-leech check, so visiting `127.0.0.1:<port>` directly only gets you a 401.
   Once the server is up it prints the only usable URL (with a one-time token), and the desktop shell picks that line out of its output and then loads it.
   (Since the fourth version the server's stdout/stderr go straight to `dsh-server.log` and the shell reads that line from the file, so a dead shell
   no longer leaves the server attached to a broken pipe — see section 6.)
   This is also why you first see a "Starting the DSH server…" transition page — a cold start has to assemble the whole profile, measured at 17–40 seconds in practice.
3. **Closing all windows is quitting** (second version, refined by the fourth): the `close` event is no longer intercepted; closing a window quits
   that window's process, while the background service is reclaimed when **the last window** quits. The features that used to live in the tray menu
   (open in browser, restart the server, view the log, open the data directory) have all moved under the `DSH` application menu.
4. **You can open more than one window** (third version): clicking the icon again opens another window that loads **the same URL** —
   the equivalent of two browser windows showing the same page. It does not start a second background service.
   The first window starts the server and publishes its URL to `~/.dsh-desktop/endpoint.json`; later windows read that and attach to it.
   See sections 5 and 6.

## 2. Exit and Reclaim: Four Paths + One Safety Net

The "shell is gone but the background service is still running" problem has to be sealed off on every exit path, so:

| Trigger | Which path it takes | Result |
| --- | --- | --- |
| Window × / Alt+F4 / taskbar right-click "Quit" | window `close` → `window-all-closed` → `app.quit()` → `before-quit` finalization | this window exits; **the service keeps running if other windows still use it**, otherwise it is reclaimed by SIGTERM→SIGKILL |
| Application menu "Quit" / `Ctrl+Q` | same as above | same as above |
| Logout, shutdown, `kill <shell pid>` in a terminal (SIGTERM/SIGINT/SIGHUP) | signal handler → `app.quit()` → `before-quit` finalization | same as above (**this is the one the first version missed**) |
| The process reaches `exit` abnormally (`before-quit` did not finish) | `process.on('exit')` synchronously delivers one extra SIGKILL | only when this window is the last user; otherwise the service is left untouched |
| `kill -9` / crash (none of the above has time to run) | the next launch reads `~/.dsh-desktop/server.pid` and cleans up the residue | the leftover service is reaped, no manual handling needed |

"Is any window still using it" is answered by the registry in `~/.dsh-desktop/clients/<pid>.json`: every shell registers itself on start and removes
its entry on exit, and right before exiting it counts how many entries are left.

`~/.dsh-desktop/server.pid` records "the server pid + the pid of the shell that started it + the full command line + the start time".
It serves two purposes: cleaning up residue from a previous run, and letting **the last window to exit** stop a server it did not start itself.
When cleaning up residue on the next launch there are four gates, all of which must hold; the principle is **rather miss a leftover than kill the wrong process**:

1. the recorded process is still alive;
2. its command line really is the `dsh web ... --no-open ...` started by this program (this rules out pid reuse by the system);
3. the shell that started it, as recorded, is already gone;
4. **no other live window is registered** (while a window is using that server, it must not be touched).

That is why a `dsh web` you run manually in a terminal will never be hit by this mechanism.

## 3. Installation and Usage

```bash
cd dsh-desktop                   # the directory you cloned this repository into
npm install                      # only needed when the dependencies are not installed yet
bash tools/install-launcher.sh   # generate icons + register the application + put a launcher on the desktop
```

After installation there are three ways to launch it:

- search for `DSH` in the application list;
- double-click the "DSH 桌面版" (DSH Desktop) icon on the desktop;
- from the command line: `./bin/dsh-desktop`

Window operations:

| Operation | Effect |
| --- | --- |
| Click the window × | quits this window; the background service keeps running while other windows still use it, and is reclaimed when the last window quits |
| `Ctrl+Q` / application menu "Quit" | same as above |
| Application menu `DSH` | show the window, open the current URL in a browser, restart the server, view the server log, open the data directory |

The log and state files all live in `~/.dsh-desktop/`:

- `app.log`: the desktop shell's own log (startup order, window events, exit flow, exit decision);
- `dsh-server.log`: the raw output of `dsh web` + the server lifecycle (start, stop, residue cleanup),
  that is, the file opened by the application menu's "view the server log";
- `server.pid`: the pid record of the currently supervised server (deleted on a normal exit; if it is still there, the last run was hard-killed);
- `endpoint.json`: the access URL bulletin of the running server (carries the token, mode 0600), reused by later windows;
- `clients/`: the registry of who is using the background service (one `<pid>.json` per window);
- `window-state.json`: remembered window size and position.

> The data directory can be overridden with the `DSH_DESKTOP_APP_DIR` environment variable (the end-to-end test relies on it for isolation);
> `DSH_DESKTOP_DSH_BIN` selects which `dsh` executable to use.

## 4. Directory Structure

| File | Purpose |
| --- | --- |
| `main.js` | Electron main-process wiring: window creation, startup order, signal handling, tying the modules below together |
| `lib/quit-flow.js` | Exit decision and finalization (the fourth-version core: is any window still using it, should it be reclaimed, how to reclaim one you did not start) |
| `lib/window-state.js` | Window geometry memory (one file per window mode, so they do not overwrite each other) |
| `lib/menu.js` | Application menu (including mode branches such as "a secondary window must not restart the server") |
| `lib/server.js` | Supervision of the `dsh web` child process: start, parse the access URL, stop by process group, pid record and residue cleanup |
| `lib/endpoint.js` | Bulletin board for the running server's URL, so later windows can reuse the same address |
| `lib/clients.js` | Client registry: who is currently using this server (decides whether it gets reclaimed on exit) |
| `lib/procinfo.js` | Process liveness / command-line reading / identity checks (shared by the three modules above so the semantics cannot drift) |
| `loading.html` | the transition page shown before the server is ready (gives the user clear feedback instead of a blank screen) |
| `bin/dsh-desktop` | launch script: fills in PATH, passes `--no-sandbox`; `Exec=` points at it |
| `tools/make-icons.py` | generates the application icons from the official favicon (brand-blue rounded background + white logo) |
| `tools/install-launcher.sh` | installs the icons, writes the `.desktop` file, places the desktop launcher icon (idempotent, safe to re-run) |
| `tools/endpoint-selftest.js` | behaviour self-test for `lib/endpoint.js` (permissions, staleness checks, server-liveness criterion) |
| `tools/clients-selftest.js` | behaviour self-test for `lib/clients.js` (register/unregister, dead pid filtering, pid-reuse protection) |
| `tools/quit-flow-selftest.js` | behaviour self-test for `lib/quit-flow.js` (decision, reclaim, race protection when the pid record is rewritten mid-stop) |
| `tools/e2e-close-test.sh` | end-to-end verification of the close semantics (isolated environment, see the next section) |
| `tools/e2e-multi-window-test.sh` | end-to-end verification of multi-window (reproduces the real "click the icon twice" path) |
| `tools/e2e-owner-first-test.sh` | end-to-end verification of **closing the main window first** (the service must stay until the last window quits) |
| `tools/e2e-real-multi-window-test.sh` | the same, but with a real `dsh web`, verifying the second window loads a real page |
| `tools/e2e-reuse-wait-test.sh` | verifies the wait logic for "the icon was clicked again while the first instance was still cold-starting" |
| `assets/` | icon resources and the SVG of the official dsh logo |

## 5. How Multiple Windows Work

Opening a DSH window on each of two screens does not mean "two background services" — it means **reusing the same URL**:

```
1st click → shell A starts dsh web → publishes the URL + server pid to ~/.dsh-desktop/endpoint.json
2nd click → shell B fails the single-instance lock → reads the bulletin → loads the same URL (starts no server of its own)
```

Details worth knowing:

- **Failing the single-instance lock does not mean the process must quit.** Electron's lock only tells the app that another shell is running;
  the process itself keeps executing — verified experimentally. So the key to multiple windows is not to call `quit()` when you get `false`,
  but to switch to reuse mode. Earlier versions quit right there, which is why a second click on the icon did nothing.
- **The lock is tied to the userData directory**, and both shells share `~/.config/Dsh Desktop`, so the second shell is always "lock not acquired".
  The test scripts deliberately share one `--user-data-dir` to reproduce that real path.
- **It waits instead of racing.** The first shell may still be cold-starting (tens of seconds) with no bulletin written yet.
  The second shell waits up to 30 seconds; if the bulletin shows up it attaches, otherwise it falls back to starting its own server.
  This is what makes the common "nothing happened, click again" interaction work correctly.
- **Each window remembers its own geometry** (`window-state.json` and `window-state.secondary.json`),
  otherwise you would have to drag the window into place on every launch.
- **Sharing one backend has one limitation**: two windows showing **the same session** interfere with each other (neither sees the other's live stream).
  Prefer one session per window — project A's session on screen A and project B's on screen B.

## 6. Server Lifetime: Reclaimed Only When the Last Window Quits

This is the core rule of the fourth version, in one sentence: **the server belongs to no single window — it belongs to the windows that are open right now.**

```
every shell on start → writes clients/<pid>.json ("I am using it")
every shell on exit  → removes its own entry, then counts what is left:
     ≥ 1 left → the server process, the URL bulletin and the server.pid record are all left untouched
     0 left   → take the bulletin down, then stop the server
                  · we started it  → stop the child process (SIGTERM → SIGKILL by process group)
                  · someone else did → verify the identity from server.pid and stop that process group
                                       (this is how a secondary window can turn off the light)
```

The resulting behaviour:

| Action | Background service | Note |
| --- | --- | --- |
| Close a secondary window (main window still open) | keeps running | always behaved this way |
| **Close the main window (secondary still open)** | **keeps running** | fixed in the fourth version; the secondary window keeps working seamlessly and newly opened windows can still attach |
| Close the last window | reclaimed | bulletin taken down + process group stopped, no residue |
| The last window is `kill -9`ed | reclaimed on the next launch | the shell had no chance to finalize; `server.pid` is the safety net |

Four easy traps, all guarded against in the code:

- **"Is anyone else using it" must exclude yourself**, otherwise every window thinks "someone else is still there" and the server can never be reclaimed.
- **One window shows up as several processes.** Besides the Electron main process there are zygote / GPU / renderer processes whose command lines all
  carry the Electron path; matching on "command line contains electron" would count one window as four, so `--type=` children must be excluded.
- **The registry gets polluted by dead pids** (a `kill -9`ed shell has no chance to unregister). Reads filter out dead pids and clean them up,
  and they also verify the command line — otherwise a recycled pid would make a dead window look permanently alive.
- **The server's output must not stay attached to the shell's pipe.** A pipe breaks when the shell exits and the server's next write to stdout hits an
  unhandled EPIPE, which ends the process — "the service survives after the main window closes" would then only last until its next log line.
  So from the fourth version on, stdout/stderr go straight to `dsh-server.log` and the ready URL is read from that file.

## 7. Verifying

```bash
# unit self-tests (all instant, no GUI needed)
node tools/endpoint-selftest.js     # URL bulletin (15 checks)
node tools/clients-selftest.js      # client registry (11 checks)
node tools/quit-flow-selftest.js    # exit decision and reclaim (8 checks, incl. race protection)

# end-to-end (needs a graphical session; fully isolated from the shell you are using)
bash tools/e2e-owner-first-test.sh        # closing the MAIN window first (28 checks, fake dsh, under a minute) — the fourth-version fix
bash tools/e2e-multi-window-test.sh       # multiple windows and reuse (22 checks, fake dsh)
bash tools/e2e-close-test.sh              # the three close paths (15 checks)
bash tools/e2e-reuse-wait-test.sh         # icon clicked again during a cold start (13 checks)
bash tools/e2e-real-multi-window-test.sh  # real dsh: multiple windows + closing the main window first (21 checks, ~3 minutes)
```

The multi-window scripts assert, among other things: the second shell really reports "lock not acquired";
only one `dsh` service is started in total; two windows really exist on the X server; the secondary window's title carries the
"secondary" marker; the two window state files do not overwrite each other; `server.pid` belongs to the main shell;
closing the secondary window leaves the main service alone; and closing the last window reclaims the service and removes the bulletin.
`e2e-owner-first-test.sh` covers the reversed order: closing the **main** window keeps the service, the bulletin and the pid record alive,
the announced URL still answers, a third window opened afterwards still reuses the same service, and only closing the last window reclaims it.

They all run in an isolated environment (`DSH_DESKTOP_APP_DIR` pointing under `/tmp`, a fake `dsh` script,
a separate `--user-data-dir`), so they **never touch the desktop shell you are using and its server**.
The real-dsh script additionally points `DSH_HOME` at an empty directory, so it loads only the stock profile and never touches your plugins or credentials.

> Note: the test window briefly appears on the current desktop; when closing it, locate it precisely by **window pid**,
> never use `wmctrl -c <title substring>` — in the past doing so accidentally closed a user's browser window whose title contained "DeepSeek Harness".

## 8. Two Linux Pitfalls (Already Handled in the Code)

1. **`chrome-sandbox` permissions**: the sandbox helper shipped with Electron requires `root:root` + `4755`,
   which is naturally not satisfied when installed under `node_modules`, and launching directly exits with FATAL.
   The launch script therefore passes `--no-sandbox` (and `main.js` also has a permission probe as a fallback).
   This program only loads local loopback pages and gives the renderer process no Node capabilities, so the risk is contained.
   If you want to restore the Chromium sandbox, run once:

   ```bash
   sudo chown root:root node_modules/electron/dist/chrome-sandbox
   sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
   ```

2. **PATH is very clean when launched from an icon**: the graphical session's PATH does not include the npm global bin directory,
   so a direct `spawn('dsh')` cannot find the command. `bin/dsh-desktop` takes care of adding the npm global bin and the node directory to PATH.

## 9. Known Limitations

- Multiple windows share one backend: two windows showing **the same session** interfere with each other, so prefer one session per window.
- The desktop shell and the `dsh web` you run in a terminal are **two independent processes** (each with its own session runtime state),
  but the session files all land in `~/.dsh/sessions`, so history is visible from both sides.
  It is recommended to keep only one entry point, so you do not fight yourself over the same workspace files.
- "Closing the window quits" means **an accidental × will interrupt a running task**. This is the behavior the user explicitly chose
  (no tray, no confirmation dialog); when you need to run a long task, please do not close the window.
  Note that closing a window only interrupts anything when it is the **last** one: the background service (and therefore the tasks running
  in it) stays alive as long as another window is using it.
- **A secondary window cannot restart the server** (its menu has no "restart the server" entry): restarting would give the server a new port and a
  new token, which would pull the rug out from under the other windows. For the same reason, after the main window is closed the remaining windows
  still show "DSH (secondary window)" in the title — they keep working normally, they just do not take over the "main" identity.
- **Restarting the server from the main window still disconnects secondary windows**, because it moves to a new port/token. This path is unchanged
  by the fourth version; the fix would be to have a secondary window re-read the bulletin before reloading.
- A leftover server killed by `kill -9` will be cleaned up at the latest on the **next launch of the desktop shell**;
  if you want "the moment the shell dies the service dies with it", you would need to insert a supervising process between the shell and the server,
  which is not done at present (the benefit is smaller than the complexity).
- During an upgrade, an old-version shell does not write the client registry, so if an **old main window and a new secondary window** run side by side,
  closing the old main window still stops the service. Close every window and reopen to get the new semantics.
- The window title is pinned by this program (`preventDefault` in `page-title-updated`), so the page's own title is not shown —
  that is what makes it possible to tell "DSH" and "DSH (secondary window)" apart across two screens.

## License

This project is released under the MIT License. See [LICENSE](LICENSE) for the full text.
