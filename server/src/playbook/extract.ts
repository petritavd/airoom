import { z } from 'zod';
import type { Playbook, PlaybookInput, PlaybookRule, PlaybookStep, Step } from '../../../shared/types';
import { allowRulesFrom } from './rules';

/**
 * From a finished session to a proposed card.
 *
 * The session is the evidence: the brief, every "no, not like that", what ran,
 * what was checked, what came out. This module turns it into a compact digest,
 * asks a model to read the PROCESS out of it, and validates the answer into a
 * Playbook the human can edit. The model is never trusted with structure —
 * the JSON is parsed against a schema, and anything malformed is dropped
 * rather than saved.
 */

/** Text that is machinery, not a human turn. The parser hides most of it
 *  already; this catches what reaches the steps. */
function isMeta(t: string): boolean {
  const s = t.trimStart();
  return s.startsWith('<') || s.startsWith('[Request interrupted') || s.startsWith('Caveat:');
}

const DIGEST_CAP = 70_000; // characters handed to the model
const USER_CAP = 6_000; // one human message
const AGENT_CAP = 900; // one reply — what it decided, not the essay
const RESULT_CAP = 500; // a failed tool's output — enough to know why

/** The session flattened to what an extraction needs, oldest first. */
export function digestSteps(steps: Step[]): string {
  const lines: string[] = [];
  let userN = 0;
  for (const s of steps) {
    if (s.kind === 'user') {
      if (isMeta(s.label)) continue;
      userN++;
      lines.push(`[human #${userN}] ${s.label.slice(0, USER_CAP)}${s.label.length > USER_CAP ? ' …' : ''}`);
    } else if (s.kind === 'assistant_text') {
      const t = s.label.trim();
      if (!t) continue;
      lines.push(`[agent] ${t.slice(0, AGENT_CAP)}${t.length > AGENT_CAP ? ' …' : ''}`);
    } else if (s.kind === 'tool_use' && s.tool) {
      lines.push(`[ran] ${s.tool.name}${s.tool.target ? `: ${s.tool.target.slice(0, 300)}` : ''}`);
    } else if (s.kind === 'tool_result' && s.isError && s.detail) {
      lines.push(`[failed] ${s.detail.slice(0, RESULT_CAP).replace(/\s+/g, ' ')}`);
    }
  }
  let out = lines.join('\n');
  if (out.length > DIGEST_CAP) {
    // Keep the head (the brief) and the tail (the corrections and the result);
    // the middle is where the agent read files.
    const headN = Math.floor(DIGEST_CAP * 0.45);
    const tailN = DIGEST_CAP - headN;
    out = `${out.slice(0, headN)}\n\n[… ${out.length - DIGEST_CAP} characters of the middle of the session left out …]\n\n${out.slice(-tailN)}`;
  }
  return out;
}

/** What the original session cost in attention — the baseline every run is
 *  measured against. Corrections = every human message after the brief. */
export function attentionOf(steps: Step[]): { messages: number; approvals: number; corrections: number } {
  let messages = 0;
  let approvals = 0;
  for (const s of steps) {
    if (s.kind === 'user' && !isMeta(s.label)) messages++;
    else if (s.kind === 'tool_use' && s.tool && !s.tool.name.startsWith('mcp__') && !['Read', 'Glob', 'Grep', 'TodoWrite'].includes(s.tool.name)) approvals++;
  }
  return { messages, approvals, corrections: Math.max(0, messages - 1) };
}

export function extractionPrompt(digest: string, roomName: string): string {
  return `You are reading a finished session between a person and a coding agent in the project "${roomName}". The person got the result they wanted. Write down the PROCESS so it can be run again with new inputs, without the person explaining or supervising it from scratch.

Return ONE JSON object and nothing else, with exactly these fields:
{
  "name": "3-6 word name for this playbook, no quotes inside",
  "goal": "the outcome, in one or two sentences, phrased as an instruction for next time",
  "inputs": [ { "key": "short-id", "label": "What to ask for", "example": "what it was this time" } ],
  "rules": [ "a standing instruction or preference, one per line" ],
  "steps": [ { "text": "one step of the process", "pause": false } ],
  "checks": [ "what proved the result was acceptable" ],
  "output": "what the run should hand back at the end"
}

How to fill it in:
- inputs: only what genuinely changes each time — a ticket number, a file, a name, a date range, a topic. Not the way of working. 0 to 5 of them. Keys are lowercase letters, digits and dashes.
- rules: turn every correction the person made ("no, not like that", "always…", "never…", "use X instead") and every stated preference into a reusable rule. Include conventions the agent discovered and had to follow. Leave out anything that only applied to this one task (specific line numbers, this ticket's details, old results, pasted data).
- steps: the sequence that worked, in order, 3 to 12 steps, each concrete enough to follow. Refer to inputs as {key}. Mark a step "pause": true where the person wanted to look before the agent went on (they asked to see something first, or approved a plan) — the run will stop there and wait.
- checks: tests run, builds, manual verifications, review criteria. What "done" looked like.
- output: the deliverable — a diff on a branch, a report file, a summary in chat — and its shape.
- Never copy private data, secrets, file contents or long outputs into any field.
- Plain language, no markdown, no code fences around the JSON.

The session:

${digest}`;
}

const InputSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  example: z.string().max(400).optional(),
});
const StepSchema = z.object({ text: z.string().min(1).max(1_000), pause: z.boolean().optional() });
const DraftSchema = z.object({
  name: z.string().min(1).max(80),
  goal: z.string().min(1).max(2_000),
  inputs: z.array(InputSchema).max(8).default([]),
  rules: z.array(z.string().min(1).max(1_000)).max(40).default([]),
  steps: z.array(StepSchema).max(24).default([]),
  checks: z.array(z.string().min(1).max(500)).max(20).default([]),
  output: z.string().max(1_000).default(''),
});

/** The model's answer, or the first JSON object inside whatever it wrote. */
function jsonIn(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* look for an object inside prose or a fence */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* fall through */
    }
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* not JSON */
    }
  }
  return null;
}

const keyOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'input';

/**
 * Validate the model's JSON into a Playbook (unsaved: empty id). Keys are
 * normalised and deduped; rules get ids and provenance; the allowlist and the
 * attention baseline come from the transcript itself, never from the model.
 */
export function draftFromAnswer(
  text: string,
  ctx: { roomId: string; sessionId: string; steps: Step[]; now?: string },
): { ok: true; draft: Playbook } | { ok: false; error: string } {
  const raw = jsonIn(text);
  if (!raw) return { ok: false, error: 'The model did not answer with a card airoom could read.' };
  const parsed = DraftSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `The proposed card was malformed: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const d = parsed.data;
  const now = ctx.now ?? new Date().toISOString();
  const seen = new Set<string>();
  const inputs: PlaybookInput[] = [];
  for (const i of d.inputs) {
    const key = keyOf(i.key);
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push({ key, label: i.label.trim(), ...(i.example?.trim() ? { example: i.example.trim() } : {}) });
  }
  const rules: PlaybookRule[] = d.rules.map((r, i) => ({ id: `r${i + 1}`, text: r.trim(), from: 'session', at: now }));
  const steps: PlaybookStep[] = d.steps.map((s) => ({ text: s.text.trim(), ...(s.pause ? { pause: true } : {}) }));
  const att = attentionOf(ctx.steps);
  return {
    ok: true,
    draft: {
      id: '',
      roomId: ctx.roomId,
      name: d.name.trim(),
      goal: d.goal.trim(),
      inputs,
      rules,
      steps,
      checks: d.checks.map((c) => c.trim()),
      output: d.output.trim(),
      allow: allowRulesFrom(ctx.steps),
      source: { sessionId: ctx.sessionId, ...att },
      createdAt: now,
      updatedAt: now,
      runs: [],
    },
  };
}

/** The line a run ends its last message with when the playbook is complete.
 *  Plain text on purpose: it must survive any model and any markdown. */
export const DONE_MARK = 'PLAYBOOK COMPLETE';

/** Fill `{key}` references with this run's inputs. */
function fill(text: string, inputs: Record<string, string>): string {
  return text.replace(/\{([a-z0-9-]+)\}/g, (m, k: string) => (inputs[k] != null && inputs[k] !== '' ? inputs[k] : m));
}

/**
 * The card as standing instructions: appended to the system prompt of every
 * turn of a run, so rules hold across follow-ups and survive a restart.
 */
export function playbookPreamble(pb: Playbook, inputs: Record<string, string>): string {
  const parts: string[] = [];
  parts.push(`## Playbook: ${pb.name} (airoom)`);
  parts.push(
    'You are running a PLAYBOOK — a process that already worked once in this project and was written down so it can be repeated without being explained or supervised again. Follow the card below. It is the whole process: do not invent steps it does not have, and do not skip its checks.',
  );
  parts.push(`### Goal\n${fill(pb.goal, inputs)}`);
  if (pb.inputs.length) {
    parts.push(
      `### Inputs for this run\n${pb.inputs.map((i) => `- ${i.label} ({${i.key}}): ${inputs[i.key]?.trim() ? inputs[i.key] : '(not given — ask for it before you start)'}`).join('\n')}`,
    );
  }
  if (pb.rules.length) parts.push(`### Rules (always in force)\n${pb.rules.map((r) => `- ${fill(r.text, inputs)}`).join('\n')}`);
  if (pb.steps.length) {
    parts.push(
      `### Steps\n${pb.steps
        .map((s, i) => `${i + 1}. ${fill(s.text, inputs)}${s.pause ? '  ← REVIEW POINT: stop after this step, show what you have, and wait for the go-ahead before continuing.' : ''}`)
        .join('\n')}`,
    );
  }
  if (pb.checks.length) parts.push(`### Checks before you finish\n${pb.checks.map((c) => `- ${fill(c, inputs)}`).join('\n')}`);
  if (pb.output.trim()) parts.push(`### Deliver\n${fill(pb.output, inputs)}`);
  parts.push(
    `### How to run\n- Work through the steps in order. Say which step you are on as you go ("Step 3: …") so the person can follow from across the room.\n- At a review point, or whenever you genuinely need a decision, stop and ask in plain text. Do not guess at an input you were not given.\n- When every step is done and every check has passed, end your final message with a short summary of what you delivered and then the exact line:\n${DONE_MARK}\n- If you cannot complete the playbook, say why plainly and do not write that line.`,
  );
  return parts.join('\n\n');
}

/** The first message of a run: the kickoff, with the inputs spelled out. */
export function kickoffMessage(pb: Playbook, inputs: Record<string, string>): string {
  const given = pb.inputs.filter((i) => inputs[i.key]?.trim());
  const lines = [`Run the playbook "${pb.name}".`];
  if (given.length) lines.push('', 'Inputs:', ...given.map((i) => `- ${i.label}: ${inputs[i.key]}`));
  const missing = pb.inputs.filter((i) => !inputs[i.key]?.trim());
  if (missing.length) lines.push('', `Not given: ${missing.map((i) => i.label).join(', ')}. Ask for what you need before starting.`);
  lines.push('', 'Start with step 1.');
  return lines.join('\n');
}
