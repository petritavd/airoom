/**
 * Tool identity for the chat timeline: a flat 12px line icon, a display name,
 * and a muted accent. No emoji — the palette taught us OS emoji look
 * inconsistent and unprofessional next to the app's own pixel art.
 */

type IconProps = { className?: string };
const S = (d: React.ReactNode) => (p: IconProps) => (
  <svg
    className={p.className}
    width="12"
    height="12"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {d}
  </svg>
);

const IconTerminal = S(
  <>
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
    <path d="M4.5 6.5 6.5 8l-2 1.5M8.5 10h3" />
  </>,
);
const IconFile = S(
  <>
    <path d="M9 1.5H4.5a1.5 1.5 0 0 0-1.5 1.5v10a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5z" />
    <path d="M9 1.5v4h4" />
  </>,
);
const IconPencil = S(
  <>
    <path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.8 12.3l-3 .8.8-3z" />
  </>,
);
const IconPlus = S(
  <>
    <path d="M9 1.5H4.5a1.5 1.5 0 0 0-1.5 1.5v10a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5z" />
    <path d="M8 8v4M6 10h4" />
  </>,
);
const IconSearch = S(
  <>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3.5 3.5" />
  </>,
);
const IconFolder = S(
  <>
    <path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 2H13A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12z" />
  </>,
);
const IconGlobe = S(
  <>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M1.8 8h12.4M8 1.8c1.7 1.8 2.6 4 2.6 6.2S9.7 12.4 8 14.2C6.3 12.4 5.4 10.2 5.4 8S6.3 3.6 8 1.8" />
  </>,
);
const IconAgent = S(
  <>
    <rect x="2.5" y="5.5" width="11" height="8" rx="2.5" />
    <path d="M8 2v3.5" />
    <circle cx="8" cy="2" r="1" />
    <path d="M6 9.2v.6M10 9.2v.6" />
  </>,
);
const IconList = S(
  <>
    <path d="M6 4h8M6 8h8M6 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
  </>,
);
const IconGear = S(
  <>
    <circle cx="8" cy="8" r="2.4" />
    <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" />
  </>,
);

interface ToolMeta {
  Icon: (p: IconProps) => React.JSX.Element;
  color: string; // muted — tools must never outshout the conversation
}

const META: Record<string, ToolMeta> = {
  Bash: { Icon: IconTerminal, color: '#7f9bb8' },
  Read: { Icon: IconFile, color: '#6f93b5' },
  Edit: { Icon: IconPencil, color: '#8ba46f' },
  MultiEdit: { Icon: IconPencil, color: '#8ba46f' },
  Write: { Icon: IconPlus, color: '#8ba46f' },
  NotebookEdit: { Icon: IconPencil, color: '#8ba46f' },
  Grep: { Icon: IconSearch, color: '#a08fb5' },
  Glob: { Icon: IconFolder, color: '#a08fb5' },
  Task: { Icon: IconAgent, color: '#6fa79b' },
  Agent: { Icon: IconAgent, color: '#6fa79b' },
  WebFetch: { Icon: IconGlobe, color: '#7f9bb8' },
  WebSearch: { Icon: IconGlobe, color: '#7f9bb8' },
  TodoWrite: { Icon: IconList, color: '#8494ad' },
};

const FALLBACK: ToolMeta = { Icon: IconGear, color: '#8494ad' };

export function toolMeta(name: string): ToolMeta {
  return META[name] ?? FALLBACK;
}

/**
 * Split a server tool label into {name, arg}. Labels look like
 * "Bash: npm test", "Read draw.ts", `Grep "needle"` or just "TodoWrite".
 * Used when a step predates structured tool data on the wire.
 */
export function splitToolLabel(label: string): { name: string; target: string } {
  const colon = /^([A-Za-z][\w-]*):\s*([\s\S]*)$/.exec(label);
  if (colon) return { name: colon[1], target: colon[2] };
  const space = /^([A-Za-z][\w-]*)\s+([\s\S]+)$/.exec(label);
  if (space && META[space[1]]) return { name: space[1], target: space[2].replace(/^"|"$/g, '') };
  return { name: label.trim(), target: '' };
}
