import { DECOR, PRESETS } from '../render/decor';
import { DecorThumb } from './DecorThumb';
import type { FloorMat } from '../roomConfig';

const FLOORS: { key: FloorMat; label: string }[] = [
  { key: 'checker', label: 'Checker' },
  { key: 'wood', label: 'Wood' },
  { key: 'tile', label: 'Tile' },
  { key: 'carpet', label: 'Carpet' },
  { key: 'stone', label: 'Stone' },
  { key: 'grass', label: 'Grass' },
];

interface Props {
  roomName: string;
  placing: string | null;
  floor: FloorMat | undefined;
  hasDecor: boolean;
  onPick: (key: string | null) => void;
  onFloor: (mat: FloorMat) => void;
  onPreset: (key: string) => void;
  onClear: () => void;
  onDone: () => void;
}

/**
 * The room-editor palette: pick an item, click the room to place it.
 *
 * The name and Done stay put while the items scroll. You change a floor, glance
 * at the room, and want Done — not a scroll back up to find it. Same for the
 * hint, which is what tells you how to stop placing, and for Clear, which is a
 * decision that should never be sitting just off the bottom of a list.
 */
export function DecorPalette({
  roomName,
  placing,
  floor,
  hasDecor,
  onPick,
  onFloor,
  onPreset,
  onClear,
  onDone,
}: Props) {
  return (
    <aside className="palette">
      <div className="palette__head">
        <span className="palette__title">🎨 {roomName}</span>
        <button className="connect__copy palette__done" onClick={onDone}>
          Done
        </button>
      </div>
      <div className="palette__hint">
        {placing
          ? 'Click the room to place · Esc or click the item again to stop'
          : 'Drag things around · right-click one to remove it'}
      </div>

      <div className="palette__scroll">
      <div className="palette__section">Items</div>
      <div className="palette__grid">
        {DECOR.map((d) => (
          <button
            key={d.key}
            className={`palette__item ${placing === d.key ? 'palette__item--on' : ''}`}
            title={d.label}
            onClick={() => onPick(placing === d.key ? null : d.key)}
          >
            <DecorThumb def={d} />
            <span className="palette__label">{d.label}</span>
          </button>
        ))}
      </div>

      <div className="palette__section">Floor</div>
      <div className="palette__floors">
        {FLOORS.map((f) => (
          <button
            key={f.key}
            className={`palette__floor ${floor === f.key ? 'palette__floor--on' : ''}`}
            onClick={() => onFloor(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="palette__section">Presets</div>
      <div className="palette__floors">
        {PRESETS.map((p) => (
          <button key={p.key} className="palette__floor" onClick={() => onPreset(p.key)}>
            {p.label}
          </button>
        ))}
      </div>

      </div>

      {hasDecor && (
        <div className="palette__foot">
          <button className="palette__clear" onClick={onClear}>
            Clear all decor
          </button>
        </div>
      )}
    </aside>
  );
}
