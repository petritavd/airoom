import { MAX_TEAM_LANES, type RosterMember } from '@shared/types';

/**
 * A half-written brief survives closing the desk.
 *
 * Writing a good brief is real work, and the form used to throw it away the
 * moment the panel closed. The draft — text, crew, preset and placement — now
 * waits in localStorage under the room it was written for, so it can never
 * surface under another project. It is cleared when the team is hired, or
 * when the person discards it on purpose.
 */
export interface HireDraft {
  task: string;
  presetId: string;
  roster: RosterMember[];
  place: 'here' | 'room' | 'rooms';
  lanes: number;
}

const key = (roomId: string) => `airoom.hire.draft.${roomId}`;

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The room's draft, checked field by field; anything malformed is no draft. */
export function loadDraft(roomId: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): HireDraft | null {
  try {
    const raw = storage?.getItem(key(roomId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Record<keyof HireDraft, unknown>>;
    if (typeof d.task !== 'string' || !Array.isArray(d.roster)) return null;
    const roster = (d.roster as unknown[]).filter(
      (m): m is RosterMember =>
        !!m && typeof m === 'object' && typeof (m as RosterMember).kind === 'string' && typeof (m as RosterMember).label === 'string',
    );
    if (!roster.length) return null;
    return {
      task: d.task,
      presetId: typeof d.presetId === 'string' ? d.presetId : 'custom',
      roster,
      place: d.place === 'room' || d.place === 'rooms' ? d.place : 'here',
      lanes:
        typeof d.lanes === 'number' && Number.isFinite(d.lanes)
          ? Math.max(2, Math.min(MAX_TEAM_LANES, Math.round(d.lanes)))
          : 2,
    };
  } catch {
    return null;
  }
}

export function saveDraft(roomId: string, d: HireDraft, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(key(roomId), JSON.stringify(d));
  } catch {
    /* private mode or a full store — the draft lives on in the form */
  }
}

export function clearDraft(roomId: string, storage: Pick<Storage, 'removeItem'> | null = safeStorage()): void {
  try {
    storage?.removeItem(key(roomId));
  } catch {
    /* nothing to clear */
  }
}

/** Something worth keeping: text, or a crew or placement that is not the default. */
export function draftWorthKeeping(d: HireDraft): boolean {
  return d.task.trim().length > 0 || d.presetId !== 'standard' || d.place !== 'here';
}
