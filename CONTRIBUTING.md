# Contributing to airoom

Thanks for looking. airoom is small enough for one person to hold in their
head, and the aim is to keep it that way.

## Set up

Node 20 or newer (CI uses 22), and Claude Code installed and logged in, since
airoom drives the `claude` on your machine.

```bash
npm run install:all     # server, web and desktop dependencies
npm run dev             # server on :8787 and the web UI on :5173
npm run app             # the desktop shell against a fresh web build
```

## Before you open a pull request

Run the three gates the Windows workflow runs, and make sure each exits 0:

```bash
(cd server && npx tsc --noEmit)
(cd web && npx tsc --noEmit)
(cd server && npm test)
```

The server suite is plain `tsx` scripts under `server/scripts/`, no test
framework. Add a case to the script nearest your change, or a new script wired
into the `test` line of `server/package.json`.

A pull request against `main` runs the same gates on a real Windows machine,
because nobody here owns one.

## What a good change looks like

- One thing per pull request, with the reason in the description.
- Comments explain why, not what. The code already says what.
- Keep the two seams: `DataSource` (read) and `AgentController` (write) in
  `server/src/`. Local implementations today; `shared/types.ts` is the
  contract the web client is written against, so a protocol change is a
  change to both sides.
- Flat colours only in the UI. The web build fails on a gradient, on purpose
  (`web/scripts/no-gradients.mjs`).
- Nothing leaves the machine. The server binds 127.0.0.1 and the app sends no
  telemetry; a change that adds a network call needs a sentence on why.

## Licence

Contributions are accepted under the Apache License 2.0, the licence the
project is under. Section 5 of the licence covers it, so there is no separate
agreement to sign.
