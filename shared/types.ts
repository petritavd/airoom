// airoom shared domain model + wire protocol.
// This file is the ONLY contract between the server and the web client.
// Both import it directly (server via tsx, web via Vite alias `@shared`).

/** Coarse lifecycle state of an agent, used to color/animate its robot. */
export type RobotStatus =
  | 'working' // actively producing output or running a tool
  | 'waiting_input' // finished a turn, waiting for the human — "your move"
  | 'idle' // no activity for a while
  | 'error' // last turn hit a hook error / prevented continuation
  | 'done'; // completed its work without asking anything (green, briefly)

/** One entry in a robot's activity feed (a flattened transcript event). */
/**
 * How much the agent may do without asking. Mirrors Claude Code's own modes so
 * the two apps mean the same thing by the same word.
 *  - ask       : approve every tool (default)
 *  - acceptEdits: file edits go through, everything else still asks
 *  - plan      : research only — the agent must present a plan before doing
 *  - bypass    : run unattended
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'asks first', hint: 'Approve every tool before it runs.' },
  { value: 'acceptEdits', label: 'auto-edits', hint: 'File edits go through; everything else still asks.' },
  { value: 'plan', label: 'plan only', hint: 'Research and propose — no changes until you approve the plan.' },
  { value: 'bypassPermissions', label: 'unattended', hint: 'Runs every tool without asking. Use with care.' },
];

export interface Step {
  /** Stable identity for this step, from the transcript record's own uuid.
   *  The client keys React off this: the server returns a SLIDING WINDOW of
   *  the last N steps, so anything positional changes on every refresh and
   *  would remount the whole thread (losing expanded blocks and selection). */
  id: string;
  ts: string | null; // ISO timestamp, if the record had one
  kind:
    | 'user'
    | 'assistant_text'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'system'
    /** A conversation-level event worth a quiet divider, not a bubble —
     *  today: "conversation compacted". Never affects robot status. */
    | 'marker';
  label: string; // short one-line summary for the feed
  detail?: string; // optional longer text (tooltip / expanded view)
  /** user steps: attached images (count), shown as a chip — the bytes stay in
   *  the transcript, the chat only says they are there. */
  images?: number;
  /** …and the original dimensions when Claude Code recorded them. */
  imageDims?: string;
  /** Where each attached image's bytes live: fetch via
   *  GET /session-image?session=<id>&ref=<recordUuid>:<blockIndex>. */
  imageRefs?: { id: string; media: string }[];
  /** tool_use steps: the SDK's block id — the identity live/transcript
   *  reconciliation matches on (text matching can never be reliable). */
  toolUseId?: string;
  /** tool_use steps: the tool's name and untruncated target, so the client
   *  can render and shorten it however it likes. */
  tool?: { name: string; target: string };
  /** tool_result steps: the tool reported a failure, so the client opens its
   *  output instead of leaving it folded away. */
  isError?: boolean;
  /** true when the parser had to cut this text at its size cap */
  truncated?: boolean;
}

/** A single Claude session = one robot in a room. */
export interface Robot {
  sessionId: string;
  roomId: string; // === cwd; groups robots into rooms
  title: string; // human label (customTitle > aiTitle > first prompt)
  status: RobotStatus;
  needsApproval?: boolean; // a live airoom run is blocked on a permission request
  currentAction: string; // e.g. "Running Bash: npm test", "Thinking…"
  pendingTool?: string; // tool name if a tool_use has no result yet
  gitBranch?: string;
  version?: string;
  lastActivity: string | null; // ISO of most recent record
  messageCount: number;
  recentSteps: Step[]; // last few steps, for at-a-glance + panel preview
  /** Set when this robot is a team member — drives the rug zone, the role
   *  badge, and the handoff walk in the renderer. */
  team?: { id: string; role: TeamRole };
  /** Skill names this agent was hired with — drives the desk badge and the
   *  panel's loadout row. Absent for ordinary hires. */
  skills?: string[];
  /** The user's name for this agent. Absent = the client's deterministic
   *  default (a callsign hashed off the session id). */
  name?: string;
  /** Set when this session is a playbook run — drives the desk card, the
   *  panel's chip and the "remember for future runs" control. */
  playbook?: { id: string; runId: string; name: string };
}

/** A project = a room. Identified by the working directory. */
export interface Room {
  id: string; // === cwd
  name: string; // basename of cwd
  path: string; // full cwd
  robotCount: number;
  needsAttention: boolean; // any robot waiting_input or error
  /**
   * This room is not a project — it is a team's lane, a git worktree the lead
   * made to keep one task's edits off everyone else's. The office draws it
   * docked to the project it branched from rather than as a room of its own,
   * because that is what it is.
   */
  lane?: { teamId: string; homeRoomId: string; lane: number; task: string; branch: string; teamName?: string };
  /**
   * A team big enough to warrant its own space works in an annex off the
   * project room, joined by a door. Set on the PROJECT room's satellite.
   */
  teamRoom?: { teamId: string; homeRoomId: string };
}

/** An agent the user let go: no desk, no robot, but still on disk and
 *  restorable. Carries enough to be recognised in a list — a bare session id
 *  is not something anyone can say yes or no to. */
export interface AwayAgent {
  sessionId: string;
  roomId: string;
  title: string;
  lastActivity: string | null;
  messageCount: number;
}

export interface FleetSnapshot {
  rooms: Room[];
  robots: Robot[];
  /** Live teams (all states — the panel shows finished ones until dismissed). */
  teams: Team[];
  /** Let go by the user — offered back from the room's session list. */
  away: AwayAgent[];
  generatedAt: string; // ISO
  /**
   * Every folder Claude Code has been used in becomes a room. On a fresh
   * install the user is asked once which of those they actually want; this
   * stays false until they have answered (or skipped). An office that was
   * already lived in before the question existed counts as answered.
   */
  curated?: boolean;
  /** Rooms the user has put away — the chooser offers them back. */
  hiddenProjects?: string[];
}

/**
 * Streamed progress while a message is being handled by Claude.
 * `runKey` identifies the run across its whole life: the target sessionId for
 * resumed sends, or `spawn:<roomId>` for brand-new agents (whose sessionId
 * resolves mid-run and is reported in `sessionId`).
 */
export interface RunUpdate {
  runKey: string;
  roomId: string;
  sessionId: string | null; // resolved once the run's init event arrives
  /** 'delta' is a chunk of the reply as it is being written; the 'assistant'
   *  that follows carries the finished text and supersedes the streamed draft. */
  phase: 'started' | 'delta' | 'assistant' | 'tool' | 'permission' | 'result' | 'error';
  text?: string; // assistant text, tool label, permission label, or result text
  isError?: boolean;
  /** result phases: the turn ended because the HUMAN stopped it. Consumers
   *  that react to silence (the team referee's nudges) must not fight a stop. */
  interrupted?: boolean;
  cost?: number; // USD, on the final result
  /** How full the model's context window is, reported after a turn. A GUI has
   *  no /context command, so this is the only way to see it coming. */
  context?: { usedTokens: number; maxTokens: number; percent: number };
  /** This 'result' carries ONLY the context meter — the turn already ended and
   *  was reported. Anything that reacts to a turn ending (the team referee's
   *  stall detector) must ignore it, or one silent turn reads as two. */
  meter?: true;
  requestId?: string; // phase 'permission': reply via {type:'permission'}
  /** phases 'tool' and 'permission': identity + untruncated detail, so the
   *  client can reconcile against the transcript and show the real command. */
  toolUseId?: string;
  tool?: {
    name: string;
    target: string;
    cwd?: string;
    /** phase 'permission': the tool's arguments, so the panel can show what it
     *  would actually DO — a diff for Edit, the body for Write. */
    input?: Record<string, unknown>;
    /** the runtime's own rendered prompt + subtitle, when it provides them */
    title?: string;
    description?: string;
  };
  /** phase 'permission': the runtime offered a rule, so "always allow" is
   *  meaningful for this request. */
  canAlways?: boolean;
  /** phase 'permission': when the runtime's way of "stop asking" is to switch
   *  the session mode, this is the mode — so the UI can make that change
   *  visibly, through the same picker the user drives, instead of altering
   *  their permissions behind their back. */
  alwaysMode?: PermissionMode;
}

/** An image attached to a message (base64, as the SDK's content blocks want it). */
export interface ImageAttachment {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** base64, WITHOUT the `data:...;base64,` prefix */
  data: string;
  name?: string;
}

/** Models offered in the composer. Aliases resolve against whatever the user's
 *  installed Claude Code maps them to, which survives model releases better
 *  than pinning ids we'd have to keep updating. */
/**
 * A model the user's own Claude Code offers.
 *
 * Never hardcode this list: it comes from the runtime's `supportedModels()`,
 * so airoom shows exactly the models Claude Code shows, named the way it names
 * them, and picks up new ones without a release.
 */
export interface ModelChoice {
  value: string; // what to pass as `model` ('' = the CLI's own default)
  displayName: string;
  description?: string;
  supportsFastMode?: boolean;
  /** Claude Code lists a handful up front and files the rest under
   *  "More models"; mirror that so the menus match. */
  primary?: boolean;
  /** Local models served by Ollama. Their value is `ollama/<name>`; the
   *  controller swaps in Ollama's Anthropic-compatible endpoint per run. */
  provider?: 'ollama';
  /** How well this model can be expected to drive Claude Code's agentic
   *  loop — graded from tool support, size and context, not vibes. */
  quality?: 'strong' | 'fair' | 'weak' | 'unfit';
  /** One plain sentence saying what to expect, shown wherever it is picked. */
  qualityNote?: string;
  params?: string; // "8.2B"
  contextK?: number;
  /** The window Ollama is actually running it with (from /api/ps), once
   *  known. Its default is 4k — no agent turn fits — so this is what the
   *  composer warns about. */
  runtimeContextK?: number; // native context window, in k tokens
}

/** A slash command the user's Claude Code offers. */
export interface CommandChoice {
  name: string; // without the leading slash
  description: string;
  argumentHint?: string;
}

// ---- Skills (skilled agents) --------------------------------------------------

/**
 * One skill installed on this machine, as offered in the hire form. Skills are
 * SKILL.md packages — the same ones Claude Code itself discovers — from the
 * user's ~/.claude/skills, the room's .claude/skills, or installed plugins.
 */
export interface SkillChoice {
  name: string;
  description: string;
  /** Where it lives: the user's own skills, this room's, an installed plugin,
   *  or the plugin marketplace mirror already on disk (not installed — airoom
   *  loads the SKILL.md directly, so it still works as equipment). */
  source: 'user' | 'project' | 'plugin' | 'marketplace';
  /** Absolute path to the SKILL.md — the id a selection travels by. */
  path: string;
}

/** One skill in a hire's loadout. */
export interface SkillSelection {
  path: string;
  /** Kept alongside the path so a moved skill (plugin updates relocate their
   *  cache dir) can be re-resolved by name instead of silently vanishing. */
  name: string;
  /** pinned: the skill's instructions are loaded into the agent's system
   *  prompt and hold for every turn. Not pinned ("granted"): the agent is told
   *  the skill exists and where it lives, and reads it when relevant. */
  pin: boolean;
}

/**
 * A skilled agent's loadout, chosen at the ghost desk. The server persists it
 * per session and re-applies it on every turn, so a loadout is standing
 * equipment — not something that evaporates when the run's keepalive does.
 */
export interface AgentSkills {
  skills: SkillSelection[];
  /** A specialist declines work its skills don't cover, instead of quietly
   *  becoming one more generalist with extra reading. */
  specialist?: boolean;
}

/** Shown until the runtime tells us better (before the first agent runs). */
export const FALLBACK_MODELS: ModelChoice[] = [
  { value: '', displayName: 'Default', description: "Whatever your Claude Code is set to", primary: true },
];

// ---- Wire protocol (versioned so we can evolve it without breaking clients) ----

export const PROTOCOL_VERSION = 1 as const;

export type ServerMessage =
  | { v: 1; type: 'snapshot'; snapshot: FleetSnapshot }
  | {
      v: 1;
      type: 'transcript';
      sessionId: string;
      steps: Step[];
      /** true when older steps exist before this window — the chat shows a
       *  "load older" affordance and asks for a bigger window */
      hasMore: boolean;
    }
  | { v: 1; type: 'run'; update: RunUpdate }
  // Transient feedback for fleet-management actions (add project, etc.)
  | { v: 1; type: 'notice'; text: string; isError?: boolean }
  // The models this machine's Claude Code offers (from `supportedModels()`).
  | { v: 1; type: 'models'; models: ModelChoice[] }
  // The slash commands this machine's Claude Code offers.
  | { v: 1; type: 'commands'; commands: CommandChoice[] }
  // The skills available to agents hired in this room (answer to 'listSkills').
  | { v: 1; type: 'skills'; roomId: string; skills: SkillChoice[] }
  // A team handoff just happened — the room animates it, the panel appends it.
  | { v: 1; type: 'handoff'; handoff: Handoff }
  // Full handoff log for one team (answer to 'subscribeTeam').
  | { v: 1; type: 'teamLog'; teamId: string; handoffs: Handoff[] }
  // Answer to a 'rewind': what would change (dryRun) or what did.
  | {
      v: 1;
      type: 'rewound';
      userMessageId: string;
      dryRun: boolean;
      canRewind: boolean;
      error?: string;
      filesChanged?: string[];
      insertions?: number;
      deletions?: number;
    }
  // Every saved playbook, sent on connect and whenever one changes.
  | { v: 1; type: 'playbooks'; playbooks: Playbook[] }
  // One room's connectors (answer to 'listConnectors', and pushed whenever a
  // live run in that room reports fresher status).
  | { v: 1; type: 'connectors'; room: RoomConnectors }
  // Answer to 'playbookDraft': what airoom read out of the session, unsaved.
  | { v: 1; type: 'playbookDraft'; sessionId: string; draft?: Playbook; error?: string };

export type ClientMessage =
  // Request a transcript window: the most recent `limit` steps of a session.
  // Scrolling to the top re-subscribes with a larger limit.
  | { v: 1; type: 'subscribe'; sessionId: string; limit?: number }
  | { v: 1; type: 'unsubscribe'; sessionId: string }
  // Send a message. Resumes `sessionId` if given, else starts a fresh session
  // in the room's cwd. If a run is already live for that session, the text is
  // QUEUED into it (steering) instead of rejected. `bypass` skips approvals.
  | {
      v: 1;
      type: 'send';
      roomId: string;
      sessionId?: string;
      text: string;
      /** How much this turn may do unattended. Replaces the old boolean
       *  bypass, which could only say "ask everything" or "ask nothing". */
      mode?: PermissionMode;
      /** Model for this turn: a Claude Code alias ('opus' | 'sonnet' | 'haiku')
       *  or a full model id. Omitted = whatever the user's CLI defaults to. */
      model?: string;
      /** Fast mode for this turn (only meaningful on models that support it). */
      fast?: boolean;
      /** Stop this agent once it has spent this many dollars in one turn.
       *  A rail for unattended work, where nothing else stands between a loop
       *  and the bill. Omitted = no cap. */
      budgetUsd?: number;
      /** Images pasted or dropped into the composer, sent alongside the text. */
      images?: ImageAttachment[];
      /** Skill loadout for a fresh hire. The server persists it against the
       *  session that spawns and re-applies it every turn thereafter; sent with
       *  a sessionId it updates that agent's stored loadout. */
      skills?: AgentSkills;
      /** Name for a fresh hire — pinned to the session the moment it exists,
       *  so the robot walks in already answering to it. Ignored on resumes
       *  (renames go through 'nameAgent'). */
      agentName?: string;
    }
  // What skills could an agent hired in this room carry? (answered: 'skills')
  | { v: 1; type: 'listSkills'; roomId: string }
  /**
   * Write a new skill at hire time: a SKILL.md under ~/.claude/skills, so it
   * is real Claude Code equipment every future hire (and Claude Code itself)
   * can use — not an airoom-only note. Answered with a notice and, on
   * success, a refreshed 'skills' list for the room.
   */
  | { v: 1; type: 'createSkill'; roomId: string; name: string; description?: string; body: string }
  // Stop the run identified by its runKey (sessionId or `spawn:<roomId>`).
  | { v: 1; type: 'interrupt'; runKey: string }
  // Answer a pending permission request (phase 'permission' RunUpdate).
  | {
      v: 1;
      type: 'permission';
      requestId: string;
      allow: boolean;
      /** Allow AND stop asking for this kind of call — the runtime's own
       *  suggested rule is applied, same as Claude Code's "don't ask again". */
      always?: boolean;
    }
  // Change a live run's permission mode without interrupting its turn.
  | { v: 1; type: 'setMode'; runKey: string; mode: PermissionMode }
  // Fast mode: same trade Claude Code offers — Opus, faster output.
  | { v: 1; type: 'setFastMode'; runKey: string; fast: boolean }
  /** Launch Ollama (the app if present, else `ollama serve`) so a local
   *  model can be picked without leaving airoom. */
  | { v: 1; type: 'startOllama' }
  /** A local model was picked: load it now so the first reply is not also a
   *  model load, and learn its runtime window. */
  | { v: 1; type: 'warmLocal'; model: string }
  /**
   * Put the files back the way they were at a given user message.
   * ALWAYS asked with dryRun first: this rewrites the user's working tree, so
   * they see exactly what would change before anything is touched.
   */
  | {
      v: 1;
      type: 'rewind';
      runKey: string;
      userMessageId: string;
      dryRun: boolean;
      // Where to look when the session is no longer running: its folder and id.
      roomId?: string;
      sessionId?: string;
    }
  /**
   * Hire a team: spawns the lead session, which then staffs the rest through
   * its orchestration tools. Autonomy and cap are fixed at hire time and
   * enforced server-side; `mode`/`model` apply to every member's runs.
   */
  | {
      v: 1;
      type: 'hireTeam';
      roomId: string;
      task: string;
      autonomy: TeamAutonomy;
      roundCap?: number; // default 2
      mode?: PermissionMode;
      model?: string;
      /** optional per-member standing instructions */
      roleNotes?: RoleNotes;
      /** optional per-member overrides; anyone not named runs on mode/model */
      roleModes?: Partial<Record<TeamRole, PermissionMode>>;
      roleModels?: Partial<Record<TeamRole, string>>;
      /** The roster to hire, lead first. Omitted = the standard trio, so an
       *  old client (and every existing default) keeps working unchanged. */
      roster?: RosterMember[];
      /** How many tasks this team may run at once, each in its own worktree. */
      lanes?: number;
      /** Give the team an annex of its own rather than a bench on the floor. */
      ownRoom?: boolean;
      /** Token saver — see Team.thrift. */
      thrift?: boolean;
    }
  /**
   * Put a task on a team's board. Works whether the team is idle or already
   * busy: a working team picks it up as soon as a lane frees, so you can hand
   * a lead three jobs in a row and walk away.
   */
  | { v: 1; type: 'teamTask'; teamId: string; task: string }
  /** Take a task off the board. A live lane is stopped and its branch left. */
  | { v: 1; type: 'teamCancelTask'; teamId: string; taskId: string }
  /** Merge a finished lane's branch into the project yourself. */
  | { v: 1; type: 'teamMergeTask'; teamId: string; taskId: string }
  /** Close a task without an approval on record — the one override the review gate accepts. */
  | { v: 1; type: 'teamCloseTask'; teamId: string; taskId: string }
  // Release a parked handoff (gated autonomy, or a cap that was hit).
  | { v: 1; type: 'teamContinue'; teamId: string }
  // Stop the whole team: interrupts every member's live run.
  | { v: 1; type: 'teamStop'; teamId: string }
  // Remove a finished/stopped team from the office (its sessions remain).
  | { v: 1; type: 'teamDismiss'; teamId: string }
  // Ask for a team's full handoff log (answered with 'teamLog').
  | { v: 1; type: 'subscribeTeam'; teamId: string }
  /** Name an agent (empty name clears the override → back to the default). */
  | { v: 1; type: 'nameAgent'; sessionId: string; name: string }
  /** Name a team (empty clears it — it goes back to being called by its job). */
  | { v: 1; type: 'nameTeam'; teamId: string; name: string }
  /**
   * Let an agent go (or bring it back). The transcript is untouched: this only
   * frees the desk, so it is always reversible.
   */
  | { v: 1; type: 'hideAgent'; sessionId: string; hidden: boolean }
  /** Delete a conversation. The server moves it somewhere recoverable. */
  | { v: 1; type: 'deleteAgent'; sessionId: string }
  // Hide a room from the office (and put it back).
  | { v: 1; type: 'hideProject'; path: string }
  | { v: 1; type: 'unhideProject'; path: string }
  /** The first-run choice, or a later revisit of it: exactly these paths are
   *  put away, everything else found on disk shows — and the question counts
   *  as answered from here on. */
  | { v: 1; type: 'curateProjects'; hidden: string[] }
  // Register a project directory as a room (even before it has any sessions).
  | { v: 1; type: 'addProject'; path: string }
  /**
   * "Make this a playbook": read a finished session and propose the reusable
   * process in it. Answered with 'playbookDraft'. Nothing is saved until the
   * client sends the (edited) draft back with 'playbookSave'.
   */
  | { v: 1; type: 'playbookDraft'; sessionId: string; roomId: string }
  /** Save a playbook — a new one (no id) or an edit of an existing one. */
  | { v: 1; type: 'playbookSave'; playbook: Playbook }
  | { v: 1; type: 'playbookDelete'; id: string }
  /** Run a playbook with fresh inputs: a new session in its room, the card as
   *  standing instructions, the allowlist in force. */
  | { v: 1; type: 'playbookRun'; id: string; inputs: Record<string, string>; mode?: PermissionMode; model?: string }
  /** "Remember for future runs": a correction becomes a visible rule. */
  | { v: 1; type: 'playbookRule'; id: string; text: string; runId?: string }
  | { v: 1; type: 'playbookDropRule'; id: string; ruleId: string }
  /** Stop a run's session; the run is marked stopped. */
  | { v: 1; type: 'playbookStop'; id: string; runId: string }
  /** What connectors (MCP servers) agents in this room have, and their health.
   *  Cached; `refresh` asks the runtime again. Answered with 'connectors'. */
  | { v: 1; type: 'listConnectors'; roomId: string; refresh?: boolean }
  /**
   * Turn a connector on or off for this room. For a project connector this is
   * Claude Code's own enable/disable for the project. For a shared one it puts
   * the socket on this room's wall (and makes sure Claude Code loads it here).
   */
  | { v: 1; type: 'setConnectorEnabled'; roomId: string; name: string; enabled: boolean }
  /** Shared connectors only: stop (or resume) Claude Code loading it for runs
   *  in this project — written to the same per-project list `/mcp` uses. */
  | { v: 1; type: 'setConnectorLoaded'; roomId: string; name: string; loaded: boolean }
  /** Add a connector to this project's .mcp.json (and approve it for the room). */
  | {
      v: 1;
      type: 'addConnector';
      roomId: string;
      name: string;
      transport: 'stdio' | 'http' | 'sse';
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
      headers?: Record<string, string>;
    }
  /** Remove a connector from this project's .mcp.json. */
  | { v: 1; type: 'removeConnector'; roomId: string; name: string };

// ---- Connectors (MCP servers, as the office sees them) ------------------------

export interface ConnectorTool {
  name: string;
  description?: string;
  readOnly?: boolean;
  destructive?: boolean;
}

/**
 * One MCP server as an agent in a room would see it. airoom adds nothing to
 * how Claude Code configures these — user, project, local and claude.ai
 * scopes all load on every run already — it only shows them, and writes the
 * per-project on/off choice where Claude Code keeps its own.
 */
export interface Connector {
  name: string;
  scope: 'user' | 'project' | 'local' | 'claudeai' | 'managed' | 'plugin' | 'unknown';
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  transport: 'stdio' | 'http' | 'sse' | 'claudeai' | 'unknown';
  /** The command or the url — what the sheet shows under the name. */
  target?: string;
  error?: string;
  tools: ConnectorTool[];
  version?: string;
  /**
   * Turned on for this room — the socket is on the wall. A project connector
   * is on when Claude Code has it enabled for the project; a shared one
   * (user-wide, claude.ai) is on only when the person turned it on for this
   * room in its settings. Nothing is on a wall without being asked.
   */
  onWall: boolean;
  /** Claude Code loads it for runs in this room (false = disabled here). */
  loaded: boolean;
}

export interface RoomConnectors {
  roomId: string;
  connectors: Connector[];
  checkedAt: string | null; // ISO; null until the runtime has answered once
  checking: boolean;
  error?: string;
}

// ---- Playbooks (a task that worked once, written down) -----------------------

/**
 * A playbook is a finished session turned into a process you can run again
 * without explaining or supervising it from scratch.
 *
 * Three design rules:
 *  - It is EXTRACTED, not authored: airoom reads the session — the brief, the
 *    corrections, what ran, what was checked — and proposes the card. The
 *    human edits and approves it. Nothing is saved behind their back.
 *  - The approvals travel with it. Commands the human allowed in the original
 *    session become the run's allowlist (as Claude Code permission rules), so
 *    the second run does not walk to the door for what the first one already
 *    got a yes to. Anything outside the list still asks.
 *  - Every correction during a run is either for that run or a new rule on the
 *    card, chosen by the human. The card is the whole process; there is no
 *    hidden state that changes it.
 */
export interface PlaybookInput {
  /** Identifier the card refers to, e.g. "ticket". Letters, digits, dashes. */
  key: string;
  /** What to ask for, e.g. "Ticket number". */
  label: string;
  /** What it was the first time — shown as a placeholder, never reused. */
  example?: string;
}

export interface PlaybookRule {
  id: string;
  text: string;
  /** Learned from the original session, or added during a later run. */
  from: 'session' | 'run';
  runId?: string;
  at: string; // ISO
}

export interface PlaybookStep {
  text: string;
  /** A review point: the run stops here and waits for the human before going on. */
  pause?: boolean;
}

export interface PlaybookRun {
  id: string;
  sessionId: string | null; // resolves once the run's session exists
  startedAt: string;
  endedAt?: string;
  /** waiting = the agent stopped at a review point or with a question. */
  state: 'working' | 'waiting' | 'done' | 'error' | 'stopped';
  inputs: Record<string, string>;
  /** Messages the human had to send after the kickoff — the supervision cost. */
  messages: number;
  /** Approval cards this run raised — the other half of it. */
  approvals: number;
  /** Corrections the human chose to keep as rules during this run. */
  rulesAdded: number;
  /** The agent's closing words, once done. */
  summary?: string;
  costUsd: number;
}

export interface Playbook {
  id: string;
  roomId: string; // the project it belongs to — playbooks live in rooms
  name: string;
  /** The outcome, in one or two sentences. */
  goal: string;
  /** What changes each run. */
  inputs: PlaybookInput[];
  /** Standing instructions and preferences, in force on every run. */
  rules: PlaybookRule[];
  /** The process that worked, with any review points marked. */
  steps: PlaybookStep[];
  /** What proves the result is acceptable. */
  checks: string[];
  /** What the run should hand back at the end. */
  output: string;
  /** Claude Code permission rules — "Bash(npm test:*)", "Edit" — that never
   *  raise a card on a run. Derived from what ran in the original session. */
  allow: string[];
  mode?: PermissionMode;
  model?: string;
  skills?: AgentSkills;
  /** Where it came from, and what that first run cost in attention: the
   *  numbers every later run is measured against. */
  source: { sessionId: string; messages: number; approvals: number; corrections: number };
  createdAt: string;
  updatedAt: string;
  /** Newest last. Kept to a handful. */
  runs: PlaybookRun[];
}

/** How many runs a playbook remembers. */
export const MAX_PLAYBOOK_RUNS = 20;

// ---- Teams (multi-agent orchestration) ---------------------------------------

/**
 * A team is a small roster of ordinary sessions working one task together:
 * a lead that orchestrates, a builder that edits files, a reviewer that reads.
 *
 * Two design rules the whole feature hangs on:
 *  - Members ARE normal sessions/robots. Chat, permissions, deny, resume and
 *    rewind all keep working; the team layer only routes messages between them.
 *  - The LEAD orchestrates but the SERVER referees. Round caps and autonomy
 *    gates are enforced in code, never by trusting an LLM to remember its
 *    instructions — this runs on the customer's own Claude subscription, and a
 *    runaway review loop would burn their weekly usage.
 */
export type TeamRole = string;

/**
 * What a member is FOR — the only thing the referee needs to know about it.
 *
 *  - lead    : orchestrates. Exactly one, always. Never edits.
 *  - worker  : does the work. `writes` decides whether it may touch files;
 *              a worker that cannot is a researcher, and any number of those
 *              can run at once because none of them can collide.
 *  - reviewer: judges one change. Never edits, ever — the write tools are
 *              physically absent from its runs.
 *
 * Everything else about a member (what it is called, what it is told, which
 * model it runs) is roster decoration. Policy hangs off the kind.
 */
export type MemberKind = 'lead' | 'worker' | 'reviewer';

/** A member as it is described in the hire form, before it exists. */
export interface RosterMember {
  kind: MemberKind;
  /** What the lead calls it: "builder", "frontend", "security reviewer". */
  label: string;
  /** workers only — a worker with this off can read and run, never edit. */
  writes?: boolean;
  /** standing instructions, in force for every task this team takes on */
  note?: string;
  mode?: PermissionMode;
  model?: string;
}

/**
 * A roster you can hire in one click.
 *
 * Shipped presets are starting points, not a menu of supported shapes: every
 * one of them is editable in the form before you hire, and what you end up
 * with can be saved as your own.
 */
export interface TeamPreset {
  id: string;
  name: string;
  hint: string;
  members: RosterMember[]; // the lead first, then the rest in bench order
  /** how many tasks this shape can sensibly run at once */
  lanes?: number;
}

/** Ships with airoom. A saved roster is the same shape with a user id. */
export const TEAM_PRESETS: TeamPreset[] = [
  {
    id: 'standard',
    name: 'Standard',
    hint: 'A builder and a reviewer. The one to reach for when in doubt.',
    members: [
      { kind: 'lead', label: 'Lead' },
      { kind: 'worker', label: 'Builder', writes: true },
      { kind: 'reviewer', label: 'Reviewer' },
    ],
    lanes: 1,
  },
  {
    id: 'full-stack',
    name: 'Full stack',
    hint: 'Two builders and a reviewer — front and back move in parallel lanes.',
    members: [
      { kind: 'lead', label: 'Lead' },
      { kind: 'worker', label: 'Backend', writes: true },
      { kind: 'worker', label: 'Frontend', writes: true },
      { kind: 'reviewer', label: 'Reviewer' },
    ],
    lanes: 2,
  },
  {
    id: 'research',
    name: 'Research',
    hint: 'Three readers that never edit. They fan out at once and report back.',
    members: [
      { kind: 'lead', label: 'Lead' },
      { kind: 'worker', label: 'Scout', writes: false },
      { kind: 'worker', label: 'Scout 2', writes: false },
      { kind: 'reviewer', label: 'Editor' },
    ],
    lanes: 1,
  },
  {
    id: 'hardening',
    name: 'Hardening',
    hint: 'A builder, a test writer, and a reviewer who reads for security.',
    members: [
      { kind: 'lead', label: 'Lead' },
      { kind: 'worker', label: 'Builder', writes: true },
      { kind: 'worker', label: 'Tests', writes: true },
      { kind: 'reviewer', label: 'Security', note: 'Read for injection, authorisation and data exposure before style.' },
    ],
    lanes: 1,
  },
];

/** Lead plus five. Past that the lead spends its turns on bookkeeping. */
export const MAX_TEAM_MEMBERS = 6;
export const MAX_TEAM_LANES = 4;

/**
 * Who moves the work forward when a stage completes.
 *  - gated       : every handoff parks until the human clicks Continue
 *  - auto_capped : stages flow on their own, but at most `roundCap` fix
 *                  rounds — then the team stops and asks
 *  - auto        : flows until the reviewer approves (Stop always works)
 */
export type TeamAutonomy = 'gated' | 'auto_capped' | 'auto';

export const TEAM_AUTONOMY_CHOICES: { value: TeamAutonomy; label: string; hint: string }[] = [
  { value: 'auto_capped', label: 'auto, capped', hint: 'Runs by itself, but stops to ask after the fix-round cap.' },
  { value: 'gated', label: 'step by step', hint: 'Every handoff waits for your go-ahead.' },
  { value: 'auto', label: 'until approved', hint: 'Loops until the reviewer approves. Watch the cost meter.' },
];

/** One message routed between team members (or parked for the human). */
export interface Handoff {
  id: string;
  teamId: string;
  ts: string; // ISO
  from: TeamRole | 'human' | 'server';
  to: TeamRole | 'human';
  kind: 'assign' | 'result' | 'verdict' | 'question' | 'finish' | 'note';
  summary: string; // one line, shown in the room and the timeline
  detail?: string; // the full routed text, expandable in the panel
  verdict?: 'approve' | 'request_changes';
}

/**
 * Standing instructions for one member, given at hire time.
 *
 * These describe HOW that member should work — "prefer the existing helpers",
 * "be strict about test coverage" — not what the current job is. They live in
 * the member's system prompt, so they hold for every turn and survive being
 * given a new task, unlike anything said in a message.
 */
export type RoleNotes = Partial<Record<TeamRole, string>>;

export interface TeamMember {
  /** Identity within the team — 'lead', 'builder', 'frontend'. Handoffs are
   *  addressed to it, and the lead's assign tool offers exactly these. Named
   *  `role` because that is what it was when there were only three of them. */
  role: TeamRole;
  kind: MemberKind;
  /** What it is called on screen and in its own preamble. */
  label: string;
  /** null until the member's first run resolves its session id */
  sessionId: string | null;
  /** workers: may edit files. Never true for a lead or a reviewer. */
  writes?: boolean;
  /** Which lane it is staffed to, once lanes exist. */
  lane?: number;
  /**
   * What this member's runs actually use — the team's choice at hire, or its
   * own override. The member's panel shows these rather than the app defaults:
   * a lead hired as Opus/unattended that read "Default · asks first" in its own
   * chat was not just mislabelled, it sent the human's follow-ups on those
   * wrong settings.
   */
  mode?: PermissionMode;
  model?: string;
}

/**
 * One job on the team's board.
 *
 * Tasks are the unit of everything now: a lane, a branch, a fix-round
 * allowance and a crew all belong to a task, not to the team. You can hand the
 * lead three at once and it works them in parallel, one worktree each.
 */
export interface TeamTask {
  id: string;
  /** Short label for the board — the first line of the brief unless named. */
  title: string;
  brief: string; // the whole thing, verbatim
  state: 'queued' | 'working' | 'blocked' | 'done' | 'merged' | 'cancelled';
  /** Which lane it occupies while active; null while queued or closed. */
  lane: number | null;
  /** Set when the lane is a real git worktree. */
  branch?: string;
  worktree?: string;
  roundsUsed: number;
  /** The member currently holding it, and who owes a report. */
  holder?: TeamRole;
  awaitingFrom?: TeamRole;
  /** Why it is blocked, or what the merge said — one line for the board. */
  note?: string;
  /** The lead's closing words for this task. */
  summary?: string;
  /**
   * The last verdict on this task's changes. `rev` fingerprints the lane's
   * folder as the reviewer saw it; closing compares against it, so an
   * approval covers exactly the changes it was given. `stale` is set when a
   * writer reported after the approval and the folder no longer matches.
   */
  review?: { verdict: 'approve' | 'request_changes'; by: TeamRole; at: string; rev: string; stale?: boolean };
  /** The human closed it from the panel without an approval on record. */
  waived?: { at: string };
  createdAt: string;
  closedAt?: string;
}

export interface Team {
  id: string;
  roomId: string; // the project it works in — teams live inside rooms
  /** What the human calls this team. Absent, it goes by the job in front of
   *  it — which is how every team started out, and why a team's sign used to
   *  read "create an amazing…" for as long as it lived. */
  name?: string;
  task: string; // the newest brief, verbatim — the panel's headline
  autonomy: TeamAutonomy;
  roundCap: number; // max fix rounds under auto_capped
  roundsUsed: number; // fix rounds consumed so far (summed over live tasks)
  state: 'working' | 'awaiting_human' | 'done' | 'stopped' | 'error';
  /** Why the team is parked, when awaiting_human (shown on the panel). */
  parkedReason?: string;
  members: TeamMember[];
  costUsd: number; // summed member run costs, live
  createdAt: string;
  updatedAt: string;
  /** The lead's closing summary once state === 'done'. */
  doneSummary?: string;
  /** How many tasks this team has been given — a standing team, not a one-shot. */
  tasksDone: number;
  /** Per-member standing instructions, set when the team was hired. */
  roleNotes?: RoleNotes;
  /** The board. Always at least one entry — hiring creates the first task. */
  tasks: TeamTask[];
  /** How many tasks may be in flight at once. 1 = the classic single file. */
  lanes: number;
  /** The room is a git repository, so lanes get their own worktrees. When
   *  false every task runs in the project folder itself, one at a time. */
  worktrees: boolean;
  /** This team works in an annex off the project room rather than on the
   *  project floor — chosen at hire, because moving a live team is disorienting. */
  ownRoom?: boolean;
  /**
   * Token saver. A team's bill is mostly the size of its context multiplied by
   * the number of turns it takes, plus what it writes. This tells every member
   * to spend both sparingly: search before reading, read ranges rather than
   * whole files, and report in a few lines rather than a few pages.
   */
  thrift?: boolean;
}

/**
 * What the app knows about the newest airoom build — `GET /release`.
 *
 * The server fetches a small public manifest from airoom.dev (the current
 * version, where to get it and, occasionally, a short announcement) and
 * nothing about this machine travels with that request. `current` is the
 * running version; it is null in dev, where nothing is ever "out of date".
 */
export interface ReleaseInfo {
  current: string | null;
  /** `url` is the Mac build; `windowsUrl` the Windows one, once there is one. */
  latest: { version: string; url: string; notes?: string; windowsUrl?: string } | null;
  /** True when `latest` is newer than `current`. */
  updateAvailable: boolean;
  /** A line from us, if there is one worth a strip at the top of the window. */
  message: { id: string; text: string; url?: string } | null;
  /** When the manifest was last fetched successfully; null until it has been. */
  checkedAt: string | null;
}
