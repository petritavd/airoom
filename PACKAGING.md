# Packaging airoom (macOS)

One command from the repo root:

```bash
npm run dist
```

That builds the web UI (`web/dist`), bundles the server into a single file
(`server/dist/index.mjs`, esbuild — no node_modules shipped), and runs
electron-builder → `desktop/release/airoom-<version>-arm64.dmg`.

## Signing + notarization (required for other people's Macs)

1. **Certificate**: in Xcode (Settings → Accounts → Manage Certificates) or at
   developer.apple.com, create a **Developer ID Application** certificate and
   make sure it's in your login keychain. electron-builder discovers it
   automatically.
2. **Notarization**: create an app-specific password at appleid.apple.com,
   then export before building:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOURTEAMID"   # developer.apple.com → Membership
npm run dist
```

Notarization uploads the app to Apple and waits (usually 1–5 min). The dmg in
`desktop/release/` is then safe to send to anyone — no Gatekeeper warnings.

**Quick local build without signing** (only runs on your own machine):

```bash
npm run dist:unsigned
```

## How the packaged app differs from dev

- `desktop/main.js` detects `app.isPackaged`: instead of `tsx watch`, it runs
  `Resources/server/index.mjs` on Electron's own Node (`ELECTRON_RUN_AS_NODE`)
  with `AIROOM_WEB_DIST=Resources/web`.
- Port: reuses a running airoom on 8787, else picks the first free port from
  8787 upward (the web client talks to its own origin, so any port works).
- The server finds the user's `claude` binary by absolute path
  (`~/.local/bin`, `~/.claude/local`, Homebrew, nvm) — packaged GUI apps get
  launchd's minimal PATH, so `which claude` can't be trusted.

## App icon

`desktop/build/icon.icns` is generated from `desktop/build/icon.svg` by
`npm run icon --prefix desktop` (stock macOS tools: qlmanage → sips →
iconutil). Re-run only after editing the SVG; the icns is committed.

## First-run experience on a fresh Mac

The web UI polls `/health` and shows, in order:
1. **Install Claude Code** card — if no `claude` binary is found (10s re-scan).
2. **Connect Claude Code** card — binary present but no token
   (`claude setup-token` one-liner → `~/.airoom/token`).
3. Normal app once both resolve — no restarts needed anywhere.

## Releasing

A release is a git tag, a GitHub release with the installers attached under
stable names, and a bump of `landing/release.json`.

1. Bump `version` in `package.json` and `desktop/package.json`, the `v0.x.y`
   badge in `landing/index.html`, and `version` in `landing/release.json`.
2. `npm run dist` from the repo root with notarization set up as above, then
   sign, notarise and staple the dmg itself (`codesign --timestamp`,
   `xcrun notarytool submit --wait`, `xcrun stapler staple`): electron-builder
   notarises the app but not the disk image around it.
3. Publish, with the asset under its stable name:

```bash
cp desktop/release/airoom-<v>-arm64.dmg /tmp/airoom-arm64.dmg
```

```bash
gh release create v<v> /tmp/airoom-arm64.dmg --title "airoom <v>" --notes "What changed."
```

   The tag starts the `windows` workflow, which builds the installer on a
   Windows runner and attaches it to the same release as `airoom-x64.exe`.
4. Commit the bump and push. `airoom.dev/download` sends browsers to
   `releases/latest/download/<asset>`, and every running copy learns about
   the version from `release.json` within six hours.

## Not wired, on purpose

- **Auto-update**: the app checks `airoom.dev/release.json` and shows a strip
  with a download link; it never replaces itself.
- **Linux**: not yet. Windows is covered in `WINDOWS.md`.
