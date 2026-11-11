import { useEffect, useRef } from 'react';
import { THEMES } from '../render/draw';
import type { DecorDef } from '../render/decor';

// A neutral, warm-accented theme so rug/beanbag accents read nicely as icons.
const ICON_THEME = THEMES[0];

/**
 * A live pixel-art thumbnail of a decor item — the palette icon IS the thing you
 * place, rendered by the item's own draw(). Crisp (nearest-neighbour, DPR-aware)
 * and static (time = 0), so it looks consistent regardless of OS emoji fonts.
 */
export function DecorThumb({ def, size = 36 }: { def: DecorDef; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(size * dpr);
    cv.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);

    // Fit the item's footprint into the box with a little breathing room.
    const pad = 5;
    const avail = size - pad * 2;
    const s = Math.min(avail / def.w, avail / def.h, 1.7);
    const drawH = def.h * s;
    ctx.save();
    ctx.translate(size / 2, (size + drawH) / 2); // anchor = bottom-centre
    ctx.scale(s, s);
    def.draw(ctx, 0, ICON_THEME);
    ctx.restore();
  }, [def, size]);
  return <canvas ref={ref} className="palette__thumb" style={{ width: size, height: size }} />;
}
