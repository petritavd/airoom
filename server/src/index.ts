import http from 'node:http';
import { OLLAMA_URL, setOllamaProxyBase, startOllama } from './agent/ollama';
import { probeShell, saveClaudeBin, validateClaudeBin } from './agent/claudeBin';
import { OLLAMA_PROXY_PREFIX, relayToOllama } from './agent/ollamaProxy';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { LocalClaudeDataSource } from './datasource/LocalClaudeDataSource';
import { MAX_STEPS } from './parse/sessionParser';
import { PERMISSION_MODES } from '../../shared/types';
import type { DataSource } from './datasource/DataSource';
import { LocalClaudeController } from './agent/LocalClaudeController';
import {
  SdkClaudeController,
  cachedCommands,
  localThinkingPolicy,
  mergedModels,
  ollamaStatus,
  refreshOllama,
  engineDiagnostics,
} from './agent/SdkClaudeController';
import type { AgentController } from './agent/AgentController';
import { FALLBACK_MODELS } from '../../shared/types';
import { releaseState, startReleaseChecks } from './release';
import { TeamController } from './team/TeamController';
import { PlaybookController } from './playbook/PlaybookController';
import { addProjectServer, ConnectorsService, removeProjectServer, setAdopted, setProjectChoice, setSharedLoaded, sharedLoaded } from './connectors';
import { gitFacts } from './team/worktrees';
import { assignSkills, buildSkillPrompt, createUserSkill, discoverSkills, sanitizeAgentSkills, skillNamesFor, skillsFor } from './skills';
import { agentNameFor, setAgentName } from './agentNames';
import type {
  ClientMessage,
  FleetSnapshot,
  PermissionMode,
  RosterMember,
  ServerMessage,
  TeamRole,
} from '../../shared/types';

import { basename as folderName, isAbsolutePath, isWindows, listRoots } from './platform';
const PORT = Number(process.env.PORT ?? 8787);
// SECURITY: this server can execute `claude` (optionally with permissions
// bypassed) in any project directory. It must never be reachable from the
// network — loopback only. Multi-user/remote is a future, authenticated seam.
const HOST = '127.0.0.1';

// --- Read path (local) and write path. Engine: Agent SDK by default —
// interrupts + per-tool approvals; AIROOM_ENGINE=cli falls back to spawning
// the claude CLI per message.
const source: DataSource = new LocalClaudeDataSource();
const controller: AgentController =
  process.env.AIROOM_ENGINE === 'cli' ? new LocalClaudeController() : new SdkClaudeController();
// The SDK controller learns the model list from the first live query; push it
// to every open client the moment it does, so an empty picker fills itself in.
if (controller instanceof SdkClaudeController) {
  // Whatever learns a new model list (a Claude run, or Ollama appearing)
  // broadcasts the MERGED list — pickers show one list, not two.
  controller.onModels = () => broadcast({ v: 1, type: 'models', models: mergedModels() });

  controller.onCommands = (commands) => broadcast({ v: 1, type: 'commands', commands });
}

// Teams need the SDK engine: their tools ride the query's in-process MCP
// server, which the CLI fallback cannot host. On the CLI engine `teams` stays
// null and hireTeam answers with a plain explanation instead of half-working.
const teams: TeamController | null =
  controller instanceof SdkClaudeController
    ? new TeamController({
        controller,
        onUpdate: (update) => broadcast({ v: 1, type: 'run', update }),
        onHandoff: (handoff) => broadcast({ v: 1, type: 'handoff', handoff }),
        onTeamsChanged: () => void broadcastSnapshot(),
        // Test harnesses run a second server against a scratch state file so
        // real E2E team runs never touch the user's own teams.
        ...(process.env.AIROOM_TEAMS_FILE ? { file: process.env.AIROOM_TEAMS_FILE } : {}),
      })
    : null;

// Playbooks ride the same engine: extraction is a tool-less query, a run is a
// session with a preamble and an allowlist. Absent on the CLI engine.
const playbooks: PlaybookController | null =
  controller instanceof SdkClaudeController
    ? new PlaybookController({
        controller,
        getTranscript: (sessionId, limit) => source.getTranscript(sessionId, limit),
        onUpdate: (update) => {
          broadcast({ v: 1, type: 'run', update });
          if (update.phase === 'permission' || update.phase === 'started') void broadcastSnapshot();
        },
        onChanged: () => {
          broadcast({ v: 1, type: 'playbooks', playbooks: playbooks?.list() ?? [] });
          void broadcastSnapshot();
        },
        ...(process.env.AIROOM_PLAYBOOKS_FILE ? { file: process.env.AIROOM_PLAYBOOKS_FILE } : {}),
      })
    : null;

// Connectors: what each room's agents can reach. Cached per room; a live run
// refreshes its room for free through the controller's status callback.
const connectors = new ConnectorsService(controller, (room) => broadcast({ v: 1, type: 'connectors', room }));
if (controller instanceof SdkClaudeController) controller.onMcpStatus = (cwd, raw) => connectors.ingest(cwd, raw);

/** Overlay playbook truth: which robots are runs of which card. */
function withPlaybookOverlay(snapshot: FleetSnapshot): FleetSnapshot {
  if (!playbooks) return snapshot;
  return {
    ...snapshot,
    robots: snapshot.robots.map((robot) => {
      const run = playbooks.runOf(robot.sessionId);
      return run ? { ...robot, playbook: run } : robot;
    }),
  };
}

/**
 * Overlay live process truth onto the disk-derived snapshot: while airoom is
 * driving a session, that robot is "working" no matter what the transcript's
 * tail says (the file lags the process).
 */
/** Overlay team truth: which robots belong to teams, and which rooms have a
 *  parked team waving for the human. */
function withTeamOverlay(snapshot: FleetSnapshot): FleetSnapshot {
  if (!teams) return snapshot;
  const waving = teams.roomsAwaitingHuman();
  // A lane is a git worktree with sessions in it, so the fleet scan finds it
  // and calls it a project. It is not one — it is a room off the project it
  // branched from, and saying so here is what lets the office draw it that way.
  const lanes = teams.laneRooms();
  return {
    ...snapshot,
    teams: teams.list(),
    robots: snapshot.robots.map((robot) => {
      const member = teams.memberOf(robot.sessionId);
      return member ? { ...robot, team: member } : robot;
    }),
    rooms: snapshot.rooms.map((room) => {
      const lane = lanes.get(room.id);
      const patch = {
        ...room,
        ...(waving.has(room.id) ? { needsAttention: true } : {}),
        ...(lane ? { lane, name: lane.teamName || lane.task } : {}),
      };
      return patch;
    }),
  };
}

/**
 * A roster arrives over a websocket anyone local can open, so nothing in it is
 * trusted: kinds must be real, labels are trimmed and capped, and the size is
 * held to what a lead can actually keep track of.
 */
function sanitiseRoster(input: RosterMember[] | undefined): RosterMember[] | undefined {
  if (!Array.isArray(input) || !input.length) return undefined;
  const out: RosterMember[] = [];
  for (const m of input.slice(0, 8)) {
    if (!m || (m.kind !== 'lead' && m.kind !== 'worker' && m.kind !== 'reviewer')) continue;
    const label = String(m.label ?? '').trim().slice(0, 32);
    if (!label) continue;
    out.push({
      kind: m.kind,
      label,
      writes: m.kind === 'worker' ? m.writes !== false : false,
      note: typeof m.note === 'string' ? m.note.slice(0, 50_000) : undefined,
      mode: PERMISSION_MODES.some((p) => p.value === m.mode) ? m.mode : undefined,
      model: typeof m.model === 'string' && m.model.length <= 100 ? m.model : undefined,
    });
  }
  return out.length >= 2 ? out : undefined;
}

/** Overlay hire identity: skill loadouts (desk badge) and given names. */
function withIdentityOverlay(snapshot: FleetSnapshot): FleetSnapshot {
  return {
    ...snapshot,
    robots: snapshot.robots.map((robot) => {
      const skills = skillNamesFor(robot.sessionId);
      const name = agentNameFor(robot.sessionId);
      return skills || name ? { ...robot, ...(skills ? { skills } : {}), ...(name ? { name } : {}) } : robot;
    }),
  };
}

function withRunOverlay(snapshot: FleetSnapshot): FleetSnapshot {
  snapshot = withPlaybookOverlay(withTeamOverlay(withIdentityOverlay(snapshot)));
  const runs = controller.activeRuns();
  if (runs.length === 0) return snapshot;
  const bySession = new Map(runs.filter((r) => r.sessionId).map((r) => [r.sessionId!, r]));
  return {
    ...snapshot,
    robots: snapshot.robots.map((robot) => {
      const run = bySession.get(robot.sessionId);
      if (!run) return robot;
      if (run.pendingPermission)
        return {
          ...robot,
          status: 'waiting_input' as const,
          needsApproval: true,
          currentAction: 'Needs your approval',
        };
      // A warm-but-idle run has already answered. Leave the transcript's own
      // verdict alone — overriding it here kept finished robots typing away for
      // the whole keepalive window.
      if (!run.busy) return robot;
      return { ...robot, status: 'working' as const, currentAction: 'Working… (airoom run)' };
    }),
  };
}

// Static hosting of the built web app (web/dist) — the desktop shell loads
// the UI from this same origin, so one port serves everything. Packaged apps
// point this at the bundled copy via AIROOM_WEB_DIST.
const WEB_DIST =
  process.env.AIROOM_WEB_DIST ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = (req.url ?? '/').split('?')[0];
  const rel = url === '/' ? 'index.html' : url.slice(1);
  const file = path.normalize(path.join(WEB_DIST, rel));
  if (!file.startsWith(WEB_DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    });
    res.end(data);
  } catch {
    // SPA fallback → index.html; if the web app isn't built, say so
    try {
      const index = await fs.readFile(path.join(WEB_DIST, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(index);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('web app not built — run: npm run build --prefix web (dev UI runs on :5173)');
    }
  }
}

/**
 * Directory listing for the in-app folder browser ("+ project"). Local-only
 * by design: the server is loopback-bound and serves the user's own machine.
 * Directories only, hidden entries skipped, symlinks not followed.
 */
async function listDirs(target: string, withFiles = false) {
  const resolved = path.resolve(target);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const visible = entries.filter((e) => !e.name.startsWith('.'));
  const dirs = visible
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Files are only listed when asked for: the folder picker wants directories
  // alone, while "@" mentions in the composer need both.
  const files = withFiles
    ? visible
        .filter((e) => e.isFile())
        .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const parent = path.dirname(resolved);
  return { path: resolved, parent: parent === resolved ? null : parent, dirs, files };
}

/**
 * Binding to loopback keeps the network out, but NOT the web.
 *
 * A browser will happily connect to 127.0.0.1 on behalf of any page the user
 * has open, and WebSockets are exempt from the same-origin policy — so without
 * this check, any site visited while airoom is running could open a socket,
 * read every transcript, and send `{type:'send', bypass:true}` to run code on
 * the machine. A page cannot forge the Origin header, so requiring a loopback
 * origin is the barrier. Non-browser clients (the desktop shell's own ws
 * client) send no Origin at all, which is why absent is allowed.
 */
function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // native clients, not a browser page
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Same reasoning for the JSON routes: `/fs/list` walks the user's filesystem,
 * so a wildcard ACAO let any page enumerate their folders. Reflect the origin
 * only when it is loopback; anything else gets no CORS header and the browser
 * refuses to hand the body to the calling page.
 */
function corsHeaders(req: http.IncomingMessage) {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (origin && isLocalOrigin(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

const server = http.createServer((req, res) => {
  // Claude Code's requests for a local model come through here on their
  // way to Ollama — see ollamaProxy.ts for the one thing the relay changes.
  if (relayToOllama(req, res, OLLAMA_URL, localThinkingPolicy)) return;
  // CORS preflight for the JSON POSTs (the token). The packaged app is
  // same-origin so this never fired there — but the dev browser setup is
  // cross-origin (vite on 5173 → server on 8787), where every JSON POST
  // triggers a preflight that used to have no answer. Loopback origins only,
  // same policy as corsHeaders.
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin && isLocalOrigin(origin)) {
      res.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    res.writeHead(403);
    res.end();
    return;
  }
  // The friendly half of `claude setup-token`: the user runs the command in a
  // terminal and pastes the printed key here, instead of being told to pipe
  // their credential through a grep one-liner (which worked, but read like a
  // phishing attempt). The key is written to ~/.airoom/token, mode 0600, and
  // never leaves this machine — the server only ever hands it to the local
  // Claude Code process via CLAUDE_CODE_OAUTH_TOKEN.
  // "My Claude Code is here": validate the path the user pasted, then keep it.
  if (req.url === '/engine/claude-bin' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      void (async () => {
        const headers = corsHeaders(req);
        try {
          const p = String(JSON.parse(body || '{}').path ?? '').trim();
          if (!p) {
            saveClaudeBin(null);
            res.writeHead(200, headers);
            res.end(JSON.stringify({ ok: true, cleared: true }));
            return;
          }
          const v = await validateClaudeBin(p);
          if (!v.ok) {
            res.writeHead(400, headers);
            res.end(JSON.stringify({ error: v.error }));
            return;
          }
          saveClaudeBin(p);
          console.log(`[engine] claude binary set by the user: ${p} (${v.version})`);
          res.writeHead(200, headers);
          res.end(JSON.stringify({ ok: true, path: p, version: v.version }));
        } catch (err) {
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: String((err as Error).message ?? err) }));
        }
      })();
    });
    return;
  }
  if (req.url === '/engine/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      void (async () => {
        const headers = corsHeaders(req);
        try {
          const token = String(JSON.parse(body || '{}').token ?? '').trim();
          if (!/^sk-ant-[A-Za-z0-9_-]{20,600}$/.test(token)) {
            res.writeHead(400, headers);
            res.end(
              JSON.stringify({
                error: "That doesn't look like a Claude Code key — it starts with sk-ant- and is one long line.",
              }),
            );
            return;
          }
          const dir = path.join(os.homedir(), '.airoom');
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, 'token'), token + '\n', { mode: 0o600 });
          res.writeHead(200, headers);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, headers);
          res.end(JSON.stringify({ error: `Could not save the key: ${String(err)}` }));
        }
      })();
    });
    return;
  }
  // Attachment bytes, addressed by the refs the transcript steps carry. The
  // content at a given uuid:index never changes, so the browser may cache it
  // forever — reopening a desk costs zero image traffic.
  if (req.url?.startsWith('/session-image?')) {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const sessionId = q.get('session') ?? '';
    const ref = q.get('ref') ?? '';
    void (async () => {
      const img = await (source as { getSessionImage?: (s: string, r: string) => Promise<{ media: string; data: Buffer } | null> })
        .getSessionImage?.(sessionId, ref)
        .catch(() => null);
      if (!img) {
        res.writeHead(404, corsHeaders(req));
        res.end(JSON.stringify({ error: 'no such image' }));
        return;
      }
      const origin = req.headers.origin;
      res.writeHead(200, {
        'content-type': img.media,
        'content-length': img.data.length,
        'cache-control': 'public, max-age=31536000, immutable',
        ...(origin && isLocalOrigin(origin) ? { 'access-control-allow-origin': origin } : {}),
      });
      res.end(img.data);
    })();
    return;
  }
  // Is there a newer build, or a line from airoom.dev worth a strip at the top?
  if (req.url === '/release') {
    res.writeHead(200, corsHeaders(req));
    res.end(JSON.stringify(releaseState()));
    return;
  }
  // The desktop shell asks for a shutdown here rather than with a signal:
  // Windows has no SIGTERM, a signal there is an immediate kill, and an
  // immediate kill skips parking the teams. Loopback-only, like everything.
  if (req.url === '/shutdown' && req.method === 'POST') {
    res.writeHead(202);
    res.end();
    void shutdown();
    return;
  }

  if (req.url === '/health') {
    // CORS: the dev UI on :5173 polls this too (server itself is loopback-only)
    res.writeHead(200, corsHeaders(req));
    // `busy` answers the one question nothing could answer before: is airoom in
    // the middle of something? Quitting the app takes every run with it, and
    // there was no way — for a person or a script — to check first.
    const working = (teams?.list() ?? []).filter((x) => x.state === 'working');
    res.end(
      JSON.stringify({
        ok: true,
        engine: engineDiagnostics(),
        busy: {
          runs: controller.activeRuns().length,
          teams: working.length,
          teamNames: working.map((x) => x.name || x.task.split('\n')[0].slice(0, 60)),
        },
      }),
    );
    return;
  }
  // What the hire form needs to say what will actually happen in this folder.
  if (req.url?.startsWith('/room-git')) {
    const q = new URL(req.url, 'http://localhost').searchParams.get('room');
    res.writeHead(200, corsHeaders(req));
    res.end(JSON.stringify(q && isAbsolutePath(q) ? gitFacts(q) : { repo: false, branch: null, dirty: 0, commits: false }));
    return;
  }
  if (req.url?.startsWith('/fs/list')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const q = params.get('path');
    // The very top of the tree is one root on Unix and a row of drives on
    // Windows; the picker asks for it with '/' and gets whichever is true.
    if (isWindows && (q === '/' || q === '\\')) {
      res.writeHead(200, corsHeaders(req));
      res.end(JSON.stringify({ path: '', parent: null, dirs: listRoots().map((r) => ({ name: r, path: r })), files: [] }));
      return;
    }
    const target = q && isAbsolutePath(q) ? q : os.homedir();
    void listDirs(target, params.get('files') === '1')
      .then((data) => {
        res.writeHead(200, corsHeaders(req));
        res.end(JSON.stringify(data));
      })
      .catch(() => {
        res.writeHead(200, corsHeaders(req));
        res.end(
          JSON.stringify({
            path: target,
            parent: path.dirname(target) === target ? null : path.dirname(target),
            dirs: [],
            files: [],
            error: 'Cannot read this folder',
          }),
        );
      });
    return;
  }
  void serveStatic(req, res);
});

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }: { origin?: string }) => isLocalOrigin(origin),
});

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const clients = new Set<WebSocket>();

function broadcast(msg: ServerMessage) {
  const payload = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}

// After a "start Ollama" request, look every 1.5s for up to ~40s so the models
// land in the menu the moment Ollama answers, not at the next 30s tick.
function watchOllamaComeUp(tries = 26) {
  setTimeout(() => {
    refreshOllama()
      .then((changed) => {
        if (changed) broadcast({ v: 1, type: 'models', models: mergedModels() });
        if (!ollamaStatus().running && tries > 1) watchOllamaComeUp(tries - 1);
      })
      .catch(() => {});
  }, 1500).unref();
}

async function broadcastSnapshot() {
  if (clients.size === 0) return;
  try {
    const snapshot = withRunOverlay(await source.getSnapshot());
    broadcast({ v: 1, type: 'snapshot', snapshot });
  } catch (err) {
    console.error('snapshot broadcast failed', err);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`client connected (${clients.size} total)`);
  void (async () => {
    try {
      send(ws, {
        v: 1,
        type: 'snapshot',
        snapshot: withRunOverlay(await source.getSnapshot()),
      });
    } catch (err) {
      console.error('initial snapshot failed', err);
    }
    // What models this machine offers. Sent up front so the picker is right
    // before the first agent has ever run.
    const models = mergedModels();
    send(ws, { v: 1, type: 'models', models: models.length ? models : FALLBACK_MODELS });
    const commands = cachedCommands();
    if (commands.length) send(ws, { v: 1, type: 'commands', commands });
    if (playbooks) send(ws, { v: 1, type: 'playbooks', playbooks: playbooks.list() });
    // Replay any approval still waiting on a human. The snapshot alone only
    // says a robot "needs your approval" — the Allow/Deny card is driven by a
    // run update, so a client arriving after that update was broadcast (a
    // reload, or reopening the window of a tray app whose server kept running)
    // used to see the alarm with no way to answer it and no stop button either.
    for (const run of controller.activeRuns()) {
      const p = run.pendingPermission;
      if (!p) continue;
      send(ws, {
        v: 1,
        type: 'run',
        update: {
          runKey: run.runKey,
          roomId: run.roomId,
          sessionId: run.sessionId,
          phase: 'permission',
          requestId: p.requestId,
          text: p.label,
          // the WHOLE ask — a replayed card must show the same diff and offer
          // the same "always allow" as the one the first renderer saw
          tool: { ...p.tool, input: p.input, title: p.title, description: p.description },
          canAlways: p.canAlways,
          alwaysMode: p.alwaysMode,
        },
      });
    }
  })();

  ws.on('message', async (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // Everything past JSON.parse is untrusted input. The old code went straight
    // to msg.text.trim() / msg.path.split('/'), so a frame missing one field
    // threw inside this async listener — and ws discards the returned promise,
    // making it an unhandled rejection that can take the whole server down.
    // Validate the shape here, and treat any throw below as a bad frame.
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    try {
      if (msg.type === 'subscribe') {
        const sessionId = str(msg.sessionId);
        if (!sessionId) return;
        // the client asks for a bigger window as it scrolls back through history
        // Ceiling must be the parser's own retention limit. Clamping lower
        // than MAX_STEPS meant a long session always answered hasMore:true —
        // "load earlier messages" then paged forever without ever arriving at
        // the beginning.
        const limit = Math.min(Math.max(Number(msg.limit) || 200, 50), MAX_STEPS);
        const { steps, hasMore } = await source.getTranscript(sessionId, limit);
        send(ws, { v: 1, type: 'transcript', sessionId, steps, hasMore });
      } else if (msg.type === 'send') {
        const text = str(msg.text) ?? '';
        const roomId = str(msg.roomId);
        if (!roomId) return;
        if (!text.trim() && !msg.images?.length) return;
        // Skilled agents: a fresh hire carries its loadout in the message; a
        // resumed one wears whatever the store remembers for its session. The
        // loadout becomes a system-prompt preamble on EVERY turn — standing
        // equipment, not a first-turn favour that evaporates with the
        // keepalive. (Loadout paths are sanitised: only real SKILL.md files
        // from where skills actually live are ever read into a prompt.)
        const sessionId = str(msg.sessionId) ?? undefined;
        const requested = sanitizeAgentSkills(msg.skills, roomId);
        if (sessionId && requested) assignSkills(sessionId, requested);
        const loadout = sessionId ? (skillsFor(sessionId) ?? requested) : requested;
        const skillPrompt = loadout ? buildSkillPrompt(loadout, roomId) : undefined;
        // A hire can also arrive christened — the name waits for the session
        // id the same way the loadout does.
        const hireName = !sessionId ? (str(msg.agentName) ?? '').trim() : '';
        // Team members are ordinary sessions, so the human chats with them
        // through this very path — but their runs only work as teammates if
        // the team MCP server, role preamble and write-blocks ride along.
        // Without this, any direct message (and EVERY message after a
        // restart, when no equipped run survives) resumed the member bare:
        // the reviewer lost give_verdict, the lead lost finish.
        const equip = sessionId ? (teams?.directSendEquipment(sessionId) ?? null) : null;
        // A playbook run keeps its card and its allowlist on every follow-up,
        // and the follow-up itself is counted as supervision.
        const book = sessionId && !equip ? (playbooks?.equipmentFor(sessionId) ?? null) : null;
        // A model picked in this member's panel must outlive this run — team
        // assignments used to snap the member back to the team-wide model.
        if (equip && sessionId && typeof msg.model === 'string' && msg.model)
          teams?.noteMemberModel(sessionId, msg.model);
        let identitySaved = (!loadout && !hireName) || !!sessionId;
        // The team must know this turn answers the HUMAN: a member that
        // replies to you without a tool call is conversing, not stalling, and
        // nagging it would inject "call your tool" into your own chat.
        if (equip && sessionId) teams?.noteDirectSend(sessionId);
        // Run updates go to every client (all tabs see the same fleet state).
        // The engine also appends to the session transcript on disk, so the
        // file watcher refreshes snapshots as the agent works.
        void broadcastSnapshot(); // reflect "working" overlay immediately
        await controller.send(
          {
            roomId,
            sessionId,
            text,
            mode: msg.mode,
            model: msg.model,
            fast: msg.fast,
            budgetUsd: typeof msg.budgetUsd === 'number' ? msg.budgetUsd : undefined,
            images: msg.images,
            systemPromptAppend:
              [book ? undefined : skillPrompt, equip?.systemPromptAppend, book?.systemPromptAppend].filter(Boolean).join('\n\n') || undefined,
            ...(equip
              ? {
                  mcpServers: equip.mcpServers,
                  extraDisallowedTools: equip.extraDisallowedTools,
                  autoAllowToolPrefixes: equip.autoAllowToolPrefixes,
                }
              : {}),
            ...(book ? { allowRules: book.allowRules } : {}),
          },
          (update) => {
            equip?.observe(update);
            book?.observe(update);
            // A hire's session id resolves mid-run — pin its identity (skill
            // loadout, given name) to it the moment it exists, so the desk
            // badge and callsign appear and every later turn (which resumes
            // by session id) finds them.
            if (!identitySaved && update.sessionId) {
              identitySaved = true;
              if (loadout) assignSkills(update.sessionId, loadout);
              if (hireName) setAgentName(update.sessionId, hireName);
              void broadcastSnapshot();
            }
            broadcast({ v: 1, type: 'run', update });
            // permission asked/answered changes the robot's overlay status
            if (update.phase === 'permission') void broadcastSnapshot();
          },
        );
        void broadcastSnapshot(); // reflect run completion immediately
      } else if (msg.type === 'playbookDraft') {
        const sessionId = str(msg.sessionId);
        const roomId = str(msg.roomId);
        if (!sessionId || !roomId) return;
        if (!playbooks) {
          send(ws, { v: 1, type: 'playbookDraft', sessionId, error: 'Playbooks need the SDK engine (unset AIROOM_ENGINE=cli).' });
          return;
        }
        // Extraction is a model call and takes a while; the socket must not
        // block on it (an approval could arrive for another agent meanwhile).
        void playbooks.draft(sessionId, roomId).then((r) => send(ws, { v: 1, type: 'playbookDraft', sessionId, ...r }));
      } else if (msg.type === 'playbookSave') {
        if (!playbooks) return;
        const r = playbooks.save(msg.playbook);
        send(ws, {
          v: 1,
          type: 'notice',
          text: r.ok ? `Playbook "${r.playbook.name}" saved — run it from the Playbooks list.` : r.error,
          isError: !r.ok,
        });
      } else if (msg.type === 'playbookDelete') {
        const id = str(msg.id);
        if (!id || !playbooks) return;
        if (!playbooks.delete(id)) send(ws, { v: 1, type: 'notice', text: 'No such playbook.', isError: true });
      } else if (msg.type === 'playbookRun') {
        const id = str(msg.id);
        if (!id || !playbooks) return;
        const pb = playbooks.get(id);
        if (!pb) {
          send(ws, { v: 1, type: 'notice', text: 'No such playbook.', isError: true });
          return;
        }
        const mode = PERMISSION_MODES.some((p) => p.value === msg.mode) ? msg.mode : undefined;
        const model = typeof msg.model === 'string' && msg.model.trim() && msg.model.length <= 100 ? msg.model.trim() : undefined;
        const r = playbooks.run(id, msg.inputs, mode, model);
        if (!r.ok) send(ws, { v: 1, type: 'notice', text: r.error ?? 'Could not start that playbook.', isError: true });
      } else if (msg.type === 'playbookRule') {
        const id = str(msg.id);
        const text = str(msg.text);
        if (!id || !text || !playbooks) return;
        const r = playbooks.addRule(id, text, str(msg.runId) || undefined);
        send(ws, { v: 1, type: 'notice', text: r.ok ? 'Remembered — it is a rule on the card now.' : (r.error ?? 'Could not add that rule.'), isError: !r.ok });
      } else if (msg.type === 'playbookDropRule') {
        const id = str(msg.id);
        const ruleId = str(msg.ruleId);
        if (!id || !ruleId || !playbooks) return;
        playbooks.dropRule(id, ruleId);
      } else if (msg.type === 'playbookStop') {
        const id = str(msg.id);
        const runId = str(msg.runId);
        if (!id || !runId || !playbooks) return;
        playbooks.stop(id, runId);
        void broadcastSnapshot();
      } else if (msg.type === 'listConnectors') {
        const roomId = str(msg.roomId);
        if (!roomId || !isAbsolutePath(roomId)) return;
        // Answers now with what is known (possibly "checking"); the fresh
        // answer is broadcast when the runtime replies.
        send(ws, { v: 1, type: 'connectors', room: connectors.list(roomId, !!msg.refresh) });
      } else if (msg.type === 'setConnectorEnabled') {
        const roomId = str(msg.roomId);
        const name = str(msg.name);
        if (!roomId || !name || !isAbsolutePath(roomId)) return;
        const known = connectors.get(roomId)?.connectors.find((c) => c.name === name);
        const isProject = !known || known.scope === 'project';
        let err: string | null;
        if (isProject) {
          // Claude Code's own per-project approval for a .mcp.json server.
          err = setProjectChoice(roomId, name, !!msg.enabled);
        } else {
          // A shared connector: on the wall for this room. Turning it on also
          // makes sure Claude Code loads it here; turning it off only takes
          // it off the wall (disabling it for the project is its own switch).
          err = setAdopted(roomId, name, !!msg.enabled);
          if (!err && msg.enabled && !sharedLoaded(roomId, name)) err = setSharedLoaded(roomId, name, true);
        }
        send(ws, {
          v: 1,
          type: 'notice',
          text:
            err ??
            (isProject
              ? `${name} is ${msg.enabled ? 'on' : 'off'} for ${folderName(roomId)} — agents pick it up on their next run.`
              : msg.enabled
                ? `${name} is on the wall in ${folderName(roomId)}.`
                : `${name} is off the wall in ${folderName(roomId)}. Claude Code still loads it here unless you disable it for the project.`),
          isError: !!err,
        });
        if (err) return;
        if (isProject) connectors.list(roomId, true);
        else connectors.reannotate(roomId);
      } else if (msg.type === 'setConnectorLoaded') {
        const roomId = str(msg.roomId);
        const name = str(msg.name);
        if (!roomId || !name || !isAbsolutePath(roomId)) return;
        const err = setSharedLoaded(roomId, name, !!msg.loaded);
        if (!err && !msg.loaded) setAdopted(roomId, name, false);
        send(ws, {
          v: 1,
          type: 'notice',
          text: err ?? (msg.loaded ? `${name} is loaded again for ${folderName(roomId)} — from the next run.` : `${name} is disabled for ${folderName(roomId)} — agents here no longer get it, from their next run.`),
          isError: !!err,
        });
        if (!err) connectors.list(roomId, true);
      } else if (msg.type === 'addConnector') {
        const roomId = str(msg.roomId);
        const name = str(msg.name);
        if (!roomId || !name || !isAbsolutePath(roomId)) return;
        const transport = msg.transport === 'http' || msg.transport === 'sse' ? msg.transport : 'stdio';
        const strMap = (v: unknown): Record<string, string> | undefined => {
          if (!v || typeof v !== 'object') return undefined;
          const out: Record<string, string> = {};
          for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 40)) if (typeof val === 'string' && /^[A-Za-z_][\w-]*$/.test(k)) out[k] = val.slice(0, 2000);
          return Object.keys(out).length ? out : undefined;
        };
        const err = addProjectServer(roomId, {
          name,
          transport,
          command: str(msg.command) ?? undefined,
          args: Array.isArray(msg.args) ? msg.args.filter((a): a is string => typeof a === 'string') : undefined,
          url: str(msg.url) ?? undefined,
          env: strMap(msg.env),
          headers: strMap(msg.headers),
        });
        send(ws, { v: 1, type: 'notice', text: err ?? `${name} added to ${folderName(roomId)}/.mcp.json — checking it now.`, isError: !!err });
        if (!err) connectors.list(roomId, true);
      } else if (msg.type === 'removeConnector') {
        const roomId = str(msg.roomId);
        const name = str(msg.name);
        if (!roomId || !name || !isAbsolutePath(roomId)) return;
        const err = removeProjectServer(roomId, name);
        send(ws, { v: 1, type: 'notice', text: err ?? `${name} removed from ${folderName(roomId)}/.mcp.json.`, isError: !!err });
        if (!err) connectors.list(roomId, true);
      } else if (msg.type === 'listSkills') {
        const roomId = str(msg.roomId);
        if (!roomId) return;
        send(ws, { v: 1, type: 'skills', roomId, skills: discoverSkills(roomId) });
      } else if (msg.type === 'createSkill') {
        const roomId = str(msg.roomId);
        const name = str(msg.name);
        const body = str(msg.body);
        if (!roomId || !name?.trim() || !body?.trim()) return;
        const r = createUserSkill(name, str(msg.description) ?? '', body);
        send(ws, {
          v: 1,
          type: 'notice',
          text: r.ok ? `Skill "${r.name}" saved to ~/.claude/skills — every room can use it now.` : r.error,
          isError: !r.ok,
        });
        if (r.ok) send(ws, { v: 1, type: 'skills', roomId, skills: discoverSkills(roomId) });
      } else if (msg.type === 'nameAgent') {
        const sessionId = str(msg.sessionId);
        if (!sessionId) return;
        setAgentName(sessionId, str(msg.name) ?? '');
        await broadcastSnapshot();
      } else if (msg.type === 'interrupt') {
        const runKey = str(msg.runKey);
        if (!runKey) return;
        controller.interrupt(runKey);
        void broadcastSnapshot();
      } else if (msg.type === 'permission') {
        const requestId = str(msg.requestId);
        if (!requestId) return;
        // `always` MUST be forwarded: without it respondPermission defaults to a
      // one-time allow and the runtime's suggested rules are dropped, so
      // "Always allow" quietly did nothing for rule-based tools.
      controller.respondPermission(requestId, !!msg.allow, !!msg.always);
        void broadcastSnapshot();
      } else if (msg.type === 'setMode') {
      const runKey = str(msg.runKey);
      if (!runKey || !msg.mode) return;
      controller.setMode?.(runKey, msg.mode);
      // If this session is a team member, the choice must outlive the current
      // run — team assignments used to quietly revert it on the next send.
      teams?.noteMemberMode(runKey, msg.mode);
    } else if (msg.type === 'startOllama') {
      const r = startOllama();
      if (!r.started) {
        send(ws, { v: 1, type: 'notice', text: 'Ollama is not installed — get it from ollama.com, pull a model, and it appears in the model menu.', isError: true });
        return;
      }
      send(ws, { v: 1, type: 'notice', text: r.how === 'app' ? 'Starting the Ollama app — your local models appear in the model menu in a moment.' : 'Starting Ollama — your local models appear in the model menu in a moment.' });
      watchOllamaComeUp();
    } else if (msg.type === 'warmLocal') {
      const m = str(msg.model);
      if (m) controller.warmLocal?.(m);
    } else if (msg.type === 'setFastMode') {
      const runKey = str(msg.runKey);
      if (!runKey) return;
      controller.setFastMode?.(runKey, !!msg.fast);
    } else if (msg.type === 'rewind') {
      const runKey = str(msg.runKey);
      const userMessageId = str(msg.userMessageId);
      if (!runKey || !userMessageId) return;
      const res = (await controller.rewind?.(runKey, userMessageId, !!msg.dryRun, {
        roomId: str(msg.roomId) || undefined,
        sessionId: str(msg.sessionId) || undefined,
      })) ?? {
        canRewind: false,
        error: 'Rewind is not supported by this engine.',
      };
      send(ws, { v: 1, type: 'rewound', userMessageId, dryRun: !!msg.dryRun, ...res });
      if (!msg.dryRun && res.canRewind) void broadcastSnapshot();
    } else if (msg.type === 'hireTeam') {
      if (!teams) {
        send(ws, { v: 1, type: 'notice', text: 'Teams need the SDK engine (unset AIROOM_ENGINE=cli).', isError: true });
        return;
      }
      // Per-role overrides arrive from the hire form; only known modes and
      // sane model strings survive — this is a websocket anyone local can open.
      const roleModes: Partial<Record<TeamRole, PermissionMode>> = {};
      const roleModels: Partial<Record<TeamRole, string>> = {};
      for (const [role, m] of Object.entries(msg.roleModes ?? {}))
        if (m && PERMISSION_MODES.some((p) => p.value === m)) roleModes[role] = m;
      for (const [role, mo] of Object.entries(msg.roleModels ?? {}))
        if (typeof mo === 'string' && mo.trim() && mo.length <= 100) roleModels[role] = mo.trim();
      const r = teams.hire({
        roomId: msg.roomId,
        task: msg.task,
        autonomy: msg.autonomy,
        roundCap: msg.roundCap,
        mode: msg.mode,
        model: msg.model,
        roleNotes: msg.roleNotes,
        roleModes,
        thrift: msg.thrift,
        roleModels,
        roster: sanitiseRoster(msg.roster),
        lanes: msg.lanes,
        ownRoom: msg.ownRoom,
      });
      if (!r.ok) send(ws, { v: 1, type: 'notice', text: r.error ?? 'Could not hire a team.', isError: true });
      else if (r.notice) send(ws, { v: 1, type: 'notice', text: r.notice });
    } else if (msg.type === 'teamTask') {
      const r = teams?.newTask(msg.teamId, msg.task);
      if (r && !r.ok) send(ws, { v: 1, type: 'notice', text: r.error ?? 'Could not give them that task.', isError: true });
    } else if (msg.type === 'teamContinue') {
      if (teams && !teams.continue_(msg.teamId))
        send(ws, { v: 1, type: 'notice', text: 'Nothing is waiting on you for that team.', isError: true });
    } else if (msg.type === 'teamCancelTask') {
      const r = teams?.cancelTask(msg.teamId, msg.taskId);
      if (r && !r.ok) send(ws, { v: 1, type: 'notice', text: r.error ?? 'Could not cancel that task.', isError: true });
    } else if (msg.type === 'teamMergeTask') {
      const r = teams?.mergeTask(msg.teamId, msg.taskId);
      if (r && !r.ok) send(ws, { v: 1, type: 'notice', text: r.error ?? 'Could not merge that lane.', isError: true });
      else if (r?.ok) send(ws, { v: 1, type: 'notice', text: 'Lane merged into the project.' });
    } else if (msg.type === 'teamCloseTask') {
      const r = teams?.closeTaskByHuman(msg.teamId, msg.taskId);
      if (r && !r.ok) send(ws, { v: 1, type: 'notice', text: r.error ?? 'Could not close that task.', isError: true });
    } else if (msg.type === 'nameTeam') {
      if (teams && !teams.rename(msg.teamId, String(msg.name ?? '')))
        send(ws, { v: 1, type: 'notice', text: 'No such team.', isError: true });
    } else if (msg.type === 'teamStop') {
      teams?.stop(msg.teamId);
    } else if (msg.type === 'teamDismiss') {
      // Say what is about to be thrown away BEFORE throwing it away: the
      // worktrees go, and a branch nobody merged is work that only exists there.
      const left = teams?.unmergedBranches(msg.teamId) ?? [];
      if (teams && !teams.dismiss(msg.teamId))
        send(ws, { v: 1, type: 'notice', text: 'Stop the team before dismissing it.', isError: true });
      else if (left.length)
        send(ws, {
          v: 1,
          type: 'notice',
          text: `Team dismissed. Unmerged work is still on ${left.join(', ')} — check those branches out to see it.`,
        });
    } else if (msg.type === 'subscribeTeam') {
      if (teams) send(ws, { v: 1, type: 'teamLog', teamId: msg.teamId, handoffs: teams.log(msg.teamId) });
    } else if (msg.type === 'hideAgent') {
      if (!source.setSessionHidden) {
        send(ws, { v: 1, type: 'notice', text: 'This build cannot let agents go.', isError: true });
        return;
      }
      // A team member cannot be sent home mid-job: the lead would keep routing
      // work to a desk nobody is sitting at, and the team would hang waiting
      // for a report that can never come.
      const member = msg.hidden ? teams?.memberOf(msg.sessionId) : undefined;
      if (member) {
        const t = teams?.list().find((x) => x.id === member.id);
        if (t && (t.state === 'working' || t.state === 'awaiting_human')) {
          send(ws, {
            v: 1,
            type: 'notice',
            text: `That agent is the ${member.role} on a running team. Stop the team first.`,
            isError: true,
          });
          return;
        }
      }
      // Stop it before it goes: a hidden robot still burning tokens in the
      // background is the worst of both worlds.
      if (msg.hidden) controller.interrupt(msg.sessionId);
      const err = await source.setSessionHidden(msg.sessionId, msg.hidden);
      if (err) send(ws, { v: 1, type: 'notice', text: err, isError: true });
      else {
        send(ws, { v: 1, type: 'notice', text: msg.hidden ? 'Agent let go — its conversation is kept.' : 'Agent is back.' });
        await broadcastSnapshot();
      }
    } else if (msg.type === 'deleteAgent') {
      if (!source.deleteSession) {
        send(ws, { v: 1, type: 'notice', text: 'This build cannot delete conversations.', isError: true });
        return;
      }
      const member = teams?.memberOf(msg.sessionId);
      if (member) {
        const t = teams?.list().find((x) => x.id === member.id);
        if (t && (t.state === 'working' || t.state === 'awaiting_human')) {
          send(ws, { v: 1, type: 'notice', text: `That agent is the ${member.role} on a running team. Stop the team first.`, isError: true });
          return;
        }
      }
      controller.interrupt(msg.sessionId);
      const res = await source.deleteSession(msg.sessionId);
      if (res.error) send(ws, { v: 1, type: 'notice', text: res.error, isError: true });
      else {
        send(ws, { v: 1, type: 'notice', text: 'Conversation deleted — recoverable from ~/.airoom/deleted' });
        await broadcastSnapshot();
      }
    } else if (msg.type === 'hideProject' || msg.type === 'unhideProject') {
      const target = str(msg.path);
      if (!target || !source.setHidden) return;
      const err = await source.setHidden(target, msg.type === 'hideProject');
      send(ws, {
        v: 1,
        type: 'notice',
        text:
          err ??
          (msg.type === 'hideProject'
            ? `Put ${folderName(target)} away — restore it from + project`
            : `${folderName(target)} is back`),
        isError: !!err,
      });
      if (!err) void broadcastSnapshot();
    } else if (msg.type === 'curateProjects') {
      if (!source.curate) return;
      const hidden = Array.isArray(msg.hidden)
        ? msg.hidden.filter((p): p is string => typeof p === 'string').slice(0, 500)
        : [];
      const err = await source.curate(hidden);
      if (err) send(ws, { v: 1, type: 'notice', text: err, isError: true });
      else void broadcastSnapshot();
    } else if (msg.type === 'addProject') {
        const target = str(msg.path);
        if (!target) return;
        const err = await source.addProject(target);
        send(ws, {
          v: 1,
          type: 'notice',
          text: err ?? `Added ${folderName(target)} — click its ghost desk to hire an agent`,
          isError: !!err,
        });
        if (!err) void broadcastSnapshot();
      }
    } catch (err) {
      console.error('client message failed', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`client disconnected (${clients.size} total)`);
  });
});

// When disk changes, re-broadcast a fresh snapshot to everyone.
source.onChange(() => void broadcastSnapshot());

// NB: ws re-emits the http server's errors on the WSS — handle BOTH, or an
// EADDRINUSE surfaces as an unhandled 'error' event with a scary stack.
const onListenError = (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // The desktop shell probes /health first and picks a free port, so this
    // only fires for hand-started duplicates — fail loud, don't limp.
    console.error(
      `\nairoom: port ${PORT} is already in use — probably the desktop app in your menu bar ` +
        `(quit it via its tray icon) or another dev server. Set PORT to override.\n`,
    );
    process.exit(1);
  }
  throw err;
};
server.on('error', onListenError);
wss.on('error', onListenError);
server.listen(PORT, HOST, () => {
  const bound = server.address();
  const boundPort = bound && typeof bound === 'object' ? bound.port : PORT;
  setOllamaProxyBase(`http://127.0.0.1:${boundPort}${OLLAMA_PROXY_PREFIX}`);
  console.log(`airoom server on http://${HOST}:${PORT}  (ws + /health, loopback only)`);
  // Ask airoom.dev, quietly and identity-free, whether a newer build is out —
  // once shortly after boot, then every few hours. See release.ts.
  startReleaseChecks();
  // Ask the runtime which models and slash commands it offers, before anyone
  // runs anything. Costs a process spawn and no tokens; without it a fresh
  // install shows a model menu with one row in it. The working directory is
  // HOME on purpose: the answer is about this machine, not any project — and
  // using the first room (usually somewhere in ~/Documents) made macOS ask
  // for Documents access at first launch, before the user had done anything.
  void controller.prewarm?.(os.homedir()).catch(() => {
    /* no runtime yet — the cached lists still stand */
  });
  // Local models: cheap probe of Ollama's tags, at boot and every 30s, so
  // starting Ollama mid-session makes its models appear in the pickers.
  const pollOllama = () =>
    refreshOllama()
      .then((changed) => {
        if (changed) broadcast({ v: 1, type: 'models', models: mergedModels() });
      })
      .catch(() => {});
  void pollOllama();
  // The login shell knows about installs that live only on the user's PATH.
  void probeShell();
  setInterval(pollOllama, 30_000).unref();
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('shutting down…');
  // Whatever the graceful path below gets stuck on — a keep-alive socket, a
  // member process that never answers — this process must not outlive the
  // app that owns it. It did: a headless airoom sat in the process list for
  // a quarter of an hour after a quit, its listener closed, waiting on a
  // connection that was never going to end. Four seconds is longer than any
  // of the closes below take when they work.
  setTimeout(() => process.exit(0), 4000).unref();
  // Teams first: their members are about to be killed, and this is the only
  // moment we still know the cause was a quit rather than a failure.
  teams?.shutDown();
  await source.close();
  await controller.close();
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
