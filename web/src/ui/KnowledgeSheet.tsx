import { useEffect } from 'react';
import type { KnowledgeDoc, KnowledgeEvent } from '@shared/types';
import { ago } from './Queue';
import { useFocusTrap } from './useFocusTrap';

/**
 * What one agent was told, and what it wrote down.
 *
 * An agent with a Cognivio connector asks its team's knowledge base for
 * context before it works and writes back what it learned. In the chat those
 * calls are single lines among hundreds. This sheet is the same calls on
 * their own, oldest first, so when an agent does something unexpected the
 * first question ("what was it told?") has an answer where you are already
 * looking.
 *
 * All of it is read from the transcript on this machine. The sheet fetches
 * nothing and sends nothing.
 */

interface Props {
  agentName: string;
  roomShort: string;
  events: KnowledgeEvent[];
  /** Switch the sheet off for the room. It is also on the connector's row,
   *  but that row goes when the connector does, and off must stay reachable. */
  onTurnOff: () => void;
  onClose: () => void;
}

const VERB: Record<KnowledgeEvent['kind'], string> = {
  primed: 'Asked for context',
  searched: 'Searched',
  read: 'Read',
  wrote: 'Wrote',
  removed: 'Removed',
};

/** The counts in the header: distinct documents, not calls. `unlisted`
 *  counts answers the transcript does not hold, so the rest is a floor. */
export function knowledgeTotals(events: KnowledgeEvent[]): { given: number; wrote: number; unlisted: number } {
  const key = (d: KnowledgeDoc) => d.id ?? `t:${d.title}`;
  const given = new Set<string>();
  const wrote = new Set<string>();
  let unlisted = 0;
  for (const e of events) {
    if (e.failed) continue;
    if (e.kind === 'removed') continue;
    if (e.unlisted) unlisted++;
    for (const d of e.docs) (e.kind === 'wrote' ? wrote : given).add(key(d));
  }
  return { given: given.size, wrote: wrote.size, unlisted };
}

const when = (iso: string | null) => (iso ? (ago(iso) === 'just now' ? 'just now' : `${ago(iso)} ago`) : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function KnowledgeSheet({ agentName, roomShort, events, onTurnOff, onClose }: Props) {
  const trapRef = useFocusTrap<HTMLElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const totals = knowledgeTotals(events);

  return (
    <section className="kn" ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="kn-title" tabIndex={-1}>
      <header className="kn__head">
        <div className="kn__headText">
          <h2 className="kn__title" id="kn-title">
            Knowledge
          </h2>
          <p className="kn__sub">
            What {agentName} took from the team’s knowledge base in this session, and what it wrote back. Read from the transcript on this machine.
          </p>
        </div>
        <button className="panel__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="kn__scroll">
        <p className="kn__totals">
          Given {totals.unlisted ? 'at least ' : ''}
          {plural(totals.given, 'document')} · wrote {totals.wrote} · {plural(events.length, 'call')}
        </p>
        <ol className="kn__list">
          {events.map((e) => (
            <li key={e.id} className={`kn__event kn__event--${e.kind}`}>
              <div className="kn__eventHead">
                <span className={`kn__verb kn__verb--${e.kind}`}>{VERB[e.kind]}</span>
                {e.query && <span className="kn__query">“{e.query}”</span>}
                <span className="kn__gap" />
                {e.pending && <span className="kn__state">waiting for the answer</span>}
                {e.failed && <span className="kn__state kn__state--err">the knowledge base refused</span>}
                <span className="kn__when">{when(e.ts)}</span>
              </div>
              {e.unlisted && <p className="kn__none">The answer was too long for the transcript to keep, so what came back is not listed here.</p>}
              {e.docs.length === 0 && !e.pending && !e.failed && !e.unlisted && (
                <p className="kn__none">{e.kind === 'searched' ? 'Found nothing.' : 'No documents came back.'}</p>
              )}
              {e.docs.length > 0 && (
                <ul className="kn__docs">
                  {e.docs.map((d, i) => (
                    <li key={d.id ?? `${d.title}-${i}`} className="kn__docRow">
                      {d.type && <span className="kn__type">{d.type}</span>}
                      <span className="kn__docTitle">{d.title}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </div>
      <footer className="kn__foot">
        <span className="kn__ask">The knowledge sheet is on for {roomShort}.</span>
        <span className="kn__gap" />
        <button className="kn__btn" onClick={onTurnOff} title={`Stop reading transcripts for this in ${roomShort}. The chip goes from its desks.`}>
          Turn it off
        </button>
      </footer>
    </section>
  );
}
