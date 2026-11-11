import { useEffect, useState } from 'react';

/**
 * Keeps keyboard focus inside a dialog while it is open, and hands it back
 * when the dialog closes.
 *
 * Every panel here says `aria-modal`, and until now none of them meant it:
 * Shift+Tab from the first control landed on a zero-width gear behind the
 * scrim. This wraps Tab at both ends and, on open, focuses the dialog itself
 * unless something inside already took focus — the dialog, not its first
 * button, because a focused button fires on Space and someone who starts
 * typing straight away must not press it by accident. On close, focus goes
 * back to whatever had it before, usually the control that opened the panel.
 * Escape is not handled here; each panel owns its own.
 *
 * Returns a callback ref, so a component that swaps its root between views
 * (a dialog with several screens) re-arms the trap on the new element.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

export function useFocusTrap<T extends HTMLElement>(active = true): (node: T | null) => void {
  const [root, setRoot] = useState<T | null>(null);
  useEffect(() => {
    if (!active || !root) return;
    const opener = document.activeElement as HTMLElement | null;

    // Initial focus, one frame late so a child's own autoFocus wins.
    const raf = requestAnimationFrame(() => {
      if (root.contains(document.activeElement)) return;
      if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
      root.focus({ preventScroll: true });
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables(root);
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const cur = document.activeElement as HTMLElement | null;
      const idx = cur ? list.indexOf(cur) : -1; // -1: the dialog itself, or outside
      if (e.shiftKey) {
        if (idx <= 0) {
          e.preventDefault();
          list[list.length - 1].focus();
        }
      } else if (idx === -1 || idx === list.length - 1) {
        e.preventDefault();
        list[0].focus();
      }
    };
    root.addEventListener('keydown', onKey);

    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener('keydown', onKey);
      // Give focus back — but only if it is still ours to give. If the person
      // has already clicked somewhere else, that click wins.
      const now = document.activeElement;
      const ours = now === document.body || (now instanceof Node && root.contains(now));
      if (ours && opener && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, [active, root]);
  return setRoot;
}
