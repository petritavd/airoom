/**
 * ONE description of a tool call, shared by every producer.
 *
 * There used to be three of these (the transcript parser, the SDK controller
 * and the CLI controller), each truncating to a different length and only one
 * of them appending an ellipsis. Because the live/transcript reconciler in
 * useFleet matches on the label text, a Bash command longer than the shortest
 * cap could never reconcile — the same tool call rendered twice for the whole
 * run. Producers now emit identical, UNtruncated text; shortening is a
 * rendering decision made in the client.
 */

export interface ToolDescription {
  /** Tool name as the SDK reports it, e.g. "Bash", "Edit". */
  name: string;
  /** What the tool is acting on, untruncated: a command, path, pattern, url. */
  target: string;
  /** One-line label for places that need a flat string (status lines, tooltips). */
  label: string;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function describeTool(name: string, input: unknown): ToolDescription {
  const inp = (input ?? {}) as Record<string, unknown>;
  let target = '';


  if (name === 'Bash') target = str(inp.command).replace(/\s*\n\s*/g, ' ').trim();
  else if (FILE_TOOLS.has(name)) target = str(inp.file_path || inp.notebook_path);
  else if (name === 'Grep') target = str(inp.pattern);
  else if (name === 'Glob') target = str(inp.pattern);
  else if (name === 'Task' || name === 'Agent') target = str(inp.description || inp.subagent_type);
  else if (name === 'WebFetch') target = str(inp.url);
  else if (name === 'WebSearch') target = str(inp.query);
  else if (name === 'AskUserQuestion')
    // the real shape is { questions: [{ question, ... }] }
    target = str((Array.isArray(inp.questions) ? (inp.questions[0] as any)?.question : '') || inp.question);
  else if (name === 'ExitPlanMode') target = str(inp.plan).split('\n')[0];
  else if (name === 'TodoWrite') {
    const todos = Array.isArray(inp.todos) ? inp.todos : [];
    const active = todos.find((t: any) => t?.status === 'in_progress') ?? todos[0];
    target = active ? str(active.content ?? active.activeForm) : `${todos.length} items`;
  }

  // Cap for the wire: this text rides in every snapshot broadcast, and a
  // pasted heredoc command can be tens of kilobytes. 400 is far more than any
  // row renders, so the client still truncates purely visually.
  if (target.length > 400) target = `${target.slice(0, 399)}…`;
  return { name, target, label: target ? `${name}: ${target}` : name };
}

/** Flat label — for the robot's `currentAction` and other one-line surfaces. */
export function toolLabel(name: string, input: unknown): string {
  return describeTool(name, input).label;
}
