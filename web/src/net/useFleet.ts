import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentSkills,
  ClientMessage,
  CommandChoice,
  ImageAttachment,
  FleetSnapshot,
  Handoff,
  ModelChoice,
  PermissionMode,
  Playbook,
  RoleNotes,
  RoomConnectors,
  RosterMember,
  RunUpdate,
  ServerMessage,
  SkillChoice,
  Step,
  TeamAutonomy,
  TeamRole,
} from '@shared/types';

import { WS_URL } from './base';

type ConnState = 'connecting' | 'open' | 'closed';

/** How many transcript steps to fetch at a time (and to grow by on "load older"). */
const PAGE = 200;
/**
 * Minimum gap between transcript refetches. The file watcher can fire several
 * times a second while an agent works; with a large scrollback each refetch is
 * hundreds of KB and a full re-render, so pace it. Must stay well under the
 * 2.5s live-thread sweep so a refresh always lands before items are dropped.
 */
const REFETCH_MS = 1200;

/** One entry of the live conversation burst (merged into the chat thread). */
export interface ThreadItem {
  kind: 'user' | 'agent' | 'tool' | 'error';
  text: string;
  /** user echoes: how many images rode along (rendered as a chip) */
  images?: number;
  /** …and their pixels, as data URLs — live echoes only; history uses refs. */
  imageSrcs?: string[];
  /** stable across re-renders — React keys must never be array indices here,
   *  or a streaming reply remounts every collapsed code block below it */
  id: string;
  toolUseId?: string;
  tool?: { name: string; target: string };
  /** still being written — the finished message will replace this text */
  streaming?: boolean;
}

/** A live conversation-run, keyed by runKey (sessionId or `spawn:<roomId>`). */
export interface RunState {
  runKey: string;
  roomId: string;
  sessionId: string | null;
  active: boolean; // a turn is generating right now
  thread: ThreadItem[]; // live items not yet visible in the transcript
  pendingPermission: {
    requestId: string;
    label: string;
    tool?: RunUpdate['tool'];
    /** the runtime offered a rule, so "always allow" means something here */
    canAlways?: boolean;
    /** …and if its way of "stop asking" is a mode switch, which mode */
    alwaysMode?: PermissionMode;
  } | null;
  cost?: number;
  context?: { usedTokens: number; maxTokens: number; percent: number };
}

function freshRun(runKey: string, roomId: string, sessionId: string | null): RunState {
  return { runKey, roomId, sessionId, active: false, thread: [], pendingPermission: null };
}

let liveSeq = 0;
const nextId = () => `l${++liveSeq}`;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);
const stepKind = (k: Step['kind']): ThreadItem['kind'] | null =>
  k === 'user' ? 'user' : k === 'assistant_text' ? 'agent' : k === 'tool_use' ? 'tool' : k === 'system' ? 'error' : null; // 'marker' & co: nothing live to reconcile

/**
 * Drop live-thread items that the transcript now contains (greedy, count-aware
 * so repeated identical messages reconcile one-for-one). Runs on every
 * transcript refresh — duplicates never survive longer than one snapshot.
 */
function dedupeThread(steps: Step[], thread: ThreadItem[]): ThreadItem[] {
  const pool = steps.slice(-60).map((s) => ({
    used: false,
    kind: stepKind(s.kind),
    key: norm(s.label),
    toolUseId: s.toolUseId,
  }));
  return thread.filter((item) => {
    // Never reconcile away a reply that is still being written — the transcript
    // has only the part flushed so far.
    if (item.streaming) return true;
    const k = norm(item.text);
    // Tool calls reconcile on IDENTITY. Matching on the label text could never
    // work reliably (producers truncate differently), which is why long
    // commands used to render twice for a whole run.
    if (item.toolUseId) {
      const byId = pool.find((p) => !p.used && p.toolUseId === item.toolUseId);
      if (byId) {
        byId.used = true;
        return false;
      }
    }
    const hit = pool.find(
      (p) =>
        !p.used &&
        p.kind === item.kind &&
        (p.key === k || (k.length >= 12 && (p.key.startsWith(k) || k.startsWith(p.key)))),
    );
    if (hit) {
      hit.used = true;
      return false;
    }
    return true;
  });
}

/**
 * Owns the WebSocket to the airoom server:
 *  - keeps the latest FleetSnapshot
 *  - exposes subscribe(sessionId) → live transcript (refreshed on snapshots)
 *  - tracks live runs by runKey; sends queue into live runs (steering)
 *  - auto-reconnects with backoff
 */
export function useFleet() {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [transcript, setTranscript] = useState<{ sessionId: string; steps: Step[]; hasMore: boolean } | null>(null);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [notice, setNotice] = useState<{ text: string; isError: boolean } | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [commands, setCommands] = useState<CommandChoice[]>([]);
  /** Skills available per room (answers to 'listSkills'), for the hire form. */
  const [skillLists, setSkillLists] = useState<Record<string, SkillChoice[]>>({});
  /** Handoff logs per team: seeded by 'teamLog', grown live by 'handoff'. */
  const [teamLogs, setTeamLogs] = useState<Record<string, Handoff[]>>({});
  /** The newest handoff with a monotonic seq — the render layer's animation
   *  trigger (an effect keyed on seq fires the walk exactly once). */
  const [lastHandoff, setLastHandoff] = useState<{ seq: number; handoff: Handoff } | null>(null);
  const handoffSeqRef = useRef(0);
  /** Every saved playbook, as the server last sent them. */
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  /** "Make this a playbook" in flight or answered, keyed by session. */
  const [playbookDrafts, setPlaybookDrafts] = useState<
    Record<string, { loading: boolean; draft?: Playbook; error?: string }>
  >({});
  /** Each room's connectors, as last reported. */
  const [connectors, setConnectors] = useState<Record<string, RoomConnectors>>({});
  /** The newest connector tool call — the render layer's cable pulse. */
  const [mcpPulse, setMcpPulse] = useState<{ seq: number; sessionId: string; roomId: string; server: string } | null>(null);
  const pulseSeqRef = useRef(0);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const resyncRef = useRef(false); // reconcile run liveness on the next snapshot
  const subRef = useRef<string | null>(null);
  const subStampRef = useRef<string>(''); // last-seen activity of the open session
  const limitRef = useRef(PAGE); // how many steps of history we're currently asking for
  const [loadingMore, setLoadingMore] = useState(false);
  const refetchAtRef = useRef(0); // throttle: last transcript refetch
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wsSend = useCallback((m: ClientMessage): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  }, []);

  const applyRun = useCallback((u: RunUpdate) => {
    setRuns((prev) => {
      const cur = prev[u.runKey] ?? freshRun(u.runKey, u.roomId, u.sessionId);
      const next: RunState = { ...cur, thread: [...cur.thread] };
      if (u.sessionId) next.sessionId = u.sessionId;
      // Only phases that actually RESOLVE a permission may clear the gate.
      // Queueing a follow-up emits 'started', which used to wipe the pending
      // Allow/Deny card and hang the run until the 10-minute auto-deny.
      if (u.phase === 'result' || u.phase === 'error') next.pendingPermission = null;
      // Any non-terminal update is proof the run is alive. 'started' alone used
      // to carry that, which meant a run whose active flag had been lost (a
      // reconnect, a missed 'started') could never get it back.
      if (u.phase !== 'result' && u.phase !== 'error') next.active = true;

      switch (u.phase) {
        case 'started':
          next.active = true;
          break;
        case 'delta': {
          // Grow the draft in place. A new item per chunk would remount the
          // reply on every keystroke of output. Find it by its streaming FLAG,
          // not by "is it last" — steering appends the user's echo mid-stream,
          // which used to orphan the draft and leave a truncated fragment
          // stranded above the real reply.
          if (!u.text) break;
          const at = next.thread.findIndex((t) => t.kind === 'agent' && t.streaming);
          if (at >= 0) next.thread[at] = { ...next.thread[at], text: next.thread[at].text + u.text };
          else next.thread.push({ kind: 'agent', text: u.text, id: nextId(), streaming: true });
          break;
        }
        case 'assistant': {
          if (!u.text?.trim()) break;
          // The finished text supersedes whatever was streamed, so the reply
          // never appears twice and never keeps a half-written tail.
          const at = next.thread.findIndex((t) => t.kind === 'agent' && t.streaming);
          if (at >= 0) next.thread[at] = { ...next.thread[at], text: u.text, streaming: false };
          else next.thread.push({ kind: 'agent', text: u.text, id: nextId() });
          break;
        }
        case 'tool':
          // A connector tool is named mcp__<server>__<tool>: light the cable.
          if (u.tool?.name.startsWith('mcp__') && next.sessionId) {
            const server = u.tool.name.split('__')[1];
            if (server && !server.startsWith('airoom-')) {
              const sessionId = next.sessionId;
              const roomId = u.roomId;
              setTimeout(() => setMcpPulse({ seq: ++pulseSeqRef.current, sessionId, roomId, server }), 0);
            }
          }
          if (u.text?.trim())
            next.thread.push({
              kind: 'tool',
              text: u.text,
              id: nextId(),
              toolUseId: u.toolUseId,
              tool: u.tool,
            });
          break;
        case 'permission':
          if (u.requestId)
            next.pendingPermission = {
              requestId: u.requestId,
              label: u.text ?? 'a tool',
              tool: u.tool,
              canAlways: u.canAlways,
              alwaysMode: u.alwaysMode,
            };
          break;
        case 'error':
          next.active = false;
          if (u.text?.trim()) next.thread.push({ kind: 'error', text: u.text, id: nextId() });
          break;
        case 'result':
          next.active = false;
          // A context report is a late follow-up to a finished turn and carries
          // no cost of its own — don't let it blank the spend figure.
          if (u.cost != null) next.cost = u.cost;
          if (u.context) next.context = u.context;
          break;
      }
      return { ...prev, [u.runKey]: next };
    });
  }, []);

  const connect = useCallback(() => {
    setConn('connecting');
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      retryRef.current = 0;
      setConn('open');
      // A run's terminal result may have been broadcast while we were away, and
      // nothing else ever clears `active` — those entries would stay "running"
      // forever: a composer stuck on "queue", a stop button wired to a run the
      // server has forgotten, and (the real damage) a stuck spawn-keyed run
      // makes the next message omit its sessionId, silently hiring a SECOND
      // agent instead of resuming the one on screen. Reconcile against the next
      // snapshot rather than blanking optimistically — clearing a run that IS
      // still alive would cause exactly the double-hire we're avoiding.
      resyncRef.current = true;
      if (subRef.current)
        wsSend({ v: 1, type: 'subscribe', sessionId: subRef.current, limit: limitRef.current });
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'snapshot') {
        setSnapshot(msg.snapshot);
        // One-shot after a reconnect: the server marks every robot it is
        // actively driving, so that is the authority on which of our runs are
        // still in flight.
        if (resyncRef.current) {
          resyncRef.current = false;
          const live = new Set(
            msg.snapshot.robots
              .filter((r) => r.needsApproval || r.currentAction.includes('airoom run'))
              .map((r) => r.sessionId),
          );
          setRuns((prev) => {
            let changed = false;
            const next: typeof prev = {};
            for (const [key, run] of Object.entries(prev)) {
              // A run with no session id yet is mid-hire and unmatchable —
              // leave it alone rather than guess.
              const active = run.sessionId ? live.has(run.sessionId) : run.active;
              if (active !== run.active) {
                changed = true;
                next[key] = { ...run, active };
              } else next[key] = run;
            }
            return changed ? next : prev;
          });
        }
        // Keep the open panel's transcript fresh — but only when that session
        // actually moved. The transcript is large; re-requesting it on every
        // snapshot would flood the socket while an agent is working.
        if (subRef.current) {
          const bot = msg.snapshot.robots.find((r) => r.sessionId === subRef.current);
          const stamp = `${bot?.lastActivity ?? ''}|${bot?.messageCount ?? 0}|${limitRef.current}`;
          if (stamp !== subStampRef.current) {
            subStampRef.current = stamp;
            const fire = () => {
              refetchAtRef.current = Date.now();
              refetchTimerRef.current = null;
              if (subRef.current)
                wsSend({ v: 1, type: 'subscribe', sessionId: subRef.current, limit: limitRef.current });
            };
            const since = Date.now() - refetchAtRef.current;
            if (since >= REFETCH_MS) fire();
            else if (!refetchTimerRef.current)
              refetchTimerRef.current = setTimeout(fire, REFETCH_MS - since); // trailing edge
          }
        }
      } else if (msg.type === 'transcript') {
        setTranscript({ sessionId: msg.sessionId, steps: msg.steps, hasMore: msg.hasMore });
        setLoadingMore(false);
        // reconcile live threads: anything the transcript now shows is dropped
        setRuns((prev) => {
          let changed = false;
          const next: typeof prev = {};
          for (const [key, run] of Object.entries(prev)) {
            if (run.sessionId === msg.sessionId && run.thread.length) {
              const thread = dedupeThread(msg.steps, run.thread);
              if (thread.length !== run.thread.length) {
                changed = true;
                next[key] = { ...run, thread };
                continue;
              }
            }
            next[key] = run;
          }
          return changed ? next : prev;
        });
      } else if (msg.type === 'run') {
        applyRun(msg.update);
      } else if (msg.type === 'models') {
        setModels(msg.models);
      } else if (msg.type === 'commands') {
        setCommands(msg.commands);
      } else if (msg.type === 'skills') {
        setSkillLists((prev) => ({ ...prev, [msg.roomId]: msg.skills }));
      } else if (msg.type === 'rewound') {
        setRewind(msg);
      } else if (msg.type === 'notice') {
        setNotice({ text: msg.text, isError: !!msg.isError });
        setTimeout(() => setNotice(null), 5000);
      } else if (msg.type === 'handoff') {
        const h = msg.handoff;
        setTeamLogs((prev) => {
          const cur = prev[h.teamId] ?? [];
          if (cur.some((x) => x.id === h.id)) return prev; // a re-broadcast (parked → delivered)
          const next = [...cur, h];
          return { ...prev, [h.teamId]: next.length > 200 ? next.slice(-200) : next };
        });
        setLastHandoff({ seq: ++handoffSeqRef.current, handoff: h });
            } else if (msg.type === 'teamLog') {
        setTeamLogs((prev) => ({ ...prev, [msg.teamId]: msg.handoffs }));
      } else if (msg.type === 'playbooks') {
        setPlaybooks(msg.playbooks);
      } else if (msg.type === 'playbookDraft') {
        setPlaybookDrafts((prev) => ({ ...prev, [msg.sessionId]: { loading: false, draft: msg.draft, error: msg.error } }));
      } else if (msg.type === 'connectors') {
        setConnectors((prev) => ({ ...prev, [msg.room.roomId]: msg.room }));
      }
    };

    ws.onclose = () => {
      // Only the socket we are currently using may drive reconnection. A
      // superseded socket closing (StrictMode's double mount, or a reconnect
      // that already succeeded) would otherwise schedule another connect and
      // orphan the live one.
      if (wsRef.current !== ws) return;
      setConn('closed');
      const delay = Math.min(1000 * 2 ** retryRef.current, 8000);
      retryRef.current++;
      setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  /**
   * Reconnect the moment the window comes back.
   *
   * airoom is a tray app: its window spends most of its life hidden, and
   * browsers throttle timers in background pages hard — so the backoff that
   * should retry in seconds can stall for minutes, and the user returns to a
   * dead-looking room. Coming to the front is the one instant we know they are
   * watching, so verify the socket then instead of waiting for a timer.
   */
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      retryRef.current = 0; // a deliberate return shouldn't inherit a long backoff
      connect();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [connect]);

  const subscribe = useCallback(
    (sessionId: string) => {
      if (subRef.current === sessionId) return; // already open — don't reset the window
      subStampRef.current = ''; // force a fresh fetch
      subRef.current = sessionId;
      limitRef.current = PAGE; // a newly opened desk starts at the newest page
      setTranscript(null);
      setLoadingMore(false);
      wsSend({ v: 1, type: 'subscribe', sessionId, limit: PAGE });
    },
    [wsSend],
  );

  /** Grow the history window — the chat calls this when you scroll to the top. */
  const loadMore = useCallback(() => {
    const sessionId = subRef.current;
    if (!sessionId) return;
    limitRef.current += PAGE;
    subStampRef.current = ''; // the window changed, so the next snapshot must refetch too
    refetchAtRef.current = Date.now(); // this IS the refetch; don't double-fire right after
    setLoadingMore(true);
    if (!wsSend({ v: 1, type: 'subscribe', sessionId, limit: limitRef.current })) setLoadingMore(false);
  }, [wsSend]);

  const unsubscribe = useCallback(() => {
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = null;
    }
    subRef.current = null;
    subStampRef.current = '';
    limitRef.current = PAGE;
    setTranscript(null);
    setLoadingMore(false);
  }, []);

  /**
   * Send a message. `sessionId` targets an existing session; omit for a fresh
   * spawn in the room. If a run is live for the same key, the server queues
   * the text into it (steering) — the UI echoes it into the thread either way.
   */
  const send = useCallback(
    (
      roomId: string,
      text: string,
      sessionId?: string,
      mode?: PermissionMode,
      model?: string,
      images?: ImageAttachment[],
      fast?: boolean,
      budgetUsd?: number,
      skills?: AgentSkills,
      agentName?: string,
    ) => {
      // Deliver FIRST: echoing an undelivered message would leave the panel
      // showing your text next to a spinner that can never finish.
      if (!wsSend({ v: 1, type: 'send', roomId, sessionId, text, mode, model, images, fast, budgetUsd, skills, agentName })) {
        setNotice({ text: 'Not connected — message not sent. Reconnecting…', isError: true });
        setTimeout(() => setNotice(null), 5000);
        return false;
      }
      setRuns((prev) => {
        // A run answers to the key it was CREATED with for its whole life — a
        // hire keeps `spawn:<roomId>` even after its session resolves, and the
        // server goes on emitting under it. So if some entry already tracks
        // this session, keep writing to that one. Opening a second entry keyed
        // by session id splits the run in half: our echo lands here, the
        // server's updates land there, and the panel watches only one of them —
        // which is how an Allow/Deny card could exist on the server and never
        // appear on screen.
        const runKey =
          (sessionId && Object.keys(prev).find((k) => prev[k].sessionId === sessionId)) ||
          sessionId ||
          `spawn:${roomId}`;
        const prior = prev[runKey];
        // `spawn:<roomId>` is reused every time you hire in this room. If the
        // entry still parked there already resolved a session, it belongs to
        // the agent hired LAST time — hiring again must start clean, or the new
        // message lands in the old agent's thread and the panel hands you over
        // to that agent instead of the one you're creating.
        // …but ONLY once it has finished. Steering a live spawn-keyed run (a
        // follow-up typed instead of answering its Allow/Deny card) comes
        // through this same path, and wiping the entry there threw away the
        // pendingPermission: the card vanished, its requestId was gone, and the
        // turn hung until the 10-minute auto-deny while the desk still flashed
        // "your move".
        const stale = !sessionId && !!prior?.sessionId && !prior.active;
        const cur = stale || !prior ? freshRun(runKey, roomId, sessionId ?? null) : prior;
        return {
          ...prev,
          [runKey]: {
            ...cur,
            active: true,
            thread: [
              ...cur.thread,
              {
                kind: 'user',
                // the echo shows what you sent; attachments render as a chip
                text,
                ...(images?.length
                  ? { images: images.length, imageSrcs: images.map((i) => `data:${i.mediaType};base64,${i.data}`) }
                  : {}),
                id: nextId(),
              },
            ],
          },
        };
      });
      return true;
    },
    [wsSend],
  );

  const interrupt = useCallback(
    (runKey: string) => wsSend({ v: 1, type: 'interrupt', runKey }),
    [wsSend],
  );

  const respondPermission = useCallback(
    (runKey: string, requestId: string, allow: boolean, always = false) => {
      setRuns((prev) => {
        const cur = prev[runKey];
        return cur ? { ...prev, [runKey]: { ...cur, pendingPermission: null } } : prev;
      });
      wsSend({ v: 1, type: 'permission', requestId, allow, always });
    },
    [wsSend],
  );

  /**
   * Ask what a rewind would change (dryRun) or perform it.
   * The answer arrives as a 'rewound' message, held in `rewind` below.
   */
  const [rewind, setRewind] = useState<
    | {
        userMessageId: string;
        dryRun: boolean;
        canRewind: boolean;
        error?: string;
        filesChanged?: string[];
        insertions?: number;
        deletions?: number;
      }
    | null
  >(null);
  const askRewind = useCallback(
    (runKey: string, userMessageId: string, dryRun: boolean, roomId?: string, sessionId?: string) => {
      if (dryRun) setRewind(null); // clear the previous answer while we ask
      // roomId/sessionId let the server rewind a session that has already
      // finished — the usual case, since you undo a turn after reading it.
      wsSend({ v: 1, type: 'rewind', runKey, userMessageId, dryRun, roomId, sessionId });
    },
    [wsSend],
  );
  const clearRewind = useCallback(() => setRewind(null), []);

  /** Toggle fast mode on a live run. */
  const setFastMode = useCallback(
    (runKey: string, fast: boolean) => wsSend({ v: 1, type: 'setFastMode', runKey, fast }),
    [wsSend],
  );
  /** Launch Ollama from the model menu; the models arrive over the socket. */
  const startOllama = useCallback(() => wsSend({ v: 1, type: 'startOllama' }), [wsSend]);
  /** A local model was picked: have the gateway load it and check its window. */
  const warmLocal = useCallback((model: string) => wsSend({ v: 1, type: 'warmLocal', model }), [wsSend]);

  /** Change a live run's permission mode without interrupting its turn. */
  const setMode = useCallback(
    (runKey: string, mode: PermissionMode) => wsSend({ v: 1, type: 'setMode', runKey, mode }),
    [wsSend],
  );

  /** Put a room away / bring it back. */
  const setRoomHidden = useCallback(
    (path: string, hidden: boolean) =>
      wsSend({ v: 1, type: hidden ? 'hideProject' : 'unhideProject', path }),
    [wsSend],
  );

  /**
   * Drop a finished run's live thread once the transcript has caught up.
   * Errors are KEPT: they come from airoom itself (failed spawn, bad token)
   * and are never written to any session file, so sweeping them would delete
   * the only explanation the user ever gets. Likewise a run whose sessionId
   * never resolved has no transcript that could reconcile it.
   */
  const clearRunThread = useCallback((runKey: string) => {
    setRuns((prev) => {
      const cur = prev[runKey];
      if (!cur || cur.active || cur.thread.length === 0) return prev;
      if (!cur.sessionId) return prev;
      const thread = cur.thread.filter((t) => t.kind === 'error');
      if (thread.length === cur.thread.length) return prev;
      return { ...prev, [runKey]: { ...cur, thread } };
    });
  }, []);

  const addProject = useCallback(
    (path: string) => wsSend({ v: 1, type: 'addProject', path }),
    [wsSend],
  );
  /** Which found projects show: these paths are put away, the rest stay. */
  const curateProjects = useCallback(
    (hidden: string[]) => wsSend({ v: 1, type: 'curateProjects', hidden }),
    [wsSend],
  );

  /** Ask what skills a hire in this room could carry (answered as 'skills'). */
  const listSkills = useCallback(
    (roomId: string) => wsSend({ v: 1, type: 'listSkills', roomId }),
    [wsSend],
  );

  /** Write a new user-level skill (answered with a notice + fresh 'skills'). */
  const createSkill = useCallback(
    (roomId: string, name: string, description: string, body: string) =>
      wsSend({ v: 1, type: 'createSkill', roomId, name, description, body }),
    [wsSend],
  );

  const setAgentHidden = useCallback(
    (sessionId: string, hidden: boolean) => wsSend({ v: 1, type: 'hideAgent', sessionId, hidden }),
    [wsSend],
  );
  /** Name an agent ('' clears the override, back to the default callsign). */
  const nameTeam = useCallback(
    (teamId: string, name: string) => wsSend({ v: 1, type: 'nameTeam', teamId, name }),
    [wsSend],
  );
  const nameAgent = useCallback(
    (sessionId: string, name: string) => wsSend({ v: 1, type: 'nameAgent', sessionId, name }),
    [wsSend],
  );
  const deleteAgent = useCallback(
    (sessionId: string) => wsSend({ v: 1, type: 'deleteAgent', sessionId }),
    [wsSend],
  );

  /** Everything the hire form settled, in one object — the roster made the
   *  positional version unreadable and easy to pass in the wrong order. */
  const hireTeam = useCallback(
    (opts: {
      roomId: string;
      task: string;
      autonomy: TeamAutonomy;
      roundCap: number;
      mode?: PermissionMode;
      model?: string;
      roleNotes?: RoleNotes;
      roleModes?: Partial<Record<TeamRole, PermissionMode>>;
      roleModels?: Partial<Record<TeamRole, string>>;
      roster?: RosterMember[];
      lanes?: number;
      ownRoom?: boolean;
          thrift?: boolean;
}) => wsSend({ v: 1, type: 'hireTeam', ...opts }),
    [wsSend],
  );
  const teamNewTask = useCallback(
    (teamId: string, task: string) => wsSend({ v: 1, type: 'teamTask', teamId, task }),
    [wsSend],
  );
  const teamCancelTask = useCallback(
    (teamId: string, taskId: string) => wsSend({ v: 1, type: 'teamCancelTask', teamId, taskId }),
    [wsSend],
  );
  const teamMergeTask = useCallback(
    (teamId: string, taskId: string) => wsSend({ v: 1, type: 'teamMergeTask', teamId, taskId }),
    [wsSend],
  );
  const teamCloseTask = useCallback(
    (teamId: string, taskId: string) => wsSend({ v: 1, type: 'teamCloseTask', teamId, taskId }),
    [wsSend],
  );
  const teamContinue = useCallback((teamId: string) => wsSend({ v: 1, type: 'teamContinue', teamId }), [wsSend]);
  const teamStop = useCallback((teamId: string) => wsSend({ v: 1, type: 'teamStop', teamId }), [wsSend]);
  const teamDismiss = useCallback((teamId: string) => wsSend({ v: 1, type: 'teamDismiss', teamId }), [wsSend]);
  const subscribeTeam = useCallback((teamId: string) => wsSend({ v: 1, type: 'subscribeTeam', teamId }), [wsSend]);

  // ---- playbooks ----
  /** Ask the server to read a session into a card. The answer lands in
   *  `playbookDrafts[sessionId]`; the caller shows a spinner until then. */
  const requestPlaybookDraft = useCallback(
    (sessionId: string, roomId: string) => {
      if (!wsSend({ v: 1, type: 'playbookDraft', sessionId, roomId })) return false;
      setPlaybookDrafts((prev) => ({ ...prev, [sessionId]: { loading: true } }));
      return true;
    },
    [wsSend],
  );
  const clearPlaybookDraft = useCallback((sessionId: string) => {
    setPlaybookDrafts((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);
  const savePlaybook = useCallback((playbook: Playbook) => wsSend({ v: 1, type: 'playbookSave', playbook }), [wsSend]);
  const deletePlaybook = useCallback((id: string) => wsSend({ v: 1, type: 'playbookDelete', id }), [wsSend]);
  const runPlaybook = useCallback(
    (id: string, inputs: Record<string, string>, mode?: PermissionMode, model?: string) =>
      wsSend({ v: 1, type: 'playbookRun', id, inputs, mode, model }),
    [wsSend],
  );
  const addPlaybookRule = useCallback(
    (id: string, text: string, runId?: string) => wsSend({ v: 1, type: 'playbookRule', id, text, runId }),
    [wsSend],
  );
  const dropPlaybookRule = useCallback((id: string, ruleId: string) => wsSend({ v: 1, type: 'playbookDropRule', id, ruleId }), [wsSend]);
  const stopPlaybookRun = useCallback((id: string, runId: string) => wsSend({ v: 1, type: 'playbookStop', id, runId }), [wsSend]);

  // ---- connectors ----
  const listConnectors = useCallback(
    (roomId: string, refresh = false) => wsSend({ v: 1, type: 'listConnectors', roomId, refresh }),
    [wsSend],
  );
  const setConnectorEnabled = useCallback(
    (roomId: string, name: string, enabled: boolean) => wsSend({ v: 1, type: 'setConnectorEnabled', roomId, name, enabled }),
    [wsSend],
  );
  const setConnectorLoaded = useCallback(
    (roomId: string, name: string, loaded: boolean) => wsSend({ v: 1, type: 'setConnectorLoaded', roomId, name, loaded }),
    [wsSend],
  );
  const addConnector = useCallback(
    (opts: { roomId: string; name: string; transport: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string> }) =>
      wsSend({ v: 1, type: 'addConnector', ...opts }),
    [wsSend],
  );
  const removeConnector = useCallback(
    (roomId: string, name: string) => wsSend({ v: 1, type: 'removeConnector', roomId, name }),
    [wsSend],
  );

  return {
    connectors,
    mcpPulse,
    listConnectors,
    setConnectorEnabled,
    setConnectorLoaded,
    addConnector,
    removeConnector,
    playbooks,
    playbookDrafts,
    requestPlaybookDraft,
    clearPlaybookDraft,
    savePlaybook,
    deletePlaybook,
    runPlaybook,
    addPlaybookRule,
    dropPlaybookRule,
    stopPlaybookRun,
    snapshot,
    conn,
    transcript,
    runs,
    notice,
    subscribe,
    loadMore,
    loadingMore,
    unsubscribe,
    send,
    interrupt,
    respondPermission,
    setMode,
    setFastMode,
    startOllama,
    warmLocal,
    setRoomHidden,
    models,
    commands,
    skillLists,
    listSkills,
    createSkill,
    rewind,
    askRewind,
    clearRewind,
    clearRunThread,
    addProject,
    curateProjects,
    setAgentHidden,
    nameAgent,
    nameTeam,
    deleteAgent,
    teamLogs,
    lastHandoff,
    hireTeam,
    teamNewTask,
    teamCancelTask,
    teamMergeTask,
    teamCloseTask,
    teamContinue,
    teamStop,
    teamDismiss,
    subscribeTeam,
  };
}
