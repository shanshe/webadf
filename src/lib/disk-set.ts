/**
 * Disk sets (spec 2026-09-28-disk-sets §2): every change to which title a disk
 * belongs to, or to its number, is planned here -- pure, so the rules are
 * tested without a database. disk-set-store.ts applies a Plan as one batch.
 */
export type SetDisk = { id: string; gameId: string; diskNo: number };
export type DeviceRef = { id: string; desiredDiskId: string | null; mountedDiskId: string | null };
export type DeviceUpdate = { deviceId: string; desired?: { gameId: string; diskNo: number }; mounted?: { gameId: string; diskNo: number } };
export type Renumber = { diskId: string; gameId: string; diskNo: number };
export type Plan = { renumber: Renumber[]; emptiedGameIds: string[]; devices: DeviceUpdate[] };

export class PlanError extends Error {
  constructor(public code: 'stale_order' | 'nothing_to_add' | 'same_title' | 'not_in_a_set' | 'stale_undo') { super(code); }
}

const byNo = (a: SetDisk, b: SetDisk) => a.diskNo - b.diskNo || (a.id < b.id ? -1 : 1);

function deviceUpdates(renumber: Renumber[], devices: DeviceRef[]): DeviceUpdate[] {
  const to = new Map(renumber.map((r) => [r.diskId, { gameId: r.gameId, diskNo: r.diskNo }]));
  const out: DeviceUpdate[] = [];
  for (const dev of devices) {
    const desired = dev.desiredDiskId ? to.get(dev.desiredDiskId) : undefined;
    const mounted = dev.mountedDiskId ? to.get(dev.mountedDiskId) : undefined;
    if (desired || mounted) out.push({ deviceId: dev.id, ...(desired ? { desired } : {}), ...(mounted ? { mounted } : {}) });
  }
  return out;
}

export function planAddDisks(
  target: { gameId: string; disks: SetDisk[] }, incoming: SetDisk[], allDisksOfSources: SetDisk[], devices: DeviceRef[],
): Plan {
  if (incoming.length === 0) throw new PlanError('nothing_to_add');
  if (incoming.some((x) => x.gameId === target.gameId)) throw new PlanError('same_title');
  const sourceOrder: string[] = [];
  for (const x of incoming) if (!sourceOrder.includes(x.gameId)) sourceOrder.push(x.gameId);
  let next = target.disks.reduce((m, x) => Math.max(m, x.diskNo), 0);
  const renumber: Renumber[] = [];
  for (const g of sourceOrder) {
    for (const x of allDisksOfSources.filter((y) => y.gameId === g).sort(byNo)) {
      renumber.push({ diskId: x.id, gameId: target.gameId, diskNo: ++next });
    }
  }
  return { renumber, emptiedGameIds: sourceOrder, devices: deviceUpdates(renumber, devices) };
}

export function planReorder(target: { gameId: string; disks: SetDisk[] }, orderedIds: string[], devices: DeviceRef[]): Plan {
  const current = new Set(target.disks.map((x) => x.id));
  const given = new Set(orderedIds);
  if (orderedIds.length !== target.disks.length || given.size !== orderedIds.length
      || [...given].some((id) => !current.has(id))) throw new PlanError('stale_order');
  const renumber = orderedIds.map((id, i) => ({ diskId: id, gameId: target.gameId, diskNo: i + 1 }));
  return { renumber, emptiedGameIds: [], devices: deviceUpdates(renumber, devices) };
}

export function planMoveOut(disk: SetDisk, newGameId: string, remaining: SetDisk[], devices: DeviceRef[]): Plan {
  const renumber: Renumber[] = [{ diskId: disk.id, gameId: newGameId, diskNo: 1 }];
  [...remaining].sort(byNo).forEach((x, i) => renumber.push({ diskId: x.id, gameId: disk.gameId, diskNo: i + 1 }));
  return { renumber, emptiedGameIds: remaining.length === 0 ? [disk.gameId] : [], devices: deviceUpdates(renumber, devices) };
}
