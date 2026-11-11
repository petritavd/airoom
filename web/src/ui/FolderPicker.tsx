import { useEffect, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';
import { API_BASE } from '../net/base';
import { basename, isAbsolutePath } from '../pathish';

interface Listing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  error?: string;
}

/**
 * In-app folder browser for "+ project", backed by the airoom server's
 * /fs/list endpoint (local machine, loopback-only). Used wherever the native
 * OS picker isn't available (browsers), and as a safety net in the app.
 */
export function FolderPicker({
  onPick,
  onClose,
}: {
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const trapRef = useFocusTrap<HTMLDivElement>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);

  const navigate = async (target?: string) => {
    setLoading(true);
    try {
      const qs = target ? `?path=${encodeURIComponent(target)}` : '';
      const r = await fetch(`${API_BASE}/fs/list${qs}`);
      const data: Listing = await r.json();
      setListing(data);
      setDraft(data.path);
    } catch {
      setListing((cur) => (cur ? { ...cur, error: 'Server unreachable' } : null));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void navigate(); // starts at the home directory
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes from anywhere in the picker. It used to work only while the
  // path box had focus — click one folder and the key went dead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="connect picker" ref={trapRef} role="dialog" aria-modal="true" aria-label="Add a project">
      <div className="connect__head">
        <span className="connect__title">Add a project</span>
        <button className="panel__close" onClick={onClose} aria-label="Cancel">
          ×
        </button>
      </div>

      <div className="connect__cmdrow">
        <input
          className="connect__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isAbsolutePath(draft)) void navigate(draft.trim());
          }}
          spellCheck={false}
        />
        <button
          className="connect__copy"
          onClick={() => isAbsolutePath(draft) && navigate(draft.trim())}
          title="Go to this path"
        >
          Go
        </button>
      </div>

      <div className="picker__list">
        {listing?.parent && (
          <button className="picker__row picker__row--up" onClick={() => navigate(listing.parent!)}>
            ↩ ..
          </button>
        )}
        {/* A drive root has no parent folder, but on Windows it does have siblings. */}
        {listing && !listing.parent && /^[A-Za-z]:[\\/]?$/.test(listing.path) && (
          <button className="picker__row picker__row--up" onClick={() => navigate('/')}>
            ↩ All drives
          </button>
        )}
        {listing?.dirs.map((d) => (
          <button className="picker__row" key={d.path} onClick={() => navigate(d.path)}>
            📁 {d.name}
          </button>
        ))}
        {listing && !listing.dirs.length && !listing.error && (
          <div className="picker__empty">no subfolders</div>
        )}
        {listing?.error && <div className="picker__empty">⚠ {listing.error}</div>}
        {loading && <div className="picker__empty">…</div>}
      </div>

      <div className="picker__foot">
        <span className="picker__current" title={listing?.path}>
          {listing ? (listing.path ? basename(listing.path) : 'All drives') : ''}
        </span>
        <button
          className="connect__copy"
          disabled={!listing || !!listing.error}
          onClick={() => listing && onPick(listing.path)}
        >
          Add this folder
        </button>
      </div>
    </div>
  );
}
