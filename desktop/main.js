// airoom desktop shell.
//
// The main process is deliberately thin: it (1) starts the airoom server as a
// child process (or reuses one already running), (2) opens a window onto it,
// and (3) connects to the SAME WebSocket protocol as any other client to power
// the menu-bar badge and native notifications. No IPC, no special casing —
// the desktop shell is just another airoom client.
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const WebSocket = require('ws');

const DEFAULT_PORT = 8787;

/** Same absolute-path search the server uses — a GUI app has no useful PATH. */
function claudeBin() {
  const home = os.homedir(); // HOME is not set on Windows
  const candidates =
    process.platform === 'win32'
      ? [
          process.env.AIROOM_CLAUDE_BIN,
          path.join(home, '.local', 'bin', 'claude.exe'), // native installer, winget
          path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'), // npm -g
        ]
      : [
          process.env.AIROOM_CLAUDE_BIN,
          path.join(home, '.local', 'bin', 'claude'),
          path.join(home, '.claude', 'local', 'claude'),
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
        ];
  return candidates.filter(Boolean).find((c) => existsSync(c));
}

// Windows ties notifications and the taskbar to this id; harmless elsewhere.
app.setAppUserModelId('dev.airoom.app');
const ROOT = path.resolve(__dirname, '..');

let port = DEFAULT_PORT; // resolved before any window opens
const serverUrl = () => `http://127.0.0.1:${port}`;

/** @type {import('node:child_process').ChildProcess | null} */
let serverProc = null;
let win = null;
let tray = null;
let ws = null;
let wsRetry = 0;
const lastAttn = new Map(); // sessionId -> boolean, for notification edges
let booted = false; // suppress notifications for pre-existing state on launch

/** Is an airoom server (specifically) answering on this port? */
async function airoomAt(p) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(900) });
    const j = await r.json();
    return j.ok === true && 'engine' in j;
  } catch {
    return false;
  }
}

/** Is anything at all listening on this port? */
function occupied(p) {
  return new Promise((resolve) => {
    const probe = net
      .createServer()
      .once('error', () => resolve(true))
      .once('listening', () => probe.close(() => resolve(false)))
      .listen(p, '127.0.0.1');
  });
}

/**
 * Resolve which port to use: reuse a running airoom on 8787, else take 8787
 * if free, else walk up until a free port (some other app owns 8787).
 * Returns true if an existing server is being reused.
 */
async function resolvePort() {
  if (await airoomAt(DEFAULT_PORT)) {
    port = DEFAULT_PORT;
    return true;
  }
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 20; p++) {
    if (!(await occupied(p))) {
      port = p;
      return false;
    }
  }
  throw new Error('no free port found near 8787');
}

function spawnServer() {
  if (app.isPackaged) {
    // Packaged: single-file server bundle + built web UI from Resources,
    // run on Electron's own Node (no external runtime needed).
    const res = process.resourcesPath;
    console.log('[shell] starting bundled airoom server…');
    serverProc = spawn(process.execPath, [path.join(res, 'server', 'index.mjs')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(port),
        AIROOM_WEB_DIST: path.join(res, 'web'),
        // So the server can tell whether airoom.dev's newest build is newer
        // than this one (server/src/release.ts).
        AIROOM_VERSION: app.getVersion(),
      },
      stdio: 'inherit',
    });
  } else {
    // Dev: tsx watch — server code changes auto-restart INSIDE the app's own
    // user session, so credentials/keychain stay intact across iterations.
    const serverDir = path.join(ROOT, 'server');
    const tsx = path.join(serverDir, 'node_modules', '.bin', 'tsx');
    console.log('[shell] starting airoom server (dev)…');
    serverProc = spawn(tsx, ['watch', 'src/index.ts'], {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), AIROOM_VERSION: app.getVersion() },
      stdio: 'inherit',
    });
  }
  serverProc.on('exit', (code) => console.log(`[shell] server exited (${code})`));
}

async function ensureServer() {
  if (await resolvePort()) {
    console.log('[shell] reusing running airoom server');
    return;
  }
  spawnServer();
  for (let i = 0; i < 40; i++) {
    if (await airoomAt(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('airoom server did not become healthy');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    // The web topbar is the title bar on both platforms. On a Mac the traffic
    // lights overlay its left edge; on Windows the caption buttons overlay the
    // right edge, drawn by the OS in our colours and sized to the top strip.
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b0e14', symbolColor: '#a9b6cb', height: 30 } }
      : { titleBarStyle: 'hiddenInset' }),
    backgroundColor: '#0b0e14',
    title: 'airoom',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadURL(serverUrl());
  // external links (if any ever appear) go to the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  } else {
    createWindow();
  }
}

function setupTray() {
  // The Mac tray is a text glyph on an empty image; Windows shows nothing for
  // an empty image and has no tray text, so it gets a real icon and a tooltip.
  const icon =
    process.platform === 'win32'
      ? nativeImage.createFromPath(path.join(__dirname, 'build', 'tray-win.png'))
      : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setTitle('⌂');
  tray.setToolTip('airoom — agent control room');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open airoom', click: showWindow },
      { type: 'separator' },
      { label: 'Quit airoom', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}

function updateTray(snapshot) {
  if (!tray) return;
  let working = 0;
  let attention = 0;
  for (const r of snapshot.robots) {
    if (r.status === 'working') working++;
    if (r.needsApproval || r.status === 'waiting_input' || r.status === 'error') attention++;
  }
  tray.setTitle(attention > 0 ? `⚠ ${attention}` : working > 0 ? `▶ ${working}` : '⌂');
  tray.setToolTip(
    attention > 0
      ? `airoom — ${attention} need${attention === 1 ? 's' : ''} you`
      : working > 0
        ? `airoom — ${working} working`
        : 'airoom — agent control room',
  );
}

function notifyAttention(snapshot) {
  for (const r of snapshot.robots) {
    const attn = !!r.needsApproval || r.status === 'waiting_input' || r.status === 'error';
    const prev = lastAttn.get(r.sessionId) ?? false;
    lastAttn.set(r.sessionId, attn);
    if (!booted || !attn || prev) continue;
    const room = r.roomId.split(/[\\/]/).filter(Boolean).pop() ?? r.roomId;
    const title = r.needsApproval
      ? `Approval needed — ${room}`
      : r.status === 'error'
        ? `Agent blocked — ${room}`
        : `Your move — ${room}`;
    const n = new Notification({ title, body: r.title, silent: false });
    n.on('click', showWindow);
    n.show();
  }
  booted = true;
}

function connectFleet() {
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('open', () => (wsRetry = 0));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'snapshot') {
        updateTray(msg.snapshot);
        notifyAttention(msg.snapshot);
      }
    } catch {
      /* ignore */
    }
  });
  ws.on('close', () => {
    const delay = Math.min(1000 * 2 ** wsRetry++, 8000);
    setTimeout(connectFleet, delay);
  });
  ws.on('error', () => ws.close());
}

/**
 * Hand a session off to Claude Code: open a terminal in the room's folder and
 * resume the session there. The transcript is the same file airoom drives, so
 * the conversation continues exactly where it left off.
 *
 * The command is assembled with quoted arguments and the ids are validated
 * first — this string reaches a shell, so nothing unvalidated goes into it.
 */
const SESSION_RE = /^[A-Za-z0-9._-]{6,100}$/;
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/**
 * Windows: a new tab in Windows Terminal when it is installed, otherwise a
 * plain console window. Arguments go verbatim, quoted by hand — cmd.exe's own
 * quoting rules and Node's escaping do not agree about anything, and the
 * session id was validated above so nothing here is unvalidated.
 */
function openOnWindows(cwd, bin, sessionId) {
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  const claude = sessionId ? `${q(bin)} --resume ${sessionId}` : q(bin);
  const shown = `cd /d ${q(cwd)} && ${claude}`;
  const attempt = (cmd, args) =>
    new Promise((resolve) => {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
      p.on('error', (err) => resolve({ ok: false, error: String(err) }));
      p.on('spawn', () => {
        p.unref();
        resolve({ ok: true, cmd: shown });
      });
    });
  return attempt('wt.exe', ['-d', q(cwd), 'cmd', '/k', claude]).then((r) =>
    r.ok ? r : attempt('cmd.exe', ['/c', 'start', '""', '/d', q(cwd), 'cmd', '/k', claude]),
  );
}

ipcMain.handle('airoom:open-claude', async (_e, { cwd, sessionId } = {}) => {
  if (typeof cwd !== 'string' || !existsSync(cwd)) return { ok: false, error: 'folder not found' };
  if (sessionId != null && !SESSION_RE.test(String(sessionId)))
    return { ok: false, error: 'bad session id' };

  const bin = claudeBin() ?? 'claude';
  if (process.platform === 'win32') return openOnWindows(cwd, bin, sessionId);
  const cmd = sessionId
    ? `cd ${shq(cwd)} && ${shq(bin)} --resume ${shq(sessionId)}`
    : `cd ${shq(cwd)} && ${shq(bin)}`;

  // Prefer the terminal the user actually lives in.
  const iterm = existsSync('/Applications/iTerm.app');
  const esc = (t) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = iterm
    ? `tell application "iTerm"
         create window with default profile
         tell current session of current window to write text "${esc(cmd)}"
         activate
       end tell`
    : `tell application "Terminal"
         do script "${esc(cmd)}"
         activate
       end tell`;

  return await new Promise((resolve) => {
    const p = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    p.on('error', (err) => resolve({ ok: false, error: String(err) }));
    p.on('exit', (code) =>
      resolve(code === 0 ? { ok: true, cmd } : { ok: false, error: `osascript exited ${code}`, cmd }),
    );
  });
});

// Native folder picker for "+ project" (window.prompt is unsupported in
// Electron renderers, so the UI calls this over the preload bridge instead).
ipcMain.handle('airoom:pick-folder', async () => {
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: 'Add a project to airoom',
    buttonLabel: 'Add project',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

app.whenReady().then(async () => {
  try {
    await ensureServer();
  } catch (err) {
    console.error('[shell]', err);
  }
  createWindow();
  setupTray();
  connectFleet();
  console.log('[shell] ready');
});

// Mac behavior: closing the window keeps airoom alive in the menu bar.
app.on('window-all-closed', () => {
  /* stay resident */
});
app.on('activate', showWindow);

/**
 * Ask before quitting on top of work in progress.
 *
 * Quitting takes every agent run down with it: a team mid-task is parked and
 * has to be picked back up by hand, and a long turn's work in that turn is
 * gone. The app used to do that silently, on a Cmd-Q typed at the wrong
 * moment. `busy` on /health is the server's own answer to "am I in the middle
 * of something?"; if it cannot be reached, we assume idle rather than trapping
 * someone in a dialog they cannot escape.
 */
let quitConfirmed = false;

async function busyNow() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const b = (await res.json())?.busy;
    return b && (b.runs > 0 || b.teams > 0) ? b : null;
  } catch {
    return null; // no server, or it is not answering — nothing to lose
  }
}

app.on('before-quit', (e) => {
  if (quitConfirmed) return;
  e.preventDefault();
  void (async () => {
    const busy = await busyNow();
    if (busy) {
      const runs = busy.runs === 1 ? '1 agent is working' : `${busy.runs} agents are working`;
      const teams = busy.teamNames?.length
        ? `\n\nTeams still running: ${busy.teamNames.join(', ')}.`
        : '';
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Quit anyway', 'Keep airoom open'],
        defaultId: 1,
        cancelId: 1,
        message: busy.runs > 0 ? `${runs} right now.` : 'A team is still working.',
        detail:
          'Quitting stops them where they are. Teams can be picked back up with Continue, but whatever the current turn was doing is lost.' +
          teams,
      });
      if (response !== 0) return; // stay open
    }
    quitConfirmed = true;
    app.quit();
  })();
});

/**
 * Quitting waits for the server this shell started, up to five seconds, so a
 * headless airoom never outlives the app. The ask goes over HTTP because
 * Windows has no SIGTERM — a signal there is an immediate kill, which skips
 * parking the teams (see shutdown in server/src/index.ts). The signal remains
 * the fallback for a server that is not answering, and SIGKILL after that.
 * Dev keeps the plain signal: tsx forwards it to the server it watches.
 */
let serverStopping = false;
app.on('will-quit', (event) => {
  if (!serverProc || serverProc.exitCode !== null || serverStopping) return;
  if (!app.isPackaged) {
    serverProc.kill('SIGTERM');
    return;
  }
  serverStopping = true;
  event.preventDefault();
  const finish = () => app.exit(0);
  const hardStop = setTimeout(() => {
    try {
      serverProc.kill('SIGKILL');
    } catch {}
    finish();
  }, 5000);
  serverProc.once('exit', () => {
    clearTimeout(hardStop);
    finish();
  });
  fetch(`${serverUrl()}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1500) }).catch(() => {
    try {
      serverProc.kill('SIGTERM');
    } catch {}
  });
});

// One airoom per machine: a second launch hands over to the first instead of
// racing it for the port and putting a second icon in the tray.
if (!app.requestSingleInstanceLock()) {
  quitConfirmed = true; // nothing of ours to protect — the work is the other instance's
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}
