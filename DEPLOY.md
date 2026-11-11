# airoom.dev on Railway

The website and the download redirect are one Railway service, deployed from
this repository with **Root Directory `landing`**. There is nothing else to
run: the installers live on GitHub Releases, the app talks to no backend of
ours, and the licence service that used to live beside the landing is gone
(the history before 27 October 2026 has it, should anyone need it).

## Setting it up

1. Railway → New project → **Deploy from GitHub repo** → this repository.
2. Service settings → **Root Directory `landing`**. `landing/railway.json`
   sets the start command and the `/health` check, so a broken build never
   replaces a working one.
3. Settings → **Networking → Custom Domain** → `airoom.dev`. At Porkbun the
   bare domain needs an **ALIAS** record, not a CNAME: a CNAME at the apex is
   illegal and would break the MX records that `hello@airoom.dev` runs on.
   Add Railway's **verification TXT record** as well. Without it the domain
   resolves, terminates TLS and then answers nothing, which looks like a
   broken deploy rather than a missing DNS record.

## Variables

All optional. The defaults are what production runs with.

| Variable | Effect |
| --- | --- |
| `DOWNLOAD_URL` | where `/download` sends browsers; default the `airoom-arm64.dmg` asset of the latest GitHub release |
| `DOWNLOAD_URL_WINDOWS` | the same for `/download?os=windows`; default the `airoom-x64.exe` asset |
| `WAITLIST_URL` | where the teams-waitlist form posts; unset, the page shows an email address instead of a form |
| `GA_MEASUREMENT_ID` | overrides the analytics id; set it empty to switch analytics off |

## Checking it

```bash
curl -s https://airoom.dev/health
```

```bash
curl -sI https://airoom.dev/download | grep -i location
```

```bash
curl -s https://airoom.dev/release.json
```

The first answers `{"ok":true,...}`, the second names the release asset, the
third is what every running copy of the app reads to learn that a build is
out. Shipping a build is described under "Releasing" in `PACKAGING.md`.

## Switched off on 27 October 2026

airoom was sold for a while: a licence service at `api.airoom.dev` with a
Postgres database, a Stripe product and webhook, licence emails through
Resend, and an admin panel in its own repository. None of that is part of the
product any more. The Railway service, the Stripe webhook endpoint and the
Resend sending domain can be deleted whenever convenient; nothing in this
repository references them.
