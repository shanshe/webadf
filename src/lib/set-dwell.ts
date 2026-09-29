// Hover-to-add inside a collection view (operator's option A, 2026-09-29).
//
// Filtered to one collection, a card dropped on a card REORDERS the
// collection. Holding the dragged card over another one for ARM_DELAY_MS
// "arms" that card instead, and a drop on an armed card asks to make the two
// one disk set -- the same dialog the unfiltered views open on any drop.
//
// Pure: time is passed in, so the rules can be tested without timers. The
// provider (collection-provider.tsx) feeds it dnd-kit's over-target changes
// and one timer tick per target.

/** How long a dragged card must rest over another before a drop means "make a set". */
export const ARM_DELAY_MS = 500;

export interface DwellState {
  /** The card the dragged one is over, or null. */
  readonly targetId: string | null;
  /** When the pointer arrived over `targetId` (ms, any monotonic clock). */
  readonly since: number;
  /** Whether `targetId` has been dwelt on for ARM_DELAY_MS. */
  readonly armed: boolean;
}

export const IDLE_DWELL: DwellState = { targetId: null, since: 0, armed: false };

/**
 * The dragged card is now over `targetId` (null: over no card). Staying on
 * the same target keeps its clock; any change -- including leaving and
 * coming back -- starts a fresh, unarmed wait.
 */
export function dwellOver(s: DwellState, targetId: string | null, now: number): DwellState {
  if (targetId === null) return IDLE_DWELL;
  if (targetId !== s.targetId) return { targetId, since: now, armed: false };
  return dwellTick(s, now);
}

/** Time has passed with the pointer where it was: arm once the wait is over. */
export function dwellTick(s: DwellState, now: number): DwellState {
  if (s.targetId === null || s.armed || now - s.since < ARM_DELAY_MS) return s;
  return { ...s, armed: true };
}

/** The armed card's id, or null. */
export function armedId(s: DwellState): string | null {
  return s.armed ? s.targetId : null;
}

/** What a drop on `overId` means: only a drop on the armed card makes a set. */
export function dropIntent(s: DwellState, overId: string | null): 'set' | 'reorder' {
  return overId !== null && armedId(s) === overId ? 'set' : 'reorder';
}
