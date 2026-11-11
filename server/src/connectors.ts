import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentController, RawMcpStatus } from './agent/AgentController';
import type { Connector, RoomConnectors } from '../../shared/types';

/**
 * Connectors: the MCP servers a room's agents can reach, as the office shows
 * them, and the two things a person can change from the office.
 *
 * WHAT IS NOT HERE: any loading of servers. Claude Code already gives every
 * airoom run its user, project, local and claude.ai servers, because the SDK
 * reads all setting sources by default. This module only READS what the
 * runtime reports — a control query per room, cached, refreshed for free by
 * any live run — and WRITES the per-project on/off choice and new project
 * servers where Claude Code keeps its own, so the terminal and the office
 * never disagree about what a project has.
 */

/** The runtime's own config file. Tests point this at a scratch copy. */
const CLAUDE_JSON = process.env.AIROOM_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
/** Which shared connectors each room has turned on — an office choice. */
const ADOPTED_FILE = process.env.AIROOM_CONNECTORS_FILE || path.join(os.homedir(), '.airoom', 'connectors.json');

// ---- shape ------------------------------------------------------------------

function scopeOf(raw: string | undefined): Connector['scope'] {
  const s = (raw ?? '').toLowerCase();
  if (s === 'user' || s === 'project' || s === 'local' || s === 'managed' || s === 'plugin') return s;
  if (s.startsWith('claude')) return 'claudeai';
  if (s === 'dynamic') return 'plugin';
  return 'unknown';
}

function statusOf(raw: string): Connector['status'] {
  if (raw === 'connected' || raw === 'failed' || raw === 'needs-auth' || raw === 'pending' || raw === 'disabled') return raw;
  if (raw === 'needs_auth' || raw === 'auth') return 'needs-auth';
  return 'failed';
}

function transportOf(config: Record<string, unknown> | undefined): { transport: Connector['transport']; target?: string } {
  if (!config) return { transport: 'unknown' };
  const type = String(config.type ?? (config.command ? 'stdio' : config.url ? 'http' : 'unknown'));
  if (type.startsWith('claudeai')) return { transport: 'claudeai', target: typeof config.url === 'string' ? config.url : undefined };
  if (type === 'stdio' || config.command) {
    const cmd = typeof config.command === 'string' ? path.basename(config.command) : '';
    const args = Array.isArray(config.args) ? (config.args as unknown[]).map(String).join(' ') : '';
    return { transport: 'stdio', target: [cmd, args].filter(Boolean).join(' ').slice(0, 160) || undefined };
  }
  if (type === 'sse' || type === 'http') return { transport: type, target: typeof config.url === 'string' ? config.url.slice(0, 160) : undefined };
  return { transport: 'unknown' };
}

/** The runtime's report, as the office shows it. Secrets never travel: only
 *  the command's basename and the url, never env or headers. */
export function toConnectors(raw: RawMcpStatus[]): Connector[] {
  const out: Connector[] = [];
  for (const r of raw) {
    if (!r || typeof r.name !== 'string') continue;
    if (r.name.startsWith('airoom-')) continue; // the office's own plumbing (team tools)
    const { transport, target } = transportOf(r.config);
    out.push({
      name: r.name,
      scope: scopeOf(r.scope),
      status: statusOf(String(r.status)),
      transport,
      ...(target ? { target } : {}),
      ...(r.error ? { error: String(r.error).slice(0, 400) } : {}),
      tools: (r.tools ?? []).slice(0, 200).map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description.slice(0, 200) } : {}),
        ...(t.annotations?.readOnly ? { readOnly: true } : {}),
        ...(t.annotations?.destructive ? { destructive: true } : {}),
      })),
      ...(r.serverInfo?.version ? { version: String(r.serverInfo.version).slice(0, 40) } : {}),
      onWall: false, // decided per room by the service
      loaded: statusOf(String(r.status)) !== 'disabled',
    });
  }
  const RANK: Record<Connector['scope'], number> = { project: 0, local: 1, user: 2, claudeai: 3, plugin: 4, managed: 5, unknown: 6 };
  return out.sort((a, b) => RANK[a.scope] - RANK[b.scope] || a.name.localeCompare(b.name));
}

// ---- the project's own files -------------------------------------------------

interface McpJson {
  mcpServers?: Record<string, Record<string, unknown>>;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Write a JSON file the way the runtime would find it: whole, or not at all. */
function writeJsonAtomic(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.airoom-tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Servers declared in the project's .mcp.json, by name. */
export function projectServers(cwd: string): Record<string, Record<string, unknown>> {
  return readJson<McpJson>(path.join(cwd, '.mcp.json'))?.mcpServers ?? {};
}

/**
 * The per-project approval lists Claude Code keeps in ~/.claude.json
 * (`enabledMcpjsonServers` / `disabledMcpjsonServers` under the project's
 * entry). A .mcp.json server the person has never approved is neither.
 */
interface ClaudeJson {
  projects?: Record<
    string,
    {
      enabledMcpjsonServers?: string[];
      disabledMcpjsonServers?: string[];
      /** user-wide (and claude.ai) servers `/mcp` has switched off for this project */
      disabledMcpServers?: string[];
      mcpServers?: Record<string, Record<string, unknown>>;
      [k: string]: unknown;
    }
  >;
  /** user-wide servers */
  mcpServers?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

/** Is this shared server switched off for the project in Claude Code? */
export function sharedLoaded(cwd: string, name: string): boolean {
  return !readJson<ClaudeJson>(CLAUDE_JSON)?.projects?.[cwd]?.disabledMcpServers?.includes(name);
}

/** User-wide servers declared in ~/.claude.json, by name. */
export function userServers(): Record<string, Record<string, unknown>> {
  return readJson<ClaudeJson>(CLAUDE_JSON)?.mcpServers ?? {};
}

/**
 * Stop (or resume) Claude Code loading a shared server for this project:
 * the same `disabledMcpServers` list its own `/mcp` screen writes.
 */
export function setSharedLoaded(cwd: string, name: string, loaded: boolean): string | null {
  const j = readJson<ClaudeJson>(CLAUDE_JSON);
  if (!j || typeof j !== 'object') return `Could not read ${CLAUDE_JSON}.`;
  j.projects = j.projects ?? {};
  const entry = (j.projects[cwd] = j.projects[cwd] ?? {});
  const dis = new Set(entry.disabledMcpServers ?? []);
  if (loaded) dis.delete(name);
  else dis.add(name);
  entry.disabledMcpServers = [...dis];
  try {
    writeJsonAtomic(CLAUDE_JSON, j);
    return null;
  } catch (err) {
    return `Could not write ${CLAUDE_JSON}: ${String((err as Error).message ?? err)}`;
  }
}

// ---- which shared connectors a room has turned on -----------------------------

interface Adopted {
  rooms?: Record<string, { on?: string[] }>;
}

export function adoptedIn(cwd: string): Set<string> {
  return new Set(readJson<Adopted>(ADOPTED_FILE)?.rooms?.[cwd]?.on ?? []);
}

export function setAdopted(cwd: string, name: string, on: boolean): string | null {
  const j = readJson<Adopted>(ADOPTED_FILE) ?? {};
  j.rooms = j.rooms ?? {};
  const set = new Set(j.rooms[cwd]?.on ?? []);
  if (on) set.add(name);
  else set.delete(name);
  if (set.size) j.rooms[cwd] = { on: [...set] };
  else delete j.rooms[cwd];
  try {
    writeJsonAtomic(ADOPTED_FILE, j);
    return null;
  } catch (err) {
    return `Could not save the room's connectors: ${String((err as Error).message ?? err)}`;
  }
}

export function projectChoice(cwd: string, name: string): 'enabled' | 'disabled' | 'unset' {
  const entry = readJson<ClaudeJson>(CLAUDE_JSON)?.projects?.[cwd];
  if (entry?.disabledMcpjsonServers?.includes(name)) return 'disabled';
  if (entry?.enabledMcpjsonServers?.includes(name)) return 'enabled';
  return 'unset';
}

/**
 * Record the choice where the CLI records it. ~/.claude.json is the
 * runtime's own file and it rewrites it often, so this is a read-modify-write
 * done in one go, touching nothing but the two lists.
 */
export function setProjectChoice(cwd: string, name: string, enabled: boolean): string | null {
  const j = readJson<ClaudeJson>(CLAUDE_JSON);
  if (!j || typeof j !== 'object') return `Could not read ${CLAUDE_JSON}.`;
  j.projects = j.projects ?? {};
  const entry = (j.projects[cwd] = j.projects[cwd] ?? {});
  const en = new Set(entry.enabledMcpjsonServers ?? []);
  const dis = new Set(entry.disabledMcpjsonServers ?? []);
  if (enabled) {
    en.add(name);
    dis.delete(name);
  } else {
    dis.add(name);
    en.delete(name);
  }
  entry.enabledMcpjsonServers = [...en];
  entry.disabledMcpjsonServers = [...dis];
  try {
    writeJsonAtomic(CLAUDE_JSON, j);
    return null;
  } catch (err) {
    return `Could not write ${CLAUDE_JSON}: ${String((err as Error).message ?? err)}`;
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function addProjectServer(
  cwd: string,
  input: { name: string; transport: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string> },
): string | null {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) return 'A connector name is letters, digits, dots, dashes or underscores.';
  const file = path.join(cwd, '.mcp.json');
  const j = readJson<McpJson>(file) ?? {};
  const servers = j.mcpServers ?? {};
  if (servers[name]) return `"${name}" is already in this project's .mcp.json.`;
  let entry: Record<string, unknown>;
  if (input.transport === 'stdio') {
    const command = (input.command ?? '').trim();
    if (!command) return 'A stdio connector needs a command.';
    entry = { type: 'stdio', command, args: (input.args ?? []).map(String).filter(Boolean).slice(0, 40) };
    if (input.env && Object.keys(input.env).length) entry.env = input.env;
  } else {
    const url = (input.url ?? '').trim();
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    } catch {
      return 'An HTTP or SSE connector needs an http(s) url.';
    }
    entry = { type: input.transport, url };
    if (input.headers && Object.keys(input.headers).length) entry.headers = input.headers;
  }
  try {
    writeJsonAtomic(file, { ...j, mcpServers: { ...servers, [name]: entry } });
  } catch (err) {
    return `Could not write .mcp.json: ${String((err as Error).message ?? err)}`;
  }
  // You added it from the office; that is the approval the trust prompt asks for.
  setProjectChoice(cwd, name, true);
  return null;
}

export function removeProjectServer(cwd: string, name: string): string | null {
  const file = path.join(cwd, '.mcp.json');
  const j = readJson<McpJson>(file);
  if (!j?.mcpServers?.[name]) return `"${name}" is not in this project's .mcp.json — it comes from somewhere the office cannot edit.`;
  const { [name]: _gone, ...rest } = j.mcpServers;
  try {
    writeJsonAtomic(file, { ...j, mcpServers: rest });
  } catch (err) {
    return `Could not write .mcp.json: ${String((err as Error).message ?? err)}`;
  }
  return null;
}

// ---- the cache ----------------------------------------------------------------

/**
 * Per-room status, remembered between asks. A control query costs a process
 * spawn (about two seconds) so rooms are asked one at a time and never twice
 * at once; a live run in the room replaces the cached answer for free.
 */
export class ConnectorsService {
  private rooms = new Map<string, RoomConnectors>();
  private inflight = new Map<string, Promise<RoomConnectors>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private controller: AgentController,
    private onRoom: (room: RoomConnectors) => void,
  ) {}

  get(roomId: string): RoomConnectors | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * The room's view of the runtime's report: servers switched off for the
   * project (which the runtime leaves out) are added as disabled, and every
   * entry is told whether it is on this room's wall.
   */
  private withDisabled(cwd: string, list: Connector[]): Connector[] {
    const seen = new Set(list.map((c) => c.name));
    const extra: Connector[] = [];
    for (const [name, cfg] of Object.entries(projectServers(cwd))) {
      if (seen.has(name)) continue;
      const { transport, target } = transportOf(cfg);
      const choice = projectChoice(cwd, name);
      extra.push({
        name,
        scope: 'project',
        status: 'disabled',
        transport,
        ...(target ? { target } : {}),
        tools: [],
        ...(choice === 'unset' ? { error: 'Not approved for this project yet — turn it on here, or answer the prompt in Claude Code.' } : {}),
        onWall: false,
        loaded: false,
      });
    }
    for (const [name, cfg] of Object.entries(userServers())) {
      if (seen.has(name) || sharedLoaded(cwd, name)) continue;
      const { transport, target } = transportOf(cfg);
      extra.push({ name, scope: 'user', status: 'disabled', transport, ...(target ? { target } : {}), tools: [], onWall: false, loaded: false });
    }
    const adopted = adoptedIn(cwd);
    return [...list, ...extra].map((c) => ({
      ...c,
      loaded: c.status !== 'disabled',
      onWall: c.scope === 'project' || c.scope === 'local' ? c.status !== 'disabled' : adopted.has(c.name) && c.status !== 'disabled',
    }));
  }

  /** Re-derive a cached room after a choice changed, without a spawn. */
  reannotate(cwd: string) {
    const cached = this.rooms.get(cwd);
    if (!cached) return;
    const base = cached.connectors.filter((c) => c.status !== 'disabled' || (c.scope !== 'project' && c.scope !== 'user'));
    const room: RoomConnectors = { ...cached, connectors: this.withDisabled(cwd, base.map((c) => ({ ...c }))) };
    this.rooms.set(cwd, room);
    this.onRoom(room);
  }

  /** A live run reported: replace the cache, tell the clients. */
  ingest(cwd: string, raw: RawMcpStatus[]) {
    const room: RoomConnectors = { roomId: cwd, connectors: this.withDisabled(cwd, toConnectors(raw)), checkedAt: new Date().toISOString(), checking: false };
    this.rooms.set(cwd, room);
    this.onRoom(room);
  }

  /** Answer from the cache, or ask the runtime (once) and answer when it does. */
  list(roomId: string, refresh = false): RoomConnectors {
    const cached = this.rooms.get(roomId);
    if (cached && !refresh) return cached;
    if (!this.controller.mcpStatus) {
      const none: RoomConnectors = { roomId, connectors: [], checkedAt: null, checking: false, error: 'This engine cannot report connectors.' };
      this.rooms.set(roomId, none);
      return none;
    }
    if (!this.inflight.has(roomId)) {
      const checking: RoomConnectors = { ...(cached ?? { roomId, connectors: [], checkedAt: null }), checking: true };
      this.rooms.set(roomId, checking);
      const p = this.queue
        .then(() => this.controller.mcpStatus!(roomId))
        .then(
          (raw) => {
            const room: RoomConnectors = { roomId, connectors: this.withDisabled(roomId, toConnectors(raw)), checkedAt: new Date().toISOString(), checking: false };
            this.rooms.set(roomId, room);
            return room;
          },
          (err) => {
            const room: RoomConnectors = { roomId, connectors: cached?.connectors ?? [], checkedAt: cached?.checkedAt ?? null, checking: false, error: String((err as Error).message ?? err) };
            this.rooms.set(roomId, room);
            return room;
          },
        )
        .then((room) => {
          this.inflight.delete(roomId);
          this.onRoom(room);
          return room;
        });
      this.inflight.set(roomId, p);
      this.queue = p.catch(() => {});
    }
    return this.rooms.get(roomId)!;
  }
}
