# airoom for Windows — the plan

Written 13 September 2026 from an audit of the code as it stands (commit
13ba0fe plus the Windows work that follows this document). The aim is one
codebase, one release, two installers: the Mac dmg that exists today and a
Windows installer that behaves the same way on the same servers.

## What already works, and why

The most important finding of the audit is that the read path — the part that
turns a user's Claude Code sessions into rooms and robots — needs no redesign.
airoom does not decode `~/.claude/projects/<dir>` names into paths. It reads
the `cwd` field from each transcript and matches it to its project folder with
the same rule Claude Code uses to encode folders on every platform (every
character that is not a letter or a digit becomes `-`). A Windows transcript
whose `cwd` is `C:\Users\petrit\proj` will land in a room at that path without
anyone touching the parser.

Everything else that makes the app work is portable already or nearly so:

- The server is Node and runs under Electron's own Node on every platform.
- The Agent SDK spawns the user's Claude Code, which has a native Windows
  build (no WSL) installed to `%USERPROFILE%\.local\bin\claude.exe`.
- Lanes are `git worktree` operations through `execFileSync('git', …)`. Claude
  Code on Windows requires Git for Windows, so `git` is on PATH wherever
  airoom can run at all.
- Licensing is an HTTPS exchange plus an offline-verified token; only the
  machine fingerprint is platform-specific.
- The whole UI is a web page in an Electron window.

## What breaks, by layer

Every item below was found by reading the code, not by guessing.

### Server

| Where | Problem | Fix |
|---|---|---|
| `index.ts` `/room-git`, `/fs/list`; `LocalClaudeDataSource.ts` add/hide/curate | absolute paths are recognised by `startsWith('/')`, so `C:\…` is rejected | `path.isAbsolute`, plus a shared helper |
| `LocalClaudeDataSource.ts` `basename()`, collision naming; `index.ts` notices | `split('/')` on room paths | one `basename`/`segments` helper that accepts both separators |
| `agent/claudeBin.ts` | every candidate location is a Unix path; the shell probe runs `$SHELL -ilc 'command -v claude'`; output is filtered by `startsWith('/')`; the not-found copy says "on this Mac" | Windows candidates (`.local\bin\claude.exe`, `%APPDATA%\npm\claude.cmd` and `.exe`, `%LOCALAPPDATA%\Programs\claude\claude.exe`), a `where claude` probe on Windows, accept drive-letter paths, platform-neutral copy |
| `licence.ts` `machineFingerprint()` | `ioreg` on Mac, `machine-id` on Linux, MAC-address fallback elsewhere | Windows: `MachineGuid` from `HKLM\SOFTWARE\Microsoft\Cryptography` via `reg query`, same salted hash |
| `agent/ollama.ts` | Mac-only app path and `open -g -a` | must degrade to "not installed" on Windows, never crash; a Windows launcher is not a goal (local models are not advertised) |
| `agent/LocalClaudeController.ts` | `spawn('claude')` cannot run a `.cmd` shim without a shell | CLI engine is a fallback; use the discovered full path and `shell: true` only for `.cmd` |
| `team/worktrees.ts` | correct as written; lane folders under `~/.airoom/lanes` | verify path length (Windows 260-char limit is off by default on modern systems but worktree paths should stay short) |
| `~/.airoom/*` files | `os.homedir()` resolves to `C:\Users\<name>` | no change; document the location |

### Desktop shell (`desktop/main.js`)

| Where | Problem | Fix |
|---|---|---|
| `createWindow` | `titleBarStyle: 'hiddenInset'` is Mac-only; on Windows the OS frame appears | on Windows use `titleBarStyle: 'hidden'` with `titleBarOverlay` (caption buttons on the right, coloured to the chrome) |
| `setupTray` / `updateTray` | `nativeImage.createEmpty()` plus `setTitle()` — the title is Mac-only and an empty image is invisible on Windows | ship a 16/32px tray icon; show counts in the tooltip and, later, an overlay badge |
| `notifyAttention` | notifications need an AppUserModelID on Windows | `app.setAppUserModelId('dev.airoom.app')` before any notification |
| `open-claude` handoff | `osascript` into Terminal/iTerm | Windows Terminal (`wt.exe`) when present, else `cmd.exe /c start` with `/d` |
| `claudeBin()` | duplicate Unix search list | reuse the server's discovery, or mirror the Windows candidates |
| startup | two launches would start two servers | `app.requestSingleInstanceLock()` and focus the existing window |
| `window-all-closed` | keeping the app resident with no window is unusual on Windows | keep resident (the tray is the app's home) but make sure the tray always offers Open and Quit |
| `will-quit` | `serverProc.kill('SIGTERM')` is an immediate kill on Windows, so the server never parked its teams on quit; on the Mac the graceful path could also hang on an open connection and leave a headless server behind | the shell asks the server over `POST /shutdown`, waits up to five seconds for it to exit, then kills; the server gives itself a four-second deadline (done, 2026-09-13) |

### Web UI (`web/src`)

| Where | Problem | Fix |
|---|---|---|
| `styles.css` `.electron .topbar`, `.trial`, `.update` | 84px left padding reserves room for Mac traffic lights | on Windows reserve the right edge for the caption buttons instead; the body gets `platform-win32` from the preload bridge |
| `FolderPicker.tsx` | absolute path check and root display assume `/` | accept `C:\` and UNC roots; `/fs/list` returns drive letters as the top level |
| `ProjectChooser.tsx`, `App.tsx`, `devworld.tsx` | `split('/')` basenames | shared `basename` helper for both separators |
| keyboard shortcuts | already `metaKey || ctrlKey` in every composer | audit the footer hint copy for ⌘ |
| `Licence.tsx` device label | strips `.local` from the host name; fine on Windows | none |

### Packaging and distribution

| Item | State | Plan |
|---|---|---|
| electron-builder target | Mac dmg only | add `win` → `nsis` (x64 first, arm64 once tested); per-machine install off, desktop shortcut on |
| icon | `icon.icns` and `icon.svg` only | add a 256px `icon.png`; electron-builder derives the `.ico` |
| code signing | Apple Developer ID + notarisation | Windows: Azure Trusted Signing (cloud, ~$10/month, no key to manage) or an OV certificate; unsigned builds trip SmartScreen ("Windows protected your PC → More info → Run anyway"), acceptable for the private beta, not for the public download |
| where builds run | this Mac | electron-builder can package NSIS from macOS; signing and real testing want a Windows runner, so add a GitHub Actions workflow on `windows-latest` that runs the suites and uploads the installer |
| landing download | one file, `/download` | `/download?os=windows` served from `landing/downloads/airoom-x64.exe`; the download button detects the platform |
| release manifest | `release.json` has one `url` | add `windows: { url }`; the update strip picks its own platform's link |
| Windows waitlist | already collecting emails at `/waitlist` | the beta invite goes to that list |
| release recipe | Mac steps in memory and `landing/README.md` | add the Windows steps beside them |

## Status

| Phase | State | Commit |
|---|---|---|
| 0 — scaffolding | done; installer builds from the Mac and from the runner | 1178233 |
| 1 — server on Windows | **verified**: all 232 server tests green on `windows-latest`, lanes against real git included | dcea208 … 928ae42 |
| 2 — desktop shell | done; the installer runs and the app launches in a Windows 11 VM (five processes, tray and window up) — caption buttons, drag, tray and handoff still await a person's eyes | 8dc45b7 |
| 3 — UI on Windows | done; renderer up in the VM at 100 percent scaling — crispness, 125/150 percent and the picker's drive row still await a person's eyes | 8dc45b7 |
| 4 — packaging | installer built by Windows itself (workflow run 4); **public since 2026-09-14** at `/download?os=windows` through the landing chooser, unsigned by decision — SmartScreen warns once per file until a certificate exists; the step-by-step route to a signed build is `WINDOWS-SIGNING.md` | 5435379, b7ddaea |
| 5 — beta | **open beta**: the VM walk-through passed (rooms, chat, curate dialog, caption buttons, tray quit); the 0.1.16 x64 installer is the public Windows download; still to do: signing, the Windows waitlist email, 125/150 percent scaling and "open in Claude Code" checked by a person | 65fc822 |

The first Windows run took four rounds to go green, and every failure was
the test harness carrying a Mac assumption — HOME instead of USERPROFILE,
forward slashes in assertions, the runner's 8.3 short paths against git's
long ones — never the app. Nothing has yet been used by a person on Windows.

## Phases

Each phase ends in something that can be verified, and the earlier phases are
verifiable on the Mac: every path change ships with tests that run the same
logic through `path.win32`, and the Windows runner in CI executes the whole
server suite on real Windows before a single installer is built.

### Phase 0 — scaffolding (half a day)

1. `server/src/platform.ts`: `isWindows`, `isAbsolutePath`, `basename`,
   `segments` that accept both separators, and `homeDir()`. Every fix below
   goes through it, so there is one place to read when something looks wrong.
2. `.github/workflows/windows.yml`: on push and on demand, install, typecheck
   web and server, run the server suite, build the NSIS installer, upload it
   as an artifact. This is the only way to see the app run on Windows without
   buying a machine, and it should exist before any Windows code does.
3. Confirm electron-builder produces an NSIS installer from this Mac at all.
   **Confirmed on 13 September:** `electron-builder --win nsis --x64` produced
   an 82 MB unsigned installer from this Mac in one run.

**Done when:** the workflow is green on `windows-latest` with today's code,
even though the app itself is not yet usable there.

### Phase 1 — the server runs on Windows (one to two days)

1. Replace every `startsWith('/')` and `split('/')` on a filesystem path with
   the platform helper. Sites: `/room-git`, `/fs/list`, `addProject`,
   `curate`, hidden rooms, collision naming, notice copy.
2. `claudeBin.ts`: Windows candidates, `where claude` probe, drive-letter
   paths in `pickPathFromShellOutput`, `setupTokenCommand` PATH directories for
   Windows, "on this Mac" → "on this computer".
3. `licence.ts`: Windows machine fingerprint from `MachineGuid`.
4. `ollama.ts`: degrade cleanly on Windows.
5. `LocalClaudeController.ts`: run the discovered binary by full path; `.cmd`
   through a shell.
6. Tests: `platform-test.ts` for the helper under `path.win32`; extend
   `claude-bin-test.ts` with Windows candidates and `where` output; a
   fingerprint test that the Windows branch is taken and salted.

**Done when:** the server suite passes on the Windows runner, `/fs/list` walks
`C:\Users\<name>` in a Windows test, and a `~/.claude/projects` fixture with a
Windows `cwd` produces a room.

### Phase 2 — the desktop shell (one day)

1. Window: `titleBarStyle: 'hidden'` + `titleBarOverlay` on Windows, sized to
   the topbar; expose `platform` through `preload.js`; body class
   `platform-win32`; CSS reserves the right edge instead of the left.
2. Single-instance lock; `setAppUserModelId`; tray icon file; tooltip counts.
3. Terminal handoff through Windows Terminal or `cmd`.
4. Drag regions: keep `-webkit-app-region: drag` on the topbar and strips —
   it works on Windows — but exclude the caption-button area.

**Done when:** the installer from CI opens on a Windows VM, the window has a
proper title bar with working buttons, the tray shows an icon, and a
notification fires.

### Phase 3 — the UI on Windows (half a day)

1. `FolderPicker`: drive roots and `C:\` paths; the server lists drives at the
   top level.
2. `basename` helper in the web for room names and the chooser.
3. Walk every screen at 100% and 150% display scaling — Windows laptops are
   commonly 125–150%, and the pixel renderer must round to device pixels.

**Done when:** a session started on Windows appears as a robot in the right
room, its chat opens, a folder can be added through the picker, and the office
is crisp at 150%.

### Phase 4 — packaging and distribution (one day)

1. `desktop/package.json`: `win` target, `nsis` options, icon, artifact name
   `airoom-<version>-x64.exe`.
2. Landing: `/download?os=windows`, platform detection on the button, the
   badge copy ("Apple Silicon · macOS 13+" gains a Windows line), `release.json`
   per-platform URLs, the update strip choosing its platform.
3. Signing: set up Azure Trusted Signing, wire `win.signtoolOptions`, sign in
   CI. Until then, ship the beta unsigned with a one-line note about SmartScreen.
4. Release recipe: the Windows steps beside the Mac ones; CI produces the
   artifact, the recipe copies it into `landing/downloads/`.

**Done when:** `npm run dist` on the Mac still produces the dmg, CI produces a
signed installer, and both are served from airoom.dev with the right one
offered to each visitor.

### Phase 5 — beta (one week of calendar time)

1. Install on a clean Windows 11 VM: Claude Code native install, Git for
   Windows, airoom. Hire an agent, hire a team with lanes, merge, dismiss.
2. Invite the Windows waitlist with the direct link and the SmartScreen note.
3. Fix what they find; then the public download.

## Risks, in the order they would bite

1. **Display scaling.** The pixel renderer draws to a canvas sized in device
   pixels; 125% and 150% are the Windows norm and produce non-integer ratios.
   Test early, on the VM, before polishing anything else.
2. **Path length and characters.** Lane worktrees nest under
   `~/.airoom/lanes/<team>/<lane>`; keep slugs short. Room ids with
   backslashes travel through URLs, WebSocket messages and localStorage keys —
   encode them, never split them by hand.
3. **SmartScreen.** An unsigned installer looks like malware to a cautious
   user. Budget for signing before the public download, not after.
4. **Claude Code's own Windows quirks.** The native install sometimes fails to
   add itself to PATH (documented for domain accounts with dots in the user
   name). airoom's own discovery must find `.local\bin\claude.exe` without PATH
   and say plainly where it looked.
5. **Two servers on one port.** Without the single-instance lock a second
   launch would race the first for 8787 and the tray would show two icons.
6. **No Windows machine on hand.** CI covers tests and builds; only a VM
   covers the feel of the thing. Windows 11 on Apple Silicon runs well under
   UTM or Parallels and is the cheapest way to get one.

## Out of scope for the first Windows release

- ARM64 Windows builds (x64 runs under emulation on ARM Windows 11).
- A Windows launcher for local models.
- Auto-update beyond the existing release strip.
- WSL. The native Claude Code build is the target; a user who runs Claude
  Code inside WSL keeps their transcripts inside the Linux filesystem and
  airoom will not see them. Say so on the download page.
