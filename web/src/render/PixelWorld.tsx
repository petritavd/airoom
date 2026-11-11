import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connector, FleetSnapshot, Robot, Room } from '@shared/types';
import {
  bottomDoorX,
  computeLayout,
  ART_PIXEL,
  drawOverlays,
  drawWorld,
  hitTest,
  teamPlateHit,
  teamPodHit,
  interiorOf,
  roomHitTest,
  rosterHit,
  socketHit,
  socketPanel,
  spawnHit,
  PULSE_MS,
  THEMES,
  WALL_BOT,
  type CablePulse,
  type Cell,
  type Layout,
  type NameTag,
} from './draw';
import { DECOR_BY_KEY, decorAt, layoutDecor, type DecorDef, type RoomLive } from './decor';
import { deriveMaps, type DecorItem, type RoomConfigs } from '../roomConfig';
import { defaultAgentName } from '../names';
import { buildPlaces, Sim } from './sim';

/** Room-editor state owned by App (palette lives in React). */
export interface EditState {
  roomId: string;
  placing: string | null; // catalog key currently being painted
}

interface Props {
  snapshot: FleetSnapshot;
  selectedId: string | null; // sessionId or `spawn:<roomId>`
  configs: RoomConfigs; // per-room theme + logo + decor
  edit: EditState | null;
  onSelect: (robot: Robot | null) => void;
  onSpawn: (roomId: string) => void;
  /** stand the life layer down (no wandering, no sounds); nothing sets it today */
  frozen?: boolean;
  /** Focus mode: monochrome world (robots and signals keep colour) and the
   *  life layer stands down — same stillness as frozen, without the gate. */
  focus?: boolean;
  /** a rug was clicked — open that team's panel */
  onTeam: (teamId: string) => void;
  /** newest routed handoff; seq guarantees the walk fires exactly once */
  handoffSignal: { seq: number; fromSessionId: string | null; toSessionId: string | null; label: string } | null;
  onOpenSettings: (room: Room) => void;
  /** the "+N more" badge — every session in the room, desk or not */
  onOpenRoster: (roomId: string) => void;
  /** roomId → its connectors: the sockets on the wall */
  connectors?: Record<string, Connector[]>;
  /** the patch panel was clicked — open that room's Connections sheet */
  onOpenConnectors?: (roomId: string) => void;
  /** an agent just called a connector tool; seq fires the cable pulse once */
  pulseSignal?: { seq: number; sessionId: string; roomId: string; server: string } | null;
  onCycleTheme: (roomId: string, next: string) => void;
  onChangeDecor: (roomId: string, decor: DecorItem[]) => void;
  /** Put down the item currently armed for placing, without leaving the editor. */
  onDisarm: () => void;
  onExitEdit: () => void;
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return '';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * Room names, the way a map labels a place.
 *
 * These used to be painted into a band across the top of every room, which is
 * what made a floor plan read as a grid of cards. As HTML they sit ABOVE the
 * world in the app's own UI font, stay crisp at any dpr, and can carry a real
 * button — the ⚙ appears on hover instead of occupying a corner of every room
 * forever.
 */
/**
 * A room's sign is two or three words wide.
 *
 * A team's room is named after the job in front of it, and a job's name is
 * whatever the human typed — often a whole sentence. Ellipsising it at the
 * wall left a sign that was all name and no room. Cut it to a phrase on a word
 * boundary instead; the whole thing is on the tooltip.
 */
function signName(text: string, max = 22): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > 8 ? cut.slice(0, at) : cut).replace(/[,;:.\-–—]+$/, '')}…`;
}

function RoomLabels({
  layout,
  names,
  attention,
  onSettings,
  labelsRef,
  focusMode,
}: {
  layout: Layout;
  names: Record<string, string>;
  attention: Record<string, boolean>;
  onSettings: (roomId: string) => void;
  labelsRef: React.MutableRefObject<HTMLDivElement | null>;
  focusMode?: boolean;
}) {
  return (
    <div className={`maplabels ${focusMode ? 'maplabels--focus' : ''}`} ref={labelsRef} aria-hidden={false}>
      {layout.cells.map((cell) => {
        const room = cell.room;
        // A lane is signed by what it is working on, not by its folder — the
        // folder is a worktree with a generated name nobody chose. It carries
        // no ⚙ either: its theme, decor and name belong to the project.
        const lane = room?.lane;
        const label = lane ? (lane.teamName || signName(lane.task)) : room ? names[room.id] || room.name : 'lounge';
        const { iX, iY, iW } = interiorOf(cell);
        return (
          <div
            key={cell.idx}
            className={`maplabel ${room ? '' : 'maplabel--quiet'} ${lane ? 'maplabel--lane' : ''}`}
            // Resting ON the zone's glass edge, the way a sign sits on a rail —
            // and never wider than the room it names. The cap used to be a
            // share of the whole floor, so a long task title ran clean across
            // the wall into the next room.
            style={{ left: `${iX + 6}px`, top: `${iY - 10}px`, maxWidth: `${Math.max(56, iW - 12)}px` }}
          >
            {room && (
              <span className={`maplabel__dot ${attention[room.id] ? 'maplabel__dot--wants' : ''}`} />
            )}
            {/* In a room too narrow to hold both, the badge gives way: which
                job the crew is on is the information, "TEAM" is the label. */}
            {lane && iW >= 150 && <span className="maplabel__lane">team</span>}
            <span className="maplabel__name" title={lane ? `${lane.task} · ${lane.branch}` : undefined}>
              {label}
            </span>
            {room && room.robotCount > 0 && <span className="maplabel__n">{room.robotCount}</span>}
            {room && !lane && (
              <button
                type="button"
                className="maplabel__gear"
                title={`${label} settings`}
                aria-label={`${label} settings`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSettings(room.id);
                }}
              >
                ⚙
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Fixed one-screen canvas (no pan/zoom) with a living simulation on top:
 * robots walk in, wander, queue at the door when they need you.
 * Click a desk/robot to open the agent. Double-click a room to retheme.
 * Arrow keys move room focus, Enter opens an agent, Esc closes.
 */
export function PixelWorld({
  snapshot,
  selectedId,
  configs,
  edit,
  onSelect,
  onSpawn,
  frozen,
  focus,
  onTeam,
  handoffSignal,
  onOpenSettings,
  onOpenRoster,
  connectors,
  onOpenConnectors,
  pulseSignal,
  onCycleTheme,
  onChangeDecor,
  onDisarm,
  onExitEdit,
}: Props) {
  // Sockets and cables: refs, because the canvas loop reads them every frame.
  const connectorsRef = useRef<Record<string, Connector[]>>(connectors ?? {});
  connectorsRef.current = connectors ?? {};
  const onOpenConnectorsRef = useRef(onOpenConnectors);
  onOpenConnectorsRef.current = onOpenConnectors;
  const pulsesRef = useRef<CablePulse[]>([]);
  useEffect(() => {
    if (!pulseSignal) return;
    const now = performance.now();
    pulsesRef.current = [...pulsesRef.current.filter((p) => now - p.t0 < PULSE_MS), { sessionId: pulseSignal.sessionId, roomId: pulseSignal.roomId, server: pulseSignal.server, t0: now }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulseSignal?.seq]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The map-label layer. Moved by the render loop rather than by React state:
   *  scrolling must not re-render every label sixty times a second. */
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /**
   * How far the office is scrolled. The canvas stays exactly viewport-sized —
   * a canvas as tall as the world would mean a backing store of tens of
   * megabytes — so scrolling is a translate on the way in and its inverse on
   * the way out for hit-testing.
   */
  const scrollRef = useRef(0);
  const [focusCell, setFocusCell] = useState<number | null>(null);
  const focusRef = useRef<number | null>(null);
  focusRef.current = focusCell;

  // themes + logos, derived once per config change and read by the render loop
  const maps = useMemo(() => deriveMaps(configs), [configs]);
  const mapsRef = useRef(maps);
  mapsRef.current = maps;

  // Live context for functional decor (branch flag, mailbox, beacon, notes).
  const live = useMemo(() => {
    const m: Record<string, RoomLive> = {};
    for (const room of snapshot.rooms)
      m[room.id] = { notes: maps.notes[room.id] ?? [], working: 0, attention: 0, errors: 0, done: 0 };
    const freshest: Record<string, string> = {};
    for (const r of snapshot.robots) {
      const l = m[r.roomId];
      if (!l) continue;
      if (r.status === 'working') l.working++;
      if (r.status === 'waiting_input' || r.status === 'error' || r.needsApproval) l.attention++;
      if (r.status === 'error') l.errors++;
      if (r.status === 'done') l.done++;
      // the room flies the branch of whichever session moved last
      const at = r.lastActivity ?? '';
      if (r.gitBranch && (freshest[r.roomId] === undefined || at > freshest[r.roomId])) {
        freshest[r.roomId] = at;
        l.branch = r.gitBranch;
      }
    }
    return m;
  }, [snapshot, maps]);
  const liveRef = useRef(live);
  liveRef.current = live;

  // Every robot has a name from its first frame: the user's, or the default
  // callsign hashed off its session id. Drawn faint over each head by the
  // overlay pass (crisp type — never through the art grid).
  const agentNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of snapshot.robots) m[r.sessionId] = r.name ?? defaultAgentName(r.sessionId);
    return m;
  }, [snapshot.robots]);
  const agentNamesRef = useRef(agentNames);
  agentNamesRef.current = agentNames;

  const simRef = useRef<Sim | null>(null);
  if (!simRef.current) simRef.current = new Sim();
  (window as any).__airoomSim = simRef.current; // dev inspection hook

  const layout: Layout = useMemo(
    () => computeLayout(snapshot, size.w, size.h),
    [snapshot, size.w, size.h],
  );

  const maxScroll = () => Math.max(0, layoutRef.current.worldH - layoutRef.current.viewH);
  const clampScroll = () => {
    scrollRef.current = Math.max(0, Math.min(scrollRef.current, maxScroll()));
  };

  useEffect(() => {
    clampScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.worldH, layout.viewH]);

  /** Keyboard focus must be able to reach rooms below the fold. */
  const revealCell = (idx: number) => {
    const lay = layoutRef.current;
    const cell = lay.cells[idx];
    if (!cell || lay.worldH <= lay.viewH) return;
    const top = cell.y - 12;
    const bottom = cell.y + cell.h + 12;
    if (top < scrollRef.current) scrollRef.current = Math.max(0, top);
    else if (bottom > scrollRef.current + lay.viewH)
      scrollRef.current = Math.min(maxScroll(), bottom - lay.viewH);
  };

  // Keep the sim in sync with fleet + geometry — and with the furniture, so
  // idle outings target the decor that is actually on the floor.
  useEffect(() => {
    if (size.w === 0) return;
    simRef.current!.setPlaces(buildPlaces(layout, maps.decor));
    simRef.current!.reconcile(layout, snapshot.robots, performance.now());
  }, [layout, snapshot, size.w, maps]);

  // Track viewport size (state drives layout; ref feeds the render loop).
  const sizeRef = useRef({ w: 0, h: 0 });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => {
      const rect = canvas.getBoundingClientRect();
      sizeRef.current = { w: rect.width, h: rect.height };
      setSize((s) => (s.w !== rect.width || s.h !== rect.height ? { w: rect.width, h: rect.height } : s));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    (document as any).fonts?.load('600 12px "Chakra Petch"');
  }, []);

  // Refs read by the render loop / listeners (always latest).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  (window as any).__airoomLayout = layout; // dev inspection hook
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onSpawnRef = useRef(onSpawn);
  onSpawnRef.current = onSpawn;
  const onTeamRef = useRef(onTeam);
  onTeamRef.current = onTeam;
  const frozenRef = useRef(!!frozen);
  frozenRef.current = !!frozen;
  const focusModeRef = useRef(!!focus);
  focusModeRef.current = !!focus;

  // The handoff walk. Keyed on seq: React may re-render for a hundred other
  // reasons, and a robot that re-walks its parcel on every snapshot would turn
  // the office into a treadmill.
  useEffect(() => {
    if (frozen) return;
    if (!handoffSignal || !handoffSignal.fromSessionId || !handoffSignal.toSessionId) return;
    simRef.current?.handoff(handoffSignal.fromSessionId, handoffSignal.toSessionId, handoffSignal.label, performance.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffSignal?.seq]);
  const onOpenSettingsRef = useRef(onOpenSettings);
  onOpenSettingsRef.current = onOpenSettings;
  const onOpenRosterRef = useRef(onOpenRoster);
  onOpenRosterRef.current = onOpenRoster;
  const onCycleThemeRef = useRef(onCycleTheme);
  onCycleThemeRef.current = onCycleTheme;
  const onChangeDecorRef = useRef(onChangeDecor);
  onChangeDecorRef.current = onChangeDecor;
  const onDisarmRef = useRef(onDisarm);
  onDisarmRef.current = onDisarm;
  const onExitEditRef = useRef(onExitEdit);
  onExitEditRef.current = onExitEdit;

  // ---- room editor state (refs: the canvas loop reads them every frame) ----
  const editRef = useRef(edit);
  editRef.current = edit;
  const editSelRef = useRef<number | null>(null);
  const editGhostRef = useRef<{ item: string; x: number; y: number; ok: boolean } | null>(null);
  const dragRef = useRef<{ index: number; item: string } | null>(null);
  useEffect(() => {
    // reset transient editor state when entering/leaving/moving rooms
    editSelRef.current = null;
    editGhostRef.current = null;
    dragRef.current = null;
  }, [edit?.roomId]);

  const editCell = (): Cell | null =>
    editRef.current ? (layoutRef.current.cells.find((c) => c.room?.id === editRef.current!.roomId) ?? null) : null;

  /** Placement legality: inside the interior, not on desks/spawn/door. */
  const canPlace = (cell: Cell, def: DecorDef, ax: number, ay: number): boolean => {
    const { iX, iY, iW, iH } = interiorOf(cell);
    const w = def.w * cell.scale;
    const h = def.h * cell.scale;
    const box = { x: ax - w / 2, y: ay - h, w, h };
    if (box.x < iX + 2 || box.x + box.w > iX + iW - 2 || box.y < iY + 2 || ay > iY + iH - 2) return false;
    const overlaps = (r: { x: number; y: number; w: number; h: number }) =>
      box.x < r.x + r.w && box.x + box.w > r.x && box.y < r.y + r.h && box.y + box.h > r.y;
    // door strip (keep the doorway walkable)
    const doorX = bottomDoorX(cell);
    if (overlaps({ x: doorX - 34, y: cell.y + cell.h - WALL_BOT - 46, w: 68, h: 46 })) return false;
    for (const d of layoutRef.current.desks)
      if (d.cellIdx === cell.idx && overlaps({ x: d.x, y: d.y, w: d.w, h: d.h })) return false;
    for (const s of layoutRef.current.spawnSpots)
      if (s.cellIdx === cell.idx && overlaps({ x: s.x, y: s.y, w: s.w, h: s.h })) return false;
    return true;
  };

  const snapFrac = (v: number) => Math.min(1, Math.max(0, Math.round(v * 40) / 40));

  /**
   * Where a pointer position will actually put an item: the stored fractions
   * plus the absolute point they resolve to.
   *
   * Placement has to be judged on THIS point, not the raw cursor. Validating
   * the unsnapped position and then committing the snapped one let an accepted
   * drop settle up to half a grid step away from what was checked — far enough
   * to clip a wall or slide under a desk.
   */
  const snapPoint = (cell: Cell, x: number, y: number) => {
    const { iX, iY, iW, iH } = interiorOf(cell);
    const fx = snapFrac((x - iX) / iW);
    const fy = snapFrac((y - iY) / iH);
    return { fx, fy, ax: iX + fx * iW, ay: iY + fy * iH };
  };
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  // Animation loop: mounted ONCE, never gated on React state — a transient
  // 0-size measurement must skip frames, not kill the loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    // The art surface: the world is painted here at one art pixel per unit and
    // then blown up onto the display canvas with smoothing off.
    const art = document.createElement('canvas');
    const actx = art.getContext('2d')!;
    let raf = 0;
    let last = performance.now();
    /**
     * 30fps cap. The display runs at 120Hz (ProMotion), and painting the whole
     * pixel world every 8.3ms cost a measured ~1.15 CPU cores with the window
     * visible — a warm Mac for animations whose smallest meaningful step is a
     * few pixels. Nothing here needs more than 30: walkers move ~2px per
     * frame at this rate, and dt-based timing keeps every speed identical.
     */
    const MIN_FRAME_MS = 1000 / 30 - 1; // -1: never skip into 20fps on a 120Hz tick grid
    let lastPaint = 0;
    const render = (time: number) => {
      raf = requestAnimationFrame(render); // schedule first — loop survives anything below
      if (time - lastPaint < MIN_FRAME_MS) return;
      lastPaint = time;
      (window as any).__frames = ((window as any).__frames | 0) + 1; // dev heartbeat
      const dt = Math.min(64, time - last);
      last = time;
      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      // Compare against the value the canvas will actually hold: width/height
      // are integers, so a fractional w*dpr (zoomed window, odd layout size)
      // never equalled it and the backing store was reallocated — and cleared —
      // on every single frame.
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      // World units are CSS pixels, so the art buffer is sized to give exactly
      // ART_PIXEL device pixels per unit.
      const aw = Math.max(1, Math.round(bw / ART_PIXEL));
      const ah = Math.max(1, Math.round(bh / ART_PIXEL));
      if (art.width !== aw || art.height !== ah) {
        art.width = aw;
        art.height = ah;
      }
      const artScale = dpr / ART_PIXEL;
      actx.setTransform(artScale, 0, 0, artScale, 0, 0);
      actx.clearRect(0, 0, aw / artScale, ah / artScale);

      const sim = simRef.current!;
      const lay = layoutRef.current;
      // Scroll the world under a fixed-size canvas. Everything drawn below is
      // in world coordinates; toLocal adds the same offset back for hits.
      const scroll = Math.max(0, Math.min(scrollRef.current, Math.max(0, lay.worldH - lay.viewH)));
      scrollRef.current = scroll;
      // Scroll on the ART grid: a fractional offset would shear every snapped
      // edge in the world by a sub-pixel and undo the point of the buffer. The
      // canvas, the text overlay and the HTML labels all use this same snapped
      // value, or they drift apart by a pixel as you scroll.
      const scrollPx = Math.round(scroll * artScale) / artScale;
      if (scrollPx) actx.translate(0, -scrollPx);
      if (labelsRef.current) labelsRef.current.style.transform = `translateY(${-scrollPx}px)`;
      sim.tick(dt, time, lay, frozenRef.current || focusModeRef.current);
      const { sprites, bubbles } = sim.views(lay, time);

      // Desk labels. Every robot that needs a person wears one all the time —
      // the task first, then who and what — so work can be found by outcome
      // from across the room. The hovered and the selected robot wear one
      // too, and a hovered team bench gets the team's.
      const nameTags: NameTag[] = [];
      const snap = snapshotRef.current;
      const tagFor = (robot: Robot, tone: NameTag['tone']): NameTag | null => {
        const pos = sim.positionOf(robot.sessionId) ?? lay.desks.find((d) => d.robot.sessionId === robot.sessionId)?.seat ?? null;
        if (!pos) return null;
        const who = agentNamesRef.current[robot.sessionId];
        const what = robot.needsApproval
          ? `wants to run ${robot.pendingTool ?? 'a tool'}`
          : robot.status === 'waiting_input'
            ? 'waiting for you'
            : robot.status === 'error'
              ? 'stopped'
              : robot.currentAction || robot.status.replace('_', ' ');
        return {
          x: pos.x,
          y: pos.y,
          title: robot.title.slice(0, 34),
          sub: `${who ? `${who} · ` : ''}${robot.team ? `${robot.team.role} · ` : ''}${what}`.slice(0, 48),
          tone,
        };
      };
      const tagged = new Set<string>();
      const add = (robot: Robot | undefined, tone: NameTag['tone']) => {
        if (!robot || tagged.has(robot.sessionId)) return;
        const t = tagFor(robot, tone);
        if (t) {
          nameTags.push(t);
          tagged.add(robot.sessionId);
        }
      };
      const hid = hoverRef.current;
      if (hid && !hid.startsWith('team:')) add(snap.robots.find((r) => r.sessionId === hid), 'live');
      if (selectedRef.current) add(snap.robots.find((r) => r.sessionId === selectedRef.current), 'live');
      for (const r of snap.robots) {
        if (r.status === 'error') add(r, 'err');
        else if (r.status === 'waiting_input' || r.needsApproval) add(r, 'warn');
      }
      let nameTag: NameTag | null = null;
      if (hid?.startsWith('team:')) {
        const teamId = hid.slice(5);
        const pod = lay.teamPods.find((p) => p.teamId === teamId);
        const team = snapshotRef.current.teams?.find((t) => t.id === teamId);
        if (pod) {
          const STATE: Record<string, string> = {
            working: 'working',
            awaiting_human: 'your move',
            done: 'done',
            stopped: 'stopped',
            error: 'error',
          };
          nameTag = {
            x: pod.x + pod.w / 2,
            y: pod.y + 26,
            title: (team?.name || team?.task || 'Team').slice(0, 34),
            sub: team ? `team · ${STATE[team.state] ?? team.state} · $${team.costUsd.toFixed(2)}` : 'team',
          };
        }
      }
      if (hid?.startsWith('sockets:')) {
        const roomId = hid.slice(8);
        const cell = lay.cells.find((c) => c.room?.id === roomId);
        const list = connectorsRef.current[roomId] ?? [];
        const panel = cell ? socketPanel(cell, list) : null;
        if (panel) {
          const up = list.filter((c) => c.status === 'connected').length;
          const down = list.filter((c) => c.status === 'failed').length;
          const auth = list.filter((c) => c.status === 'needs-auth').length;
          const parts = [`${up} connected`, down ? `${down} down` : '', auth ? `${auth} need sign-in` : ''].filter(Boolean);
          nameTags.push({
            x: panel.x + panel.w / 2,
            y: panel.y + panel.h + 30,
            title: list
              .slice(0, 5)
              .map((c) => c.name)
              .join(' · ')
              .slice(0, 34),
            sub: `connections · ${parts.join(' · ')}`.slice(0, 48),
          });
        }
      }
      if (nameTag) nameTags.push(nameTag);

      drawWorld(actx, lay, {
        time,
        focus: focusModeRef.current,
        hoverId: hid,
        selectedId: selectedRef.current,
        connectors: connectorsRef.current,
        pulses: pulsesRef.current,
        themes: mapsRef.current.themes,
        logos: mapsRef.current.logos,
        names: mapsRef.current.names,
        agentNames: agentNamesRef.current,
        floors: mapsRef.current.floors,
        decor: mapsRef.current.decor,
        live: liveRef.current,
        edit: editRef.current
          ? {
              roomId: editRef.current.roomId,
              selected: editSelRef.current,
              ghost: editGhostRef.current,
            }
          : null,
        sprites,
        bubbles,
        focusCell: focusRef.current,
        nameTags,
        scrollY: scrollPx,
      });

      // Blow the art buffer up onto the display surface, then put the text on
      // top at full resolution — chunky world, sharp words.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, bw, bh);
      ctx.drawImage(art, 0, 0, aw, ah, 0, 0, aw * ART_PIXEL, ah * ART_PIXEL);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (scrollPx) ctx.translate(0, -scrollPx);
      drawOverlays(ctx, {
        time,
        hoverId: hid,
        selectedId: selectedRef.current,
        themes: mapsRef.current.themes,
        logos: mapsRef.current.logos,
        names: mapsRef.current.names,
        agentNames: agentNamesRef.current,
        floors: mapsRef.current.floors,
        decor: mapsRef.current.decor,
        live: liveRef.current,
        edit: null,
        sprites,
        bubbles,
        focusCell: null,
        nameTags,
        scrollY: scrollPx,
      });

      // A slim rail, drawn back in SCREEN space, so it is obvious the office
      // continues past the window — otherwise rooms below the fold simply look
      // like they don't exist.
      const over = lay.worldH - lay.viewH;
      if (over > 1) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // screen space — nothing world-space may follow
        const trackH = lay.viewH - 16;
        const thumbH = Math.max(28, (lay.viewH / lay.worldH) * trackH);
        const y = 8 + (scroll / over) * (trackH - thumbH);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(lay.viewW - 6, 8, 3, trackH);
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(lay.viewW - 6, y, 3, thumbH);
      }
    };
    raf = requestAnimationFrame(render);

    // Hidden tabs pause rAF — keep the simulation ticking so robots aren't
    // frozen mid-doorway when the user switches back. Timers are throttled to
    // ~1Hz in background, so sub-step the elapsed time in 64ms slices.
    const bg = setInterval(() => {
      if (!document.hidden) return;
      const now = performance.now();
      let remaining = Math.min(3000, now - last);
      last = now;
      while (remaining > 0) {
        const step = Math.min(64, remaining);
        remaining -= step;
        simRef.current!.tick(step, now - remaining, layoutRef.current, frozenRef.current || focusModeRef.current);
      }
    }, 250);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(bg);
    };
  }, []);

  // Native pointer + keyboard interaction.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Screen → world: everything in the layout lives in world coordinates, so
    // the scroll offset has to be added back before any hit test.
    const toLocal = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top + scrollRef.current };
    };
    const robotAt = (x: number, y: number): Robot | null => {
      const byDesk = hitTest(layoutRef.current, x, y);
      if (byDesk) return byDesk;
      const bySprite = simRef.current!.spriteAt(x, y);
      return bySprite ? (snapshotRef.current.robots.find((r) => r.sessionId === bySprite) ?? null) : null;
    };

    // ---- room-editor pointer logic ----
    const decorOf = (roomId: string) => mapsRef.current.decor[roomId] ?? [];
    const editMove = (p: { x: number; y: number }) => {
      const cell = editCell();
      const ed = editRef.current!;
      if (!cell) return;
      const drag = dragRef.current;
      if (drag) {
        const def = DECOR_BY_KEY.get(drag.item);
        // Preview the snapped spot, so the ghost stands exactly where the item
        // will land and its ok/blocked colour is the verdict that will be used.
        const s = snapPoint(cell, p.x, p.y);
        if (def) editGhostRef.current = { item: drag.item, x: s.ax, y: s.ay, ok: canPlace(cell, def, s.ax, s.ay) };
        return;
      }
      if (ed.placing) {
        const def = DECOR_BY_KEY.get(ed.placing);
        const s = snapPoint(cell, p.x, p.y);
        if (def) editGhostRef.current = { item: ed.placing, x: s.ax, y: s.ay, ok: canPlace(cell, def, s.ax, s.ay) };
        else editGhostRef.current = null;
      } else {
        editGhostRef.current = null;
      }
    };
    const editDown = (p: { x: number; y: number }) => {
      const cell = editCell();
      if (!cell || editRef.current!.placing) return;
      const hit = decorAt(layoutDecor(cell, decorOf(cell.room!.id)), p.x, p.y);
      if (hit) {
        editSelRef.current = hit.index;
        dragRef.current = { index: hit.index, item: decorOf(cell.room!.id)[hit.index].item };
      } else {
        editSelRef.current = null;
      }
    };
    const editUp = (p: { x: number; y: number }) => {
      const cell = editCell();
      const drag = dragRef.current;
      dragRef.current = null;
      editGhostRef.current = null;
      if (!cell || !drag) return;
      const def = DECOR_BY_KEY.get(drag.item);
      const s = snapPoint(cell, p.x, p.y);
      if (!def || !canPlace(cell, def, s.ax, s.ay)) return; // invalid drop → stays put
      const items = [...decorOf(cell.room!.id)];
      items[drag.index] = { ...items[drag.index], fx: s.fx, fy: s.fy };
      onChangeDecorRef.current(cell.room!.id, items);
    };
    const editClick = (p: { x: number; y: number }) => {
      const cell = editCell();
      const ed = editRef.current!;
      if (!cell || !ed.placing) return;
      const def = DECOR_BY_KEY.get(ed.placing);
      const s = snapPoint(cell, p.x, p.y);
      if (!def || !canPlace(cell, def, s.ax, s.ay)) return;
      const items = [...decorOf(cell.room!.id), { item: ed.placing, fx: s.fx, fy: s.fy }];
      onChangeDecorRef.current(cell.room!.id, items);
    };

    const onMove = (e: PointerEvent) => {
      const p = toLocal(e);
      if (editRef.current) return editMove(p);
      // Same order as a click, so what lights up is what would open.
      const plate = teamPlateHit(layoutRef.current, p.x, p.y);
      const robot = plate ? null : robotAt(p.x, p.y);
      const spawn = plate || robot ? null : spawnHit(layoutRef.current, p.x, p.y);
      const pod = plate ?? (robot || spawn ? null : teamPodHit(layoutRef.current, p.x, p.y));
      const sockets = robot || spawn || pod ? null : socketHit(layoutRef.current, connectorsRef.current, p.x, p.y);
      const id = robot?.sessionId ?? (spawn ? `spawn:${spawn.roomId}` : pod ? `team:${pod.teamId}` : sockets ? `sockets:${sockets.roomId}` : null);
      // A hand over anything that opens. The office had no pointer cursor at
      // all, so nothing on it said "this can be clicked".
      canvas.style.cursor = id || rosterHit(layoutRef.current, p.x, p.y) ? 'pointer' : '';
      if (id !== hoverRef.current) {
        hoverRef.current = id;
        setHoverId(id);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!editRef.current) return;
      // Capture the pointer for the whole drag. pointerup is bound to the
      // canvas alone, so without this a decor item released over the palette
      // (which overlays the right edge of the stage) never finished its drag:
      // the ghost kept following the cursor with no way to put it down.
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety, not a requirement */
      }
      editDown(toLocal(e));
    };
    const onUp = (e: PointerEvent) => {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* never captured */
      }
      if (!editRef.current) return;
      editUp(toLocal(e));
    };
    // A cancelled gesture (window blur, touch interruption) must not leave a
    // half-finished drag armed either.
    const onCancel = () => {
      dragRef.current = null;
    };
    /**
     * Right-click removes the thing under the cursor.
     *
     * Deleting used to require selecting an item first and pressing Del — but
     * selection is skipped while an item is armed for placing, so straight
     * after adding something every click placed ANOTHER one and there was no
     * way to take it back off the floor.
     */
    const onContext = (e: MouseEvent) => {
      if (!editRef.current) return;
      e.preventDefault();
      const cell = editCell();
      if (!cell?.room) return;
      const p = toLocal(e);
      const items = decorOf(cell.room.id);
      const hit = decorAt(layoutDecor(cell, items), p.x, p.y);
      if (!hit) return;
      const next = [...items];
      next.splice(hit.index, 1);
      editSelRef.current = null;
      dragRef.current = null;
      onChangeDecorRef.current(cell.room.id, next);
    };
    const onClick = (e: MouseEvent) => {
      const p = toLocal(e);
      if (editRef.current) return editClick(p);
      // the overflow badge wins over the desks behind it
      const roster = rosterHit(layoutRef.current, p.x, p.y);
      if (roster) return onOpenRosterRef.current(roster.roomId);
      // …and so does a team's plaque: it is the team's button, and it sits
      // where no member's desk is.
      const plate = teamPlateHit(layoutRef.current, p.x, p.y);
      if (plate) return onTeamRef.current(plate.teamId);
      const robot = robotAt(p.x, p.y);
      if (robot) return onSelectRef.current(robot);
      // the patch panel on the wall: the room's connections
      const sockets = socketHit(layoutRef.current, connectorsRef.current, p.x, p.y);
      if (sockets && onOpenConnectorsRef.current) return onOpenConnectorsRef.current(sockets.roomId);
      const spawn = spawnHit(layoutRef.current, p.x, p.y);
      if (spawn) return onSpawnRef.current(spawn.roomId);
      const pod = teamPodHit(layoutRef.current, p.x, p.y);
      if (pod) return onTeamRef.current(pod.teamId);
      onSelectRef.current(null);
    };
    const onDbl = (e: MouseEvent) => {
      if (editRef.current) return;
      const p = toLocal(e);
      if (robotAt(p.x, p.y) || spawnHit(layoutRef.current, p.x, p.y)) return;
      const room = roomHitTest(layoutRef.current, p.x, p.y);
      if (!room) return;
      // quick shortcut: cycle the floor theme (same setting the ⚙ panel edits)
      const cur = mapsRef.current.themes[room.id];
      const idx = Math.max(0, THEMES.findIndex((t) => t.id === cur));
      onCycleThemeRef.current(room.id, THEMES[(idx + 1) % THEMES.length].id);
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT';
      // The office owns the keyboard only when nothing else does. With a
      // button, link, menu or dialog control focused, Enter and the arrows are
      // that control's — Enter on "+ project" used to open whichever agent sat
      // in the focused room instead of the menu. Escape stays global: it is the
      // one key that means the same thing everywhere.
      const inOffice = t === document.body || t === document.documentElement || t === canvas;
      // room editor owns the keyboard while active
      if (editRef.current && !typing) {
        if (e.key === 'Escape') {
          // First press puts the item down, second leaves the editor — quitting
          // outright meant there was no way to stop placing and start selecting.
          if (editRef.current.placing) onDisarmRef.current();
          else onExitEditRef.current();
          return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && editSelRef.current != null) {
          const cell = editCell();
          if (cell?.room) {
            const items = [...(mapsRef.current.decor[cell.room.id] ?? [])];
            items.splice(editSelRef.current, 1);
            editSelRef.current = null;
            onChangeDecorRef.current(cell.room.id, items);
          }
          return;
        }
        return; // no room-nav while editing
      }
      if (e.key === 'Escape') {
        onSelectRef.current(null);
        if (typing) t.blur();
        return;
      }
      if (typing || !inOffice) return;
      const lay = layoutRef.current;
      const roomCells = lay.cells.filter((c) => c.kind === 'room');
      if (!roomCells.length) return;

      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const cur = focusRef.current != null ? lay.cells[focusRef.current] : null;
        if (!cur) {
          setFocusCell(roomCells[0].idx);
          revealCell(roomCells[0].idx);
          return;
        }
        const cx = cur.x + cur.w / 2;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const rowCells = lay.cells
            .filter((c) => c.row === cur.row && c.kind === 'room' && c.idx !== cur.idx)
            .filter((c) => (e.key === 'ArrowLeft' ? c.x < cur.x : c.x > cur.x))
            .sort((a, b) => (e.key === 'ArrowLeft' ? b.x - a.x : a.x - b.x));
          if (rowCells[0]) { setFocusCell(rowCells[0].idx); revealCell(rowCells[0].idx); }
        } else {
          const dir = e.key === 'ArrowUp' ? -1 : 1;
          for (let r = cur.row + dir; r >= 0 && r < lay.rows; r += dir) {
            const rowRooms = lay.cells.filter((c) => c.row === r && c.kind === 'room');
            if (!rowRooms.length) continue;
            rowRooms.sort(
              (a, b) => Math.abs(a.x + a.w / 2 - cx) - Math.abs(b.x + b.w / 2 - cx),
            );
            setFocusCell(rowRooms[0].idx);
          revealCell(rowRooms[0].idx);
            return;
          }
        }
      } else if (e.key === 'Enter') {
        const cell = focusRef.current != null ? lay.cells[focusRef.current] : roomCells[0];
        if (!cell?.room) return;
        e.preventDefault();
        const deskBots = lay.desks.filter((d) => d.cellIdx === cell.idx).map((d) => d.robot);
        if (!deskBots.length) return;
        const curIdx = deskBots.findIndex((r) => r.sessionId === selectedRef.current);
        onSelectRef.current(deskBots[(curIdx + 1) % deskBots.length]);
        if (focusRef.current == null) setFocusCell(cell.idx);
      }
    };

    const onWheel = (e: WheelEvent) => {
      const max = maxScroll();
      if (max <= 0) return; // everything fits — let the page have the gesture
      e.preventDefault();
      scrollRef.current = Math.max(0, Math.min(scrollRef.current + e.deltaY, max));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('contextmenu', onContext);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('dblclick', onDbl);
    window.addEventListener('keydown', onKey);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDbl);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const roomsById = useMemo(() => {
    const m: Record<string, Room> = {};
    for (const r of snapshot.rooms) m[r.id] = r;
    return m;
  }, [snapshot.rooms]);
  const attention = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const r of snapshot.rooms) m[r.id] = r.needsAttention;
    return m;
  }, [snapshot.rooms]);

  return (
    <>
      <canvas ref={canvasRef} className={`world ${hoverId ? 'world--hit' : ''}`} />
      {!edit && (
        <RoomLabels
          layout={layout}
          names={maps.names}
          attention={attention}
          labelsRef={labelsRef}
          focusMode={focus}
          onSettings={(id) => {
            const room = roomsById[id];
            if (room) onOpenSettings(room);
          }}
        />
      )}
    </>
  );
}
