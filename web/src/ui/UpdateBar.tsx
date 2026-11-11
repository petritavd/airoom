import { useCallback, useEffect, useState } from 'react';
import type { ReleaseInfo } from '@shared/types';
import { API_BASE } from '../net/base';

/**
 * News from airoom.dev, when there is any: a newer build, or a line from us.
 *
 * The server does the asking (server/src/release.ts) and this reflects its
 * answer, polled slowly. The strip shows once per build and
 * once per announcement — dismissed is dismissed, until there is something new
 * to say. It never counts down and never nags. The Download link goes straight
 * to the file: nobody who already runs airoom should meet the email form again.
 */
export function useRelease() {
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/release`);
      setRelease((await r.json()) as ReleaseInfo);
    } catch {
      /* server not up yet — nothing to say until it is */
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30 * 60_000);
    return () => clearInterval(t);
  }, [refresh]);
  return { release, refresh };
}

const SEEN_BUILD = 'airoom.update.dismissed';
const SEEN_NOTE = 'airoom.message.dismissed';
const recall = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const remember = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode — it comes back next launch, which is fine */
  }
};

/** The build for THIS machine: a Windows app must never be handed a dmg. */
function downloadFor(latest: NonNullable<ReleaseInfo['latest']>): string {
  const win = document.body.classList.contains('platform-win32') || /Windows/i.test(navigator.userAgent);
  return win && latest.windowsUrl ? latest.windowsUrl : latest.url;
}

export function UpdateBar({ release }: { release: ReleaseInfo }) {
  // Dismissal lives in localStorage; this only forces the re-render.
  const [, bump] = useState(0);
  const build =
    release.updateAvailable && release.latest && recall(SEEN_BUILD) !== release.latest.version ? release.latest : null;
  // A build takes precedence over a note; once the build is dismissed the note gets its turn.
  const note = !build && release.message && recall(SEEN_NOTE) !== release.message.id ? release.message : null;
  if (!build && !note) return null;
  const dismiss = () => {
    if (build) remember(SEEN_BUILD, build.version);
    else if (note) remember(SEEN_NOTE, note.id);
    bump((n) => n + 1);
  };
  return (
    <div className={`update${build ? ' update--build' : ''}`} role="status">
      {build ? (
        <>
          <span className="update__text">
            airoom <b>{build.version}</b> is out
          </span>
          <span className="update__gap" />
          {build.notes && (
            <a className="update__link" href={build.notes} target="_blank" rel="noreferrer">
              What's new
            </a>
          )}
          <a className="update__get" href={downloadFor(build)} target="_blank" rel="noreferrer">
            Download
          </a>
        </>
      ) : (
        <>
          <span className="update__text">{note!.text}</span>
          <span className="update__gap" />
          {note!.url && (
            <a className="update__link" href={note!.url} target="_blank" rel="noreferrer">
              Read more
            </a>
          )}
        </>
      )}
      <button className="update__x" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
        ×
      </button>
    </div>
  );
}
