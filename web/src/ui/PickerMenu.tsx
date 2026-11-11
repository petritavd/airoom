import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
  /** Rendered but not pickable — with the hint saying why. */
  disabled?: boolean;
  /** A small coloured dot before the label (e.g. a model's quality tier). */
  tone?: 'strong' | 'fair' | 'weak' | 'unfit';
}

/**
 * A dropdown that belongs to this app.
 *
 * A native `<select>` renders its list through the OS: rounded, light, system
 * blue — a macOS popup dropped into the middle of a pixel office. It cannot be
 * styled, only replaced, which is what this is. Same button, same list, drawn
 * by us.
 *
 * The model picker in the composer keeps its own richer menu (fast mode, a
 * "more models" submenu); this is for the plain "pick one of these" cases.
 */
export function PickerMenu({
  value,
  options,
  onPick,
  placement = 'up',
  className = '',
  label,
  ariaLabel,
  title,
}: {
  value: string;
  options: PickerOption[];
  onPick: (value: string) => void;
  /** Which way the list opens. The composer sits at the bottom of the panel. */
  placement?: 'up' | 'down';
  /** extra classes for the trigger, so callers keep their own accent states */
  className?: string;
  /** trigger content; defaults to the selected option's label. Takes nodes so
   *  a trigger can match the shape of whatever it sits beside — the hire
   *  form's "+ Add" has to look like the member chips it is queued with. */
  label?: ReactNode;
  ariaLabel?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  // Escape closes it, like every other layer in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <div className="mm" ref={ref}>
      <button
        type="button"
        className={className}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title ?? current?.hint}
      >
        {label ?? current?.label ?? value}
      </button>
      {open && (
        <>
          <div className="mm__scrim" onClick={() => setOpen(false)} />
          <div className={`mm__menu ${placement === 'down' ? 'mm__menu--down' : ''}`} role="menu">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                className="mm__row"
                role="menuitemradio"
                aria-checked={o.value === value}
                aria-disabled={o.disabled || undefined}
                disabled={o.disabled}
                title={o.hint}
                onClick={() => {
                  if (o.disabled) return;
                  onPick(o.value);
                  setOpen(false);
                }}
              >
                <span className="mm__name">
                  {o.tone && <span className={`mm__q mm__q--${o.tone}`} aria-hidden="true" />}
                  {o.label}
                </span>
                {/* The tick is ALWAYS rendered, just hidden when unselected:
                    it keeps every row's label on the same left edge, and a
                    column that appears and disappears is exactly what made
                    "which one is on?" hard to answer at a glance. */}
                <span className={`mm__tick ${o.value === value ? '' : 'mm__tick--off'}`} aria-hidden="true">
                  ✓
                </span>
                {o.hint && <span className="mm__desc">{o.hint}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
