# The redesign, as runnable source

This folder is the **spec** for the pixel-art redesign of the world — agents,
rooms, the building, and the decor catalog. It is not application code and
nothing in `web/` imports it. It exists so the implementation reads real
numbers instead of eyeballing screenshots.

```bash
node design/preview.mjs && open design/preview.html
```

Everything renders as SVG on an integer grid, which is the SVG equivalent of the
renderer's `ART_PIXEL = 2` + `imageSmoothingEnabled = false` discipline. Read the
modules; don't sample pixels out of the images.

The published design canvas (same content, with the rationale written out, plus
the two rejected art directions):
<https://claude.ai/code/artifact/eaf283b2-d531-48fa-9814-b7c1300c9acc>

## Decisions already made

- **Art direction: Bold 16-bit.** A hard `#141925` keyline on every object,
  saturated fills, strong silhouettes. `art.mjs` also carries `cozy` and `ops`
  palettes — they were the alternatives, and they share the sprite map exactly,
  so switching later is a colour-table swap, not a redraw.
- **Building: the open floor.** A project is a *zone* — its own carpet,
  waist-high glass on three sides, open onto a corridor — not a sealed
  rectangular cell.

## What maps to what

| File | Exports | Implements |
| --- | --- | --- |
| `art.mjs` | `DIRECTIONS`, `STATUS`, `ROBOT`, `ROBOT_OLD`, `robot()`, `mapRects()` | Palettes and the agent sprite |
| `scenes.mjs` | `deskUnit`, `chairRects`, `workstationRects`, `bench`, `glass`, `officeSVG`, `pool` | Furniture, the floor, lighting |
| `decor.mjs` | `DECOR` (31 items), `DROPPED` (8) | The decor catalog |
| `preview.mjs` | `ZONES`, `COLS`, `ROWS` | The zone plan, and the render harness |

Sprites are **char maps**, one string per row, rendered by `mapRects()` with
run-length merging — the same way you would author them in `draw.ts`. `ROBOT` is
the new agent; `ROBOT_OLD` is today's, reproduced from `drawRobot()` at its real
proportions and colours so before/after is honest.

Every decor item draws relative to its **anchor = bottom-centre of its
footprint**, matching `decor.ts`, and every footprint is unchanged.

## Numbers worth not re-deriving

- **Agent** — 22×32 art px. Same width as today; ten rows shorter (today's runs
  `hy-6` to `hy+36`, so 42). Head-top at row 4;
  seated is rows 0–25. Status colour appears on a 2×2 antenna bulb, a 6×1 brow
  over two 2×1 eyes inside a `#161c29` visor, and a 6×4 chest plate.
  This is **not more status pixels than today** — 38 against 44. The win is that
  they now sit inside dark fields, so they survive `cell.scale` 0.62–0.8.
- **Chair** — `#4a5268` / `#5f6a85` / `#2b3140`, backrest 28px wide, top edge at
  `-22` so it never rises above the head at `-24`. It is *wider* than today's
  24px backrest; width was never the problem. Position and saturation were.
- **Screen** — the whole panel takes the status colour, content is `#141925` on
  top. Each state differs by **shape**: code lines (working), prompt + cursor
  (waiting), `!` (error), tick (done), dark panel (idle).
- **Night** — veil `0.30 → 0.14`. Draw order matters: veil on the *room*, then
  lamp pools, **then** benches and agents, so they stay readable. Light is flat
  concentric rings (`pool()`), never a gradient.
- **Tile grid** — 16 art px. **Bench** — seat pitch 58, width `n * 58 + 10`.
- **Glass** — fill `rgba(196,226,240,0.42)`, top `rgba(255,255,255,0.62)`,
  bottom `rgba(64,102,122,0.45)`, steel posts every 64px, contact shadow beneath.

## Things that are cheaper than they look

Three were checked against the code before the design was drawn:

- **The open floor does not need a layout rewrite.** A zone *is* a `Cell`, so
  `computeLayout`, `interiorOf`, `hitTest` / `spawnHit` / `teamPodHit` /
  `roomHitTest`, `layoutDecor`, the `.maplabel` chips and keyboard focus nav all
  keep working. What changes is `drawShell`: carpet and glass instead of four
  walls. Agents move from the `SLOTS` scatter to one shared bench per zone —
  which is what `TeamPod` already does.
- **Dropping 8 decor items breaks nothing.** `layoutDecor` already skips unknown
  keys (`decor.ts:1213`), and none of the three `PRESETS` reference a cut item.
  Re-verify both before deleting.
- **Floor materials need one fix.** The plank algorithm (90px boards, 13px rows,
  a tone flip on ~38% of them) reads as *brick courses* once a cell is wider than
  ~350px — fine in a 320px room, wrong in an open plan. `scenes.mjs` uses 170px
  boards, 11px rows, flips above 0.74.

## One thing this spec got wrong

`cell.scale` used to be `clamp(min(w / 320, h / 215), …)` off each cell's own
box. That was a reasonable level-of-detail knob when rooms were uniform walled
boxes. On the open floor it is a bug, and the spec missed it: `chunkNeed()`
sizes a band by how many bench rows it needs, so **cell height tracks
headcount** — and furniture size derived from it made a one-agent room's robot
visibly smaller than a busy room's. Raising the ceiling to 1.7 turned a
previously invisible variance into a 2.7x spread.

Scale is now a property of the FLOOR, not the cell: `worldScale` in `draw.ts`,
set once per `computeLayout` from the viewport and read by every cell. It still
answers the question the old formula was reaching for — "how much room does this
screen have" — so a 27" display still grows the furniture, but there is no
per-cell input left, so rooms cannot disagree.

`computeLayout` receives the canvas's CSS-pixel rect, so cells and the reference
constants are in the same space: `SCALE_REF_W 960 x SCALE_REF_H 645` is exactly
a three-across, three-down floor of the old 320x215 room, which puts a laptop
window near 1.

## Not in the first pass

The canvas has a board of follow-ups. Keep them out until the floor ships:
zone status halos (`officeSVG(..., { zoneStatus: true })` — visible in the
preview's third section), teams walking to the meeting room, live notes on the
pinboard, zones growing with headcount.

`tv` was kept but is the weakest item in the catalog — a dead screen on a wall.
Wire it to live room state and it becomes one of the best.
