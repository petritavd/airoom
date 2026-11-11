import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Lanes, in git.
 *
 * A team that runs three tasks at once cannot run them in one folder: two
 * agents editing the same working tree is not parallelism, it is a merge
 * conflict with extra steps. So each lane is a git worktree of its own — a
 * real checkout sharing the repository's history — and the crew staffed to
 * that lane works inside it.
 *
 * ONE WORKTREE PER LANE, ONE BRANCH PER TASK.
 * The worktree is long-lived; the branch is not. Each task that starts in a
 * lane gets a fresh branch cut from the project's branch AS IT IS NOW, so the
 * second task in a lane sees everything the other lanes merged while the first
 * was running. The first version reused one branch per lane forever, which
 * meant the second task started from the first task's world and every later
 * merge was a conflict waiting to happen.
 *
 * WHY THE WORKTREES LIVE OUTSIDE THE REPOSITORY
 * `~/.airoom/lanes/<team>/lane-N` rather than a folder inside the project.
 * Anything inside the project shows up in `git status`, in the user's editor,
 * in their test globs and in their next commit. A lane is airoom's business,
 * not the project's.
 *
 * WHY NOTHING HERE EVER LEAVES THE TREE DIRTY, OR LOSES WORK
 * A merge that hits a conflict is aborted immediately and reported instead.
 * The human's own checkout is the one thing in this system that is genuinely
 * theirs, and a tool that leaves conflict markers in it — while they are not
 * watching — is a tool nobody should run unattended. And before a lane is
 * switched or removed, whatever is loose in it is committed to the branch it
 * belongs to: an unmerged branch is work, and airoom does not delete work.
 */

export interface Lane {
  path: string;
  /** the branch checked out in this worktree right now — the current task's */
  branch: string;
}

/**
 * Where lanes are cut. Read on every call, not once at import: a test sets the
 * override in its own module body, which runs AFTER this module is loaded, so
 * a constant here would have every test writing into the real home directory.
 */
const lanesRoot = () => process.env.AIROOM_LANES_DIR || path.join(os.homedir(), '.airoom', 'lanes');

function git(cwd: string, args: string[], timeout = 20_000): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Is this folder inside a git working tree we can branch from? */
export function isGitRepo(dir: string): boolean {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

/** The repository root, so lanes branch from the top and not from a subfolder.
 *  Git answers with forward slashes on every platform; the path comes back in
 *  the platform's own form, so it compares and joins like every other path. */
export function repoRoot(dir: string): string | null {
  try {
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    return top ? path.resolve(top) : null;
  } catch {
    return null;
  }
}

/** The branch the project is on right now — what lanes fork from and merge to. */
export function currentBranch(repo: string): string | null {
  try {
    const b = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}

/**
 * Uncommitted work in a folder. `tracked` counts only changes to files git
 * already knows about — a build folder or a scratch file is not a reason to
 * refuse a merge, but an edit to a tracked file is, because the merge commit
 * would sweep in whatever the human had staged.
 */
export function dirtyFiles(dir: string, tracked = false): number {
  try {
    const lines = git(dir, ['status', '--porcelain']).split('\n').filter(Boolean);
    return (tracked ? lines.filter((l) => !l.startsWith('??')) : lines).length;
  } catch {
    return 0;
  }
}

export const isDirty = (dir: string) => dirtyFiles(dir) > 0;

/** A repository with no commits cannot have worktrees at all. */
export function hasCommits(repo: string): boolean {
  try {
    git(repo, ['rev-parse', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a room's git looks like, for the hire form.
 *
 * A team can only have a room of its own where there is something to branch
 * from, and its lanes fork from the last COMMIT — so uncommitted work is
 * invisible to them. Both of those used to be caveats in the form's small
 * print, which is the least effective way to tell anyone anything. With this
 * the form states the actual situation instead: the branch it would fork from,
 * and how many of your files it would not see.
 */
export function gitFacts(dir: string): { repo: boolean; branch: string | null; dirty: number; commits: boolean } {
  if (!isGitRepo(dir)) return { repo: false, branch: null, dirty: 0, commits: false };
  const root = repoRoot(dir) ?? dir;
  return { repo: true, branch: currentBranch(root), dirty: dirtyFiles(root), commits: hasCommits(root) };
}

export function slugify(s: string, fallback = 'task'): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return out || fallback;
}

function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** `airoom/<slug>`, suffixed until it names nothing that already exists. */
function freeBranch(repo: string, slug: string): string | null {
  const want = `airoom/${slugify(slug)}`;
  if (!branchExists(repo, want)) return want;
  for (let n = 2; n < 40; n++) if (!branchExists(repo, `${want}-${n}`)) return `${want}-${n}`;
  return null;
}

/**
 * Cut a lane: a worktree on a fresh branch for its first task, off the branch
 * the project is on. Returns null (never throws) when the repository will not
 * have it — the caller falls back to running the task in the project folder.
 */
export function openLane(repo: string, teamId: string, laneSlug: string, taskSlug: string, base: string): Lane | null {
  if (!hasCommits(repo)) return null;
  const root = path.join(lanesRoot(), teamId.replace(/[^a-zA-Z0-9_-]/g, ''), laneSlug);
  // A leftover folder from a crash must not be reused as if it were ours.
  let dir = root;
  for (let n = 2; n < 40 && existsSync(dir); n++) dir = `${root}-${n}`;
  if (existsSync(dir)) return null;
  const branch = freeBranch(repo, taskSlug);
  if (!branch) return null;
  try {
    git(repo, ['worktree', 'add', '-b', branch, dir, base], 60_000);
    return { path: dir, branch };
  } catch {
    return null;
  }
}

/**
 * Point a lane at its next task: whatever is loose is committed to the branch
 * it was done on, then a fresh branch is cut from the project's branch as it
 * stands NOW — so the crew starts from a checkout that includes everything the
 * other lanes merged in the meantime. The branch it leaves behind is deleted
 * only if fully merged; `-d` refuses otherwise, which is the point.
 */
export function startBranch(lane: Lane, repo: string, base: string, taskSlug: string): { ok: boolean; branch?: string; error?: string } {
  const kept = commitLane(lane, `airoom: work left on ${lane.branch}`);
  if (!kept.ok) return { ok: false, error: kept.error };
  const branch = freeBranch(repo, taskSlug);
  if (!branch) return { ok: false, error: `could not find a free branch name for ${taskSlug}` };
  const previous = lane.branch;
  try {
    git(lane.path, ['checkout', '-q', '-b', branch, base]);
  } catch (err) {
    return { ok: false, error: msg(err) };
  }
  try {
    git(repo, ['branch', '-d', previous]);
  } catch {
    /* unmerged — it stays, as it should */
  }
  return { ok: true, branch };
}

/** Anything the branch has that the project does not: commits, or dirt in the lane. */
export function laneHasWork(lane: Lane, repo: string, base?: string): boolean {
  try {
    if (dirtyFiles(lane.path) > 0) return true;
    return branchHasWork(repo, lane.branch, base);
  } catch {
    return false;
  }
}

export function branchHasWork(repo: string, branch: string, base?: string): boolean {
  try {
    if (!branchExists(repo, branch)) return false;
    return git(repo, ['rev-list', '--count', `${base ?? currentBranch(repo) ?? 'HEAD'}..${branch}`]) !== '0';
  } catch {
    return false;
  }
}

/** Commit whatever is loose in a lane, so it can be merged or left safely.
 *  Agents are told to commit; plenty of briefs tell them not to, and their work
 *  must not be lost because of a wording clash between two instructions the
 *  human wrote. */
export function commitLane(lane: Lane, message: string): { ok: boolean; committed: boolean; error?: string } {
  try {
    if (!git(lane.path, ['status', '--porcelain'])) return { ok: true, committed: false };
    git(lane.path, ['add', '-A']);
    git(lane.path, ['commit', '-q', '-m', message, '--no-verify'], 60_000);
    return { ok: true, committed: true };
  } catch (err) {
    return { ok: false, committed: false, error: msg(err) };
  }
}

export interface MergeResult {
  ok: boolean;
  /** nothing to merge — the branch never changed anything */
  empty?: boolean;
  conflicts?: string[];
  error?: string;
}

/**
 * Bring a task's branch home, onto the branch the team was hired on.
 *
 * Refuses if the project has since moved to a different branch (the work
 * belongs on the one it forked from, not wherever the human happens to be
 * this afternoon), refuses over edits to tracked files (the merge commit
 * would sweep in whatever was staged), and aborts cleanly on conflict, naming
 * the files. The team parks on that; resolving a merge is a human's job by
 * definition.
 */
export function mergeBranch(repo: string, branch: string, title: string, base: string): MergeResult {
  try {
    const on = currentBranch(repo);
    if (on !== base)
      return {
        ok: false,
        error: `the project is on ${on ?? 'a detached commit'} now, not ${base} — switch back to ${base} to merge`,
      };
    if (!branchExists(repo, branch)) return { ok: false, error: `branch ${branch} no longer exists` };
    // Emptiness BEFORE dirtiness: a branch with nothing on it cannot touch the
    // human's files, so their half-finished edits are no reason to refuse it.
    // The other way round left a team stuck "blocked" on a lane that had done
    // nothing, until the human committed twenty unrelated files to free it.
    if (git(repo, ['rev-list', '--count', `${base}..${branch}`]) === '0') return { ok: true, empty: true };
    if (dirtyFiles(repo, true) > 0)
      return {
        ok: false,
        error: 'the project folder has uncommitted changes to tracked files — commit or stash them, then merge again',
      };
    try {
      git(repo, ['merge', '--no-commit', '--no-ff', branch], 60_000);
    } catch (err) {
      const conflicts = git(repo, ['diff', '--name-only', '--diff-filter=U'])
        .split('\n')
        .filter(Boolean);
      try {
        git(repo, ['merge', '--abort']);
      } catch {
        /* nothing to abort — the merge failed before it started */
      }
      if (!conflicts.length) return { ok: false, error: msg(err) };
      return { ok: false, conflicts };
    }
    git(repo, ['commit', '-q', '-m', `airoom: ${title}`, '--no-verify'], 60_000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: msg(err) };
  }
}

/** Take a lane down. Loose work is committed first so the folder can go
 *  without taking anything with it; the branch survives unless fully merged. */
export function closeLane(repo: string, lane: Lane) {
  commitLane(lane, `airoom: work left on ${lane.branch}`);
  try {
    git(repo, ['worktree', 'remove', '--force', lane.path], 60_000);
  } catch {
    /* already gone, or busy — `worktree prune` will catch it later */
  }
  try {
    git(repo, ['worktree', 'prune']);
  } catch {
    /* best effort */
  }
  try {
    git(repo, ['branch', '-d', lane.branch]);
  } catch {
    /* -d refuses unmerged branches, which is exactly what we want */
  }
}

function msg(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const s = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString();
  return (s || e.message || String(err)).trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
}

/** A folder git does not version: nothing to fingerprint, and nothing to merge. */
export const NO_VCS = 'no-vcs';

/**
 * A fingerprint of a folder's working tree: the git tree hash of everything
 * git would track or sees as new, ignored files excluded.
 *
 * Built by staging the whole worktree into a THROWAWAY index — the real index
 * is never touched, so a person's own `git add` survives — and writing that
 * index out as a tree. Two equal hashes mean the working tree is identical,
 * and only the working tree: committing the same content leaves it unchanged,
 * so the referee's own commit before a merge cannot void a reviewer's
 * approval, while any edit after it will. This is what ties an approval to
 * the changes that are actually merged.
 *
 * Returns NO_VCS for a folder outside git, and null when git is there but
 * could not answer — which the gate treats as "cannot verify", never as "no
 * change". An earlier version returned '' on failure and compared it against
 * itself, so a broken command read as "nothing moved" and every edit made
 * after an approval merged unreviewed.
 */
export function revisionOf(dir: string): string | null {
  if (!isGitRepo(dir)) return NO_VCS;
  const idx = path.join(os.tmpdir(), `airoom-rev-${process.pid}-${randomUUID()}`);
  try {
    const opts: Parameters<typeof execFileSync>[2] & { encoding: 'utf8' } = {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_INDEX_FILE: idx },
    };
    execFileSync('git', ['add', '-A'], opts);
    const tree = execFileSync('git', ['write-tree'], opts).trim();
    return /^[0-9a-f]{40}$/.test(tree) ? tree : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(idx, { force: true });
    } catch {
      /* the temp index is in tmp; a leftover is harmless */
    }
  }
}
