/**
 * The airoom mark: a robot face and a room, read at the same time.
 *
 * Drawn on a 16×16 pixel grid — every shape is an integer rect, so there is not
 * a curve or a half-pixel anywhere and it stays crisp at any size. The two
 * readings share their parts rather than taking turns:
 *
 *   the square outline   → a head, and four walls seen from above
 *   the gap in the base  → a chin, and the room's doorway
 *   the two blocks       → eyes, and two desks with agents at them
 *   the bar above them   → a mouth, and the threshold of that doorway
 *   the nub on top       → an antenna, and the plant on the roof
 *
 * Two eye colours because a room holds more than one agent, and they don't all
 * do the same thing.
 */
const WALL = '#5eead4';
const EYE_B = '#5b9dff';

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      shapeRendering="crispEdges"
      aria-hidden
    >
      {/* antenna / roof unit */}
      <rect x="7" y="0" width="2" height="2" fill={WALL} />
      {/* walls, seen from above — the head's outline */}
      <rect x="1" y="2" width="14" height="2" fill={WALL} />
      <rect x="1" y="4" width="2" height="10" fill={WALL} />
      <rect x="13" y="4" width="2" height="10" fill={WALL} />
      {/* the base, left open in the middle: a chin, and a doorway */}
      <rect x="1" y="12" width="5" height="2" fill={WALL} />
      <rect x="10" y="12" width="5" height="2" fill={WALL} />
      {/* eyes / two occupied desks */}
      <rect x="4" y="6" width="3" height="3" fill={WALL} />
      <rect x="9" y="6" width="3" height="3" fill={EYE_B} />
      {/* mouth, sitting exactly above the doorway it doubles as */}
      <rect x="6" y="10" width="4" height="1" fill={WALL} />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="logo">
      <LogoMark size={26} />
      <span className="logo__word">
        airoom<span className="logo__tld">.dev</span>
      </span>
    </div>
  );
}
