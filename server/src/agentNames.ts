import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * User-given agent names, sessionId → name, persisted like the skill loadouts
 * so a christened robot keeps its name across restarts and on every client.
 * Defaults are NOT stored: the client derives them deterministically from the
 * session id, so only actual renames live here.
 */
const STORE_PATH = path.join(os.homedir(), '.airoom', 'agent-names.json');
const STORE_CAP = 1000;
let store: Record<string, string> | null = null;

function loadStore(): Record<string, string> {
  if (store) return store;
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as { sessions?: Record<string, string> };
    store = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  } catch {
    store = {};
  }
  return store;
}

export function agentNameFor(sessionId: string): string | undefined {
  return loadStore()[sessionId];
}

/** Set (or, with an empty name, clear) an agent's name. */
export function setAgentName(sessionId: string, name: string): void {
  const s = loadStore();
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (clean) s[sessionId] = clean;
  else delete s[sessionId];
  const keys = Object.keys(s);
  if (keys.length > STORE_CAP) for (const k of keys.slice(0, keys.length - STORE_CAP)) delete s[k];
  try {
    mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify({ sessions: s }, null, 2));
  } catch {
    /* the in-memory copy still serves this server's lifetime */
  }
}
