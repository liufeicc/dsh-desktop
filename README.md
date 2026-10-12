English | [中文](README.zh-CN.md)

# dsh-desktop —— Turn DSH into a Desktop Application

This project packs the dsh web UI into a native Electron window, and **closing the window = quitting the app = the background dsh service is stopped as well**,
leaving no background residue behind.

> **Semantics change (2026-10-10, second version)**
> The first version was "closing the window = hiding to the system tray, the server keeps running". In real use, after the user closed the window
> the background `dsh web` was still running, and the only way out was to dig through `ps` and kill the process yourself — which is exactly the
> problem the second version fixes. There is no tray and no hiding now: **closed means closed**.

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
   Once the server is up it prints the only usable URL (with a one-time token) to stdout, and the desktop shell captures that line and then loads it.
   This is also why you first see a "Starting the DSH server…" transition page — a cold start has to assemble the whole profile, measured at 17–40 seconds in practice.
3. **Closing the window is quitting** (second version): the `close` event is no longer intercepted; closing the window stops the background service and then quits the app.
   The features that used to live in the tray menu (open in browser, restart the server, view the log, open the data directory) have all moved under the `DSH` application menu.
4. **Single instance**: clicking the icon again does not start a second server; it brings the existing window to the front instead.

## 2. Exit and Reclaim: Four Paths + One Safety Net

The "shell is gone but the background service is still running" problem has to be sealed off on every exit path, so:

| Trigger | Which path it takes | Result |
| --- | --- | --- |
| Window × / Alt+F4 / taskbar right-click "Quit" | window `close` → `window-all-closed` → `app.quit()` → `before-quit` finalization | the shell exits, the server is reclaimed by SIGTERM→SIGKILL |
| Application menu "Quit" / `Ctrl+Q` | same as above | same as above |
| Logout, shutdown, `kill <shell pid>` in a terminal (SIGTERM/SIGINT/SIGHUP) | signal handler → `app.quit()` → `before-quit` finalization | same as above (**this is the one the first version missed**) |
| The process reaches `exit` abnormally (`before-quit` did not finish) | `process.on('exit')` synchronously delivers one extra SIGKILL | the server is force-killed |
| `kill -9` / crash (none of the above has time to run) | the next launch reads `~/.dsh-desktop/server.pid` and cleans up the residue | the leftover service is reaped, no manual handling needed |

`~/.dsh-desktop/server.pid` records "the child process pid + the shell's pid + the full command line + the start time".
When cleaning up residue on the next launch there are three gates, all of which must hold; the principle is **rather miss a leftover than kill the wrong process**:

1. the recorded process is still alive;
2. its command line really is the `dsh web ... --no-open ...` started by this program (this rules out pid reuse by the system);
3. the shell process in the record is already gone (if the shell is still there, that is the server it is using and must not be touched).

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
| Click the window × | quits the app and stops the background `dsh web` as well |
| `Ctrl+Q` / application menu "Quit" | same as above |
| Application menu `DSH` | show the window, open the current URL in a browser, restart the server, view the server log, open the data directory |

The log and state files all live in `~/.dsh-desktop/`:

- `app.log`: the desktop shell's own log (startup order, window events, exit flow);
- `dsh-server.log`: the raw output of `dsh web` + the server lifecycle (start, stop, residue cleanup),
  that is, the file opened by the application menu's "view the server log";
- `server.pid`: the pid record of the currently supervised server (deleted on a normal exit; if it is still there, the last run was hard-killed);
- `window-state.json`: remembered window size and position.

> The data directory can be overridden with the `DSH_DESKTOP_APP_DIR` environment variable (the end-to-end test relies on it for isolation);
> `DSH_DESKTOP_DSH_BIN` selects which `dsh` executable to use.

## 4. Directory Structure

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process: window, menu, exit flow, signal handling, window state memory |
| `lib/server.js` | Supervision of the `dsh web` child process: start, parse the access URL, stop by process group, pid record and residue cleanup |
| `loading.html` | the transition page shown before the server is ready (gives the user clear feedback instead of a blank screen) |
| `bin/dsh-desktop` | launch script: fills in PATH, passes `--no-sandbox`; `Exec=` points at it |
| `tools/make-icons.py` | generates the application icons from the official favicon (brand-blue rounded background + white logo) |
| `tools/install-launcher.sh` | installs the icons, writes the `.desktop` file, places the desktop launcher icon (idempotent, safe to re-run) |
| `tools/e2e-close-test.sh` | end-to-end verification of the close semantics (isolated environment, see the next section) |
| `assets/` | icon resources and the SVG of the official dsh logo |

## 5. Verifying the Close Semantics

```bash
bash tools/e2e-close-test.sh
```

It runs entirely in an isolated environment (`DSH_DESKTOP_APP_DIR` pointing at `/tmp/dsh-desktop-e2e`,
a fake `dsh` script + a separate `--user-data-dir`), so it **never touches the desktop shell you are using and its server**.
Three scenarios:

1. click the window × (`wmctrl -i -c <window id>`) → both the shell and the background service should disappear, and `server.pid` should be cleaned up;
2. send SIGTERM to the shell → both the shell and the background service should disappear;
3. hard-kill the shell with `kill -9` (reproducing the original problem: the service is still running) → on the next launch the shell must clear the residue and start a new server.

> Note: the test window briefly appears on the current desktop; when closing it, locate it precisely by **window pid**,
> never use `wmctrl -c <title substring>` — in the past doing so accidentally closed a user's browser window whose title contained "DeepSeek Harness".

## 6. Two Linux Pitfalls (Already Handled in the Code)

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

## 7. Known Limitations

- The desktop shell and the `dsh web` you run in a terminal are **two independent processes** (each with its own session runtime state),
  but the session files all land in `~/.dsh/sessions`, so history is visible from both sides.
  It is recommended to keep only one entry point, so you do not fight yourself over the same workspace files.
- "Closing the window quits" means **an accidental × will interrupt a running task**. This is the behavior the user explicitly chose
  (no tray, no confirmation dialog); when you need to run a long task, please do not close the window.
- A leftover server killed by `kill -9` will be cleaned up at the latest on the **next launch of the desktop shell**;
  if you want "the moment the shell dies the service dies with it", you would need to insert a supervising process between the shell and the server,
  which is not done at present (the benefit is smaller than the complexity).
- The window title bar shows the web page title (`DeepSeek Harness`); taskbar grouping relies on `StartupWMClass=Dsh Desktop`.

## License

This project is released under the MIT License. See [LICENSE](LICENSE) for the full text.
