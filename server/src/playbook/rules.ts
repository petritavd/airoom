import path from 'node:path';
import type { Step } from '../../../shared/types';

/**
 * Permission rules for playbooks, in Claude Code's own syntax.
 *
 * A playbook carries the approvals its original session got, as rules like
 * `Bash(npm test:*)` or `Edit`. Two things live here: deriving those rules
 * from what a session actually ran, and matching a live tool call against
 * them. Both are deliberately CONSERVATIVE — a rule may only ever cover what
 * the human already said yes to, generalised no further than the command's
 * runner and subcommand — because the whole point of the list is that the
 * human does not have to read the card again.
 */

/** Tools whose rules are matched on a path glob rather than a command. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Tools a playbook run may hold without a card: they cannot change anything. */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'Task', 'WebSearch', 'LSP', 'ToolSearch', 'Skill']);

/**
 * Runners whose first argument is the real verb: `npm test` and `npm publish`
 * are not the same permission, so a rule keeps both words.
 */
const TWO_WORD = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'git', 'node', 'python', 'python3', 'pip', 'pip3', 'make', 'cargo', 'go',
  'docker', 'kubectl', 'gh', 'rails', 'bundle', 'mix', 'dotnet', 'gradle', 'mvn', 'poetry', 'uv', 'deno', 'swift',
  'xcodebuild', 'flutter', 'composer', 'php', 'ruby', 'terraform', 'aws', 'gcloud', 'az',
]);

/**
 * Commands that never generalise. `git push` after one approval is not the
 * same as `git push` forever; a deletion is exactly the deletion that was
 * approved. These become exact-match rules (or, for the destructive shapes,
 * no rule at all).
 */
const EXACT_ONLY = [/^git\s+push\b/, /^git\s+reset\b/, /^git\s+checkout\b/, /^git\s+rebase\b/, /^git\s+commit\b/, /^npm\s+publish\b/, /^curl\b/, /^wget\b/, /^ssh\b/, /^scp\b/, /^brew\b/, /^chmod\b/, /^chown\b/, /^mv\b/, /^cp\b/];
const NEVER = [/^rm\b/, /^sudo\b/, /^rmdir\b/, /^dd\b/, /^mkfs\b/, /^kill\b/, /^pkill\b/, /^killall\b/, /^shutdown\b/, /^reboot\b/, /\bgit\s+push\s+.*--force\b/, /\bgit\s+push\s+-f\b/];

/** First "word" of a shell command, ignoring env assignments and `cd x &&`. */
function head(command: string): string {
  let c = command.trim();
  // `cd dir && real command` — the real command is what matters
  const amp = c.indexOf('&&');
  if (/^cd\s/.test(c) && amp !== -1) c = c.slice(amp + 2).trim();
  // leading VAR=value assignments
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(c)) c = c.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  return c;
}

/** The rule one approved Bash command earns, or null when it must not. */
export function bashRuleFor(command: string): string | null {
  const c = head(command).replace(/\s+/g, ' ').trim();
  if (!c) return null;
  if (NEVER.some((re) => re.test(c))) return null;
  // Pipes and chains are approved as a whole, never as their first word.
  const compound = /[|;&`$()<>]/.test(c);
  if (compound || EXACT_ONLY.some((re) => re.test(c))) return `Bash(${c.slice(0, 200)})`;
  const words = c.split(' ');
  const first = path.basename(words[0]);
  if (TWO_WORD.has(first) && words[1] && !words[1].startsWith('-')) return `Bash(${first} ${words[1]}:*)`;
  return `Bash(${first}:*)`;
}

/**
 * The allowlist a session earns: one rule per distinct thing that ran. Read
 * tools are always on it — a run that had to ask before reading a file would
 * not be "less supervision" than the first one.
 */
export function allowRulesFrom(steps: Step[]): string[] {
  const out = new Set<string>();
  for (const s of steps) {
    if (s.kind !== 'tool_use' || !s.tool) continue;
    const { name, target } = s.tool;
    if (name.startsWith('mcp__')) continue; // host plumbing carries its own policy
    if (name === 'AskUserQuestion' || name === 'ExitPlanMode') continue;
    if (name === 'Bash') {
      const r = bashRuleFor(target);
      if (r) out.add(r);
    } else if (name === 'WebFetch') {
      try {
        out.add(`WebFetch(domain:${new URL(target).hostname})`);
      } catch {
        /* not a url — no rule */
      }
    } else out.add(name);
  }
  for (const t of ['Read', 'Glob', 'Grep']) out.add(t);
  return [...out].sort();
}

/** `Tool(pattern)` → its two halves; a bare tool name has no pattern. */
function splitRule(rule: string): { tool: string; pattern: string | null } {
  const m = /^([A-Za-z_][\w-]*)\((.*)\)$/s.exec(rule.trim());
  return m ? { tool: m[1], pattern: m[2] } : { tool: rule.trim(), pattern: null };
}

/** A minimal glob: `*` within a segment, `**` across segments. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Does this rule cover this call?
 *
 *  - `Bash(prefix:*)` matches a command that starts with `prefix` at a word
 *    boundary (the same reading Claude Code gives its own rules); `Bash(x)`
 *    matches exactly `x`, whitespace-normalised.
 *  - File tools match their path against a glob, relative to `cwd`.
 *  - `WebFetch(domain:host)` matches the url's host.
 *  - A bare tool name matches every call of that tool.
 */
export function ruleMatches(rule: string, toolName: string, input: Record<string, unknown>, cwd: string): boolean {
  const { tool, pattern } = splitRule(rule);
  if (tool !== toolName) return false;
  if (pattern === null) return true;
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  if (toolName === 'Bash') {
    const cmd = head(str('command')).replace(/\s+/g, ' ').trim();
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2).trim();
      return cmd === prefix || cmd.startsWith(prefix + ' ');
    }
    return cmd === pattern.replace(/\s+/g, ' ').trim();
  }
  if (FILE_TOOLS.has(toolName)) {
    const p = str('file_path') || str('notebook_path');
    if (!p) return false;
    // Globs are matched on `/`. Windows hands over `src\deep\a.ts`: left as it
    // is, `src/**` would never match it, and a segment-bound `*` would run
    // straight through every backslash of an absolute path.
    const slashed = (s: string) => s.replace(/\\/g, '/');
    const rel = slashed(path.isAbsolute(p) ? path.relative(cwd, p) : p);
    const re = globToRegExp(slashed(pattern));
    return re.test(rel) || re.test(slashed(p));
  }
  if (toolName === 'WebFetch') {
    const m = /^domain:(.+)$/.exec(pattern);
    if (!m) return false;
    try {
      const host = new URL(str('url')).hostname;
      return host === m[1] || host.endsWith(`.${m[1]}`);
    } catch {
      return false;
    }
  }
  return pattern === str('pattern') || pattern === str('query');
}

/** True when any rule on the list covers the call. */
export function allowedByRules(rules: string[], toolName: string, input: Record<string, unknown>, cwd: string): boolean {
  if (READ_ONLY_TOOLS.has(toolName) && rules.includes(toolName)) return true;
  return rules.some((r) => ruleMatches(r, toolName, input, cwd));
}

/**
 * Rules arrive from the client (an edited card) so they are checked: known
 * syntax only, no destructive shapes, capped in number and length.
 */
export function sanitiseRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw.slice(0, 80)) {
    if (typeof r !== 'string') continue;
    const rule = r.trim().slice(0, 240);
    const { tool, pattern } = splitRule(rule);
    if (!/^[A-Za-z_][\w-]*$/.test(tool)) continue;
    if (tool === 'Bash' && pattern) {
      const cmd = pattern.endsWith(':*') ? pattern.slice(0, -2) : pattern;
      if (NEVER.some((re) => re.test(cmd.trim()))) continue;
      if (pattern === '*' || pattern === ':*' || !cmd.trim()) continue; // "any command" is a mode, not a rule
    }
    if (tool === 'Bash' && pattern === null) continue; // bare Bash = unattended shell; that is what modes are for
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}
