import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSkills, SkillChoice, SkillSelection } from '../../shared/types';

/**
 * Skilled agents: discovery of the skills on this machine, the per-session
 * loadout store, and the system-prompt preamble a loadout becomes.
 *
 * A skill here is exactly what Claude Code means by one — a SKILL.md package —
 * so there is nothing airoom-specific to author. What airoom adds is the HIRE:
 * choosing a loadout at the ghost desk, and making it standing equipment.
 * That last part matters mechanically: every session sees the machine's skills
 * and *may* invoke them, but nothing guarantees it will. A pinned skill is
 * loaded into the system prompt on every turn, which is the difference between
 * "could follow the checklist" and "is the checklist".
 */

// ---- discovery ---------------------------------------------------------------

/** First ~90 lines is plenty for frontmatter; bodies are read separately. */
function frontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith('---')) return {};
  const end = md.indexOf('\n---', 3);
  if (end === -1) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of md.slice(3, end).split('\n')) {
    const m = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (m && !out[m[1] as 'name' | 'description']) out[m[1] as 'name' | 'description'] = m[2].trim();
  }
  return out;
}

/**
 * `dir/<name>/SKILL.md` → choices. Unreadable dirs are simply not skills.
 * `prefix` disambiguates plugin skills: three messaging plugins all ship an
 * `access` skill, and three identical rows help nobody — they list as
 * `discord/access`, `telegram/access`, `imessage/access` instead.
 */
function scanSkillDir(dir: string, source: SkillChoice['source'], prefix?: string): SkillChoice[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SkillChoice[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const file = path.join(dir, name, 'SKILL.md');
    try {
      const md = readFileSync(file, 'utf8');
      const fm = frontmatter(md);
      const bare = fm.name ?? name;
      out.push({
        name: prefix && prefix !== bare ? `${prefix}/${bare}` : bare,
        description: (fm.description ?? '').slice(0, 400),
        source,
        path: file,
      });
    } catch {
      /* no SKILL.md in this entry */
    }
  }
  return out;
}

interface InstalledPlugin {
  scope?: string;
  projectPath?: string;
  installPath?: string;
}

/**
 * Skills from INSTALLED plugins (the cache the runtime loads from). ALL of
 * them, whatever project they were installed for: airoom loads a skill by
 * reading its SKILL.md into the prompt, so equipment is not gated on where a
 * plugin happened to be enabled.
 */
function pluginSkills(): SkillChoice[] {
  let installs: InstalledPlugin[] = [];
  try {
    const raw = JSON.parse(
      readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins?: Record<string, InstalledPlugin[]> };
    installs = Object.values(raw.plugins ?? {}).flat();
  } catch {
    return [];
  }
  const out: SkillChoice[] = [];
  for (const p of installs) {
    if (!p?.installPath) continue;
    // cache/<marketplace>/<plugin>/<version>/skills → the plugin is 2 up
    const plugin = path.basename(path.dirname(p.installPath));
    out.push(...scanSkillDir(path.join(p.installPath, 'skills'), 'plugin', plugin));
  }
  return out;
}

/**
 * Skills from the marketplace mirror already synced under ~/.claude/plugins.
 * These plugins are NOT installed, but their SKILL.md files are on disk and
 * airoom's loadout mechanism reads files, so they work as equipment — this is
 * what turns a one-row picker on a fresh machine into a library. A bounded
 * walk, because marketplaces nest (plugins/, external_plugins/) and layouts
 * shift between versions.
 */
function marketplaceSkills(): SkillChoice[] {
  const root = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces');
  const out: SkillChoice[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 7 || out.length > 200) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const sub = path.join(dir, e.name);
      if (e.name === 'skills') out.push(...scanSkillDir(sub, 'marketplace', path.basename(dir)));
      else walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Everything an agent hired in `roomId` could carry. Deduped by path, and
 * marketplace rows are also deduped by NAME against everything nearer — an
 * installed plugin's skill would otherwise appear twice, once from its cache
 * and once from the mirror it was installed from.
 */
export function discoverSkills(roomId: string): SkillChoice[] {
  const near = [
    ...scanSkillDir(path.join(roomId, '.claude', 'skills'), 'project'),
    ...scanSkillDir(path.join(os.homedir(), '.claude', 'skills'), 'user'),
    ...pluginSkills(),
  ];
  const names = new Set(near.map((s) => s.name));
  const all = [...near, ...marketplaceSkills().filter((s) => !names.has(s.name))];
  const seen = new Set<string>();
  const RANK: Record<SkillChoice['source'], number> = { project: 0, user: 1, plugin: 2, marketplace: 3 };
  return all
    .filter((s) => !seen.has(s.path) && (seen.add(s.path), true))
    .sort((a, b) => RANK[a.source] - RANK[b.source] || a.name.localeCompare(b.name));
}

// ---- authoring ---------------------------------------------------------------

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * Write a new user-level skill from the hire form. A REAL skill — a SKILL.md
 * under ~/.claude/skills with ordinary frontmatter — so Claude Code discovers
 * it too and it outlives airoom. Never overwrites: a name collision is an
 * error, not a merge.
 */
export function createUserSkill(
  name: string,
  description: string,
  body: string,
): { ok: true; name: string; path: string } | { ok: false; error: string } {
  const slug = slugify(name);
  if (!slug) return { ok: false, error: 'Give the skill a name (letters and digits).' };
  if (body.length > 64_000) return { ok: false, error: 'That skill is too long — keep it under 64k characters.' };
  const dir = path.join(os.homedir(), '.claude', 'skills', slug);
  const file = path.join(dir, 'SKILL.md');
  try {
    readFileSync(file, 'utf8');
    return { ok: false, error: `A skill called "${slug}" already exists in ~/.claude/skills.` };
  } catch {
    /* good — it doesn't exist yet */
  }
  const desc = (description || body.split('\n')[0] || '').replace(/\n/g, ' ').slice(0, 300);
  const md = `---\nname: ${slug}\ndescription: ${desc}\n---\n\n${body.trim()}\n`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, md);
    return { ok: true, name: slug, path: file };
  } catch (err) {
    return { ok: false, error: `Could not write the skill: ${String(err)}` };
  }
}

// ---- the loadout store -------------------------------------------------------

/**
 * sessionId → loadout, on disk so a loadout survives the server. Session ids
 * are never reused, so entries for deleted sessions are inert rather than
 * wrong; they are pruned opportunistically on save past a generous cap.
 */
const STORE_PATH = path.join(os.homedir(), '.airoom', 'skilled-agents.json');
const STORE_CAP = 500;
let store: Record<string, AgentSkills> | null = null;

function loadStore(): Record<string, AgentSkills> {
  if (store) return store;
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as { sessions?: Record<string, AgentSkills> };
    store = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  } catch {
    store = {};
  }
  return store;
}

export function assignSkills(sessionId: string, skills: AgentSkills): void {
  const s = loadStore();
  s[sessionId] = skills;
  const keys = Object.keys(s);
  if (keys.length > STORE_CAP) for (const k of keys.slice(0, keys.length - STORE_CAP)) delete s[k];
  try {
    mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify({ sessions: s }, null, 2));
  } catch {
    /* the in-memory copy still serves this server's lifetime */
  }
}

export function skillsFor(sessionId: string): AgentSkills | undefined {
  return loadStore()[sessionId];
}

export function skillNamesFor(sessionId: string): string[] | undefined {
  const a = loadStore()[sessionId];
  return a?.skills.length ? a.skills.map((s) => s.name) : undefined;
}

// ---- wire input --------------------------------------------------------------

/**
 * The loadout arrives from a websocket frame, so it is untrusted twice over:
 * shape (anything parses as JSON) and content (the paths are read and fed into
 * a system prompt). Paths are only accepted where skills actually live — the
 * machine's .claude tree or the room's own — never arbitrary files.
 */
export function sanitizeAgentSkills(raw: unknown, roomId: string): AgentSkills | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const skillsIn = (raw as { skills?: unknown }).skills;
  if (!Array.isArray(skillsIn)) return undefined;
  const roots = [path.join(os.homedir(), '.claude') + path.sep, path.join(roomId, '.claude', 'skills') + path.sep];
  const skills: SkillSelection[] = [];
  for (const s of skillsIn.slice(0, 12)) {
    if (!s || typeof s !== 'object') continue;
    const p = (s as { path?: unknown }).path;
    const name = (s as { name?: unknown }).name;
    if (typeof p !== 'string' || typeof name !== 'string' || !name.trim()) continue;
    const norm = path.normalize(p);
    if (path.basename(norm) !== 'SKILL.md') continue;
    if (!roots.some((r) => norm.startsWith(r))) continue;
    skills.push({ path: norm, name: name.slice(0, 80), pin: !!(s as { pin?: unknown }).pin });
  }
  if (!skills.length) return undefined;
  return { skills, specialist: !!(raw as { specialist?: unknown }).specialist };
}

// ---- the preamble ------------------------------------------------------------

const PIN_BODY_CAP = 10_000; // per pinned skill
const PROMPT_CAP = 32_000; // the whole preamble

/** A skill's body without its frontmatter block. */
function skillBody(md: string): string {
  if (!md.startsWith('---')) return md.trim();
  const end = md.indexOf('\n---', 3);
  return end === -1 ? md.trim() : md.slice(end + 4).trim();
}

/** A selection whose file moved (plugin update) re-resolves by name. */
function resolveSelection(sel: SkillSelection, roomId: string): string | null {
  try {
    return readFileSync(sel.path, 'utf8');
  } catch {
    const hit = discoverSkills(roomId).find((s) => s.name === sel.name);
    if (!hit) return null;
    try {
      return readFileSync(hit.path, 'utf8');
    } catch {
      return null;
    }
  }
}

/**
 * The loadout as a system-prompt preamble. Pinned skills carry their whole
 * body — that is what "pinned" buys; granted ones carry a pointer, so a big
 * loadout stays cheap until a skill is actually needed.
 */
export function buildSkillPrompt(loadout: AgentSkills, roomId: string): string | undefined {
  const parts: string[] = [];
  for (const sel of loadout.skills) {
    const md = resolveSelection(sel, roomId);
    if (md == null) continue; // deleted since the hire — quietly not equipment any more
    const fm = frontmatter(md);
    if (sel.pin) {
      let body = skillBody(md);
      if (body.length > PIN_BODY_CAP) body = body.slice(0, PIN_BODY_CAP) + '\n\n[skill truncated]';
      parts.push(`### Pinned skill: ${sel.name}\nFollow these instructions for all applicable work in this session:\n\n${body}`);
    } else {
      parts.push(
        `### Granted skill: ${sel.name}\n${fm.description ?? ''}\nWhen this becomes relevant, read ${sel.path} and follow it.`,
      );
    }
  }
  if (!parts.length) return undefined;
  const head = loadout.specialist
    ? 'You are a SPECIALIST hired for the skills below. Only take on work they cover; if asked for something outside them, say so briefly and suggest a general agent for it instead of improvising.'
    : 'You were hired with this skill loadout. Lean on it — it is why this agent exists.';
  let out = `## Skill loadout (airoom)\n\n${head}\n\n${parts.join('\n\n')}`;
  if (out.length > PROMPT_CAP) out = out.slice(0, PROMPT_CAP) + '\n\n[loadout truncated]';
  return out;
}
