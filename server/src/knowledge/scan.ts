import type { KnowledgeDoc, KnowledgeEvent } from '../../../shared/types';

/**
 * What a session took from its team's knowledge base, and what it gave back.
 *
 * An agent with a Cognivio connector reads documents before it works and
 * writes one when it has learned something. The chat shows those calls as
 * one line each among hundreds; this module pulls them out of the transcript
 * as a short list, so "what was this agent told?" has an answer.
 *
 * It reads the transcript's own records, not the parsed steps: a step keeps
 * four thousand characters of a tool's output, and the list of documents a
 * search returned is longer than that. Everything here comes from the file
 * on disk. Nothing is fetched, and no connector's address or key is read.
 *
 * A scan is fed one line at a time and can be fed more later, which is how a
 * session still being written is followed without reading it again.
 */

/** A connector is a Cognivio knowledge base if its name says so. */
export const isKnowledgeBase = (connectorName: string): boolean => /cognivio/i.test(connectorName);

/**
 * mcp__<server>__<tool>, where the server's name says it is Cognivio. The
 * tool is what follows the last `__`: a server may have `__` in its own name
 * (`cognivio__prod`), and a plugin's arrives as
 * mcp__plugin_<plugin>_<server>__<tool>.
 */
function toolOf(name: string): string | null {
  if (!name.startsWith('mcp__')) return null;
  const cut = name.lastIndexOf('__');
  if (cut <= 5) return null;
  return isKnowledgeBase(name.slice(5, cut)) ? name.slice(cut + 2).toLowerCase() : null;
}

/** Does this line name a Cognivio tool, in any letter case? Looked for in
 *  the bytes, next to each `mcp__`, so a megabyte of screenshot costs one
 *  pass and no string. */
const NAME_REACH = 200;
function namesTool(line: Buffer): boolean {
  for (let i = line.indexOf('mcp__'); i !== -1; i = line.indexOf('mcp__', i + 5))
    if (isKnowledgeBase(line.toString('latin1', i, Math.min(line.length, i + NAME_REACH)))) return true;
  return false;
}

const KIND: Record<string, KnowledgeEvent['kind']> = {
  prime_context: 'primed',
  search_memory: 'searched',
  get_related: 'searched',
  get_memory: 'read',
  read_map: 'read',
  write_memory: 'wrote',
  delete_memory: 'removed',
};

const MAX_EVENTS = 500;
const MAX_DOCS = 40;
const text = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

function asDoc(v: unknown): KnowledgeDoc | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const title = text(o.title, 200);
  if (!title) return null;
  const id = text(o.id, 80);
  const type = text(o.type, 40);
  return { title, ...(id ? { id } : {}), ...(type ? { type } : {}) };
}

/** The documents in a tool's answer: the answer itself if it is one, or the
 *  list it carries. The `index` a prime_context returns is the team's map,
 *  sent with every call, and says nothing about this task, so it is left out. */
function docsIn(answer: unknown): KnowledgeDoc[] {
  if (!answer || typeof answer !== 'object') return [];
  const o = answer as Record<string, unknown>;
  const out: KnowledgeDoc[] = [];
  const push = (v: unknown) => {
    const d = asDoc(v);
    if (d && out.length < MAX_DOCS && !out.some((x) => (d.id ? x.id === d.id : x.title === d.title))) out.push(d);
  };
  for (const key of ['results', 'memories', 'related'])
    if (Array.isArray(o[key])) for (const item of o[key] as unknown[]) push(item);
  // read_map: the map document itself. The graph it comes with lists every
  // document in the team, which the agent was not thereby told.
  if (o.mapMemory) push(o.mapMemory);
  if (!out.length) push(o);
  return out;
}

/** A tool_result's content as text: a string, or text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('');
}

export interface KnowledgeScan {
  /** One transcript line. Lines that cannot matter are not parsed. */
  line(line: Buffer): void;
  events(): KnowledgeEvent[];
}

export function createKnowledgeScan(): KnowledgeScan {
  const events: KnowledgeEvent[] = [];
  /** Calls whose answer has not been read yet, by tool_use id. */
  const open = new Map<string, KnowledgeEvent>();

  function call(id: string, name: string, input: Record<string, unknown>, ts: string | null) {
    const tool = toolOf(name);
    const kind = tool ? KIND[tool] : undefined;
    if (!tool || !kind || !id || events.some((e) => e.id === id)) return;
    const event: KnowledgeEvent = { id, ts, kind, docs: [], pending: true };
    const query = text(input.query, 300);
    if (query) event.query = query;
    // What the call names is known before its answer: the title being
    // written, or at least which map. The answer replaces these with what
    // the server said.
    if (kind === 'wrote') {
      const title = text(input.title, 200);
      const type = text(input.type, 40);
      if (title) event.docs = [{ title, ...(type ? { type } : {}) }];
    } else if (tool === 'read_map') {
      event.docs = [{ title: 'The project map', type: 'map' }];
    } else if (tool === 'get_related') {
      event.query = 'documents related to one it had read';
    }
    const about = text(input.memory_id, 80);
    if (about && (kind === 'read' || kind === 'removed')) event.docs = [{ id: about, title: 'A document' }];
    events.push(event);
    open.set(id, event);
    if (events.length > MAX_EVENTS) open.delete(events.shift()!.id);
  }

  function answer(id: string, content: unknown, isError: boolean) {
    const event = open.get(id);
    if (!event) return;
    open.delete(id);
    delete event.pending;
    if (isError) {
      event.failed = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(resultText(content));
    } catch {
      // Not JSON: Claude Code keeps a long answer in a file and leaves a note
      // in the transcript. Keep what the call said. Where the call named no
      // document, say that the answer cannot be listed, not that it was empty.
      if (!event.docs.length) event.unlisted = true;
      return;
    }
    if (event.kind === 'removed') return; // the answer to a delete names nothing
    const docs = docsIn(parsed);
    if (docs.length) event.docs = docs;
    else if (event.kind === 'primed' || event.kind === 'searched') event.docs = [];
  }

  return {
    line(line) {
      // Most of a transcript is not about the knowledge base, and a line can
      // be megabytes of screenshot. Parse one only if it names a Cognivio
      // tool, or carries the answer to a call that is still open.
      let wanted = namesTool(line);
      if (!wanted) for (const id of open.keys()) if (line.includes(id)) wanted = true;
      if (!wanted) return;
      let r: { timestamp?: string; message?: { content?: unknown } };
      try {
        r = JSON.parse(line.toString('utf8'));
      } catch {
        return; // a torn line
      }
      const content = r?.message?.content;
      if (!Array.isArray(content)) return;
      for (const b of content as Array<Record<string, unknown>>) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use' && typeof b.name === 'string')
          call(String(b.id ?? ''), b.name, (b.input ?? {}) as Record<string, unknown>, typeof r.timestamp === 'string' ? r.timestamp : null);
        else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') answer(b.tool_use_id, b.content, b.is_error === true);
      }
    },
    events: () => events.map((e) => ({ ...e, docs: [...e.docs] })),
  };
}

/** A whole transcript at once, for tests and small files. */
export function knowledgeIn(raw: string): KnowledgeEvent[] {
  const scan = createKnowledgeScan();
  for (const l of raw.split('\n')) if (l) scan.line(Buffer.from(l));
  return scan.events();
}
