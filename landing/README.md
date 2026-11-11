# airoom.dev landing page

Static page + a zero-dependency Node server (`server.mjs`) that also sends
browsers to the app download. Built for Railway.

## Preview locally

```bash
node landing/server.mjs
# → http://localhost:8123
```

## Deploy on Railway

The Railway and DNS notes are in [`../DEPLOY.md`](../DEPLOY.md). The short
version: one service, **Root Directory `landing`**, custom domain `airoom.dev`
(an ALIAS record at the apex, never a CNAME, plus Railway's verification TXT).
`railway.json` sets the start command and the `/health` check.

## Variables

| Variable | Effect |
| --- | --- |
| `DOWNLOAD_URL` | where `/download` sends browsers. Default: the `airoom-arm64.dmg` asset of the latest GitHub release. |
| `DOWNLOAD_URL_WINDOWS` | the same for `/download?os=windows`. Default: the `airoom-x64.exe` asset of the latest GitHub release. |
| `WAITLIST_URL` | where the teams-waitlist form posts `{ email, platform: "teams" }`. Unset, the page shows an email address instead of the form. |
| `GA_MEASUREMENT_ID` | overrides the GA4 measurement id baked into `server.mjs` (set it empty to turn analytics off without a commit). The baked-in id only applies on Railway — locally the pages carry no analytics at all, so dev and preview traffic never reaches the stats. |

## The download button

Every Download button on the page opens a chooser (a native `<dialog>` in
`index.html`) with two choices. **macOS** links to `/download`, **Windows** to
`/download?os=windows`. The server streams a file from `downloads/` when one is
there (a local preview with a build of its own; the directory is ignored by
git) and otherwise answers a 302 to the release asset. Nothing is asked for
and nothing is recorded.

Releases are tags: see "Releasing" in [`../PACKAGING.md`](../PACKAGING.md).
The asset names are stable (`airoom-arm64.dmg`, `airoom-x64.exe`), so
`releases/latest/download/<name>` always resolves and a release needs no
change here beyond `release.json`.

`/buy` answers a redirect to the front page: airoom used to be sold there, and
builds up to 0.1.16 still carry the link.

## The waitlist

The front page ends with one form, for the hosted team office that will be
the paid part of airoom. It posts to `/waitlist`, which forwards to
`WAITLIST_URL` with the visitor's IP in `x-forwarded-for`. Without that
variable the server stamps `<body data-waitlist="email">` and the page shows
an email address instead; with it, `data-waitlist="form"`. The form treats any
non-2xx as "not recorded" and owns up with the same address.

## House rules

- **No gradients. Ever.** Flat solid colors only — this is a hard design rule
  for everything airoom.
- Fonts: Chakra Petch (display) + Space Grotesk (body), same as the app.
- The hero office is not a screenshot — `gen-img.mjs` renders it from the
  design modules in `../design/` into static SVGs in `img/`. When the design
  evolves, run `node landing/gen-img.mjs` and commit the diff; there is no
  build step on deploy, so what is checked in is what the site serves.
- Phones get `office-narrow.svg` via `<picture>` — a different composition
  (three zones stacked), never the wide floor scaled down. Fractional scaling
  destroys pixel art.

## Telling running apps about a release

The app has no auto-updater. Instead every running copy fetches
`https://airoom.dev/release.json` shortly after launch and then every six
hours, and shows a strip at the top of its window when the manifest names a
newer version than the one running — or carries a short note from us. The
request is identity-free (see `server/src/release.ts` and the privacy page,
section 3.3).

`release.json` is checked in next to this file. A full one looks like:

```json
{
  "version": "0.1.16",
  "url": "https://airoom.dev/download",
  "notes": "https://airoom.dev/whats-new",
  "windows": { "url": "https://airoom.dev/download?os=windows" },
  "message": {
    "id": "2026-09-teams",
    "text": "Teams are here: hire a lead and a crew, and watch them work in a room of their own.",
    "url": "https://airoom.dev/#teams",
    "until": "2026-10-01T00:00:00Z"
  }
}
```

- `version` and `url` are required and `url` must be https. Bump `version` as
  part of every release, together with the badge in `index.html`.
- `notes` is optional; when present the strip gains a "What's new" link.
- `windows.url` is optional; when present, a Windows copy of airoom links there
  instead of to the dmg.
- `message` is optional and independent of releases: an `id` (the strip is
  dismissed per id, so a new id is a new message), the `text` (one line, at
  most 200 characters), an optional https `url`, and an optional `until` after
  which the app stops showing it on its own. Delete the key to pull a message
  early. Commit, push, and Railway serves it within a minute; apps pick it up
  at their next check.

Users can switch the check off with `AIROOM_NO_UPDATE_CHECK=1`.
