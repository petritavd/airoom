import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runKeyFor, type AgentController } from '../agent/AgentController';
import { MAX_STEPS } from '../parse/sessionParser';
import { buildSkillPrompt, sanitizeAgentSkills } from '../skills';
import { PERMISSION_MODES, MAX_PLAYBOOK_RUNS } from '../../../shared/types';
import type { PermissionMode, Playbook, PlaybookRun, RunUpdate, Step } from '../../../shared/types';
import { attentionOf, digestSteps, DONE_MARK, draftFromAnswer, extractionPrompt, kickoffMessage, playbookPreamble } from './extract';
import { sanitiseRules } from './rules';

/**
 * Playbooks: extraction, the store, and runs.
 *
 * A run is an ORDINARY session. The playbook layer only adds a preamble (the
 * card) and an allowlist to its turns, and watches its updates to keep score —
 * how many times the human had to step in, how many cards it raised. Those
 * two numbers are the feature's claim ("less supervision the second time"),
 * so they are counted here, in code, from what actually happened.
 */

export interface PlaybookDeps {
  controller: AgentController;
  /** The session's steps, all of them — extraction reads the whole thing. */
  getTranscript: (sessionId: string, limit: number) => Promise<{ steps: Step[] }>;
  onUpdate: (u: RunUpdate) => void;
  /** Something about a playbook changed — clients get the list again. */
  onChanged: () => void;
  file?: string;
  now?: () => string;
}

const STORE = path.join(os.homedir(), '.airoom', 'playbooks.json');
const MAX_PLAYBOOKS = 200;
const cap = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

export class PlaybookController {
  private books = new Map<string, Playbook>();
  private file: string;
  /** Live runs by session id (or spawn key until the session exists). */
  /** `reopened`: the run had already finished when the human spoke to it
   *  again. A reply that ends without the completion line is then just an
   *  answer, not a run waiting on a decision. */
  private live = new Map<string, { id: string; runId: string; lastText: string; reopened?: boolean }>();
  private drafting = new Set<string>();

  constructor(private deps: PlaybookDeps) {
    this.file = deps.file ?? STORE;
    this.load();
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  list(): Playbook[] {
    return [...this.books.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Playbook | undefined {
    return this.books.get(id);
  }

  /** Which run (if any) a session belongs to — the office overlay. */
  runOf(sessionId: string): { id: string; runId: string; name: string } | undefined {
    for (const pb of this.books.values())
      for (const r of pb.runs) if (r.sessionId === sessionId) return { id: pb.id, runId: r.id, name: pb.name };
    return undefined;
  }

  // ---- extraction ------------------------------------------------------------

  /**
   * Read a session and propose its playbook. One extraction per session at a
   * time; a second click while the first is reading is answered with the
   * first one's result.
   */
  async draft(sessionId: string, roomId: string): Promise<{ draft?: Playbook; error?: string }> {
    if (!this.deps.controller.ask) return { error: 'Playbooks need the SDK engine (unset AIROOM_ENGINE=cli).' };
    if (this.drafting.has(sessionId)) return { error: 'Still reading that session — one moment.' };
    this.drafting.add(sessionId);
    try {
      const { steps } = await this.deps.getTranscript(sessionId, MAX_STEPS);
      const humans = steps.filter((s) => s.kind === 'user' && !s.label.trimStart().startsWith('<')).length;
      if (!steps.length) return { error: 'That session has no transcript on disk to read.' };
      if (humans === 0) return { error: 'That session has no message from you in it — there is no task to write down yet.' };
      const digest = digestSteps(steps);
      const answer = await this.deps.controller.ask(roomId, extractionPrompt(digest, path.basename(roomId)), {
        maxTurns: 1,
      });
      if (!answer.ok) return { error: answer.error };
      const res = draftFromAnswer(answer.text, { roomId, sessionId, steps, now: this.now() });
      return res.ok ? { draft: res.draft } : { error: res.error };
    } catch (err) {
      return { error: `Could not read the session: ${String((err as Error).message ?? err)}` };
    } finally {
      this.drafting.delete(sessionId);
    }
  }

  // ---- the store -------------------------------------------------------------

  /**
   * Save a card the client sent back. Every field is untrusted: capped,
   * normalised, the allowlist checked against the same rules as a derived
   * one. An existing id keeps its runs and its provenance; a new one is
   * minted here.
   */
  save(raw: unknown): { ok: true; playbook: Playbook } | { ok: false; error: string } {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'No playbook in that request.' };
    const r = raw as Record<string, unknown>;
    const id = cap(r.id, 60);
    const prev = id ? this.books.get(id) : undefined;
    const roomId = cap(r.roomId, 4_000) || prev?.roomId || '';
    if (!roomId) return { ok: false, error: 'A playbook belongs to a room.' };
    const name = cap(r.name, 80) || prev?.name || '';
    if (!name) return { ok: false, error: 'Give the playbook a name.' };
    const now = this.now();
    const seen = new Set<string>();
    const inputs = (Array.isArray(r.inputs) ? r.inputs : [])
      .slice(0, 8)
      .map((i) => {
        const x = (i ?? {}) as Record<string, unknown>;
        const key = cap(x.key, 40)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        const label = cap(x.label, 120) || key;
        const example = cap(x.example, 400);
        return key && !seen.has(key) && seen.add(key) ? { key, label, ...(example ? { example } : {}) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    const rules = (Array.isArray(r.rules) ? r.rules : [])
      .slice(0, 60)
      .map((x, i) => {
        const y = (x ?? {}) as Record<string, unknown>;
        const text = cap(y.text, 1_000);
        if (!text) return null;
        const from = y.from === 'run' ? ('run' as const) : ('session' as const);
        return {
          id: cap(y.id, 24) || `r${Date.now().toString(36)}${i}`,
          text,
          from,
          ...(cap(y.runId, 40) ? { runId: cap(y.runId, 40) } : {}),
          at: cap(y.at, 40) || now,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    const steps = (Array.isArray(r.steps) ? r.steps : [])
      .slice(0, 30)
      .map((x) => {
        const y = (x ?? {}) as Record<string, unknown>;
        const text = cap(y.text, 1_000);
        return text ? { text, ...(y.pause ? { pause: true as const } : {}) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    const checks = (Array.isArray(r.checks) ? r.checks : []).slice(0, 20).map((c) => cap(c, 500)).filter(Boolean);
    const mode = PERMISSION_MODES.some((p) => p.value === r.mode) ? (r.mode as PermissionMode) : undefined;
    const model = cap(r.model, 100) || undefined;
    const skills = sanitizeAgentSkills(r.skills, roomId);
    const src = (r.source ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const pb: Playbook = {
      id: id || `pb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      roomId,
      name,
      goal: cap(r.goal, 2_000),
      inputs,
      rules,
      steps,
      checks,
      output: cap(r.output, 1_000),
      allow: sanitiseRules(r.allow),
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(skills ? { skills } : {}),
      source: prev?.source ?? {
        sessionId: cap(src.sessionId, 80),
        messages: n(src.messages),
        approvals: n(src.approvals),
        corrections: n(src.corrections),
      },
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      runs: prev?.runs ?? [],
    };
    this.books.set(pb.id, pb);
    if (this.books.size > MAX_PLAYBOOKS) {
      const oldest = this.list().slice(MAX_PLAYBOOKS);
      for (const o of oldest) this.books.delete(o.id);
    }
    this.persist();
    this.deps.onChanged();
    return { ok: true, playbook: pb };
  }

  delete(id: string): boolean {
    const pb = this.books.get(id);
    if (!pb) return false;
    for (const r of pb.runs) if (r.sessionId && (r.state === 'working' || r.state === 'waiting')) this.deps.controller.interrupt(r.sessionId);
    this.books.delete(id);
    this.persist();
    this.deps.onChanged();
    return true;
  }

  /** A correction the human chose to keep: a visible rule on the card. */
  addRule(id: string, text: string, runId?: string): { ok: boolean; error?: string } {
    const pb = this.books.get(id);
    if (!pb) return { ok: false, error: 'No such playbook.' };
    const t = text.trim().slice(0, 1_000);
    if (!t) return { ok: false, error: 'An empty rule is not a rule.' };
    if (pb.rules.length >= 60) return { ok: false, error: 'That card already has sixty rules — trim it before adding more.' };
    pb.rules.push({ id: `r${Date.now().toString(36)}${pb.rules.length}`, text: t, from: runId ? 'run' : 'session', ...(runId ? { runId } : {}), at: this.now() });
    const run = runId ? pb.runs.find((r) => r.id === runId) : undefined;
    if (run) run.rulesAdded++;
    pb.updatedAt = this.now();
    this.persist();
    this.deps.onChanged();
    return { ok: true };
  }

  dropRule(id: string, ruleId: string): boolean {
    const pb = this.books.get(id);
    if (!pb) return false;
    const before = pb.rules.length;
    pb.rules = pb.rules.filter((r) => r.id !== ruleId);
    if (pb.rules.length === before) return false;
    pb.updatedAt = this.now();
    this.persist();
    this.deps.onChanged();
    return true;
  }

  // ---- runs ------------------------------------------------------------------

  /**
   * Start a run: a fresh session in the playbook's room, the card as its
   * standing instructions, the allowlist in force for every turn.
   */
  run(id: string, inputsRaw: unknown, mode?: PermissionMode, model?: string): { ok: boolean; error?: string; runId?: string } {
    const pb = this.books.get(id);
    if (!pb) return { ok: false, error: 'No such playbook.' };
    const inputs: Record<string, string> = {};
    const given = (inputsRaw ?? {}) as Record<string, unknown>;
    for (const i of pb.inputs) inputs[i.key] = cap(given[i.key], 4_000);
    const now = this.now();
    const run: PlaybookRun = {
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      sessionId: null,
      startedAt: now,
      state: 'working',
      inputs,
      messages: 0,
      approvals: 0,
      rulesAdded: 0,
      costUsd: 0,
    };
    pb.runs.push(run);
    if (pb.runs.length > MAX_PLAYBOOK_RUNS) pb.runs = pb.runs.slice(-MAX_PLAYBOOK_RUNS);
    pb.updatedAt = now;
    this.persist();
    this.deps.onChanged();

    const spawnTag = `pb:${run.id}`;
    const key = runKeyFor({ roomId: pb.roomId, spawnTag });
    this.live.set(key, { id: pb.id, runId: run.id, lastText: '' });
    const skillPrompt = pb.skills ? buildSkillPrompt(pb.skills, pb.roomId) : undefined;
    void this.deps.controller
      .send(
        {
          roomId: pb.roomId,
          text: kickoffMessage(pb, inputs),
          spawnTag,
          mode: mode ?? pb.mode ?? 'default',
          model: model ?? pb.model,
          systemPromptAppend: [playbookPreamble(pb, inputs), skillPrompt].filter(Boolean).join('\n\n'),
          allowRules: pb.allow,
        },
        (u) => {
          this.observe(pb.id, run.id, u);
          this.deps.onUpdate(u);
        },
      )
      .catch(() => {
        /* the error already came through as an update */
      })
      .finally(() => this.live.delete(key));
    return { ok: true, runId: run.id };
  }

  /** Keep score from what the run reports. */
  private observe(id: string, runId: string, u: RunUpdate) {
    const pb = this.books.get(id);
    const run = pb?.runs.find((r) => r.id === runId);
    if (!pb || !run) return;
    const slot = [...this.live.values()].find((l) => l.runId === runId);
    let changed = false;
    if (u.sessionId && run.sessionId !== u.sessionId) {
      run.sessionId = u.sessionId;
      if (slot) this.live.set(u.sessionId, slot);
      changed = true;
    }
    if (u.phase === 'permission') {
      run.approvals++;
      changed = true;
    } else if (u.phase === 'assistant' && u.text) {
      if (slot) slot.lastText = u.text;
    } else if (u.phase === 'result' && !u.meter) {
      if (typeof u.cost === 'number') run.costUsd = u.cost;
      const last = slot?.lastText ?? '';
      if (u.interrupted) run.state = 'stopped';
      else if (last.includes(DONE_MARK) || (u.text ?? '').includes(DONE_MARK)) {
        run.state = 'done';
        run.summary = (last || u.text || '').replace(DONE_MARK, '').trim().slice(-2_000);
      } else if (slot?.reopened) run.state = 'done';
      else run.state = 'waiting';
      if (run.state !== 'waiting') run.endedAt = this.now();
      changed = true;
    } else if (u.phase === 'error') {
      run.state = 'error';
      run.summary = (u.text ?? '').slice(0, 2_000);
      run.endedAt = this.now();
      changed = true;
    }
    if (changed) {
      pb.updatedAt = this.now();
      this.persist();
      this.deps.onChanged();
    }
  }

  /**
   * A human message is about to go to a run's session, through the ordinary
   * send path. It counts as supervision, it puts the run back to work, and the
   * turn it starts needs the card and the allowlist again — so this hands the
   * gateway the equipment, exactly as the team layer does for its members.
   */
  equipmentFor(sessionId: string): { systemPromptAppend: string; allowRules: string[]; observe: (u: RunUpdate) => void } | null {
    for (const pb of this.books.values()) {
      const run = pb.runs.find((r) => r.sessionId === sessionId);
      if (!run) continue;
      const finished = run.state === 'done' || run.state === 'error' || run.state === 'stopped';
      const slot = this.live.get(sessionId) ?? { id: pb.id, runId: run.id, lastText: '' };
      // Talking to a finished run reopens it: the card still applies, and a
      // reply that does not re-complete the playbook leaves it finished
      // rather than "waiting on you" for ever.
      if (finished) slot.reopened = true;
      this.live.set(sessionId, slot);
      run.messages++;
      run.state = 'working';
      delete run.endedAt;
      pb.updatedAt = this.now();
      this.persist();
      this.deps.onChanged();
      const skillPrompt = pb.skills ? buildSkillPrompt(pb.skills, pb.roomId) : undefined;
      return {
        systemPromptAppend: [playbookPreamble(pb, run.inputs), skillPrompt].filter(Boolean).join('\n\n'),
        allowRules: pb.allow,
        observe: (u) => this.observe(pb.id, run.id, u),
      };
    }
    return null;
  }

  stop(id: string, runId: string): boolean {
    const pb = this.books.get(id);
    const run = pb?.runs.find((r) => r.id === runId);
    if (!pb || !run) return false;
    const key = run.sessionId ?? runKeyFor({ roomId: pb.roomId, spawnTag: `pb:${run.id}` });
    this.deps.controller.interrupt(key);
    if (run.state === 'working' || run.state === 'waiting') {
      run.state = 'stopped';
      run.endedAt = this.now();
      pb.updatedAt = run.endedAt;
      this.persist();
      this.deps.onChanged();
    }
    return true;
  }

  /** On boot nothing is running: a run saved as working was killed with the
   *  server. Say so rather than show a spinner that can never finish. */
  private reconcile() {
    for (const pb of this.books.values())
      for (const r of pb.runs)
        if (r.state === 'working') {
          r.state = 'stopped';
          r.endedAt = r.endedAt ?? this.now();
        }
  }

  private load() {
    let text: string | null = null;
    for (const f of [this.file, `${this.file}.bak`]) {
      try {
        text = readFileSync(f, 'utf8');
        break;
      } catch {
        /* try the backup */
      }
    }
    if (!text) return;
    try {
      const raw = JSON.parse(text) as { v?: number; playbooks?: Playbook[] };
      for (const pb of raw.playbooks ?? []) if (pb && typeof pb.id === 'string') this.books.set(pb.id, { ...pb, runs: Array.isArray(pb.runs) ? pb.runs : [] });
      this.reconcile();
    } catch {
      try {
        renameSync(this.file, `${this.file}.damaged-${Date.now()}`);
      } catch {
        /* keep going with an empty store */
      }
    }
  }

  private persist() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, playbooks: this.list() }, null, 2));
      try {
        renameSync(this.file, `${this.file}.bak`);
      } catch {
        /* first save */
      }
      renameSync(tmp, this.file);
    } catch {
      /* a read-only disk should not take the feature down */
    }
  }
}

export { attentionOf };
