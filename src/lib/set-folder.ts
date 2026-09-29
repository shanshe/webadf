// Card-on-card inside a collection view, like making a folder on a phone's
// home screen (operator, 2026-09-29; replaces the hold-anywhere dwell of
// feat/set-dwell, whose target slid out from under the pointer while it
// waited).
//
// Every card has a CENTRE and an EDGE, judged from the POINTER against the
// card's own slot -- dnd-kit's droppable rect, which is measured without the
// sortable preview's transforms, so a card that has been nudged aside still
// answers for the place it came from.
//
//   - Pointer in a card's edge: the normal reorder preview; a drop reorders.
//   - Pointer in a card's centre: nothing moves. After ARM_DELAY_MS the card
//     arms ("Add to disk set") and a drop there opens the set dialog. A drop
//     in a centre before it arms does nothing at all.
//   - Leaving the centre disarms at once.
//
// Pure: time is passed in, so the rules are testable without timers. The
// provider (collection-provider.tsx) feeds it the zone its collision
// detection computed and one timer tick per target.

/** How long the pointer must rest in a card's centre before a drop there means "make a set". */
export const ARM_DELAY_MS = 300;

/** The centre is the middle half of a card's width... */
export const CENTRE_WIDTH_FRACTION = 0.5;
/** ...and the middle 60% of its height. Everything else is edge. */
export const CENTRE_HEIGHT_FRACTION = 0.6;

export type Zone = 'centre' | 'edge';

export interface Point { readonly x: number; readonly y: number }
export interface Rect { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

/**
 * Which part of `rect` the pointer is in. The centre's boundary counts as
 * centre. A pointer outside the rect is edge -- the caller only asks about the
 * card the pointer is within, and "edge" is the answer that changes nothing
 * about today's reorder.
 */
export function zoneOf(p: Point, rect: Rect): Zone {
  const insetX = (rect.width * (1 - CENTRE_WIDTH_FRACTION)) / 2;
  const insetY = (rect.height * (1 - CENTRE_HEIGHT_FRACTION)) / 2;
  const inX = p.x >= rect.left + insetX && p.x <= rect.left + rect.width - insetX;
  const inY = p.y >= rect.top + insetY && p.y <= rect.top + rect.height - insetY;
  return inX && inY ? 'centre' : 'edge';
}

export interface FolderState {
  /** The card whose CENTRE the pointer is in, or null (an edge, a gap, its own slot). */
  readonly targetId: string | null;
  /** When the pointer entered `targetId`'s centre (ms, any monotonic clock). */
  readonly since: number;
  /** Whether the pointer has rested in that centre for ARM_DELAY_MS. */
  readonly armed: boolean;
}

export const IDLE_FOLDER: FolderState = { targetId: null, since: 0, armed: false };

/**
 * The pointer is now in the centre of `targetId` (null: in no card's centre).
 * Staying in the same centre keeps its clock and returns the SAME object, so
 * a caller can skip a re-render; any change -- including leaving and coming
 * back -- starts a fresh, unarmed wait.
 */
export function folderOver(s: FolderState, targetId: string | null, now: number): FolderState {
  if (targetId === null) return s.targetId === null ? s : IDLE_FOLDER;
  if (targetId !== s.targetId) return { targetId, since: now, armed: false };
  return folderTick(s, now);
}

/** Time has passed with the pointer where it was: arm once the wait is over. */
export function folderTick(s: FolderState, now: number): FolderState {
  if (s.targetId === null || s.armed || now - s.since < ARM_DELAY_MS) return s;
  return { ...s, armed: true };
}

/** The armed card's id, or null. */
export function armedId(s: FolderState): string | null {
  return s.armed ? s.targetId : null;
}

export type DropOutcome = 'set' | 'reorder' | 'none';

/**
 * What a card-on-card drop inside a collection means. `drop` is the card the
 * pointer was released over and the zone it was in there.
 *   - centre of the armed card -> 'set' (open the dialog)
 *   - centre, not armed        -> 'none' (neither reorder nor dialog)
 *   - edge                     -> 'reorder'
 */
export function dropOutcome(s: FolderState, drop: { overId: string; zone: Zone }): DropOutcome {
  if (drop.zone === 'edge') return 'reorder';
  return armedId(s) === drop.overId ? 'set' : 'none';
}
