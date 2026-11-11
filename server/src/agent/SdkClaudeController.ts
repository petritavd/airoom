import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  query,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { runKeyFor, type ActiveRun, type AgentController, type AskResult, type RawMcpStatus, type SendOptions } from './AgentController';
import { allowedByRules } from '../playbook/rules';
import { writeFileSync, mkdirSync } from 'node:fs';
import type {
  CommandChoice,
  ImageAttachment,
  ModelChoice,
  PermissionMode,
  RunUpdate,
} from '../../../shared/types';
import { describeTool } from '../../../shared/describeTool';
import { claudeBin, claudeBinDiagnostics, NOT_FOUND_MESSAGE, setupTokenCommand } from './claudeBin';
import { discoverOllama, isOllamaModel, localRunEnv, localRunOptions, ollamaName, warmOllamaModel, type OllamaState } from './ollama';

/**
 * Use the USER'S installed `claude` binary instead of the SDK's bundled
 * runtime: on macOS the OAuth credentials live in the Keychain, ACL'd to the
 * binary that wrote them — the bundled runtime is a different executable and
 * gets "Not logged in". Override with AIROOM_CLAUDE_BIN.
 */
/**
 * Headless auth that sidesteps the macOS Keychain entirely (its items are
 * ACL'd per binary, which breaks SDK-spawned runtimes): a long-lived OAuth
 * token from `claude setup-token`, provided via the CLAUDE_CODE_OAUTH_TOKEN
 * env var or dropped into ~/.airoom/token. Read lazily on every send so the
 * user can add it without restarting anything.
 */
const TOKEN_PATH = path.join(os.homedir(), '.airoom', 'token');
function authToken(): { token: string; source: 'env' | 'file' } | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
    return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: 'env' };
  try {
    const t = readFileSync(TOKEN_PATH, 'utf8').trim();
    if (t) return { token: t, source: 'file' };
  } catch {
    /* no token file */
  }
  return null;
}

/** What the engine sees — surfaced on /health so auth issues are diagnosable. */
export function engineDiagnostics(): {
  claudeBin: string | null;
  claudeBinSource: 'env' | 'saved' | 'found' | 'shell' | null;
  searched: string[];
  /** What to run in a terminal to get a key — by full path when `claude` is not on PATH. */
  setupCommand: string;
  authToken: 'env' | 'file' | null;
  ollama: { installed: boolean; running: boolean; models: number };
} {
  const d = claudeBinDiagnostics();
  return {
    claudeBin: d.bin,
    claudeBinSource: d.source,
    searched: d.searched,
    setupCommand: setupTokenCommand(d.bin, d.source),
    authToken: authToken()?.source ?? null,
    ollama: ollamaStatus(),
  };
}

/**
 * Drives Claude via the Agent SDK (in-process, streaming-input mode).
 *
 * Each run is a LIVE CONVERSATION, not a one-shot:
 *  - follow-up sends with the same runKey are pushed into the open stream
 *    (steering / queueing while the agent works)
 *  - after a turn completes, the run stays warm for KEEPALIVE_MS so the next
 *    message answers instantly with no process cold-start
 *  - interrupt() stops the current turn and closes the run
 *  - canUseTool surfaces per-tool approvals to the airoom UI
 *
 * The SDK writes the session transcript to ~/.claude/projects as it goes, so
 * the DataSource file-watcher animates the robot exactly as before.
 */

/**
 * The models this machine's Claude Code offers.
 *
 * Only a live query can answer `supportedModels()`, so the first run to start
 * fills this in and it is cached to disk — otherwise the picker would be empty
 * until the user happened to run an agent, and would forget again on restart.
 */
const MODELS_PATH = path.join(os.homedir(), '.airoom', 'models.json');
let modelCache: ModelChoice[] | null = null;

export function cachedModels(): ModelChoice[] {
  if (modelCache) return modelCache;
  try {
    const raw = JSON.parse(readFileSync(MODELS_PATH, 'utf8'));
    if (Array.isArray(raw?.models) && raw.models.length) modelCache = raw.models as ModelChoice[];
  } catch {
    /* never fetched yet */
  }
  return modelCache ?? [];
}

/**
 * Local models via Ollama, graded. Refreshed on a timer by the gateway so a
 * user who starts Ollama mid-session sees their models appear without a
 * restart; the picker always shows the merged list.
 */
let ollamaState: OllamaState = { installed: false, running: false, models: [] };
export function ollamaStatus(): { installed: boolean; running: boolean; models: number } {
  return { installed: ollamaState.installed, running: ollamaState.running, models: ollamaState.models.length };
}
export async function refreshOllama(): Promise<boolean> {
  const next = await discoverOllama();
  const changed = JSON.stringify(next) !== JSON.stringify(ollamaState);
  ollamaState = next;
  return changed;
}
/** Claude Code's models plus whatever Ollama serves — one list for every picker. */
export function mergedModels(): ModelChoice[] {
  return [...cachedModels(), ...ollamaState.models];
}
/** Which local models the relay switches thinking off for: everything below
 *  the strong tier — small models think long and derail (see ollamaProxy.ts). */
export function localThinkingPolicy(name: string): 'disabled' | null {
  const m = ollamaState.models.find((x) => ollamaName(x.value) === name);
  return m?.quality === 'strong' ? null : 'disabled';
}

const COMMANDS_PATH = path.join(os.homedir(), '.airoom', 'commands.json');
let commandCache: CommandChoice[] | null = null;

export function cachedCommands(): CommandChoice[] {
  if (commandCache) return commandCache;
  try {
    const raw = JSON.parse(readFileSync(COMMANDS_PATH, 'utf8'));
    if (Array.isArray(raw?.commands)) commandCache = raw.commands as CommandChoice[];
  } catch {
    /* never fetched yet */
  }
  return commandCache ?? [];
}

function rememberCommands(list: CommandChoice[], onChange: (c: CommandChoice[]) => void) {
  if (!list.length || JSON.stringify(list) === JSON.stringify(commandCache)) return;
  commandCache = list;
  try {
    mkdirSync(path.dirname(COMMANDS_PATH), { recursive: true });
    writeFileSync(COMMANDS_PATH, JSON.stringify({ commands: list }, null, 2));
  } catch {
    /* cache is an optimisation */
  }
  onChange(list);
}

/** How many models Claude Code shows before "More models". */
const PRIMARY_MODELS = 4;

function rememberModels(list: ModelChoice[], onChange: (m: ModelChoice[]) => void) {
  if (!list.length) return;
  const same = JSON.stringify(list) === JSON.stringify(modelCache);
  modelCache = list;
  if (same) return;
  try {
    mkdirSync(path.dirname(MODELS_PATH), { recursive: true });
    writeFileSync(MODELS_PATH, JSON.stringify({ models: list }, null, 2));
  } catch {
    /* cache is an optimisation, not a requirement */
  }
  onChange(list);
}

/**
 * Run one control request against a Claude Code process and shut it down.
 *
 * The control channel (`supportedModels`, `rewindFiles`, …) only answers on a
 * live query, but a query whose input stream never yields never sends a prompt
 * — so this costs a process spawn (~1.5s) and exactly zero tokens. It is how
 * the pickers can be right before the first run, and how a finished session can
 * still be rewound.
 */
async function withControlQuery<T>(
  options: Record<string, unknown>,
  use: (q: Query) => Promise<T>,
): Promise<T> {
  let close: () => void = () => {};
  const input: AsyncIterable<SDKUserMessage> = (async function* () {
    await new Promise<void>((resolve) => (close = resolve));
  })();
  const auth = authToken();
  const q = query({
    prompt: input,
    options: {
      pathToClaudeCodeExecutable: claudeBin(),
      env: auth
        ? ({ ...process.env, CLAUDE_CODE_OAUTH_TOKEN: auth.token } as Record<string, string>)
        : undefined,
      ...options,
    },
  });
  try {
    return await use(q);
  } finally {
    // End the stream first: the CLI sees end-of-input and exits on its own.
    // interrupt() is the belt for a build that waits for something else.
    close();
    void q.interrupt?.().catch(() => {});
  }
}

/** Tools that write to files — the ones 'auto-edits' mode lets through. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000; // undecided approvals auto-deny
const KEEPALIVE_MS = 2 * 60 * 1000; // idle runs stay warm for fast follow-ups
/**
 * How long a session that started background work stays warm.
 *
 * Ending the input stream ends the CLI process, and everything it launched
 * dies with it — a dev server, a watch, a long build. A session waiting on
 * those is idle but NOT finished: it wakes when they report. Two minutes killed
 * a user's backend and the log monitor watching it out from under them, so a
 * run holding background work is kept for long enough to be woken by it.
 */
const BACKGROUND_KEEPALIVE_MS = 30 * 60 * 1000;

/**
 * Does this stream message mean a turn is under way?
 *
 * The stream also carries housekeeping — rate-limit notices above all — and
 * treating one of those as work marked an idle session busy for ever, which in
 * turn stopped the team referee from ever nudging it again.
 */
export function isTurnTraffic(type: string): boolean {
  return type === 'assistant' || type === 'user' || type === 'stream_event';
}

/** How long a run may sit idle before its session is wound down. */
export function windDownWindow(hasBackgroundWork: boolean): number {
  return hasBackgroundWork ? BACKGROUND_KEEPALIVE_MS : KEEPALIVE_MS;
}

/**
 * An approval waiting on the user.
 *
 * It carries its own description, not just its id, because the ask has to be
 * REPLAYABLE. It was previously a fire-once event: a renderer that wasn't
 * connected when it was broadcast — after a reload, or after reopening the
 * window of a tray app whose server kept running — could never draw the
 * Allow/Deny card, leaving the turn blocked until the 10-minute auto-deny with
 * no way to answer and no stop button either.
 */
interface PendingPermission {
  requestId: string;
  label: string;
  tool: { name: string; target: string; cwd: string };
  /** The runtime's own rendered prompt ("Claude wants to …") and subtitle —
   *  better than anything reconstructed from toolName + input. */
  title?: string;
  description?: string;
  /** The tool's arguments, capped, so the panel can show WHAT it would do:
   *  a diff for Edit, the body for Write, the command for Bash. */
  input?: Record<string, unknown>;
  /** The runtime's suggested permission rules — handing these back as
   *  `updatedPermissions` is exactly Claude Code's "don't ask again". */
  suggestions?: unknown[];
  /** The run this ask belongs to — "always allow" may need to change the run's
   *  mode, not just answer this one call. */
  run: Run;
  settle: (r: PermissionResult) => void;
}

/** Tool arguments can carry a whole file. Keep them readable, not enormous. */
const INPUT_VALUE_CAP = 6000;
function capInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === 'string') out[k] = v.length > INPUT_VALUE_CAP ? v.slice(0, INPUT_VALUE_CAP) + '\n…' : v;
    else if (v == null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else {
      const j = JSON.stringify(v) ?? '';
      out[k] = j.length > INPUT_VALUE_CAP ? j.slice(0, INPUT_VALUE_CAP) + '…' : v;
    }
  }
  return out;
}

interface Run {
  key: string;
  /** This turn started work that outlives it (a background command, a watch).
   *  Winding the session down would kill it, so a run that has any keeps its
   *  conversation warm far longer. */
  hasBackgroundWork: boolean;
  /** When the session last said anything at all, turn-bearing or not. */
  lastMessageAt: number;
  /** Start (or restart) the idle wind-down for this run. Assigned once the
   *  stream is running, so control paths like interrupt() can use it too. */
  armWindDown: () => void;
  q: Query;
  roomId: string;
  sessionId: string | null;
  push: (msg: { text: string; images?: ImageAttachment[] }) => void;
  endInput: () => void;
  /**
   * Every approval this run is blocked on, oldest first.
   *
   * A single slot was wrong: one assistant message can raise two
   * concurrency-safe tool calls at once, and the second overwrote the first —
   * answering the visible card unblocked only that one while the invisible one
   * held the turn until it timed out, with no UI able to name its requestId.
   */
  pending: PendingPermission[];
  keepalive: NodeJS.Timeout | null;
  costSeen: number; // last cumulative total_cost_usd read from THIS query
  /** Served by Ollama. Claude Code still prices the tokens off its Anthropic
   *  table, so the figure it reports is fiction — a local turn costs nothing. */
  local: boolean;
  seq: number; // creation order — disambiguates runs sharing a spawn key
  interrupted: boolean; // the user pressed stop — the error that follows is expected
  /** A terminal update (result/error) already went out for the current turn.
   *  An abort surfaces BOTH as a result event and as a throw from the loop —
   *  emitting for each sent two terminals per stop, and the late one landed
   *  on whatever newer run had inherited the same spawn key. */
  terminalSent: boolean;
  busy: boolean; // a turn is in flight (false while idling out the keepalive)
  ended: boolean; // input stream closed — nothing more can be pushed into it
  fast: boolean; // fast mode (a setting, applied to the live query)
  /** The newest message pushed was a slash command (/compact, /context…).
   *  The runtime answers those with SYNTHETIC assistant messages — the same
   *  shape it uses for real failures ("Not logged in") — so this is what
   *  keeps a /context report from rendering as a red "run failed" card. */
  lastWasCommand: boolean;
  /** A compact_result status was just relayed with better wording; the
   *  synthetic assistant that follows repeats it and is dropped. */
  swallowSynthetic: boolean;
  budgetUsd: number; // 0 = uncapped; fixed at query creation like mode/model
  mode: PermissionMode; // the mode this query was CREATED with…
  model: string; // …and the model; both decide whether a run can be reused
}

/**
 * Turn a message into SDK content. Plain text stays a string (the common case);
 * with attachments it becomes a content-block array — image blocks first, so
 * the model sees what you're pointing at before it reads the question.
 */
function messageContent(text: string, images?: ImageAttachment[]): unknown {
  if (!images?.length) return text;
  const blocks: unknown[] = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
  if (text.trim()) blocks.push({ type: 'text', text });
  return blocks;
}

interface Outgoing {
  text: string;
  images?: ImageAttachment[];
}

/** A pushable streaming input: yields messages as they arrive, until ended. */
function pushableInput(first: Outgoing) {
  const queue: Outgoing[] = [first];
  let done = false;
  let wake: (() => void) | null = null;
  const iterable: AsyncIterable<SDKUserMessage> = (async function* () {
    while (true) {
      while (queue.length) {
        const msg = queue.shift()!;
        yield {
          type: 'user',
          message: { role: 'user', content: messageContent(msg.text, msg.images) },
          parent_tool_use_id: null,
          session_id: '',
        } as unknown as SDKUserMessage;
      }
      if (done) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  })();
  return {
    iterable,
    push: (msg: Outgoing) => {
      queue.push(msg);
      wake?.();
    },
    end: () => {
      done = true;
      wake?.();
    },
  };
}

/** The wire form of an approval — built in one place so a replayed ask on
 *  reconnect is byte-for-byte the one the first renderer got. */
function permissionUpdate(
  run: { key: string; roomId: string; sessionId: string | null },
  p: PendingPermission,
): RunUpdate {
  return {
    runKey: run.key,
    roomId: run.roomId,
    sessionId: run.sessionId,
    phase: 'permission',
    requestId: p.requestId,
    text: p.label,
    tool: { ...p.tool, input: p.input, title: p.title, description: p.description },
    canAlways: !!p.suggestions?.length,
    alwaysMode: suggestedMode(p.suggestions),
  };
}

/** The runtime sometimes answers "how do I stop being asked?" with a mode
 *  switch rather than a rule. Surface it so the UI can do it in the open. */
function suggestedMode(suggestions: unknown[] | undefined): PermissionMode | undefined {
  const hit = (suggestions ?? []).find(
    (s): s is { type: string; mode: PermissionMode } =>
      !!s && typeof s === 'object' && (s as { type?: string }).type === 'setMode',
  );
  return hit?.mode;
}

export class SdkClaudeController implements AgentController {
  private running = new Map<string, Run>(); // by runKey

  /**
   * Running spend per session, in USD.
   *
   * The SDK's `total_cost_usd` is cumulative WITHIN one query() — turn 2 of a
   * warm run reports turn 1 + turn 2. But a run only stays warm for
   * KEEPALIVE_MS; the next message opens a fresh query whose counter restarts
   * at zero. Reporting that number raw made the panel forget everything spent
   * before the last cold start. So each result contributes only its delta over
   * the previous reading from the same query, and the session total is what
   * airoom actually shows.
   */
  private spend = new Map<string, number>(); // by sessionId
  private runSeq = 0; // creation order, so control always finds the NEWEST run
  /** Told when the model list is first learned, so clients can be updated. */
  onModels: (models: ModelChoice[]) => void = () => {};
  onCommands: (commands: CommandChoice[]) => void = () => {};
  /** A live run just reported its MCP servers — fresher than any cache. */
  onMcpStatus: (cwd: string, servers: RawMcpStatus[]) => void = () => {};
  private pendingByRequest = new Map<string, PendingPermission>();
  private permCounter = 0;

  /**
   * Learn the model and slash-command lists before anyone runs anything.
   *
   * Only a live query can answer, so on a fresh install both pickers used to be
   * empty — the model menu offered one row reading "Default" — until the user
   * happened to finish a turn. A control-only query fixes that for the price of
   * a process spawn and no tokens at all.
   */
  async prewarm(cwd: string): Promise<void> {
    try {
      await withControlQuery({ cwd }, async (q) => {
        const [models, commands] = await Promise.all([
          q.supportedModels?.().catch(() => null),
          q.supportedCommands?.().catch(() => null),
        ]);
        if (Array.isArray(models))
          rememberModels(
            models.map((m, i) => ({
              value: m.value,
              displayName: m.displayName,
              description: m.description,
              supportsFastMode: m.supportsFastMode,
              primary: i < PRIMARY_MODELS,
            })),
            this.onModels,
          );
        if (Array.isArray(commands))
          rememberCommands(
            commands.map((c) => ({
              name: c.name,
              description: c.description,
              argumentHint: c.argumentHint || undefined,
            })),
            this.onCommands,
          );
      });
    } catch {
      /* no Claude Code on PATH yet, or an older build — the cache still stands */
    }
  }

  /**
   * Which MCP servers a run in `cwd` gets, and whether they are up. Servers
   * connect while the runtime starts, so a first answer of "pending" is
   * asked again after a moment inside the same process.
   */
  async mcpStatus(cwd: string): Promise<RawMcpStatus[]> {
    if (!existsSync(cwd) || !claudeBin()) return [];
    return withControlQuery({ cwd }, async (q) => {
      const read = async () => ((await q.mcpServerStatus?.().catch(() => null)) ?? []) as RawMcpStatus[];
      let list = await read();
      for (let i = 0; i < 3 && list.some((s) => s.status === 'pending'); i++) {
        await new Promise((r) => setTimeout(r, 1500));
        list = await read();
      }
      return list;
    });
  }

  /**
   * One question, answered by a session that holds no tools and is thrown
   * away. The prompt is the whole conversation; the reply is the whole answer.
   * A custom system prompt keeps the runtime's coding preamble (and its
   * per-project instructions) out of it — this is reading, not working.
   */
  async ask(cwd: string, prompt: string, opts: { model?: string; maxTurns?: number } = {}): Promise<AskResult> {
    if (!existsSync(cwd)) return { ok: false, error: `The folder no longer exists on disk (${cwd}).` };
    if (!claudeBin()) return { ok: false, error: NOT_FOUND_MESSAGE };
    const auth = authToken();
    const text: string[] = [];
    try {
      const q = query({
        prompt,
        options: {
          cwd,
          ...(opts.model ? { model: opts.model } : {}),
          pathToClaudeCodeExecutable: claudeBin(),
          env: auth ? ({ ...process.env, CLAUDE_CODE_OAUTH_TOKEN: auth.token } as Record<string, string>) : undefined,
          tools: [],
          maxTurns: opts.maxTurns ?? 1,
          // Nothing to keep: a transcript of this would appear in the office
          // as a robot whose whole conversation is "here is the JSON".
          persistSession: false,
          systemPrompt: 'You answer exactly as asked, in the format asked for, and nothing else.',
          permissionMode: 'default',
          canUseTool: () => Promise.resolve<PermissionResult>({ behavior: 'deny', message: 'no tools in this session' }),
        },
      });
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          const synthetic = !!(msg as { error?: unknown }).error || (msg.message as { model?: string } | undefined)?.model === '<synthetic>';
          const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const block of content)
            if (block.type === 'text' && block.text?.trim()) {
              if (synthetic) return { ok: false, error: block.text.trim() };
              text.push(block.text);
            }
        } else if (msg.type === 'result') {
          if (msg.is_error && !text.length)
            return { ok: false, error: 'result' in msg && typeof msg.result === 'string' ? msg.result : `the run ended: ${(msg as { subtype?: string }).subtype ?? 'no reason given'}` };
          if ('result' in msg && typeof msg.result === 'string' && msg.result.trim() && !text.length) text.push(msg.result);
        }
      }
    } catch (err) {
      return { ok: false, error: `Could not ask the model: ${String((err as Error).message ?? err)}` };
    }
    const out = text.join('\n').trim();
    return out ? { ok: true, text: out } : { ok: false, error: 'The model gave no answer.' };
  }

  activeRuns(): ActiveRun[] {
    return [...this.running.values()].map((r) => ({
      runKey: r.key,
      roomId: r.roomId,
      sessionId: r.sessionId,
      pendingPermission: r.pending[0]
        ? {
            requestId: r.pending[0].requestId,
            label: r.pending[0].label,
            tool: r.pending[0].tool,
            input: r.pending[0].input,
            title: r.pending[0].title,
            description: r.pending[0].description,
            canAlways: !!r.pending[0].suggestions?.length,
            alwaysMode: suggestedMode(r.pending[0].suggestions),
          }
        : null,
      busy: r.busy,
    }));
  }

  async send(opts: SendOptions, onUpdate: (u: RunUpdate) => void): Promise<void> {
    const { roomId, sessionId, text, model, images, fast, budgetUsd, mcpServers, systemPromptAppend, extraDisallowedTools } = opts;
    // The runtime is spawned with the room as its working directory. When the
    // folder has been moved or deleted, that spawn fails with the SDK's
    // "binary exists but failed to launch" — a wall of libc speculation that
    // points everywhere except at the actual problem. Say the true thing.
    if (!existsSync(roomId)) {
      onUpdate({
        runKey: runKeyFor(opts),
        roomId,
        sessionId: sessionId ?? null,
        phase: 'error',
        text: `This room's folder no longer exists on disk (${roomId}). It may have been moved or deleted — remove the room, or restore the folder.`,
        isError: true,
      });
      return;
    }
    // No binary, no run — and a sentence that names every place we looked,
    // instead of the SDK's "reinstall without --omit=optional".
    if (!claudeBin()) {
      onUpdate({ runKey: runKeyFor(opts), roomId, sessionId: sessionId ?? null, phase: 'error', text: NOT_FOUND_MESSAGE, isError: true });
      return;
    }
    const mode: PermissionMode = opts.mode ?? 'default';
    const key = runKeyFor(opts);
    const denySet = new Set(extraDisallowedTools ?? []);
    const autoAllow = opts.autoAllowToolPrefixes ?? [];
    const allowRules = opts.allowRules ?? [];

    // Live run for this session? Queue the message into it — steering.
    //
    // Two things disqualify the run it finds. Its input stream may already be
    // closed (interrupt, or the keepalive winding down): the entry lingers in
    // the map until the SDK finishes tearing the CLI down, and anything pushed
    // in that window lands in a queue with no reader — the text vanished and
    // the panel sat on a spinner that could never finish. And permissionMode
    // and model are fixed when the query is created, so a run built with
    // different ones cannot honour this message's settings.
    const existing = this.running.get(key);
    if (existing && !existing.ended) {
      // Mid-turn, take the message as steering even if the settings changed:
      // killing a turn already in flight to switch model would be worse. Like
      // Claude Code, a new model applies from the next turn.
      const sameSettings =
        existing.mode === mode &&
        existing.model === (model ?? '') &&
        existing.budgetUsd === (budgetUsd ?? 0);
      if (existing.busy || sameSettings) {
        if (existing.keepalive) {
          clearTimeout(existing.keepalive);
          existing.keepalive = null;
        }
        existing.busy = true;
        existing.terminalSent = false; // a new turn owes its own terminal
        existing.interrupted = false; // a stop applied to the turn before this one
        existing.lastWasCommand = /^\s*\//.test(text);
        existing.push({ text, images });
        // Report under the run's OWN key. Every other update for this run —
        // deltas, tools, approvals, result — uses run.key, which for an agent
        // hired in-session stays `spawn:<roomId>` for life. Emitting the
        // caller's key here forked the run into a second, empty client entry
        // that the panel then followed: no streamed reply, no Allow/Deny card,
        // and a composer stuck in "queue" until reload.
        onUpdate({
          runKey: existing.key,
          roomId: existing.roomId,
          sessionId: existing.sessionId,
          phase: 'started',
        });
        return;
      }
      // Idle and warm, but built with settings this message doesn't want.
      // Let it go and open a fresh query below.
      existing.ended = true;
      if (existing.keepalive) clearTimeout(existing.keepalive);
      existing.endInput();
    }

    const input = pushableInput({ text, images });
    const run: Run = {
      key,
      q: null as unknown as Query,
      roomId,
      sessionId: sessionId ?? null,
      push: input.push,
      endInput: input.end,
      pending: [],
      keepalive: null,
      hasBackgroundWork: false,
      lastMessageAt: Date.now(),
      armWindDown: () => {},
      costSeen: 0,
      local: isOllamaModel(model),
      seq: ++this.runSeq,
      interrupted: false,
      terminalSent: false,
      busy: true,
      ended: false,
      fast: !!fast,
      lastWasCommand: /^\s*\//.test(text),
      swallowSynthetic: false,
      budgetUsd: budgetUsd ?? 0,
      mode,
      model: model ?? '',
    };

    const auth = authToken();
    // A local model is not a different engine: Claude Code honours
    // ANTHROPIC_BASE_URL, so the same binary runs against Ollama's
    // Anthropic-compatible endpoint. The model value arrives as
    // `ollama/<name>`; the runtime gets the bare name and the redirect env.
    const local = isOllamaModel(model);
    const runModel = local && model ? ollamaName(model) : model;
    const runEnv: Record<string, string> | undefined =
      auth || local
        ? ({
            ...process.env,
            ...(auth ? { CLAUDE_CODE_OAUTH_TOKEN: auth.token } : {}),
            ...(local && model ? localRunEnv(ollamaName(model)) : {}),
          } as Record<string, string>)
        : undefined;
    if (local && model) void this.checkLocalRuntime(model);
    let q: Query;
    try {
      q = query({
        prompt: input.iterable,
        options: {
          cwd: roomId,
          resume: sessionId,
          // omitted → the user's own Claude Code default
          ...(runModel ? { model: runModel } : {}),
          pathToClaudeCodeExecutable: claudeBin(),
          env: runEnv,
          // Local models get a prompt and tool set their size can carry.
          ...(local ? localRunOptions(ollamaState.models.find((m) => m.value === model)?.quality, roomId) : {}),
          permissionMode: mode,
          // A hard ceiling on one turn's spend. The runtime stops the turn on
          // its own once it is reached, which is the only thing standing
          // between an unattended loop and a surprising bill.
          ...(budgetUsd && budgetUsd > 0 ? { maxBudgetUsd: budgetUsd } : {}),
          // Stream the reply as it is written. Without this a long answer
          // arrives as one silent block, which in a GUI reads as a hang.
          includePartialMessages: true,
          // Keep backups of files before tools change them, so a turn that went
          // the wrong way can be undone from the chat instead of from git.
          enableFileCheckpointing: true,
          // Belt: the SDK is documented not to consult canUseTool under
          // bypassPermissions, so the question tool is also disallowed outright
          // — otherwise a bypassed run that tries to ask a question blocks on a
          // dialog airoom cannot draw, with no visible reason.
          disallowedTools: ['AskUserQuestion', ...(extraDisallowedTools ?? [])],
          // Host extras (the team layer): in-process MCP tools, and a role
          // preamble appended to the standard Claude Code prompt.
          ...(mcpServers ? { mcpServers: mcpServers as never } : {}),
          ...(systemPromptAppend
            ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend } }
            : {}),
          // Braces: canUseTool is installed in BOTH modes. Under bypass it
          // still denies the question dialog and allows everything else.
          canUseTool: (toolName, toolInput, opts) => {
            // Question dialogs can't render headless — never surface an
            // absurd "may I ask you something?" approval; redirect the
            // agent to ask in plain chat instead.
            if (toolName === 'AskUserQuestion') {
              return Promise.resolve<PermissionResult>({
                behavior: 'deny',
                message:
                  'airoom cannot display question dialogs. Ask your question as a regular reply, listing any options as plain text.',
              });
            }
            // Braces for the host's hard blocks too: disallowedTools already
            // hides these, but a rename or an alias must fail closed — under
            // bypass mode this callback is the only gate left standing.
            if (denySet.has(toolName)) {
              return Promise.resolve<PermissionResult>({
                behavior: 'deny',
                message: `The ${toolName} tool is not available to this role. Describe what you need in your report instead.`,
              });
            }
            // Host plumbing tools (team routing) carry their own policy —
            // approve them regardless of mode, before any card is raised.
            if (autoAllow.some((p) => toolName.startsWith(p)))
              return Promise.resolve<PermissionResult>({ behavior: 'allow', updatedInput: toolInput });
            // Honour the run's CURRENT mode, not the one it was created with —
            // the mode picker and "always allow" both change it mid-run. And
            // once a host installs canUseTool the runtime delegates every
            // decision here, so airoom has to implement what each mode means
            // rather than assume the runtime already filtered.
            if (run.mode === 'bypassPermissions')
              return Promise.resolve<PermissionResult>({ behavior: 'allow', updatedInput: toolInput });
            if (run.mode === 'acceptEdits' && EDIT_TOOLS.has(toolName))
              return Promise.resolve<PermissionResult>({ behavior: 'allow', updatedInput: toolInput });
            // A playbook's earned approvals: the human already said yes to
            // calls shaped like this one in the session the card came from.
            if (allowRules.length && allowedByRules(allowRules, toolName, toolInput, roomId))
              return Promise.resolve<PermissionResult>({ behavior: 'allow', updatedInput: toolInput });
            return this.requestPermission(run, toolName, toolInput, opts, onUpdate);
          },
        },
      });
    } catch (err) {
      input.end();
      onUpdate({ runKey: key, roomId, sessionId: run.sessionId, phase: 'error', text: `Failed to start agent: ${String(err)}`, isError: true });
      return;
    }
    run.q = q;
    // Fast mode is a setting, not a query option, so it is applied to the live
    // query the moment it exists.
    if (fast) void q.applyFlagSettings?.({ fastMode: true }).catch(() => {});
    // Ask the runtime what models it offers. Cheap, once per run, and it keeps
    // the picker honest as Claude Code adds models.
    void q
      .supportedModels?.()
      .then((list) => {
        if (!Array.isArray(list)) return;
        rememberModels(
          list.map((m, i) => ({
            value: m.value,
            displayName: m.displayName,
            description: m.description,
            supportsFastMode: m.supportsFastMode,
            primary: i < PRIMARY_MODELS,
          })),
          this.onModels,
        );
      })
      .catch(() => {
        /* older runtime — the fallback list stands */
      });
    // …and which slash commands it knows. Same reasoning: only a live query can
    // answer, so learn it once and cache it.
    void q
      .supportedCommands?.()
      .then((list) => {
        if (!Array.isArray(list)) return;
        rememberCommands(
          list.map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint || undefined,
          })),
          this.onCommands,
        );
      })
      .catch(() => {
        /* older runtime */
      });
    // Where this run lives in the map. It starts at `key` — for a hire that is
    // `spawn:<roomId>` — and moves to the real session id the moment one is
    // known. `run.key` (and every runKey we emit) deliberately stays put so the
    // client's view of the run is unbroken.
    let mapKey = key;
    this.running.set(mapKey, run);
    onUpdate({ runKey: key, roomId, sessionId: run.sessionId, phase: 'started' });

    // Wind the session down only after it has genuinely gone quiet.
    //
    // Ending the input ends the CLI process, so this is the one thing that must
    // not happen to a session that is still working. Claude Code sessions wake
    // themselves — a background command finishes, a watch fires, a queued
    // message lands — and closing one mid-thought left it running with no route
    // back to airoom's in-process tools, which is what every "the tool call was
    // interrupted before a result was received" error was. The timer therefore
    // re-checks instead of firing blind: still mid-turn, or anything said while
    // it ran, buys another full window.
    run.armWindDown = () => {
      if (run.keepalive) clearTimeout(run.keepalive);
      const window = windDownWindow(run.hasBackgroundWork);
      const wait = Math.max(1_000, window - (Date.now() - run.lastMessageAt));
      run.keepalive = setTimeout(() => {
        run.keepalive = null;
        if (run.ended) return;
        if (run.busy || Date.now() - run.lastMessageAt < window) return run.armWindDown();
        run.ended = true; // same reason as interrupt: no more pushes
        input.end();
      }, wait);
    };

    try {
      for await (const msg of q) {
        run.lastMessageAt = Date.now();
        // Turn-bearing traffic only. The stream also carries housekeeping
        // (rate-limit notices above all), and treating one of those as a new
        // turn marked an idle session "busy" for ever.
        if (!run.busy && isTurnTraffic(msg.type)) {
          run.busy = true; // the session started a turn of its own accord
          run.terminalSent = false; // it owes this turn a terminal
          run.interrupted = false; // whatever was stopped, this is a new turn
        }
        const sid = (msg as { session_id?: string }).session_id;
        if (sid && run.sessionId !== sid) {
          run.sessionId = sid;
          // Re-key onto the session. Keeping a live agent parked under
          // `spawn:<roomId>` meant the first follow-up (sent by session id)
          // missed this warm run and cold-started a SECOND process on the same
          // session — and worse, the spawn slot stayed claimable, so hiring
          // again in this room within the keepalive pushed the "new agent"
          // prompt into this agent's conversation instead of creating one.
          if (mapKey !== sid) {
            if (this.running.get(mapKey) === run) this.running.delete(mapKey);
            mapKey = sid;
            this.running.set(mapKey, run);
          }
        }

        if (msg.type === 'stream_event') {
          // Text as it arrives. Subagent (Task) output has a parent tool id and
          // belongs to that tool's own trace, not the user's conversation.
          const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
          const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
          if (
            !parent &&
            ev?.type === 'content_block_delta' &&
            ev.delta?.type === 'text_delta' &&
            ev.delta.text
          ) {
            onUpdate({
              runKey: key,
              roomId,
              sessionId: run.sessionId,
              phase: 'delta',
              text: ev.delta.text,
            });
          }
        } else if (msg.type === 'system' && msg.subtype === 'init') {
          onUpdate({ runKey: key, roomId, sessionId: run.sessionId, phase: 'started' });
          // The servers are connected by now; tell the office for free.
          void q
            .mcpServerStatus?.()
            .then((list) => {
              if (Array.isArray(list)) this.onMcpStatus(roomId, list as RawMcpStatus[]);
            })
            .catch(() => {});
        } else if (msg.type === 'system') {
          // The runtime answers LOCAL slash commands (/compact, /context,
          // /cost…) through system messages, not assistant turns. Dropping
          // them made /compact look like it did nothing: the command ran,
          // the reply just never reached the panel.
          const sys = msg as unknown as {
            subtype?: string;
            content?: string;
            level?: string;
            status?: string | null;
            compact_result?: 'success' | 'failed';
            compact_error?: string;
          };
          if (sys.subtype === 'local_command_output' && sys.content?.trim()) {
            onUpdate({ runKey: key, roomId, sessionId: run.sessionId, phase: 'assistant', text: sys.content });
          } else if (sys.subtype === 'status') {
            if (sys.status === 'compacting')
              onUpdate({
                runKey: key,
                roomId,
                sessionId: run.sessionId,
                phase: 'tool',
                text: 'Compacting conversation…',
                tool: { name: 'Compact', target: 'conversation history' },
              });
            else if (sys.compact_result === 'success') {
              run.swallowSynthetic = true; // the "Compacted" echo that follows
              onUpdate({
                runKey: key,
                roomId,
                sessionId: run.sessionId,
                phase: 'assistant',
                text: 'Conversation compacted — earlier history is now a summary, and the context window is freed up.',
              });
              // Show the meter dropping — the whole point of compacting.
              void run.q
                .getContextUsage?.()
                .then((u) => {
                  if (!u || typeof u.totalTokens !== 'number') return;
                  onUpdate({
                    runKey: key,
                    roomId,
                    sessionId: run.sessionId,
                    phase: 'result',
                    meter: true,
                    context: {
                      usedTokens: u.totalTokens,
                      maxTokens: u.maxTokens,
                      percent: Math.round(u.percentage ?? (u.totalTokens / Math.max(1, u.maxTokens)) * 100),
                    },
                  });
                })
                .catch(() => {});
            } else if (sys.compact_result === 'failed') {
              run.swallowSynthetic = true; // the synthetic repeats compact_error
              onUpdate({
                runKey: key,
                roomId,
                sessionId: run.sessionId,
                phase: 'error',
                text: sys.compact_error ?? 'Compaction failed.',
                isError: true,
              });
            }
          } else if (
            sys.subtype === 'informational' &&
            sys.content?.trim() &&
            (sys.level === 'notice' || sys.level === 'suggestion' || sys.level === 'warning')
          ) {
            // banners the loop wants a human to see (hook feedback and the
            // like); 'info' level is transcript-only noise by contract
            onUpdate({ runKey: key, roomId, sessionId: run.sessionId, phase: 'assistant', text: sys.content });
          }
        } else if (msg.type === 'assistant') {
          // Synthetic messages are the runtime reporting failures (auth, API),
          // not the agent speaking — surface them as errors, not replies.
          const synthetic =
            !!(msg as { error?: unknown }).error ||
            (msg.message as { model?: string } | undefined)?.model === '<synthetic>';
          const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const block of content) {
            if (block.type === 'text' && block.text?.trim()) {
              if (synthetic && run.swallowSynthetic) {
                // Already said, with better words, by the compact_result branch.
                run.swallowSynthetic = false;
                continue;
              }
              // Local commands (/context, /cost, /compact, an unknown /typo)
              // answer through synthetic messages too — the exact shape real
              // failures use. When we know the user just sent a command, this
              // is its output; painting it as "run failed" made every command
              // look broken even as it worked.
              const isFailure = synthetic && !run.lastWasCommand;
              onUpdate({
                runKey: key,
                roomId,
                sessionId: run.sessionId,
                phase: isFailure ? 'error' : 'assistant',
                text: block.text,
                isError: isFailure,
              });
            } else if (block.type === 'tool_use') {
              {
                // Work that outlives the turn — see BACKGROUND_KEEPALIVE_MS.
                const inp = (block.input ?? {}) as Record<string, unknown>;
                if (inp.run_in_background === true || block.name === 'Monitor' || block.name === 'CronCreate')
                  run.hasBackgroundWork = true;
                const d = describeTool(block.name, block.input);
                onUpdate({
                  runKey: key,
                  roomId,
                  sessionId: run.sessionId,
                  phase: 'tool',
                  text: d.label,
                  toolUseId: block.id,
                  tool: { name: d.name, target: d.target },
                });
              }
            }
          }
        } else if (msg.type === 'result') {
          // Stopping is something the user chose, not a failure. The SDK still
          // reports the aborted turn as an error result carrying an internal
          // diagnostic string, and surfacing that verbatim made a deliberate
          // "stop" look like the app had broken. Land the run quietly instead —
          // whatever the agent already said stays on screen.
          const aborted = run.interrupted;
          run.swallowSynthetic = false;
          run.terminalSent = true;
          onUpdate({
            runKey: key,
            roomId,
            sessionId: run.sessionId,
            phase: !aborted && msg.is_error ? 'error' : 'result',
            ...(aborted ? { interrupted: true } : {}),
            // A failed turn does not always carry a `result` string — an
            // aborted or max-turns run reports the reason in `subtype` alone,
            // and dropping it left the UI saying "hit an error: unknown",
            // which is the least useful sentence a debugger can be handed.
            text: aborted
              ? undefined
              : 'result' in msg && typeof msg.result === 'string'
                ? msg.result
                : msg.is_error
                  ? `the run ended: ${(msg as { subtype?: string }).subtype ?? 'no reason given'}`
                  : undefined,
            isError: aborted ? false : msg.is_error,
            cost: run.local ? 0 : this.chargeSession(run, msg.total_cost_usd),
          });
          run.busy = false; // turn over; the run now just idles warm
          // How close this conversation is to filling the window. Asked once a
          // turn ends (it is a control round-trip, not free) and never allowed
          // to break the run if the runtime is too old to answer.
          void run.q
            .getContextUsage?.()
            .then((u) => {
              if (!u || typeof u.totalTokens !== 'number') return;
              onUpdate({
                runKey: key,
                roomId,
                sessionId: run.sessionId,
                phase: 'result',
                meter: true,
                context: {
                  usedTokens: u.totalTokens,
                  maxTokens: u.maxTokens,
                  percent: Math.round(u.percentage ?? (u.totalTokens / Math.max(1, u.maxTokens)) * 100),
                },
              });
            })
            .catch(() => {
              /* older runtime, or the run ended first */
            });
          // Keep the conversation warm for quick follow-ups, then wind down.
          run.armWindDown();
        }
      }
    } catch (err) {
      // Same reasoning as the result branch: aborting the query can surface as
      // a throw, and the user who pressed stop does not need to see it. But
      // never send a SECOND terminal: an abort often produces the result event
      // AND this throw, and the late duplicate broadcast under a spawn key
      // was received by whatever newer run had taken that key over — its
      // spinner cleared and its composer flipped while it was still working.
      if (!run.terminalSent) {
        run.terminalSent = true;
        onUpdate(
          run.interrupted
            ? { runKey: key, roomId, sessionId: run.sessionId, phase: 'result', interrupted: true }
            : { runKey: key, roomId, sessionId: run.sessionId, phase: 'error', text: String(err), isError: true },
        );
      }
    } finally {
      for (const p of [...run.pending]) p.settle({ behavior: 'deny', message: 'airoom: run ended' });
      if (run.keepalive) clearTimeout(run.keepalive);
      run.ended = true;
      run.busy = false;
      input.end();
      // Only clear the slot if it is still OURS. A replacement run can be
      // registered under this key while this one is still tearing down, and an
      // unconditional delete would evict the live run instead of the dead one.
      if (this.running.get(mapKey) === run) this.running.delete(mapKey);
    }
  }

  /**
   * Is this session mid-turn? Callers that would otherwise interject — the team
   * referee's nudges — need to know, because a reminder pushed into a session
   * that is already working arrives as steering and derails it.
   */
  isBusy(sessionId: string): boolean {
    for (const r of this.running.values()) if (r.sessionId === sessionId && r.busy && !r.ended) return true;
    return false;
  }

  /** A local model was picked: load it ahead of its first turn and learn the
   *  window Ollama runs it with. */
  warmLocal(model: string): void {
    if (isOllamaModel(model)) void this.checkLocalRuntime(model);
  }

  /** Warm the model and record its runtime window on its row, so the composer
   *  can say when Ollama is running it too small for agent turns. */
  private async checkLocalRuntime(model: string): Promise<void> {
    const { contextLength } = await warmOllamaModel(ollamaName(model));
    const entry = ollamaState.models.find((m) => m.value === model);
    if (!entry || contextLength == null) return;
    const k = Math.round(contextLength / 1024);
    if (entry.runtimeContextK !== k) {
      entry.runtimeContextK = k;
      this.onModels?.(mergedModels());
    }
  }

  /**
   * Fold one result's cumulative reading into the session total, and return it.
   *
   * `cumulative` counts from the start of the current query, so the delta over
   * what this run last reported is what the turn actually cost. A fresh query
   * restarts at zero, which makes its first delta the whole reading — exactly
   * right, since a cold start's cache write is real money.
   */
  private chargeSession(run: Run, cumulative: number | undefined): number {
    const key = run.sessionId ?? run.key;
    const total = this.spend.get(key) ?? 0;
    if (typeof cumulative !== 'number' || !Number.isFinite(cumulative)) return total;
    const delta = Math.max(0, cumulative - run.costSeen);
    run.costSeen = cumulative;
    const next = total + delta;
    this.spend.set(key, next);
    return next;
  }

  private requestPermission(
    run: Run,
    toolName: string,
    toolInput: Record<string, unknown>,
    ctx: { signal: AbortSignal; suggestions?: unknown[]; title?: string; description?: string },
    onUpdate: (u: RunUpdate) => void,
  ): Promise<PermissionResult> {
    const { signal } = ctx;
    return new Promise<PermissionResult>((resolve) => {
      const requestId = `perm_${++this.permCounter}_${Date.now().toString(36)}`;
      let settled = false;
      const settle = (r: PermissionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingByRequest.delete(requestId);
        run.pending = run.pending.filter((p) => p.requestId !== requestId);
        resolve(r);
        // The client shows one card at a time, so answering this one has to
        // hand it the next still-blocked ask — otherwise a queued approval
        // would sit there invisible while the turn waited on it.
        const next = run.pending[0];
        if (next) onUpdate(permissionUpdate(run, next));
      };
      const timer = setTimeout(
        () => settle({ behavior: 'deny', message: 'airoom: approval timed out' }),
        PERMISSION_TIMEOUT_MS,
      );
      const desc = describeTool(toolName, toolInput);
      const pending: PendingPermission = {
        requestId,
        label: desc.label,
        // the FULL command plus where it would run — an approval you can read
        tool: { name: desc.name, target: desc.target, cwd: run.roomId },
        // Prefer the runtime's own wording over anything reconstructed here.
        title: ctx.title,
        description: ctx.description,
        input: capInput(toolInput),
        suggestions: ctx.suggestions,
        run,
        settle,
      };
      if (process.env.AIROOM_DEBUG_PERMS)
        console.log('[perm] suggestions', JSON.stringify(ctx.suggestions));
      this.pendingByRequest.set(requestId, pending);
      run.pending.push(pending);
      signal.addEventListener('abort', () => settle({ behavior: 'deny', message: 'aborted' }), { once: true });
      // Only the oldest ask is on screen; a second one waits its turn above.
      if (run.pending[0] === pending) onUpdate(permissionUpdate(run, pending));
    });
  }

  respondPermission(requestId: string, allow: boolean, always = false): boolean {
    const pending = this.pendingByRequest.get(requestId);
    if (!pending) return false;
    if (!allow) {
      // Deny STOPS the turn.
      //
      // Answering "no" and then watching the agent carry on for another few
      // seconds — reasoning about the refusal, sometimes trying a different
      // route to the same thing — is not what "deny" means to the person who
      // clicked it. Settle first so the runtime unblocks cleanly and the tool
      // genuinely does not run, then interrupt: the turn ends, and the
      // transcript records it as an interruption rather than a silent stall.
      pending.settle({ behavior: 'deny', message: 'Denied from airoom — stopping this turn.' });
      this.interrupt(pending.run.key);
      return true;
    }
    // "Always allow" hands the runtime back its OWN suggested rules, so the
    // rule matches the tool exactly rather than being an approximation airoom
    // invented. Two shapes come back and they are applied differently:
    //   addRules  → travels with the result as updatedPermissions
    //   setMode   → is ADVICE TO US ("stop asking by switching the session
    //               mode"); passing it back does nothing, so we drive it
    //               through the same control the mode picker uses.
    // Rules travel back with the result. A `setMode` suggestion deliberately
    // does NOT: silently widening what an agent may do — with the mode picker
    // still reading "asks first" — is the kind of invisible permission change
    // this UI exists to prevent. The client makes that switch through the
    // picker instead, so the user can see (and undo) it.
    const suggestions = (pending.suggestions ?? []) as { type?: string }[];
    const rules = always ? suggestions.filter((s) => s?.type !== 'setMode') : [];
    pending.settle(
      rules.length ? ({ behavior: 'allow', updatedPermissions: rules } as PermissionResult) : { behavior: 'allow' },
    );
    return true;
  }

  /**
   * Find the run a control message means.
   *
   * An exact map hit wins. Otherwise match on the key the run REPORTS under —
   * but a hired agent keeps `spawn:<roomId>` for life while its predecessor
   * lingers through the keepalive, so two runs can answer to the same name.
   * Take the newest, or Stop would kill the previous agent while the current
   * one carried on.
   */
  private findRun(runKey: string): Run | undefined {
    const exact = this.running.get(runKey);
    if (exact) return exact;
    let best: Run | undefined;
    for (const r of this.running.values())
      if (r.key === runKey && (!best || r.seq > best.seq)) best = r;
    return best;
  }

  /**
   * Change a running conversation's permission mode without stopping it. The
   * SDK applies this to the live query, so the control finally behaves like the
   * switch it looks like — flipping it used to do nothing until the next turn.
   */
  setMode(runKey: string, mode: PermissionMode): boolean {
    const run = this.findRun(runKey);
    if (!run) return false;
    run.mode = mode;
    // A control request is a PROMISE: it rejects when the transport is closing
    // or an older CLI answers with an error. try/catch cannot see that, and an
    // unhandled rejection takes the whole server down with every live agent.
    void run.q.setPermissionMode?.(mode).catch(() => {});
    return true;
  }

  /**
   * Put files back the way they were at a user message.
   *
   * Only a live run can do this — the checkpoints belong to its query — which
   * is also why the UI has to say so rather than offering a button that
   * silently fails on a session nobody is driving.
   */
  async rewind(
    runKey: string,
    userMessageId: string,
    dryRun: boolean,
    ctx?: { roomId?: string; sessionId?: string },
  ) {
    const run = this.findRun(runKey);
    try {
      if (run) {
        const res = await run.q.rewindFiles?.(userMessageId, { dryRun });
        return res ?? { canRewind: false, error: 'This Claude Code build cannot rewind files.' };
      }
      // No live run — which is the normal case, because you want to undo a
      // turn AFTER reading what it did. Checkpoints live on disk with the
      // session, so a resumed control-only query can revert them without
      // costing a turn. (This used to answer "send a message first".)
      const cwd = ctx?.roomId;
      const sessionId = ctx?.sessionId ?? (runKey.startsWith('spawn:') ? '' : runKey);
      if (!cwd || !sessionId)
        return { canRewind: false, error: 'This agent has no saved session to rewind yet.' };
      const res = await withControlQuery(
        { cwd, resume: sessionId, enableFileCheckpointing: true },
        (q) => q.rewindFiles?.(userMessageId, { dryRun }) ?? Promise.resolve(undefined),
      );
      return res ?? { canRewind: false, error: 'This Claude Code build cannot rewind files.' };
    } catch (err) {
      return { canRewind: false, error: String(err) };
    }
  }

  /** Turn fast mode on/off for a running conversation. */
  setFastMode(runKey: string, fast: boolean): boolean {
    const run = this.findRun(runKey);
    if (!run) return false;
    run.fast = fast;
    void run.q.applyFlagSettings?.({ fastMode: fast }).catch(() => {}); // see setMode
    return true;
  }

  /**
   * Stop the turn this key is running.
   *
   * Ending the input as well is deliberate: the SDK closes the message stream
   * on an abort regardless, and marking the run ended is what stops a follow-up
   * being pushed into a stream with no reader. What must NOT happen is airoom
   * queueing a message into a session it is about to stop — see the referee's
   * busy checks before it nudges anyone.
   */
  interrupt(runKey: string): boolean {
    // A run is stored under its session id once one resolves, but it still
    // reports itself by the key the client knows (`spawn:<roomId>` for a fresh
    // hire) — so fall back to matching on that, or Stop would do nothing for
    // the entire first turn of every new agent.
    const run = this.findRun(runKey);
    if (!run) return false;
    run.interrupted = true;
    run.ended = true; // stream closing: send() must not push into it any more
    for (const p of [...run.pending]) p.settle({ behavior: 'deny', message: 'airoom: interrupted' });
    run.endInput(); // no more follow-ups — this run is over
    void run.q.interrupt().catch(() => {
      /* already finishing */
    });
    return true;
  }

  async close(): Promise<void> {
    for (const run of this.running.values()) {
      for (const p of [...run.pending]) p.settle({ behavior: 'deny', message: 'airoom: shutting down' });
      run.ended = true;
      if (run.keepalive) clearTimeout(run.keepalive);
      void run.q.interrupt().catch(() => {});
      run.endInput();
    }
    this.running.clear();
  }
}

