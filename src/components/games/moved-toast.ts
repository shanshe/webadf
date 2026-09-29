'use client';

// "Moved to <set>" with Undo, shared by everything that adds titles to a disk
// set through POST /api/games/[id]/disks: the "Add disks…" dialog and a
// library card dropped on another card (set-drop-dialog.tsx). The server
// answers with one undo snapshot per title it emptied and deleted, and Undo
// puts each back through /api/disks/[id]/undo-move.

import { toast } from 'sonner';
import type { useRouter } from 'next/navigation';
import type { UndoSnapshot } from '@/lib/disk-set-store';

type AppRouter = ReturnType<typeof useRouter>;

const UNDO_TOAST_MS = 10_000;
const EXTRAS_NOTE = 'Covers, Demozoo links and collections of the old title are not restored by Undo.';

/**
 * After a successful Undo of ONE title: 'open' goes to it (the title page a
 * lone disk left for the set), 'stay' redraws where the person is (the
 * library, where the restored card simply reappears).
 */
export type AfterUndo = 'open' | 'stay';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Put every picked title back, one snapshot at a time. Stops at the first
 * refusal: a 409 means the set was changed since the add (a disk moved out,
 * the set reordered into another title), and the server writes nothing then.
 */
async function undoMoves(undo: UndoSnapshot[], router: AppRouter, after: AfterUndo): Promise<void> {
  const restored: string[] = [];
  // Why the loop stopped early, if it did: one reason, reported once below,
  // together with how much WAS undone -- a partial undo must never be silent.
  let failure: 'unreachable' | 'stale' | 'other' | null = null;
  for (const snapshot of undo) {
    let res: Response;
    try {
      res = await fetch(`/api/disks/${snapshot.diskIds[0]}/undo-move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshot }),
      });
    } catch {
      failure = 'unreachable';
      break;
    }
    if (res.status === 409) { failure = 'stale'; break; }
    if (!res.ok) { failure = 'other'; break; }
    const body = (await res.json().catch(() => null)) as { gameId?: string } | null;
    // Counted even without an id: the server said it was done.
    restored.push(body?.gameId ?? '');
  }

  if (failure) {
    const reason = failure === 'stale' ? 'the set has changed since'
      : failure === 'unreachable' ? 'the server could not be reached'
        : 'the server refused it';
    if (restored.length === 0) {
      toast.error(failure === 'stale' ? "Can't undo — the set has changed since"
        : failure === 'unreachable' ? 'Could not reach the server' : 'Could not undo',
      failure === 'unreachable' ? { description: 'Nothing was undone.' } : undefined);
    } else {
      toast.error(`Undid ${restored.length} of ${undo.length} — the rest could not be undone because ${reason}`);
    }
    router.refresh();
    return;
  }

  // One title put back: go to it when asked, as the lone disk's own page was
  // left for the set. Several: stay where the person is and redraw it --
  // there is no one title to land on.
  if (after === 'open' && undo.length === 1 && restored[0]) {
    toast.success('Undone');
    router.push(`/games/${restored[0]}`);
  } else {
    toast.success(undo.length === 1 ? 'Undone' : `Undone — ${plural(restored.length, 'title', 'titles')} restored`);
    router.refresh();
  }
}

/** "Moved to <set>", with Undo when the server returned anything to undo. */
export function movedToast(setTitle: string, undo: UndoSnapshot[], router: AppRouter, after: AfterUndo = 'open'): void {
  toast.success(`Moved to ${setTitle}`, {
    description: undo.some((s) => s.hadExtras) ? EXTRAS_NOTE : undefined,
    duration: undo.length > 0 ? UNDO_TOAST_MS : undefined,
    action: undo.length > 0
      ? { label: 'Undo', onClick: () => { void undoMoves(undo, router, after); } }
      : undefined,
  });
}
