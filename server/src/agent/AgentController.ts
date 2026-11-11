import type { ImageAttachment, PermissionMode, RunUpdate } from '../../../shared/types';

export interface SendOptions {
  roomId: string; // cwd to run in
  sessionId?: string; // resume this session, if provided
  text: string;
  mode?: PermissionMode; // how much may run unattended; omitted = 'default'
  model?: string; // Claude Code model alias or id; omitted = the CLI's default
  fast?: boolean; // fast mode, where the chosen model supports it
  budgetUsd?: number; // hard spend ceiling for one turn; omitted = none
  images?: ImageAttachment[]; // pasted/dropped images sent with the text
  /**
   * Distinguishes concurrent fresh spawns in the same room. Without it every
   * new-session run in a cwd shares the key `spawn:<roomId>`, so the second
   * spawn would be swallowed as steering into the first — impossible before
   * teams, guaranteed with them (three members spawn into one room).
   */
  spawnTag?: string;
  /**
   * Host-provided extras for this run — the seam the team layer uses without
   * the controller knowing what a team is. All optional, all generic:
   * in-process MCP servers, extra text appended to the system prompt, and
   * tools to hard-block (the single-writer rule: reviewer and lead cannot
   * hold Edit/Write even by asking nicely).
   */
  mcpServers?: Record<string, unknown>;
  systemPromptAppend?: string;
  extraDisallowedTools?: string[];
  /**
   * Tool-name prefixes that never raise a permission card (e.g. the team
   * layer's own routing tools). These are airoom plumbing with their own
   * policy — surfacing "may the lead assign work?" as a per-call approval
   * would turn orchestration into a drip of permission prompts.
   */
  autoAllowToolPrefixes?: string[];
  /**
   * Claude Code permission rules ("Bash(npm test:*)", "Edit") that answer a
   * tool call with "allow" before any card is raised. A playbook run carries
   * the approvals its original session got; anything outside them still asks.
   */
  allowRules?: string[];
}

/** What a one-shot question to the model comes back as. */
export type AskResult = { ok: true; text: string } | { ok: false; error: string };

export interface ActiveRun {
  runKey: string; // sessionId or `spawn:<roomId>`
  roomId: string;
  sessionId: string | null;
  /**
   * The approval this run is blocked on, if any — the whole ask, not just a
   * flag, so a client that connects late can be handed the Allow/Deny card it
   * missed instead of staring at a robot that says "needs your approval" with
   * no way to give it.
   */
  pendingPermission: {
    requestId: string;
    label: string;
    tool: { name: string; target: string; cwd: string };
    /** everything the card needs to be drawn in full on replay */
    input?: Record<string, unknown>;
    title?: string;
    description?: string;
    canAlways?: boolean;
    alwaysMode?: PermissionMode;
  } | null;
  /**
   * Is a turn actually in flight? A run outlives its turn — it idles warm for
   * KEEPALIVE_MS so the next message skips a cold start. Callers that paint
   * "working" must check this, or a robot keeps pretending to type for two
   * minutes after it finished answering.
   */
  busy: boolean;
}

/** The stable identity of a run: the session it drives, or the spawn slot. */
export function runKeyFor(opts: { roomId: string; sessionId?: string; spawnTag?: string }): string {
  if (opts.sessionId) return opts.sessionId;
  // Tagged spawns get their own slot; the untagged ghost-desk hire keeps its
  // historical key, which the web client matches on exactly.
  return opts.spawnTag ? `spawn:${opts.roomId}#${opts.spawnTag}` : `spawn:${opts.roomId}`;
}

/**
 * The write-path seam (mirror of DataSource, which is read-only).
 *
 * SdkClaudeController drives the Claude Agent SDK on this machine. Later a
 * RemoteAgentController could dispatch the same requests to an agent running
 * on another machine / for another user — the server gateway and web client
 * are unchanged.
 */
export interface AgentController {
  /**
   * Runs currently in flight. Lets the gateway overlay authoritative status
   * onto snapshots — the transcript on disk lags process reality.
   */
  activeRuns(): ActiveRun[];

  /**
   * Deliver a message. If a run is already live for the same runKey, the text
   * is queued into it (steering / follow-up) rather than rejected. Streams
   * RunUpdates via `onUpdate`; resolves when the run fully ends.
   */
  send(opts: SendOptions, onUpdate: (u: RunUpdate) => void): Promise<void>;

  /** Stop the run with this runKey. Returns false if none. */
  interrupt(runKey: string): boolean;

  /** Answer a pending permission request. Returns false if unknown/expired. */
  respondPermission(requestId: string, allow: boolean, always?: boolean): boolean;
  /** Change a live run's permission mode mid-turn (no-op if unsupported). */
  setMode?(runKey: string, mode: PermissionMode): boolean;
  /** Toggle fast mode on a live run (no-op if unsupported). */
  setFastMode?(runKey: string, fast: boolean): boolean;
  /** Is this session mid-turn? Used to avoid interjecting into live work. */
  isBusy?(sessionId: string): boolean;
  /** Load a local model ahead of its first turn and learn its runtime window. */
  warmLocal?(model: string): void;
  /**
   * Restore files to their state at a user message.
   *
   * `ctx` lets a finished session be rewound too: with no run in memory the
   * controller needs the folder and session id to reopen the checkpoints.
   */
  rewind?(
    runKey: string,
    userMessageId: string,
    dryRun: boolean,
    ctx?: { roomId?: string; sessionId?: string },
  ): Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  }>;

  /**
   * Learn what this machine's Claude Code offers (models, slash commands)
   * before the first run. Costs no tokens; no-op on engines that can't answer.
   */
  prewarm?(cwd: string): Promise<void>;

  /**
   * One question, one answer, no tools: a throwaway session that reads the
   * prompt and replies. Used to read a playbook out of a finished session.
   * Runs on the user's subscription like everything else; never resumed.
   */
  ask?(cwd: string, prompt: string, opts?: { model?: string; maxTurns?: number }): Promise<AskResult>;

  /**
   * The MCP servers a run in this folder would connect to, with their health.
   * A control-only query: a process spawn, no tokens. Raw runtime shape; the
   * connectors module turns it into what the office shows.
   */
  mcpStatus?(cwd: string): Promise<RawMcpStatus[]>;

  close(): Promise<void>;
}

/** What the runtime reports per MCP server — kept loose, it varies by build. */
export interface RawMcpStatus {
  name: string;
  status: string;
  error?: string;
  scope?: string;
  serverInfo?: { name?: string; version?: string };
  config?: Record<string, unknown>;
  tools?: { name: string; description?: string; annotations?: { readOnly?: boolean; destructive?: boolean } }[];
}
