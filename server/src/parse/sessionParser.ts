import type { Robot, RobotStatus, Step } from '../../../shared/types';
import { describeTool, toolLabel } from '../../../shared/describeTool';

// A "working" session whose last activity is older than this is really parked.
const IDLE_MS = 8 * 60 * 1000; // 8 minutes
// "Your move" is a TRANSIENT state: if the human hasn't replied within this
// window they know about it — the session is finished/parked, not an alarm.
const ATTENTION_MS = 10 * 60 * 1000; // 10 minutes

// How many steps we retain per session. This is the ceiling on how far back
// the chat can scroll, so it is generous: a long working session easily passes
// a thousand events, and stopping at 150 made the panel feel truncated.
export const MAX_STEPS = 20000;

/** Raw JSONL record — we only rely on a handful of fields, rest is unknown. */
interface Rec {
  uuid?: string; // record identity — becomes Step.id
  type?: string;
  subtype?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  sessionId?: string;
  customTitle?: string;
  aiTitle?: string;
  hookErrors?: unknown[];
  preventedContinuation?: boolean;
  isSidechain?: boolean; // true on subagent (Task) traffic — not the user's conversation
  error?: string; // set on synthetic error records (e.g. auth failures)
  message?: { role?: string; content?: any; stop_reason?: string | null; model?: string };
}

function snippet(s: unknown, n = 120): string {
  const str = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  const clean = str.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

/**
 * Chat-bearing text keeps its RAW structure — newlines carry the markdown
 * (lists, paragraphs, code fences). Only truly huge messages get capped.
 */
const TEXT_CAP = 8000;
/** Tool output is reference material, not prose — a smaller cap is plenty to
 *  read an error or a test summary without bloating every snapshot. */
const RESULT_CAP = 4000;

function rawText(s: string, n = TEXT_CAP): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Did rawText have to cut this? The client says so out loud rather than
 *  silently presenting a clipped message as if it were complete. */
function wasCut(s: string, n = TEXT_CAP): true | undefined {
  return s.trim().length > n ? true : undefined;
}


/**
 * Tools that BLOCK on a user decision in the Claude Code UI (a dialog the
 * user must click through). Only these — never message-text guesses — make a
 * session "waiting for your reply".
 */
const INPUT_TOOLS: Record<string, string> = {
  AskUserQuestion: 'Asking you a question',
  ExitPlanMode: 'Waiting for you to approve the plan',
};

/** Text that is machinery, not a human turn (reminders, notifications, command wrappers…). */
function isMetaText(t: string): boolean {
  const s = t.trimStart();
  return (
    s.startsWith('<system-reminder') ||
    s.startsWith('Caveat:') ||
    s.startsWith('<command-name>') ||
    s.startsWith('<local-command') ||
    s.startsWith('<task-notification') ||
    s.startsWith('<teammate-message') ||
    s.startsWith('[SYSTEM NOTIFICATION') ||
    s.startsWith('[Request interrupted') ||
    // harness-injected XML envelopes in general (humans rarely open with a tag
    // immediately followed by another tag)
    /^<[a-z][a-z0-9-]*>\s*</.test(s)
  );
}

/**
 * Slash-command records. Claude Code writes an invocation as XML-ish tags in a
 * user message (`<command-name>/compact</command-name>… <command-args>…`), and
 * what the command printed as `<local-command-stdout>…</local-command-stdout>`.
 * isMetaText hides both wholesale, which made every command invisible in
 * history: you could run /compact and reload into a chat that swore nothing
 * had happened. Surface them as what they are — a user turn and its output.
 */
function commandInvocation(t: string): string | null {
  const name = /<command-name>\s*(\/?[\w:-]+)\s*<\/command-name>/.exec(t)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? '';
  const slash = name.startsWith('/') ? name : `/${name}`;
  return args ? `${slash} ${args}` : slash;
}

function commandStdout(t: string): string | null {
  const m = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(t);
  return m ? m[1].trim() : null;
}

/**
 * The record Claude Code leaves when a turn is stopped — by airoom's stop
 * button or by Esc in a terminal. isMetaText hides it from the chat (it is not
 * something the user typed), so status inference has to spot it separately.
 */
function isInterruptMarker(t: string): boolean {
  return t.trimStart().startsWith('[Request interrupted');
}

/**
 * Runtime notices that are NOT failures. Everything else the runtime emits
 * synthetically — "Not logged in", "You've hit your session limit", "API Error:
 * …" — is a real problem and must keep surfacing as one.
 */
function isBenignNotice(t: string): boolean {
  return t.trim().startsWith('No response requested');
}

/**
 * A tool_result's content is either a string or content blocks. Flatten it to
 * the text a human would want to read.
 */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? (b.text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  return content == null ? '' : JSON.stringify(content);
}

/** Did this tool fail? Used only to decide whether the client opens the output
 *  by default — a wrong guess costs a fold, not correctness. */
function looksLikeToolError(t: string): boolean {
  return /^(error|command failed|traceback|exception)\b|\bENOENT\b|\bpermission denied\b/i.test(t.trimStart().slice(0, 200));
}

/** Split a user message's content into human text, tool_result blocks, and
 *  attached images (counted — the chat shows a chip, never the bytes). */
function flattenUser(content: any): {
  text: string;
  toolResults: { id: string; content: unknown }[];
  imageBlocks: { idx: number; media: string }[];
} {
  if (typeof content === 'string') return { text: content, toolResults: [], imageBlocks: [] };
  let text = '';
  const imageBlocks: { idx: number; media: string }[] = [];
  const toolResults: { id: string; content: unknown }[] = [];
  if (Array.isArray(content)) {
    content.forEach((b, idx) => {
      if (b?.type === 'text') text += b.text + ' ';
      else if (b?.type === 'image') imageBlocks.push({ idx, media: String(b.source?.media_type ?? 'image/png') });
      else if (b?.type === 'tool_result')
        toolResults.push({ id: b.tool_use_id, content: b.content });
    });
  }
  return { text: text.trim(), toolResults, imageBlocks };
}

/**
 * Claude Code's own note about a scaled screenshot — "[Image: original
 * 3458x1176, displayed at 2000x680. Multiply coordinates …]". It is written
 * as if the user typed it, and rendering it that way made every attachment
 * look like a wall of machinery. It IS the attachment record, so it becomes
 * the chip: one image, with its true dimensions.
 */
function extractScalingNotes(t: string): { dims: string[]; rest: string } {
  const dims: string[] = [];
  // Only the note itself (and the spaces hugging it) goes. Collapsing ALL
  // whitespace here flattened every multi-paragraph message a user ever
  // typed into one run of text — and a 55k-character paste into "1 line".
  const rest = t
    .replace(/[ \t]*\[Image: original (\d+x\d+)[^\]]*\][ \t]*/g, (_, d: string) => {
      dims.push(d.replace('x', '×'));
      return ' ';
    })
    .replace(/[ \t]+\n/g, '\n') // a note that sat on its own line leaves no blank line behind
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { dims, rest };
}

/**
 * Stable id for a step. The transcript is served as a sliding window of the
 * last N steps, so an id must not depend on where the step lands in that
 * window — it comes from the record's own uuid plus an ordinal for records
 * that emit several steps (an assistant turn with text + tool calls).
 */
function stepId(r: Rec, ordinal: number): string {
  return `${r.uuid ?? r.timestamp ?? 'x'}#${ordinal}`;
}

function pushStep(steps: Step[], s: Step) {
  steps.push(s);
  if (steps.length > MAX_STEPS) steps.shift();
}

/**
 * Parse one session's JSONL text into a Robot model.
 * Pure and side-effect free so it's trivially testable.
 *
 * `projectDirName` (the ~/.claude/projects/<encoded> dirname the transcript
 * lives in) anchors the robot to its session's HOME project: sessions can cd
 * around mid-conversation, but resume only works from the home project — so
 * that's the room the robot belongs to.
 */
export function parseSession(raw: string, fallbackId: string, projectDirName?: string): Robot | null {
  return parseInternal(raw, fallbackId, projectDirName).robot;
}

function parseInternal(
  raw: string,
  fallbackId: string,
  projectDirName?: string,
): { robot: Robot | null; steps: Step[] } {
  const records: Rec[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* tolerate partial/corrupt trailing line */
    }
  }

  const cwds: string[] = []; // ordered, unique — first is the session's origin
  let gitBranch: string | undefined;
  let version: string | undefined;
  let sessionId = fallbackId;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let firstUserText: string | undefined;
  let lastTs: string | null = null;

  const steps: Step[] = [];
  let messageCount = 0;

  const toolUses = new Map<string, { name: string; input: any }>();
  let seq = 0; // monotonic per parse — deterministic for a given file
  const resolved = new Set<string>();
  // What was the last meaningful event? Drives status.
  let lastEvent: 'user' | 'assistant_text' | 'assistant_tool' | 'tool_result' | 'system' | null =
    null;
  let lastSystemError = false;
  // Did the turn end because someone pressed stop? Claude Code records that as
  // a "[Request interrupted…]" user message, which isMetaText correctly hides
  // from the chat — but dropping it silently left lastEvent on the user's own
  // message, so a stopped session went on claiming it was thinking for the
  // full idle timeout: a phantom "working" robot, a wrong topbar count, and a
  // panel insisting the session was open in a terminal. Remember it instead.
  let interrupted = false;

  for (const r of records) {
    // Sidechain records are subagent (Task) traffic, not the user's
    // conversation — they must never shape the robot's room, status, or chat.
    if (r.isSidechain) continue;
    if (r.cwd && !cwds.includes(r.cwd)) cwds.push(r.cwd);
    if (r.gitBranch) gitBranch = r.gitBranch;
    if (r.version) version = r.version;
    if (r.sessionId) sessionId = r.sessionId;
    if (r.type === 'custom-title' && r.customTitle) customTitle = r.customTitle;
    if (r.type === 'ai-title' && r.aiTitle) aiTitle = r.aiTitle;
    if (r.timestamp && (!lastTs || r.timestamp > lastTs)) lastTs = r.timestamp;

    if (r.type === 'user' && r.message) {
      // The post-compact continuation summary is machinery: the agent's own
      // notes to itself, injected as a "user" message. Claude Code hides it
      // behind the compact divider; rendering it here put a wall of prompt
      // text in the chat as if the user had typed it.
      if ((r as { isCompactSummary?: boolean }).isCompactSummary) continue;
      const { text, toolResults, imageBlocks } = flattenUser(r.message.content);
      // Records Claude Code itself flags as machinery (isMeta): a skill's
      // expanded instructions, its own "continue" nudge after a compaction,
      // hook output. Claude Code's UI hides them; rendering the skill one put
      // 55k characters of prompt in the chat as if the user had pasted it.
      // The scaling-note records for attachments are isMeta too and are the
      // only ones that carry something the chat shows (the image chip), so
      // they fall through to the normal path.
      if ((r as { isMeta?: boolean }).isMeta && !text.includes('[Image: original ')) {
        const skill = /^Base directory for this skill:\s*(\S+)/.exec(text.trimStart());
        if (skill) {
          const name = skill[1].replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'skill';
          pushStep(steps, {
            id: stepId(r, seq++),
            ts: r.timestamp ?? null,
            kind: 'marker',
            label: `Skill loaded: ${name}`,
            detail: 'its instructions stay out of the chat',
          });
        }
        continue;
      }
      const images = imageBlocks.length;
      // The bytes stay in the transcript; steps carry an address per image so
      // the client can fetch a thumbnail on demand instead of every snapshot
      // hauling megabytes of base64 around.
      const imageRefs = r.uuid ? imageBlocks.map((b) => ({ id: `${r.uuid}:${b.idx}`, media: b.media })) : undefined;
      for (const tr of toolResults) resolved.add(tr.id);
      if (text && isInterruptMarker(text)) interrupted = true;
      // Scaling notes can arrive one per image, CONCATENATED into one record
      // — "[Image: …] [Image: …]" — and mixed with real prose. Strip every
      // note wherever it appears; each one counts as an attachment.
      const notes = text ? extractScalingNotes(text) : { dims: [], rest: '' };
      const noteImages = notes.dims.length;
      const cleanText = text ? notes.rest : '';
      if ((noteImages > 0 && !cleanText) || (images > 0 && !cleanText)) {
        // Attachments with no prose: the images are the whole turn.
        pushStep(steps, {
          id: stepId(r, seq++),
          ts: r.timestamp ?? null,
          kind: 'user',
          label: '',
          images: Math.max(1, images + noteImages),
          imageDims: notes.dims[0],
          ...(imageRefs?.length ? { imageRefs } : {}),
        });
        continue;
      }
      const invocation = cleanText ? commandInvocation(cleanText) : null;
      const stdout = cleanText && !invocation ? commandStdout(cleanText) : null;
      if (invocation) {
        // A slash command is a user turn — show it the way it was typed. It
        // deliberately does NOT touch lastEvent: SDK-driven sessions never
        // persist the command's output, so treating this as "user spoke"
        // left the robot claiming "Thinking…" (and the panel warning about a
        // phantom terminal) for the whole idle window after every /context.
        pushStep(steps, { id: stepId(r, seq++), ts: r.timestamp ?? null, kind: 'user', label: rawText(invocation), truncated: wasCut(invocation) });
      } else if (stdout !== null) {
        // What the command printed. Close the turn either way — a command that
        // printed nothing still finished, and leaving lastEvent on 'user' kept
        // the robot "Thinking…" for the whole idle window after a /context.
        // A bare "Compacted" is skipped: the compact_boundary marker below
        // says the same thing with the numbers.
        if (stdout && stdout !== 'Compacted')
          pushStep(steps, { id: stepId(r, seq++), ts: r.timestamp ?? null, kind: 'assistant_text', label: rawText(stdout), truncated: wasCut(stdout) });
        lastEvent = 'assistant_text';
        interrupted = false;
      } else if (cleanText && !isMetaText(cleanText)) {
        messageCount++;
        if (!firstUserText) firstUserText = cleanText;
        // The human spoke: whatever tool calls were still open belong to a
        // turn that is over. Without this, a Bash orphaned by a dead process
        // (a crash, a kill, a laptop lid) pinned the robot on "working —
        // Running Bash…" for as long as the conversation stayed alive,
        // because every new record refreshed the idle timer.
        for (const id of toolUses.keys()) resolved.add(id);
        pushStep(steps, { id: stepId(r, seq++), ts: r.timestamp ?? null, kind: 'user', label: rawText(cleanText), truncated: wasCut(cleanText), ...(images + noteImages > 0 ? { images: images + noteImages, imageDims: notes.dims[0] } : {}), ...(imageRefs?.length ? { imageRefs } : {}) });
        lastEvent = 'user';
        lastSystemError = false; // a new turn clears a previous failure
        interrupted = false; // asking for something new resumes the session
      } else if (toolResults.length) {
        // Carry the REAL output, not a 120-char teaser. The chat could say an
        // agent ran the tests and never what they printed — so the only way to
        // read a stack trace was to leave airoom for a terminal. Keyed by
        // toolUseId so the client can fold it into the call it belongs to.
        const body = resultText(toolResults[0].content);
        pushStep(steps, { id: stepId(r, seq++),
          ts: r.timestamp ?? null,
          kind: 'tool_result',
          label: 'tool result',
          detail: rawText(body, RESULT_CAP),
          truncated: wasCut(body, RESULT_CAP),
          toolUseId: toolResults[0].id,
          isError: looksLikeToolError(body),
        });
        lastEvent = 'tool_result';
        interrupted = false;
      }
    } else if (r.type === 'assistant' && r.message) {
      // Synthetic records are the runtime speaking, not the agent. Most report
      // a real failure (auth, session limit, API), but not all of them do.
      if (r.error || r.message.model === '<synthetic>') {
        const content = Array.isArray(r.message.content) ? r.message.content : [];
        const errText = content.find((b: any) => b?.type === 'text')?.text ?? r.error ?? 'run failed';
        // "No response requested." is what a stopped turn leaves behind, and it
        // is the commonest synthetic record there is. Calling it a failure put
        // a permanent red "run failed" in the chat and left the robot flagged
        // "Blocked — needs attention" for a run the user had simply stopped.
        if (isBenignNotice(errText)) continue;
        interrupted = false; // a genuine failure, not a clean stop
        lastSystemError = true;
        pushStep(steps, { id: stepId(r, seq++), ts: r.timestamp ?? null, kind: 'system', label: snippet(errText, 100) });
        lastEvent = 'system';
        continue;
      }
      interrupted = false; // the agent spoke again — whatever stopped is over
      messageCount++;
      lastSystemError = false; // real assistant output clears a previous failure
      const content = Array.isArray(r.message.content) ? r.message.content : [];
      for (const b of content) {
        if (b?.type === 'thinking' && b.thinking) {
          pushStep(steps, { id: stepId(r, seq++),
            ts: r.timestamp ?? null,
            kind: 'thinking',
            label: 'Thinking…',
            detail: snippet(b.thinking, 200),
          });
          lastEvent = 'assistant_tool'; // mid-turn; not a reply to the user yet
        } else if (b?.type === 'text' && b.text?.trim()) {
          pushStep(steps, { id: stepId(r, seq++),
            ts: r.timestamp ?? null,
            kind: 'assistant_text',
            label: rawText(b.text),
            truncated: wasCut(b.text),
          });
          lastEvent = 'assistant_text';
        } else if (b?.type === 'tool_use') {
          toolUses.set(b.id, { name: b.name, input: b.input });
          const desc = describeTool(b.name, b.input);
          pushStep(steps, { id: stepId(r, seq++),
            ts: r.timestamp ?? null,
            kind: 'tool_use',
            label: desc.label,
            toolUseId: b.id,
            tool: { name: desc.name, target: desc.target },
          });
          lastEvent = 'assistant_tool';
        }
      }
    } else if (r.type === 'system') {
      if (r.subtype === 'compact_boundary') {
        // The context window was folded into a summary here. Worth a quiet
        // divider with the numbers; a manual /compact also ends its turn.
        const meta = (r as { compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number } }).compactMetadata;
        const fmt = (n?: number) => (typeof n === 'number' && n > 0 ? `${Math.round(n / 1000)}k` : null);
        const pre = fmt(meta?.preTokens);
        const post = fmt(meta?.postTokens);
        const detail = [pre && post ? `${pre} → ${post} tokens` : null, meta?.trigger === 'auto' ? 'automatic' : null]
          .filter(Boolean)
          .join(' · ');
        pushStep(steps, { id: stepId(r, seq++), ts: r.timestamp ?? null, kind: 'marker', label: 'Conversation compacted', detail: detail || undefined });
        for (const id of toolUses.keys()) resolved.add(id); // the old turns are a summary now
        if (meta?.trigger !== 'auto') {
          lastEvent = 'assistant_text';
          interrupted = false;
        }
      } else if ((r.hookErrors && r.hookErrors.length) || r.preventedContinuation) {
        lastSystemError = true;
        pushStep(steps, { id: stepId(r, seq++),
          ts: r.timestamp ?? null,
          kind: 'system',
          label: `system: ${r.subtype ?? 'event'}`,
        });
        lastEvent = 'system';
      }
    }
  }

  // A file with no main-chain conversation at all — e.g. a subagent
  // transcript stored top-level, or a session that never got started — is
  // NOT an agent and must never appear in any room.
  if (messageCount === 0 && steps.length === 0) return { robot: null, steps };

  // Find a tool_use with no matching result → agent is executing (or awaiting permission).
  let pending: { name: string; input: any } | null = null;
  for (const [id, tu] of toolUses) if (!resolved.has(id)) pending = tu;

  const ageMs = lastTs ? Date.now() - Date.parse(lastTs) : Infinity;

  let status: RobotStatus;
  let currentAction: string;

  if (lastSystemError) {
    status = 'error';
    currentAction = 'Blocked — needs attention';
  } else if (interrupted) {
    // Stopped on purpose. Checked before `pending`, because interrupting a tool
    // call leaves its tool_use unresolved and that would otherwise read as work
    // still in flight.
    status = 'idle';
    currentAction = 'Stopped';
  } else if (pending && INPUT_TOOLS[pending.name]) {
    // literally blocked on a user decision (question dialog, plan approval)
    status = 'waiting_input';
    currentAction = INPUT_TOOLS[pending.name];
  } else if (pending) {
    status = 'working';
    currentAction = `Running ${toolLabel(pending.name, pending.input)}`;
  } else if (lastEvent === 'assistant_text') {
    // A completed turn is FINISHED. "Waiting for your reply" is reserved for
    // states where the user must actually click/decide — never inferred from
    // the text of a finished answer.
    status = 'done';
    currentAction = 'Finished';
  } else if (lastEvent === 'user') {
    status = 'working';
    currentAction = 'Thinking…';
  } else if (lastEvent === 'assistant_tool' || lastEvent === 'tool_result') {
    status = 'working';
    currentAction = 'Working…';
  } else {
    status = 'idle';
    currentAction = 'Idle';
  }

  // Age overrides: a "working" that stopped emitting is parked; a finished
  // turn only counts as "your move" briefly — then it's simply done.
  if (status === 'working' && ageMs > IDLE_MS) {
    status = 'idle';
    currentAction = 'Idle';
  }
  if (status === 'waiting_input' && ageMs > ATTENTION_MS) {
    status = 'idle';
    currentAction = 'Idle · asked you something earlier';
  }
  if (status === 'done' && ageMs > ATTENTION_MS) {
    status = 'idle';
    currentAction = 'Idle';
  }
  if (status === 'error' && ageMs > ATTENTION_MS) {
    status = 'idle';
    currentAction = 'Idle · last run failed';
  }

  const title =
    customTitle ||
    aiTitle ||
    (firstUserText ? snippet(firstUserText, 40) : `session ${sessionId.slice(0, 8)}`);

  // Home project: the cwd whose encoding matches the transcript's project dir
  // (resume only works there). Claude Code has encoded project dirs both as
  // slashes→dashes and as all-non-alphanumerics→dashes — accept either.
  // Fall back to the first cwd the session saw; a session with no cwd at all
  // is unplaceable and must not invent a room.
  let home = cwds[0] ?? '';
  if (projectDirName) {
    const match = cwds.find(
      (c) =>
        c.replaceAll('/', '-') === projectDirName ||
        c.replace(/[^a-zA-Z0-9]/g, '-') === projectDirName,
    );
    if (match) home = match;
  }
  if (!home) return { robot: null, steps };

  const robot: Robot = {
    sessionId,
    roomId: home,
    title,
    status,
    currentAction,
    pendingTool: pending?.name,
    gitBranch,
    version,
    lastActivity: lastTs,
    messageCount,
    recentSteps: steps.slice(-8),
  };
  return { robot, steps };
}

/**
 * A window onto a session's steps: the most recent `limit`, plus whether older
 * ones exist before it (so the chat can offer "load older").
 */
export function parseSteps(raw: string, limit = 40): { steps: Step[]; hasMore: boolean } {
  return windowSteps(parseAllSteps(raw), limit);
}

/** Every step in the transcript. Split out so callers that fetch the same file
 *  repeatedly can cache the parse instead of redoing it per request. */
export function parseAllSteps(raw: string): Step[] {
  return parseInternal(raw, 'x').steps;
}

/** Take the newest `limit` steps, and say whether older ones remain. */
export function windowSteps(all: Step[], limit: number): { steps: Step[]; hasMore: boolean } {
  return { steps: all.slice(-limit), hasMore: all.length > limit };
}
