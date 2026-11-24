import path from 'node:path';
import { localServers, projectChoice, projectServers, sharedLoaded, userServers } from '../connectors';
import type { Playbook, TeamPlaybook } from '../../../shared/types';
import { sanitiseRules } from './rules';

/**
 * Sharing a playbook with the people you work with.
 *
 * A playbook lives in `~/.airoom/playbooks.json`, on one machine. This module
 * copies a card to a Cognivio knowledge base (cognivio.app, or one a team
 * hosts itself) and reads the team's cards back, so a process one person
 * worked out is there for the next person who opens the same project.
 *
 * THE NETWORK CALLS, and why they are acceptable in an app that makes none:
 *  - Nothing is configured here. The address and the key are the ones the
 *    room's own Cognivio connector already has, so airoom talks only to a
 *    server the person's agents in that room already talk to.
 *  - A room with no Cognivio connector makes no call at all.
 *  - Listing happens when the playbooks panel is opened; sharing and getting
 *    happen on a click. Nothing runs on a timer or in the background.
 *  - Only the card travels: no run history, no session id, no transcript.
 *
 * WHAT COMES BACK IS UNTRUSTED. A teammate's card is opened in the editor as
 * a proposal and is saved only by the person, its allowlist goes through the
 * same check as an edited one, and its permission mode and model do not
 * travel: nobody inherits "bypass" from a colleague.
 */

// ---- the room's connection ---------------------------------------------------

export interface Connection {
  /** The connector's name in Claude Code, for messages. */
  name: string;
  /** REST root, e.g. https://cognivio.app/api/v1 */
  api: string;
  key: string;
}

/** `${VAR}` and `${VAR:-fallback}`, as Claude Code expands them in .mcp.json. */
function expand(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => process.env[name] ?? fallback ?? '');
}

function apiRoot(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const base = u.pathname.replace(/\/+$/, '').replace(/\/mcp$/, '');
    return `${u.origin}${base}/api/v1`;
  } catch {
    return null;
  }
}

/** A connector entry as a Cognivio connection, or null if it is not one. */
function fromEntry(name: string, entry: Record<string, unknown>): Connection | null {
  if (!/cognivio/i.test(name)) return null;
  // The hosted endpoint: a url and an Authorization header.
  if (typeof entry.url === 'string') {
    const headers = (entry.headers ?? {}) as Record<string, unknown>;
    const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    const key = expand(auth).replace(/^Bearer\s+/i, '').trim();
    const api = apiRoot(expand(entry.url));
    return key && api ? { name, api, key } : null;
  }
  // The local connector: the same two facts, as environment variables.
  const env = (entry.env ?? {}) as Record<string, unknown>;
  const key = expand(env.KB_API_KEY).trim();
  const base = expand(env.KB_BASE_URL).trim();
  const api = base ? apiRoot(base) : null;
  return key && api ? { name, api, key } : null;
}

/**
 * The Cognivio connector this room's agents use, if there is one and it is
 * switched on for the project. Project first, then the person's own for this
 * project, then user-wide: the order Claude Code resolves a name in.
 */
export function connectionFor(cwd: string): Connection | null {
  for (const [name, entry] of Object.entries(projectServers(cwd))) {
    const c = fromEntry(name, entry);
    if (c && projectChoice(cwd, name) !== 'disabled') return c;
  }
  for (const servers of [localServers(cwd), userServers()]) {
    for (const [name, entry] of Object.entries(servers)) {
      const c = fromEntry(name, entry);
      if (c && sharedLoaded(cwd, name)) return c;
    }
  }
  return null;
}

// ---- the card as a document --------------------------------------------------

export const SHARE_TAG = 'airoom-playbook';
const FENCE = 'airoom-playbook';
const TITLE_PREFIX = 'Playbook: ';

/** A project's tag: its folder name, which is the same on every machine that
 *  cloned it, where the full path is not. */
export function projectTag(roomId: string): string {
  const slug = path
    .basename(roomId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `airoom-project-${slug || 'unnamed'}`;
}

/** What travels. Everything else on a Playbook is about this machine. */
interface SharedCard {
  v: 1;
  name: string;
  goal: string;
  inputs: Playbook['inputs'];
  rules: string[];
  steps: Playbook['steps'];
  checks: string[];
  output: string;
  allow: string[];
  /** What the first session cost, so the score still has a baseline. */
  first: { messages: number; approvals: number; corrections: number };
}

/**
 * The card as markdown a person can read in Cognivio, followed by the block
 * airoom reads back. The prose is for people and for agents that find the
 * document; only the block is parsed.
 */
export function toDoc(pb: Playbook): { title: string; content: string } {
  const card: SharedCard = {
    v: 1,
    name: pb.name,
    goal: pb.goal,
    inputs: pb.inputs,
    rules: pb.rules.map((r) => r.text),
    steps: pb.steps,
    checks: pb.checks,
    output: pb.output,
    allow: pb.allow,
    first: { messages: pb.source.messages, approvals: pb.source.approvals, corrections: pb.source.corrections },
  };
  const list = (items: string[], mark = '-') => items.map((t) => `${mark} ${t.replace(/\s*\n\s*/g, ' ')}`).join('\n');
  const parts = [`# ${TITLE_PREFIX}${pb.name}`, pb.goal];
  if (pb.inputs.length) parts.push('## Inputs', list(pb.inputs.map((i) => (i.example ? `${i.label} (for example: ${i.example})` : i.label))));
  if (pb.rules.length) parts.push('## Rules', list(card.rules));
  if (pb.steps.length) parts.push('## Steps', pb.steps.map((s, i) => `${i + 1}. ${s.text.replace(/\s*\n\s*/g, ' ')}${s.pause ? ' (stop here for review)' : ''}`).join('\n'));
  if (pb.checks.length) parts.push('## Checks', list(pb.checks));
  if (pb.output) parts.push('## Deliver', pb.output);
  parts.push(
    '## For airoom',
    `Shared from [airoom](https://airoom.dev) for the project \`${path.basename(pb.roomId)}\`. airoom reads the block below, so edit the card in airoom and share it again; an edit made here to the text above is not read back.`,
    // Three backticks inside a rule or a step would close the fence early, so
    // they are written as JSON escapes, which parse back to the same text.
    '```' + FENCE + '\n' + JSON.stringify(card, null, 2).replace(/```/g, '\\u0060\\u0060\\u0060') + '\n```',
  );
  return { title: `${TITLE_PREFIX}${pb.name}`.slice(0, 180), content: parts.filter(Boolean).join('\n\n') + '\n' };
}

const text = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/**
 * A shared document as a proposal for `roomId`: no id, no runs, nothing
 * saved. Every field is capped again by `PlaybookController.save` when the
 * person saves it; the checks here are the ones that must not wait for that.
 */
export function fromDoc(content: string, roomId: string, now: string): { ok: true; draft: Playbook } | { ok: false; error: string } {
  const m = new RegExp('```' + FENCE + '\\s*\\n([\\s\\S]*?)\\n```').exec(content);
  if (!m) return { ok: false, error: 'That document has no airoom card in it.' };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'The airoom card in that document is damaged. Ask whoever shared it to share it again.' };
  }
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return { ok: false, error: 'That card was shared by a newer airoom than this one.' };
  const name = text(raw.name, 80);
  if (!name) return { ok: false, error: 'That card has no name.' };
  const first = (raw.first ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const draft: Playbook = {
    id: '',
    roomId,
    name,
    goal: text(raw.goal, 2_000),
    inputs: arr(raw.inputs)
      .slice(0, 8)
      .map((i) => {
        const x = (i ?? {}) as Record<string, unknown>;
        const example = text(x.example, 400);
        return { key: text(x.key, 40), label: text(x.label, 120), ...(example ? { example } : {}) };
      })
      .filter((i) => i.key),
    rules: arr(raw.rules)
      .slice(0, 60)
      .map((r, i) => ({ id: `r${i + 1}`, text: text(r, 1_000), from: 'session' as const, at: now }))
      .filter((r) => r.text),
    steps: arr(raw.steps)
      .slice(0, 30)
      .map((s) => {
        const x = (s ?? {}) as Record<string, unknown>;
        return { text: text(x.text, 1_000), ...(x.pause ? { pause: true as const } : {}) };
      })
      .filter((s) => s.text),
    checks: arr(raw.checks)
      .slice(0, 20)
      .map((c) => text(c, 500))
      .filter(Boolean),
    output: text(raw.output, 1_000),
    allow: sanitiseRules(raw.allow),
    source: { sessionId: '', messages: count(first.messages), approvals: count(first.approvals), corrections: count(first.corrections) },
    createdAt: now,
    updatedAt: now,
    runs: [],
  };
  return { ok: true, draft };
}

// ---- talking to the server ---------------------------------------------------

const TIMEOUT_MS = 10_000;
/** A key that reaches more teams than this is not asked about each of them. */
const MAX_TEAMS = 8;

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(conn: Connection, method: 'GET' | 'POST', route: string, body?: unknown): Promise<Reply<T>> {
  const host = new URL(conn.api).host;
  try {
    const res = await fetch(`${conn.api}${route}`, {
      method,
      headers: { Authorization: `Bearer ${conn.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error', // a redirect would carry the key to another address
    });
    if (res.status === 401) return { ok: false, error: `${host} did not accept the key in the "${conn.name}" connector.` };
    if (res.status === 403) return { ok: false, error: `The key in the "${conn.name}" connector is not allowed to do that. Sharing needs a key that can write.` };
    if (!res.ok) return { ok: false, error: `${host} answered ${res.status}.` };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, error: `Could not reach ${host}.` };
  }
}

interface Team {
  id: string;
  name: string;
}
interface DocRow {
  id: string;
  title: string;
  tags?: string[];
  updatedAt?: string;
}

async function teamsOf(conn: Connection): Promise<Reply<Team[]>> {
  const r = await call<Team[]>(conn, 'GET', '/teams');
  if (!r.ok) return r;
  const teams = (Array.isArray(r.data) ? r.data : []).filter((t) => t && typeof t.id === 'string');
  return teams.length ? { ok: true, data: teams } : { ok: false, error: `The key in the "${conn.name}" connector reaches no team.` };
}

/**
 * Copy a card to the team. Writing a title that exists updates that document,
 * so sharing again after an edit replaces the shared copy.
 *
 * Which team: the only one the key reaches, or the one named after the
 * project. With several and no match there is nothing to go on, and guessing
 * would put one team's process in front of another.
 */
export async function shareCard(pb: Playbook): Promise<{ ok: boolean; text: string }> {
  const conn = connectionFor(pb.roomId);
  if (!conn) return { ok: false, text: 'This room has no Cognivio connector, so there is nowhere to share to. Add one in the room’s Connections.' };
  const teams = await teamsOf(conn);
  if (!teams.ok) return { ok: false, text: teams.error };
  const project = path.basename(pb.roomId).toLowerCase();
  const team = teams.data.length === 1 ? teams.data[0] : teams.data.find((t) => String(t.name).toLowerCase() === project);
  if (!team)
    return {
      ok: false,
      text: `The key in the "${conn.name}" connector reaches ${teams.data.length} teams and none is named "${path.basename(pb.roomId)}". Use a key limited to one team.`,
    };
  const doc = toDoc(pb);
  const r = await call<DocRow & { status?: string }>(conn, 'POST', `/teams/${encodeURIComponent(team.id)}/memories`, {
    title: doc.title,
    content: doc.content,
    type: 'playbook',
    tags: [SHARE_TAG, projectTag(pb.roomId)],
  });
  if (!r.ok) return { ok: false, text: r.error };
  const held = r.data?.status === 'draft';
  return {
    ok: true,
    text: held ? `"${pb.name}" was sent to ${team.name}. That team reviews what is written to it, so it shows for others once approved.` : `"${pb.name}" is shared with ${team.name}.`,
  };
}

/**
 * Which of these rooms can share at all (the client shows the Share button
 * only there), and the team's cards for them that this machine does not have
 * yet. Rooms are grouped by connection so one server is asked once, and a card is
 * offered only in the room of the project it was shared from.
 */
export async function teamCards(roomIds: string[], local: Playbook[]): Promise<{ rooms: string[]; items: TeamPlaybook[]; error?: string }> {
  const groups = new Map<string, { conn: Connection; rooms: string[] }>();
  for (const roomId of roomIds) {
    const conn = connectionFor(roomId);
    if (!conn) continue;
    const k = `${conn.api}\n${conn.key}`;
    groups.set(k, { conn, rooms: [...(groups.get(k)?.rooms ?? []), roomId] });
  }
  const items: TeamPlaybook[] = [];
  let error: string | undefined;
  for (const { conn, rooms } of groups.values()) {
    const teams = await teamsOf(conn);
    if (!teams.ok) {
      error = error ?? teams.error;
      continue;
    }
    for (const team of teams.data.slice(0, MAX_TEAMS)) {
      const r = await call<{ memories?: DocRow[] }>(conn, 'GET', `/teams/${encodeURIComponent(team.id)}/memories?tag=${SHARE_TAG}&limit=100`);
      if (!r.ok) {
        error = error ?? r.error;
        continue;
      }
      for (const doc of r.data.memories ?? []) {
        if (!doc || typeof doc.id !== 'string' || typeof doc.title !== 'string') continue;
        const name = doc.title.startsWith(TITLE_PREFIX) ? doc.title.slice(TITLE_PREFIX.length) : doc.title;
        for (const roomId of rooms) {
          if (!(doc.tags ?? []).includes(projectTag(roomId))) continue;
          if (local.some((p) => p.roomId === roomId && p.name.trim().toLowerCase() === name.trim().toLowerCase())) continue;
          items.push({ roomId, docId: doc.id, name: name.slice(0, 80), team: String(team.name).slice(0, 80), ...(doc.updatedAt ? { updatedAt: String(doc.updatedAt) } : {}) });
        }
      }
    }
  }
  const rooms = [...groups.values()].flatMap((g) => g.rooms);
  return { rooms, items: items.slice(0, 200), ...(error ? { error } : {}) };
}

/** One of the team's cards, as a proposal for the room it was offered in. */
export async function getTeamCard(roomId: string, docId: string, now: string): Promise<{ draft?: Playbook; error?: string }> {
  const conn = connectionFor(roomId);
  if (!conn) return { error: 'This room has no Cognivio connector any more.' };
  const r = await call<{ content?: string }>(conn, 'GET', `/memories/${encodeURIComponent(docId)}`);
  if (!r.ok) return { error: r.error };
  const res = fromDoc(String(r.data?.content ?? ''), roomId, now);
  return res.ok ? { draft: res.draft } : { error: res.error };
}
