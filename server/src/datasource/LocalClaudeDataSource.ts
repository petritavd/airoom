import { createReadStream, promises as fs, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { DataSource } from './DataSource';
import type { AwayAgent, FleetSnapshot, KnowledgeEvent, Room, Robot, Step } from '../../../shared/types';
import { createKnowledgeScan, type KnowledgeScan } from '../knowledge/scan';
import { createSessionParse, MAX_STEPS, RECENT_STEPS, windowSteps, type SessionParse } from '../parse/sessionParser';

import { basename, isAbsolutePath, normalizePath, segments } from '../platform';
/**
 * Only sessions active within this window count as "agents at desks".
 * (Claude Code auto-deletes transcripts after ~30 days anyway.) The most
 * recent session per project is always kept, so every project keeps its room.
 */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A session written to within this window stays open: only what it appends is read. */
const LIVE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** How many bytes are compared to decide that a file only grew. */
const ANCHOR_BYTES = 256;
/** Open chats whose every step is kept. */
const OPEN_CHATS = 3;

/** A parse kept open: how far into the file it got, and what the file looked like there. */
interface LiveParse {
  parse: SessionParse;
  /** Bytes consumed: everything before this is in `parse`. Always just past a whole line. */
  offset: number;
  ino: number;
  /** The file's first bytes and the bytes just before `offset`, as they were when read. */
  head: Buffer;
  anchor: Buffer;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  // null = parsed and determined NOT to be an agent (e.g. a sidechain/subagent
  // transcript) — cached so large skipped files aren't re-parsed every snapshot
  robot: Robot | null;
  live?: LiveParse;
}

/**
 * Hand a file's lines to `onLine`, from byte `from` on, one line in memory at
 * a time. Returns the offset just past the last line that ended in a newline,
 * and whatever followed it (a line still being written, or a last line that
 * never got its newline). `onLine` returning false stops the read.
 */
async function eachLine(
  file: string,
  from: number,
  onLine: (line: Buffer) => boolean | void,
): Promise<{ offset: number; tail: Buffer }> {
  let offset = from;
  let carry: Buffer[] = [];
  let carried = 0;
  const stream = createReadStream(file, { start: from, highWaterMark: 1 << 20 });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let at = 0;
      for (let nl = chunk.indexOf(10, at); nl !== -1; nl = chunk.indexOf(10, at)) {
        const piece = chunk.subarray(at, nl);
        const line = carried ? Buffer.concat([...carry, piece], carried + piece.length) : piece;
        carry = [];
        carried = 0;
        offset += line.length + 1;
        at = nl + 1;
        if (line.length && onLine(line) === false) return { offset, tail: Buffer.alloc(0) };
      }
      if (at < chunk.length) {
        const rest = chunk.subarray(at);
        carry.push(rest);
        carried += rest.length;
      }
    }
  } finally {
    stream.destroy();
  }
  return { offset, tail: carried ? Buffer.concat(carry, carried) : Buffer.alloc(0) };
}

/** The bytes just before `offset` (up to 64), to tell later whether the file
 *  was appended to or rewritten. */
async function bytesBefore(file: string, offset: number): Promise<Buffer> {
  const n = Math.min(64, offset);
  if (!n) return Buffer.alloc(0);
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, offset - n);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function sameBytes(file: string, offset: number, before: Buffer): Promise<boolean> {
  return (await bytesBefore(file, offset)).equals(before);
}

/**
 * Reads live Claude Code session state from this machine's ~/.claude/projects.
 * Directory layout:  <root>/<encoded-project>/<sessionId>.jsonl
 * (Subagent transcripts live in <encoded-project>/<sessionId>/subagents/ —
 * deliberately NOT scanned: they are sidechains of a session, not sessions.)
 *
 * Perf: session files reach hundreds of MB, and the busiest one is appended to
 * every few seconds. Files are streamed a line at a time, never held whole; a
 * session still being written keeps its parse open, so only what it appends
 * is read. Compaction can rewrite a file in place, so "it only grew" is
 * checked, never assumed.
 */
export class LocalClaudeDataSource implements DataSource {
  private root: string;
  private watcher: FSWatcher | null = null;
  private listeners = new Set<() => void>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private cache = new Map<string, CacheEntry>();
  /** The few chats open in the UI, every step kept, least recent first. */
  private chats = new Map<string, { size: number; mtimeMs: number; live: LiveParse }>();
  /** Knowledge scans of the sessions looked at last, and where each stopped. */
  private knowledge = new Map<string, { size: number; mtimeMs: number; offset: number; before: Buffer; scan: KnowledgeScan }>();
  /** Reads under way: asked twice at once, a file is still read once. */
  private reading = new Map<string, Promise<unknown>>();
  /** How much reading the transcripts has cost. For tests and for /health. */
  private readStats = { bytes: 0, fullReads: 0, appends: 0 };
  // Manually registered project dirs (rooms that may not have sessions yet).
  private configPath: string;
  private registered: string[] | null = null; // lazy-loaded
  /** Rooms the user has put away. Every directory ever visited with `claude`
   *  becomes a room forever otherwise — an office nobody can tidy. */
  private hidden: string[] | null = null;
  /** Individual sessions the user has let go. Same reasoning as hidden rooms,
   *  one level down: a room has six desks, so yesterday's finished agents
   *  crowd out today's work if there is no way to send anyone home. */
  private hiddenSessionIds: string[] | null = null;
  /** Has the user been asked which found projects to show? A projects.json
   *  written before the question existed means an office already lived in —
   *  those users are not asked; a missing file is a fresh install, and is. */
  private curated: boolean | null = null;

  constructor(root?: string) {
    this.root = root ?? path.join(os.homedir(), '.claude', 'projects');
    this.configPath = path.join(os.homedir(), '.airoom', 'projects.json');
  }

  private async loadRegistered(): Promise<string[]> {
    if (this.registered) return this.registered;
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.registered = Array.isArray(parsed.projects)
        ? (parsed.projects.filter((p: unknown) => typeof p === 'string') as string[])
        : [];
      this.hidden = Array.isArray(parsed.hidden)
        ? (parsed.hidden.filter((p: unknown) => typeof p === 'string') as string[])
        : [];
      this.hiddenSessionIds = Array.isArray(parsed.hiddenSessions)
        ? (parsed.hiddenSessions.filter((p: unknown) => typeof p === 'string') as string[])
        : [];
      this.curated = typeof parsed.curated === 'boolean' ? parsed.curated : true;
    } catch {
      this.registered = [];
      this.hidden = [];
      this.hiddenSessionIds = [];
      this.curated = false;
    }
    return this.registered ?? [];
  }

  /** Rooms the user has hidden (loaded alongside the registered list). */
  private async loadHidden(): Promise<string[]> {
    if (!this.hidden) await this.loadRegistered();
    return this.hidden ?? [];
  }

  private async persist(): Promise<string | null> {
    try {
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });
      await fs.writeFile(
        this.configPath,
        JSON.stringify(
          {
            projects: this.registered ?? [],
            hidden: this.hidden ?? [],
            hiddenSessions: this.hiddenSessionIds ?? [],
            curated: this.curated ?? false,
          },
          null,
          2,
        ),
      );
      return null;
    } catch (err) {
      return `Could not save: ${String(err)}`;
    }
  }

  /**
   * Put a room away / bring it back. Hiding never touches the transcripts on
   * disk — it only stops airoom drawing a room for them, so it is always
   * undoable and can never lose a conversation.
   */
  async setHidden(p: string, hidden: boolean): Promise<string | null> {
    const clean = normalizePath(p);
    if (!isAbsolutePath(clean)) return 'Path must be absolute';
    const list = await this.loadHidden();
    const at = list.indexOf(clean);
    if (hidden && at === -1) list.push(clean);
    if (!hidden && at !== -1) list.splice(at, 1);
    const err = await this.persist();
    if (err) return err;
    this.notify();
    return null;
  }

  /** Hidden rooms, so the UI can offer them back. */
  async hiddenProjects(): Promise<string[]> {
    return [...(await this.loadHidden())];
  }

  /**
   * The first-run answer, or a later revisit of it. The whole hidden list is
   * replaced — this is the one place the user sees every found project at
   * once, so what they leave unticked IS the list. Transcripts are untouched.
   */
  async curate(hidden: string[]): Promise<string | null> {
    await this.loadRegistered();
    const clean = hidden.map((p) => normalizePath(p)).filter((p) => isAbsolutePath(p));
    this.hidden = [...new Set(clean)];
    this.curated = true;
    const err = await this.persist();
    if (err) return err;
    this.notify();
    return null;
  }

  private async loadHiddenSessions(): Promise<string[]> {
    if (!this.hiddenSessionIds) await this.loadRegistered();
    return this.hiddenSessionIds ?? [];
  }

  /**
   * Let an agent go / bring it back.
   *
   * Like hiding a room, this NEVER touches the transcript: the conversation is
   * still on disk, still resumable from Claude Code, and one click from coming
   * back. "Fired" here means "no longer taking up a desk", which is what people
   * actually want when a room is full of finished work.
   */
  async setSessionHidden(sessionId: string, hidden: boolean): Promise<string | null> {
    const id = sessionId.trim();
    if (!id) return 'No session id given.';
    const list = await this.loadHiddenSessions();
    const at = list.indexOf(id);
    if (hidden && at === -1) list.push(id);
    if (!hidden && at !== -1) list.splice(at, 1);
    const err = await this.persist();
    if (err) return err;
    this.notify();
    return null;
  }

  async hiddenSessions(): Promise<string[]> {
    return [...(await this.loadHiddenSessions())];
  }

  /**
   * Delete a conversation for real.
   *
   * The transcript is MOVED to ~/.airoom/deleted rather than unlinked. A
   * transcript can represent a day of work, and a misread confirmation dialog
   * should never be able to destroy one — this way "undo" is a file move the
   * user can do themselves, and the app can say exactly where it went.
   */
  async deleteSession(sessionId: string): Promise<{ error?: string; movedTo?: string }> {
    const id = sessionId.trim();
    if (!id || /[\\/]/.test(id) || id.includes('..')) return { error: 'That session id is not valid.' };
    const files = await this.listSessionFiles();
    const match = files.find((f) => path.basename(f, '.jsonl') === id);
    if (!match) return { error: 'No transcript on disk for that session.' };
    const graveyard = path.join(os.homedir(), '.airoom', 'deleted');
    const dest = path.join(graveyard, `${path.basename(path.dirname(match))}__${id}.jsonl`);
    try {
      await fs.mkdir(graveyard, { recursive: true });
      await fs.rename(match, dest);
    } catch (err) {
      return { error: `Could not move the transcript: ${String(err)}` };
    }
    // Drop it from the away-list too, or the id lingers in config forever.
    const list = await this.loadHiddenSessions();
    const at = list.indexOf(id);
    if (at !== -1) list.splice(at, 1);
    await this.persist();
    this.cache.delete(match);
    this.chats.delete(match);
    this.notify();
    return { movedTo: dest };
  }

  async addProject(p: string): Promise<string | null> {
    const clean = normalizePath(p);
    if (!isAbsolutePath(clean)) return 'Path must be absolute';
    try {
      const st = await fs.stat(clean);
      if (!st.isDirectory()) return 'Not a directory';
    } catch {
      return 'Directory does not exist';
    }
    const list = await this.loadRegistered();
    if (!list.includes(clean)) list.push(clean);
    // Adding a room you previously put away should bring it back, not create
    // an entry that stays invisible.
    const away = await this.loadHidden();
    const at = away.indexOf(clean);
    if (at !== -1) away.splice(at, 1);
    const err = await this.persist();
    if (err) return err;
    this.notify(); // room appears on the next snapshot
    return null;
  }

  /** Top-level session .jsonl files only (one level deep, files only). */
  private async listSessionFiles(): Promise<string[]> {
    let projectDirs: string[];
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(this.root, e.name));
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const dir of projectDirs) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries)
          if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(dir, e.name));
      } catch {
        continue;
      }
    }
    return files;
  }

  /** What reading transcripts has cost since this process started. */
  stats(): { bytes: number; fullReads: number; appends: number } {
    return { ...this.readStats };
  }

  /** Stream `file` from `from` into `parse`. Returns how far it got: always just past a whole record. */
  private async feed(parse: SessionParse, file: string, from: number): Promise<number> {
    const take = (line: Buffer) => {
      try {
        parse.add(JSON.parse(line.toString('utf8')));
      } catch {
        /* a line that is not JSON is skipped, as it always was */
      }
    };
    const { offset, tail } = await eachLine(file, from, take);
    this.readStats.bytes += offset - from;
    if (!tail.length) return offset;
    // No newline after the last line. If it is whole JSON it is a record like
    // any other; if not, the writer is mid-line and it waits for next time.
    try {
      parse.add(JSON.parse(tail.toString('utf8')));
    } catch {
      return offset;
    }
    this.readStats.bytes += tail.length;
    return offset + tail.length;
  }

  /** The file's first bytes and the bytes just before `offset`: what "it only grew" is checked against. */
  private async ends(file: string, offset: number): Promise<{ head: Buffer; anchor: Buffer }> {
    const n = Math.min(ANCHOR_BYTES, offset);
    const head = Buffer.alloc(n);
    const anchor = Buffer.alloc(n);
    const fh = await fs.open(file, 'r');
    try {
      await fh.read(head, 0, n, 0);
      await fh.read(anchor, 0, n, offset - n);
    } finally {
      await fh.close();
    }
    return { head, anchor };
  }

  /**
   * Bring a parse of `file` up to date: only the appended bytes when the file
   * only grew (same file, same first bytes, same bytes before where reading
   * stopped), from the top otherwise. `track` keeps what the next check needs.
   */
  private async catchUp(file: string, stat: Stats, live: LiveParse | undefined, keep: number, track: boolean): Promise<LiveParse> {
    if (live && (stat.ino !== live.ino || stat.size < live.offset)) live = undefined;
    if (live) {
      const now = await this.ends(file, live.offset);
      if (!now.head.equals(live.head) || !now.anchor.equals(live.anchor)) live = undefined;
    }
    if (live) this.readStats.appends++;
    else {
      this.readStats.fullReads++;
      const parse = createSessionParse(path.basename(file, '.jsonl'), path.basename(path.dirname(file)), keep);
      live = { parse, offset: 0, ino: stat.ino, head: Buffer.alloc(0), anchor: Buffer.alloc(0) };
    }
    live.offset = await this.feed(live.parse, file, live.offset);
    if (track) Object.assign(live, await this.ends(file, live.offset));
    return live;
  }

  /** Run `read` once per key at a time: a second caller shares the first one's result. */
  private once<T>(key: string, read: () => Promise<T>): Promise<T> {
    const running = this.reading.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = read().finally(() => this.reading.delete(key));
    this.reading.set(key, p);
    return p;
  }

  /** Parse one session file for its desk, reusing the cached result if it hasn't changed. */
  private robotFor(file: string): Promise<Robot | null> {
    return this.once(`desk ${file}`, async () => {
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        return null;
      }
      const cached = this.cache.get(file);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.robot;
      try {
        // Only a session someone is still writing to is worth keeping open,
        // and a desk needs no more than its last few steps.
        const open = Date.now() - stat.mtimeMs < LIVE_WINDOW_MS;
        const live = await this.catchUp(file, stat, cached?.live, RECENT_STEPS, open);
        const robot = live.parse.robot();
        this.cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, robot, ...(open ? { live } : {}) });
        return robot;
      } catch {
        return null;
      }
    });
  }

  async getSnapshot(): Promise<FleetSnapshot> {
    const files = await this.listSessionFiles();
    const away = new Set(await this.loadHidden());
    const letGo = new Set(await this.loadHiddenSessions());

    // Evict cache entries for deleted files.
    const live = new Set(files);
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);

    const all: Robot[] = [];
    const gone: AwayAgent[] = [];
    for (const file of files) {
      const robot = await this.robotFor(file);
      if (!robot) continue;
      if (letGo.has(robot.sessionId)) {
        gone.push({
          sessionId: robot.sessionId,
          roomId: robot.roomId,
          title: robot.title,
          lastActivity: robot.lastActivity,
          messageCount: robot.messageCount,
        });
      } else all.push(robot);
    }

    // Active-agent policy: a robot at a desk = a session with recent activity.
    // Older sessions are history, not agents — but keep the most recent session
    // per room so every project retains a (quiet) office.
    const now = Date.now();
    const byRoom = new Map<string, Robot[]>();
    for (const r of all) {
      const list = byRoom.get(r.roomId) ?? [];
      list.push(r);
      byRoom.set(r.roomId, list);
    }
    const robots: Robot[] = [];
    for (const [roomId, list] of byRoom.entries()) {
      if (away.has(roomId)) continue; // put away by the user
      list.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
      const active = list.filter(
        (r) => r.lastActivity && now - Date.parse(r.lastActivity) < ACTIVE_WINDOW_MS,
      );
      robots.push(...(active.length ? active : [list[0]]));
    }

    // Group robots into rooms.
    const roomMap = new Map<string, Room>();
    for (const r of robots) {
      let room = roomMap.get(r.roomId);
      if (!room) {
        room = {
          id: r.roomId,
          name: basename(r.roomId),
          path: r.roomId,
          robotCount: 0,
          needsAttention: false,
        };
        roomMap.set(r.roomId, room);
      }
      room.robotCount++;
      if (r.status === 'waiting_input' || r.status === 'error') room.needsAttention = true;
    }

    // Manually registered projects appear as rooms even with no sessions yet —
    // an office waiting for its first hire.
    for (const p of await this.loadRegistered()) {
      if (!roomMap.has(p) && !away.has(p)) {
        roomMap.set(p, { id: p, name: basename(p), path: p, robotCount: 0, needsAttention: false });
      }
    }

    // …and so does a room whose every agent has been let go. Without this,
    // letting the last one go deletes the room from the office and strands the
    // agent inside it: nothing left to click, and no way to ask for it back.
    for (const a of gone) {
      if (!roomMap.has(a.roomId) && !away.has(a.roomId)) {
        roomMap.set(a.roomId, {
          id: a.roomId,
          name: basename(a.roomId),
          path: a.roomId,
          robotCount: 0,
          needsAttention: false,
        });
      }
    }

    // Disambiguate rooms whose names collide by prefixing parent directories
    // ("frontend" → "applyai/frontend"), walking further up until unique.
    for (let depth = 2; depth <= 5; depth++) {
      const byName = new Map<string, Room[]>();
      for (const room of roomMap.values()) {
        const list = byName.get(room.name) ?? [];
        list.push(room);
        byName.set(room.name, list);
      }
      let collided = false;
      for (const list of byName.values()) {
        if (list.length < 2) continue;
        collided = true;
        for (const room of list) {
          // Display joins with `/` on every platform: `proj/web` reads as one name
          // whether the room lives at /x/proj/web or C:\\x\\proj\\web.
          const parts = segments(room.path);
          room.name = parts.slice(-depth).join('/');
        }
      }
      if (!collided) break;
    }

    const rooms = [...roomMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    // Teams are the gateway's overlay (TeamController owns them); the disk
    // datasource only ever reports what transcripts prove exists.
    return {
      rooms,
      robots,
      teams: [],
      away: gone,
      generatedAt: new Date().toISOString(),
      curated: this.curated ?? true,
      hiddenProjects: [...away],
    };
  }

  /**
   * One attached image's bytes, addressed as <recordUuid>:<blockIndex>.
   * Read on demand: shipping base64 inside every transcript window would
   * multiply snapshot traffic by the size of every screenshot ever pasted.
   */
  async getSessionImage(
    sessionId: string,
    ref: string,
  ): Promise<{ media: string; data: Buffer } | null> {
    const m = /^([0-9a-f-]{8,64}):(\d{1,2})$/i.exec(ref);
    if (!m) return null;
    const [, uuid, idxStr] = m;
    const idx = Number(idxStr);
    const files = await this.listSessionFiles();
    const file = files.find((f) => path.basename(f, '.jsonl') === sessionId);
    if (!file) return null;
    // One line at a time, and no further than the record: the image may be in
    // a transcript of several hundred megabytes.
    const needle = Buffer.from(uuid);
    let found: { media: string; data: Buffer } | null = null;
    const look = (line: Buffer): boolean | void => {
      if (!line.includes(needle)) return;
      try {
        const rec = JSON.parse(line.toString('utf8'));
        if (rec.uuid !== uuid) return;
        const block = rec.message?.content?.[idx];
        if (block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string')
          found = { media: String(block.source.media_type ?? 'image/png'), data: Buffer.from(block.source.data, 'base64') };
        return false; // this was the record, image or not
      } catch {
        /* torn line */
      }
    };
    const { tail } = await eachLine(file, 0, look);
    if (!found && tail.length) look(tail);
    return found;
  }

  async getTranscript(sessionId: string, limit = 40): Promise<{ steps: Step[]; hasMore: boolean }> {
    const files = await this.listSessionFiles();
    const match = files.find((f) => path.basename(f, '.jsonl') === sessionId);
    if (!match) return { steps: [], hasMore: false };
    try {
      // The open chat asks again on every change to its session: keep its
      // parse, every step of it, and catch up on what was appended.
      const steps = await this.once(`chat ${match}`, async () => {
        const stat = await fs.stat(match);
        let hit = this.chats.get(match);
        this.chats.delete(match); // most recent last
        if (!hit || hit.size !== stat.size || hit.mtimeMs !== stat.mtimeMs)
          hit = { size: stat.size, mtimeMs: stat.mtimeMs, live: await this.catchUp(match, stat, hit?.live, MAX_STEPS, true) };
        this.chats.set(match, hit);
        if (this.chats.size > OPEN_CHATS) this.chats.delete(this.chats.keys().next().value as string);
        return hit.live.parse.steps();
      });
      return windowSteps(steps, limit);
    } catch {
      return { steps: [], hasMore: false };
    }
  }

  /**
   * What a session used from its knowledge base. The scan is kept with where
   * it stopped, so an open sheet following a working session reads only what
   * was appended. A file that shrank, or whose bytes before the stopping
   * point changed, was rewritten (`/compact` does that) and is read again
   * from the top.
   */
  async getKnowledge(sessionId: string): Promise<KnowledgeEvent[]> {
    const files = await this.listSessionFiles();
    const match = files.find((f) => path.basename(f, '.jsonl') === sessionId);
    if (!match) return [];
    try {
      return await this.once(`knowledge ${match}`, async () => {
        const stat = await fs.stat(match);
        let hit = this.knowledge.get(match);
        this.knowledge.delete(match); // most recent last
        if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
          this.knowledge.set(match, hit);
          return hit.scan.events();
        }
        if (hit && (stat.size < hit.offset || !(await sameBytes(match, hit.offset, hit.before)))) hit = undefined;
        const scan = hit?.scan ?? createKnowledgeScan();
        const from = hit?.offset ?? 0;
        const { offset } = await eachLine(match, from, (line) => scan.line(line));
        // A last line with no newline yet is left for the next read, when it
        // is whole: scanning it now would count a call that is half written.
        this.knowledge.set(match, { size: stat.size, mtimeMs: stat.mtimeMs, offset, before: await bytesBefore(match, offset), scan });
        if (this.knowledge.size > OPEN_CHATS) this.knowledge.delete(this.knowledge.keys().next().value as string);
        return scan.events();
      });
    } catch {
      return [];
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    if (!this.watcher) this.startWatching();
    return () => this.listeners.delete(cb);
  }

  private notify = () => {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      for (const cb of this.listeners) cb();
    }, 300);
  };

  private startWatching() {
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      depth: 1, // root → project dir → session files; excludes subagent subdirs
      ignored: (p: string) => p.includes(`${path.sep}subagents${path.sep}`),
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    });
    this.watcher.on('add', this.notify).on('change', this.notify).on('unlink', this.notify);
  }

  async close(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    await this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }
}

// basename() itself now lives in ../platform, where it accepts either separator.
