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
//   - Pointer in a card's edge: a drop reorders. The reorder preview shows
//     once the pointer RESTS there (EDGE_REST_MS within EDGE_REST_RADIUS_PX),
//     and then stays while the pointer is anywhere in that card's edge.
//   - Pointer in a card's centre: nothing moves. After ARM_DELAY_MS the card
//     arms ("Add to disk set") and a drop there opens the set dialog. A drop
//     in a centre before it arms does nothing at all.
//   - Leaving the centre disarms at once.
//
// Why the edge waits for a rest: the centre is ringed by edge, so every
// approach to a centre crosses an edge first. Measured in e2e with the
// preview shown at once, a hand-speed walk from one card into its
// neighbour's centre slid the neighbour a whole column (194 px) away the
// moment the pointer touched its edge, and back again as the pointer reached
// the centre -- the "slides out from under the pointer" failure, moved to the
// approach. A pointer passing through does not rest; one choosing a gap does.
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

/** How long the pointer must rest in a card's edge before the reorder preview shows. 0 = at once. */
export const EDGE_REST_MS: number = 200;
/** "Resting" allows this much drift -- a hand is never perfectly still. */
export const EDGE_REST_RADIUS_PX = 8;

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

/** The card under the pointer and which part of it, or null (a gap, the dragged card's own slot, a rail row). */
export interface Hit { readonly id: string; readonly zone: Zone }

export interface FolderState {
  /** The card whose CENTRE the pointer is in, or null. */
  readonly targetId: string | null;
  /** When the pointer entered `targetId`'s centre (ms, any monotonic clock). */
  readonly since: number;
  /** Whether the pointer has rested in that centre for ARM_DELAY_MS. */
  readonly armed: boolean;
  /** The card whose EDGE the pointer is in, or null. */
  readonly edgeId: string | null;
  /** Where the pointer's current rest in that edge began, and when. */
  readonly restAt: Point | null;
  readonly restSince: number;
  /** Whether the reorder preview for `edgeId` is showing. */
  readonly previewing: boolean;
}

export const IDLE_FOLDER: FolderState = {
  targetId: null, since: 0, armed: false, edgeId: null, restAt: null, restSince: 0, previewing: false,
};

/**
 * The pointer moved to `p`, over `hit`. Returns the SAME object when nothing
 * a caller renders or times has changed, so it can skip a re-render.
 *
 * Centre: staying in the same centre keeps its clock; any change --
 * including leaving and coming back -- starts a fresh, unarmed wait.
 * Edge: the rest clock restarts whenever the pointer drifts more than
 * EDGE_REST_RADIUS_PX from where the rest began; once the preview shows it
 * stays until the pointer leaves that card's edge.
 */
export function folderMove(s: FolderState, hit: Hit | null, p: Point, now: number): FolderState {
  const centreId = hit?.zone === 'centre' ? hit.id : null;
  const edgeId = hit?.zone === 'edge' ? hit.id : null;
  let next = s;

  if (centreId === null) {
    if (s.targetId !== null) next = { ...next, targetId: null, since: 0, armed: false };
  } else if (centreId !== s.targetId) {
    next = { ...next, targetId: centreId, since: now, armed: false };
  }

  if (edgeId === null) {
    if (s.edgeId !== null) next = { ...next, edgeId: null, restAt: null, restSince: 0, previewing: false };
  } else if (edgeId !== s.edgeId) {
    next = { ...next, edgeId, restAt: p, restSince: now, previewing: EDGE_REST_MS === 0 };
  } else if (!s.previewing && s.restAt && Math.hypot(p.x - s.restAt.x, p.y - s.restAt.y) > EDGE_REST_RADIUS_PX) {
    next = { ...next, restAt: p, restSince: now };
  }

  return folderTick(next, now);
}

/** Time has passed with the pointer where it was: arm a centre, or show an edge's preview, once due. */
export function folderTick(s: FolderState, now: number): FolderState {
  let next = s;
  if (s.targetId !== null && !s.armed && now - s.since >= ARM_DELAY_MS) next = { ...next, armed: true };
  if (s.edgeId !== null && !s.previewing && now - s.restSince >= EDGE_REST_MS) next = { ...next, previewing: true };
  return next;
}

/** When `folderTick` next has something to do (ms, same clock), or null. */
export function nextDue(s: FolderState): number | null {
  if (s.targetId !== null && !s.armed) return s.since + ARM_DELAY_MS;
  if (s.edgeId !== null && !s.previewing) return s.restSince + EDGE_REST_MS;
  return null;
}

/** The armed card's id, or null. */
export function armedId(s: FolderState): string | null {
  return s.armed ? s.targetId : null;
}

/** The card whose edge is showing the reorder preview, or null (no card moves). */
export function previewId(s: FolderState): string | null {
  return s.previewing ? s.edgeId : null;
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
