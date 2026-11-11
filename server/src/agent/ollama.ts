import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ModelChoice } from '../../../shared/types';

/**
 * Local models through Ollama.
 *
 * Ollama serves an Anthropic-compatible /v1/messages endpoint, and Claude Code
 * honours ANTHROPIC_BASE_URL — so a local model is not a new engine, it is the
 * same runtime pointed elsewhere. Every airoom feature (approval cards, teams,
 * rewind, the parser) works unchanged; only the model behind the turn differs.
 *
 * What DOES differ is quality. Claude Code's system prompt is ~20k tokens of
 * tool descriptions, and small models drown in it — asked to reply "ok", an
 * 8B model here rambled about TaskGet. So every local model is graded from
 * the facts Ollama reports (tool support, parameter count, context window),
 * and the grade travels with the model into every picker.
 */
export const OLLAMA_PREFIX = 'ollama/';
export const OLLAMA_URL = process.env.AIROOM_OLLAMA_URL ?? 'http://127.0.0.1:11434';

export const isOllamaModel = (model?: string | null): boolean => !!model && model.startsWith(OLLAMA_PREFIX);
export const ollamaName = (model: string): string => model.slice(OLLAMA_PREFIX.length);

/** The env that points Claude Code at Ollama instead of Anthropic. */
/** Where Claude Code should send its requests: airoom's own relay when the
 *  gateway has one (see ollamaProxy.ts), else Ollama directly. */
let proxyBase: string | null = null;
export function setOllamaProxyBase(base: string | null): void {
  proxyBase = base;
}

export function ollamaEnv(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: proxyBase ?? OLLAMA_URL,
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
  };
}

export const OLLAMA_APP = '/Applications/Ollama.app';
export const OLLAMA_BINS = ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama'];

/** How to bring Ollama up: the app when present (it gives the user a menu-bar
 *  icon to quit it from), else the CLI's own server, else nothing to do. */
/** Below this window an agent turn does not fit: the compact local prompt
 *  and tools are ~3k, and one file read can be more than that. */
export const LOCAL_MIN_CONTEXT = 16384;
/** What airoom starts Ollama with. Ollama's own guidance for Claude Code is
 *  32k or more; its default is 4k. */
export const LOCAL_START_CONTEXT = 32768;

export function pickOllamaLauncher(
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): { how: 'app' | 'cli'; cmd: string; args: string[]; env?: Record<string, string> } | null {
  if (platform === 'win32') {
    // Ollama's Windows installer puts the CLI under the user's programs; there
    // is nothing else to look for, and nothing to advertise either way.
    const bin = path.win32.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe');
    return exists(bin) ? { how: 'cli', cmd: bin, args: ['serve'], env: { OLLAMA_CONTEXT_LENGTH: String(LOCAL_START_CONTEXT) } } : null;
  }
  if (exists(OLLAMA_APP)) return { how: 'app', cmd: '/usr/bin/open', args: ['-g', '-a', 'Ollama'] };
  const bin = OLLAMA_BINS.find((b) => exists(b));
  return bin ? { how: 'cli', cmd: bin, args: ['serve'], env: { OLLAMA_CONTEXT_LENGTH: String(LOCAL_START_CONTEXT) } } : null;
}

export function ollamaInstalled(): boolean {
  return pickOllamaLauncher() != null;
}

/** Start Ollama detached — it outlives airoom, like any server the user
 *  would have started by hand. Resolves once the launch is handed off; the
 *  gateway watches /api/tags to learn when it is actually answering. */
export function startOllama(): { started: boolean; how: 'app' | 'cli' | null } {
  const l = pickOllamaLauncher();
  if (!l) return { started: false, how: null };
  try {
    const child = spawn(l.cmd, l.args, { detached: true, stdio: 'ignore', env: { ...process.env, ...(l.env ?? {}) } });
    child.on('error', () => {});
    child.unref();
    return { started: true, how: l.how };
  } catch {
    return { started: false, how: l.how };
  }
}

/** Grade from facts. Thresholds follow Ollama's own Claude Code guidance
 *  (≥30B models recommended; ≥32k context required) and what we measured. */
export function gradeOllamaModel(facts: {
  name: string;
  capabilities: string[];
  paramsB: number | null;
  contextK: number | null;
}): { quality: NonNullable<ModelChoice['quality']>; note: string } {
  if (!facts.capabilities.includes('tools'))
    return { quality: 'unfit', note: 'No tool calling — Claude Code cannot drive it at all.' };
  if (facts.contextK != null && facts.contextK < 32)
    return {
      quality: 'weak',
      note: `Context window is ${facts.contextK}k; Claude Code's prompt needs 32k+. Expect truncated turns.`,
    };
  if (facts.paramsB != null && facts.paramsB < 14)
    return {
      quality: 'weak',
      note: 'Too small to drive agents reliably — loses track of its tools and wanders. Fine for a quick question.',
    };
  if (facts.paramsB != null && facts.paramsB < 30)
    return {
      quality: 'fair',
      note: 'Handles small, well-scoped edits. Slower turns, weaker reasoning; not recommended for teams.',
    };
  return {
    quality: 'strong',
    note: 'Big enough to plan, call tools and finish multi-step work — still slower than Claude, and best kept off teams until proven.',
  };
}

const parseParams = (s?: string): number | null => {
  const m = /([\d.]+)\s*([BbMmTt])/.exec(s ?? '');
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return unit === 'T' ? n * 1000 : unit === 'M' ? n / 1000 : n;
};

async function fetchJson(url: string, init?: RequestInit, ms = 2500): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export interface OllamaState {
  installed: boolean;
  running: boolean;
  models: ModelChoice[];
}

/** Ask a running Ollama what it has, graded. Quiet when it is not running. */
export async function discoverOllama(): Promise<OllamaState> {
  const installed = ollamaInstalled();
  type Tags = { models?: { name: string; details?: { parameter_size?: string } }[] };
  let tags: Tags | null = null;
  try {
    tags = (await fetchJson(`${OLLAMA_URL}/api/tags`)) as Tags | null;
  } catch {
    tags = null;
  }
  if (!tags) return { installed, running: false, models: [] };
  const models: ModelChoice[] = [];
  for (const m of tags.models ?? []) {
    let capabilities: string[] = [];
    let contextK: number | null = null;
    try {
      const show = (await fetchJson(`${OLLAMA_URL}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: m.name }),
      })) as { capabilities?: string[]; model_info?: Record<string, unknown> } | null;
      capabilities = show?.capabilities ?? [];
      const ctxKey = Object.keys(show?.model_info ?? {}).find((k) => k.endsWith('.context_length'));
      const ctx = ctxKey ? Number(show!.model_info![ctxKey]) : NaN;
      if (Number.isFinite(ctx) && ctx > 0) contextK = Math.round(ctx / 1024);
    } catch {
      /* grade from what we have */
    }
    const paramsB = parseParams(m.details?.parameter_size);
    const { quality, note } = gradeOllamaModel({ name: m.name, capabilities, paramsB, contextK });
    models.push({
      value: OLLAMA_PREFIX + m.name,
      displayName: m.name,
      description: [m.details?.parameter_size, contextK ? `${contextK}k context` : null, 'local'].filter(Boolean).join(' · '),
      supportsFastMode: false,
      primary: false,
      provider: 'ollama',
      quality,
      qualityNote: note,
      params: m.details?.parameter_size,
      contextK: contextK ?? undefined,
    });
  }
  return { installed, running: true, models };
}

/**
 * What makes Claude Code liveable on a laptop-sized model.
 *
 * The stock agent prompt plus every tool schema is ~33k tokens — minutes of
 * prefill on Apple silicon, and more instruction than a small model can hold
 * (measured: qwen3:8b answered "hello" after 166s with a TaskUpdate call). A
 * local run gets a short prompt, six core tools, and — below the strong tier —
 * no forced thinking. Team MCP tools are unaffected: this only sets the
 * built-in base set.
 */
export function localRunOptions(
  quality: ModelChoice['quality'] | undefined,
  cwd: string,
): { systemPrompt: string; tools: string[]; thinking?: { type: 'disabled' } } {
  const os = process.platform === 'darwin' ? 'macOS' : process.platform;
  const systemPrompt = [
    `You are a coding assistant running on a local model, working in the project at ${cwd} (${os}).`,
    'Answer greetings and plain questions directly, in a sentence or two, without using any tool.',
    'Use a tool only when the task needs it: Read, Glob and Grep to look at files; Edit and Write to change them; Bash to run commands. Never invent file contents or command output — read or run to find out.',
    'After using tools, say what you did and what you found in one or two short sentences.',
  ].join('\n');
  const tools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
  return quality === 'strong' ? { systemPrompt, tools } : { systemPrompt, tools, thinking: { type: 'disabled' } };
}

/** The redirect env plus the quiet flags Ollama's own launcher sets. */
export function localRunEnv(name: string): Record<string, string> {
  return {
    ...ollamaEnv(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_SUBAGENT_MODEL: name,
  };
}

/**
 * Load the model now (an empty generate is Ollama's "just load it") and read
 * back the window it runs with. Quiet on any failure — this is advisory.
 */
export async function warmOllamaModel(name: string): Promise<{ contextLength: number | null }> {
  type Ps = { models?: { name?: string; model?: string; context_length?: number }[] };
  const loaded = async () => {
    const ps = (await fetchJson(`${OLLAMA_URL}/api/ps`)) as Ps | null;
    return ps?.models?.find((x) => x.name === name || x.model === name) ?? null;
  };
  try {
    // Already resident? Then touch nothing: an empty generate against a live
    // runner resets its prompt cache, and the next turn pays a full prefill.
    let m = await loaded();
    if (!m) {
      await fetchJson(
        `${OLLAMA_URL}/api/generate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: name, prompt: '', keep_alive: '15m' }),
        },
        60_000,
      );
      m = await loaded();
    }
    return { contextLength: typeof m?.context_length === 'number' ? m.context_length : null };
  } catch {
    return { contextLength: null };
  }
}
