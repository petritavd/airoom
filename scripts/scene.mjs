#!/usr/bin/env node
/**
 * Dress the office for a screenshot.
 *
 *   node scripts/scene.mjs            # add the rooms below and start the agents
 *   node scripts/scene.mjs --watch    # same, then keep printing what they do
 *   node scripts/scene.mjs --dry      # print the plan, send nothing
 *
 * Talks to the RUNNING airoom (the desktop app's own server on 8787, or
 * AIROOM_PORT), so the agents are hired the way a person would hire them: with
 * the user's own Claude login, in real project folders, as real sessions that
 * appear as robots. Every prompt is read-only work on purpose — a screenshot
 * is not a reason to edit anyone's code.
 *
 * Three states are staged so the floor has something to say:
 *   done     a quick read on Haiku; the robot finishes and shows its tick
 *   working  a longer read on Sonnet; the monitor scrolls for a few minutes
 *   needs    a task that wants a command, asked in "asks first" mode; the
 *            approval stays pending (amber, robot at the door) for ten
 *            minutes unless someone answers it
 *
 * Re-run it any time the floor has gone quiet. Rooms are added once; agents
 * are new each run, and old ones age out of the office after a week.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'node_modules', 'ws'));

const HOME = os.homedir();
const doc = (p) => path.join(HOME, 'Documents', p);
const READ_ONLY = ' Read only — do not create, edit or delete any file.';

/** The plan: which rooms, and who works in them on what. */
const SCENE = [
  { room: doc('PocketManus'), state: 'done', model: 'haiku', text: 'Explain how the agent loop in this project decides when to stop, in five bullet points.' + READ_ONLY },
  { room: doc('food_delivery'), state: 'done', model: 'haiku', text: 'Summarize the API routes and point out any endpoint that has no authentication.' + READ_ONLY },
  { room: doc('langchain-academy'), state: 'done', model: 'haiku', text: 'List the modules in this course and what each one teaches, one line each.' + READ_ONLY },
  { room: doc('CalAI'), state: 'done', model: 'haiku', text: 'Explain how the Microsoft calendar sync refreshes its tokens, in one short paragraph.' + READ_ONLY },
  { room: doc('xclsv'), state: 'working', model: 'sonnet', text: 'Review the database schema and the queries that use it. List the three queries most likely to be slow and why.' + READ_ONLY },
  { room: doc('airoom'), state: 'working', model: 'sonnet', text: 'Audit the landing server for any route that could serve a file outside its own folder, and report what you find.' + READ_ONLY },
  { room: doc('celery-chain-router'), state: 'needs', model: 'haiku', text: 'Run the test suite and report which tests fail.' },
  { room: doc('domate'), state: 'needs', model: 'haiku', text: 'Run the linter and report the top issues it finds.' },
];

const args = new Set(process.argv.slice(2));
const port = process.env.AIROOM_PORT || '8787';

for (const s of SCENE) {
  if (!existsSync(s.room)) {
    console.error(`missing folder: ${s.room}`);
    process.exit(1);
  }
}
if (args.has('--dry')) {
  for (const s of SCENE) console.log(`${s.state.padEnd(8)} ${path.basename(s.room).padEnd(22)} ${s.model.padEnd(7)} ${s.text}`);
  process.exit(0);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const send = (m) => ws.send(JSON.stringify({ v: 1, ...m }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rooms = null;
ws.on('open', () => console.log(`connected to airoom on :${port}`));
ws.on('error', (e) => {
  console.error(`cannot reach airoom on :${port} — is the app running? (${e.message})`);
  process.exit(1);
});
ws.on('message', async (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'snapshot' && !rooms) {
    rooms = new Set(m.snapshot.rooms.map((r) => r.id));
    const missing = SCENE.map((s) => s.room).filter((r, i, all) => !rooms.has(r) && all.indexOf(r) === i);
    for (const r of missing) {
      send({ type: 'addProject', path: r });
      console.log(`room   + ${path.basename(r)}`);
      await sleep(400);
    }
    if (missing.length) await sleep(1500);
    for (const s of SCENE) {
      send({ type: 'send', roomId: s.room, text: s.text, model: s.model, mode: 'default' });
      console.log(`agent  → ${path.basename(s.room).padEnd(22)} ${s.state.padEnd(8)} ${s.model}`);
      await sleep(1200);
    }
    console.log(args.has('--watch') ? 'watching (ctrl-c to stop)…' : 'done — give the floor a minute to fill');
    if (!args.has('--watch')) {
      await sleep(3000);
      ws.close();
      process.exit(0);
    }
  } else if (m.type === 'notice') {
    console.log(`notice ${m.isError ? '✗' : '·'} ${m.text}`);
  } else if (m.type === 'run' && args.has('--watch')) {
    const u = m.update;
    if (u.phase === 'permission') console.log(`needs  ! ${path.basename(u.roomId)} wants: ${u.text}`);
    else if (u.phase === 'result') console.log(`done   ✓ ${path.basename(u.roomId)}`);
    else if (u.phase === 'error') console.log(`error  ✗ ${path.basename(u.roomId)} ${u.text ?? ''}`);
  }
});
