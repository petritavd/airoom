import { useLayoutEffect, type RefObject } from 'react';

/**
 * Grow a textarea with what is typed or pasted, up to a fraction of the
 * window, then scroll inside. Done in code rather than `field-sizing`
 * because the engine reports support for that property without acting on it
 * in these boxes, and a brief the size of a ticket must not be read through a
 * five-line slot. Height is recomputed whenever the value changes, so a
 * user's own drag-resize holds until they type again.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxFraction = 0.55): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.max(120, Math.floor(window.innerHeight * maxFraction));
    const wanted = el.scrollHeight + 2; // + the borders
    el.style.height = `${Math.min(wanted, max)}px`;
    el.style.overflowY = wanted > max ? 'auto' : 'hidden';
  }, [ref, value, maxFraction]);
}
