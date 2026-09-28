import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, addDisk, authHeader, cleanupSeeded } from './device-helpers';

/**
 * Disk sets (spec 2026-09-28-disk-sets, Task 10): the first time the title
 * page's Disk set section, the Add disks… dialog and the upload suggestion
 * run in a real browser against the real database.
 *
 * Every test signs up its own org. Disks that need a real image (the upload
 * suggestion reads volume names; move-out names the new title after one) go
 * through the REAL ingest flow and are purged with the org; the rest are
 * seeded rows, tracked by device-helpers. cleanupSeeded removes both.
 */
test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(`disk-sets-${s}`).digest('hex');

/**
 * A real FFS volume named `volumeName`, with one file of random bytes so its
 * sha256 is new on every run (blobs are global and content-addressed; a fixed
 * image would dedupe against an earlier run and prove nothing about ingest).
 */
function adfBytes(volumeName: string): Buffer {
  return Buffer.from(syntheticVolume({
    filesystem: 'FFS',
    volumeName,
    entries: [{ name: 'id', bytes: new TextEncoder().encode(randomUUID()) }],
  }));
}

/** Upload one image through the real presign → PUT → complete flow. */
async function ingestAdf(page: Page, filename: string, content: Buffer): Promise<string> {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const presign = await page.request.post('/api/ingest/presign', {
    data: { files: [{ sha256, sizeBytes: content.length }] },
  });
  expect(presign.status()).toBe(200);
  const { uploads } = await presign.json();
  if (uploads.length > 0) {
    const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
    if (!put.ok) throw new Error(`test setup: blob PUT failed with ${put.status}`);
  }
  const done = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: content.length, filename }] },
  });
  expect(done.status()).toBe(200);
  return sha256;
}

async function diskOf(orgId: string, sha256: string) {
  const [row] = await getDb().select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo })
    .from(disks).where(and(eq(disks.orgId, orgId), eq(disks.sha256, sha256)));
  if (!row) throw new Error(`no disk for ${sha256.slice(0, 12)}`);
  return row;
}

async function diskNos(ids: string[]): Promise<Record<string, { gameId: string; diskNo: number }>> {
  const rows = await getDb().select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo })
    .from(disks).where(inArray(disks.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, { gameId: r.gameId, diskNo: r.diskNo }]));
}

async function orgGames(orgId: string) {
  return getDb().select({ id: games.id, title: games.title }).from(games).where(eq(games.orgId, orgId));
}

async function gameExists(id: string): Promise<boolean> {
  return (await getDb().select({ id: games.id }).from(games).where(eq(games.id, id))).length > 0;
}

/** The set's disk rows, top to bottom, as ids. */
async function rowOrder(page: Page): Promise<string[]> {
  return page.getByTestId('disk-set-section').locator(':scope > div.glass-card[data-testid^="disk-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('disk-'.length)));
}

/** Reorder mode's rows, top to bottom, as ids. */
async function reorderOrder(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="disk-reorder-row-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('disk-reorder-row-'.length)));
}

/** Seed a title with `n` disks (no images). */
async function seedSet(orgId: string, title: string, n: number) {
  const tag = runTag();
  const first = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(`${tag}-1`) });
  const ids = [first.diskId];
  const shas = [sha(`${tag}-1`)];
  for (let i = 2; i <= n; i++) {
    const s = sha(`${tag}-${i}`);
    ids.push((await addDisk(orgId, first.gameId, { diskNo: i, sha256: s })).diskId);
    shas.push(s);
  }
  return { gameId: first.gameId, ids, shas };
}

/**
 * Drag with the real pointer -- copied from disk-drag-drop.spec.ts's
 * `dragOnto` (itself from collections.spec.ts): dnd-kit's MouseSensor needs
 * 8px of travel it can SEE accumulate, so a single jump never starts a drag.
 */
async function dragOnto(page: Page, source: Locator, target: Locator) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('drag: source or target is not visible');
  const sx = from.x + from.width / 2;
  const sy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 14, sy + 14, { steps: 6 });
  await page.mouse.move(tx, ty, { steps: 15 });
  await page.mouse.move(tx, ty, { steps: 2 });
  await page.mouse.up();
}


/**
 * Drop the five 3.1.4-style files on /ingest and wait for the panel. Each
 * image's volume name is its filename without the extension, so labels and
 * the suggested name come out the same whether suggestSet reads the volume or
 * falls back to the filename. Dropped in a deliberately wrong order
 * (Install third) so "Install first" is the suggestion's doing.
 */
async function dropRelease(page: Page, orgId: string) {
  const order = ['Workbench3_1_4', 'Extras3_1_4', 'Install3_1_4', 'Fonts', 'Locale'];
  const files = order.map((v) => ({ name: `${v}.adf`, mimeType: 'application/octet-stream', buffer: adfBytes(v) }));
  await page.goto('/ingest');
  await page.getByTestId('file-input').setInputFiles(files);
  await expect(page.getByTestId('ingest-row')).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    await expect(page.getByTestId('ingest-row').nth(i).locator('[data-state="done"]')).toBeVisible({ timeout: 60_000 });
  }
  await expect(page.getByTestId('set-suggestion')).toBeVisible({ timeout: 30_000 });

  const id: Record<string, string> = {};
  const shas: Record<string, string> = {};
  for (let i = 0; i < order.length; i++) {
    shas[order[i]] = createHash('sha256').update(files[i].buffer).digest('hex');
    id[order[i]] = (await diskOf(orgId, shas[order[i]])).id;
  }
  return { id, shas, files };
}

async function panelOrder(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="set-suggestion-row-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('set-suggestion-row-'.length)));
}

// ---------------------------------------------------------------------------

test('upload: the 3.1.4 disks are suggested as "AmigaOS 3.1.4", Install first; accepting all five makes the set', async ({ page }) => {
  test.setTimeout(120_000);
  const { orgId } = await signUpFresh(page);
  const { id } = await dropRelease(page, orgId);

  await expect(page.getByTestId('set-suggestion')).toContainText('These 5 disks look like one set.');
  await expect(page.getByTestId('set-suggestion-name')).toHaveValue('AmigaOS 3.1.4');

  const panel = await panelOrder(page);
  expect(panel[0]).toBe(id.Install3_1_4);
  expect(panel.slice(0, 3)).toEqual([id.Install3_1_4, id.Workbench3_1_4, id.Extras3_1_4]);
  for (const v of ['Install3_1_4', 'Workbench3_1_4', 'Extras3_1_4']) {
    await expect(page.getByTestId(`set-suggestion-tick-${id[v]}`)).toBeChecked();
  }
  for (const v of ['Fonts', 'Locale']) {
    await expect(page.getByTestId(`set-suggestion-tick-${id[v]}`)).not.toBeChecked();
    await page.getByTestId(`set-suggestion-tick-${id[v]}`).check();
  }

  await page.getByTestId('set-suggestion-accept').click();
  await expect(page.getByTestId('set-suggestion')).toHaveCount(0);

  // The set is Install's title, renamed; every other title is gone.
  const setId = (await diskNos([id.Install3_1_4]))[id.Install3_1_4].gameId;
  const left = await orgGames(orgId);
  expect(left).toEqual([{ id: setId, title: 'AmigaOS 3.1.4' }]);

  await page.goto(`/games/${setId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'AmigaOS 3.1.4' }).first()).toBeVisible();
  await expect(page.getByTestId('disk-set-section')).toContainText('5 disks');
  expect(await rowOrder(page)).toEqual(panel);
  await expect(page.getByTestId(`disk-${id.Install3_1_4}`)).toContainText('Disk 1');
  const nos = await diskNos(panel);
  panel.forEach((d, i) => expect(nos[d]).toEqual({ gameId: setId, diskNo: i + 1 }));
});

test('upload: a reordered, partly ticked suggestion makes exactly that set; re-uploading a moved disk brings back no title', async ({ page }) => {
  test.setTimeout(150_000);
  const { orgId } = await signUpFresh(page);
  const { id, files } = await dropRelease(page, orgId);

  // Extras above Workbench, Fonts ticked, Locale left out, and a new name.
  await page.getByTestId(`set-suggestion-up-${id.Extras3_1_4}`).click();
  const panel = await panelOrder(page);
  expect(panel.slice(0, 3)).toEqual([id.Install3_1_4, id.Extras3_1_4, id.Workbench3_1_4]);
  await page.getByTestId(`set-suggestion-tick-${id.Fonts}`).check();
  await page.getByTestId('set-suggestion-name').fill('My 3.1.4');
  await page.getByTestId('set-suggestion-accept').click();
  await expect(page.getByTestId('set-suggestion')).toHaveCount(0);

  const expected = panel.filter((d) => d !== id.Locale);
  const nos = await diskNos([...expected, id.Locale]);
  const setId = nos[id.Install3_1_4].gameId;
  expected.forEach((d, i) => expect(nos[d]).toEqual({ gameId: setId, diskNo: i + 1 }));
  // Locale stays a lone title of its own.
  expect(nos[id.Locale].gameId).not.toBe(setId);
  expect(nos[id.Locale].diskNo).toBe(1);

  const before = (await orgGames(orgId)).map((g) => g.id).sort();
  expect(before).toEqual([setId, nos[id.Locale].gameId].sort());

  await page.goto(`/games/${setId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'My 3.1.4' }).first()).toBeVisible();
  expect(await rowOrder(page)).toEqual(expected);

  // Review Focus 2 / plan P4: Workbench now lives in the set but keeps its
  // id, which was minted from its ORIGINAL title. Re-uploading the same file
  // must not bring that title back, empty or with a duplicate disk.
  const wb = files.find((f) => f.name === 'Workbench3_1_4.adf')!;
  await page.goto('/ingest');
  // Waited on /complete itself, not the row: a deduped row turns blue as soon
  // as /check answers, BEFORE /complete has run (and re-created, then
  // removed, the original title).
  const completed = page.waitForResponse((r) => r.url().includes('/api/ingest/complete'), { timeout: 30_000 });
  await page.getByTestId('file-input').setInputFiles(wb);
  expect((await completed).status()).toBe(200);
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="deduped"]')).toBeVisible();

  const after = (await orgGames(orgId)).map((g) => g.id).sort();
  expect(after).toEqual(before);
  const wbRows = await getDb().select({ id: disks.id, gameId: disks.gameId }).from(disks)
    .where(and(eq(disks.orgId, orgId), eq(disks.sha256, createHash('sha256').update(wb.buffer).digest('hex'))));
  expect(wbRows).toEqual([{ id: id.Workbench3_1_4, gameId: setId }]);

  await page.goto('/library');
  await expect(page.getByTestId('game-card')).toHaveCount(2);
});

test('Add disks… folds a lone title in as the last disk, and the old title is really gone', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const set = await seedSet(orgId, `Set ${tag}`, 2);
  const lone = await seedDisk(orgId, { title: `Lone ${tag}`, diskNo: 1, sha256: sha(`${tag}-lone`) });

  await page.goto(`/games/${set.gameId}`);
  await page.getByTestId('disk-set-add').click();
  const dialog = page.getByTestId('add-disks-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('add-disks-search').fill(`Lone ${tag}`);
  await dialog.getByTestId(`add-disks-pick-${lone.gameId}`).check();
  await dialog.getByTestId('add-disks-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`Moved to Set ${tag}`)).toBeVisible();

  await expect(page.getByTestId(`disk-${lone.diskId}`)).toContainText('Disk 3');
  expect(await rowOrder(page)).toEqual([...set.ids, lone.diskId]);
  expect((await diskNos([lone.diskId]))[lone.diskId]).toEqual({ gameId: set.gameId, diskNo: 3 });

  // Task 4's NOT EXISTS guard, on the real database: the emptied title is gone.
  expect(await gameExists(lone.gameId)).toBe(false);
  const res = await page.goto(`/games/${lone.gameId}`);
  expect(res?.status()).toBe(404);
  await page.goto('/library');
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await expect(page.getByTestId('game-card').filter({ hasText: `Lone ${tag}` })).toHaveCount(0);
});

test('reorder: Move up renumbers, and in reorder mode a drag and the ▲▼ buttons move disks', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const set = await seedSet(orgId, `Reorder ${runTag()}`, 3);
  const [a, b, c] = set.ids;

  await page.goto(`/games/${set.gameId}`);
  await page.getByTestId(`disk-menu-${b}`).click();
  await page.getByTestId(`disk-up-${b}`).click();
  await expect(page.getByTestId(`disk-${b}`)).toContainText('Disk 1');
  await expect(page.getByTestId(`disk-${a}`)).toContainText('Disk 2');
  expect(await rowOrder(page)).toEqual([b, a, c]);
  await expect.poll(async () => (await diskNos([b]))[b].diskNo).toBe(1);

  // The first row's Move up is disabled, the last row's Move down too.
  await page.getByTestId(`disk-menu-${b}`).click();
  await expect(page.getByTestId(`disk-up-${b}`)).toHaveAttribute('data-disabled', /.*/);
  await page.keyboard.press('Escape');

  await page.getByTestId('disk-set-reorder').click();
  expect(await reorderOrder(page)).toEqual([b, a, c]);

  // Drag c to the top.
  await dragOnto(page, page.getByTestId(`disk-grip-${c}`), page.getByTestId(`disk-reorder-row-${b}`));
  await expect(page.getByTestId(`disk-reorder-no-${c}`)).toHaveText('1');
  await expect.poll(async () => {
    const n = await diskNos([a, b, c]);
    return [n[c].diskNo, n[b].diskNo, n[a].diskNo];
  }).toEqual([1, 2, 3]);

  // ▼ on the top row.
  await page.getByTestId(`disk-reorder-down-${c}`).click();
  await expect(page.getByTestId(`disk-reorder-no-${c}`)).toHaveText('2');
  await expect.poll(async () => {
    const n = await diskNos([a, b, c]);
    return [n[b].diskNo, n[c].diskNo, n[a].diskNo];
  }).toEqual([1, 2, 3]);

  await page.getByTestId('disk-set-done').click();
  await expect(page.getByTestId('disk-set-reorder')).toBeVisible();
  await page.reload();
  expect(await rowOrder(page)).toEqual([b, c, a]);
  await expect(page.getByTestId(`disk-${a}`)).toContainText('Disk 3');
});

test('move out makes a lone title named after the volume; Add to a disk set… and Undo from its toast put it back', async ({ page }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const title = `MoveOut ${tag}`;
  const vols = ['MoA', 'MoB', 'MoC'].map((v) => `${v}${tag.slice(-6)}`);
  const shas: string[] = [];
  for (let i = 0; i < 3; i++) {
    shas.push(await ingestAdf(page, `${title} (Disk ${i + 1} of 3).adf`, adfBytes(vols[i])));
  }
  const d = await Promise.all(shas.map((s) => diskOf(orgId, s)));
  const setId = d[0].gameId;
  expect(d.map((x) => x.gameId)).toEqual([setId, setId, setId]);

  await page.goto(`/games/${setId}`);
  await page.getByTestId(`disk-menu-${d[1].id}`).click();
  await page.getByTestId(`disk-move-out-${d[1].id}`).click();

  // The page goes to the new title, named after disk 2's volume.
  await expect(page).not.toHaveURL(new RegExp(`/games/${setId}$`));
  await expect(page.getByRole('heading', { level: 1, name: vols[1] }).first()).toBeVisible();
  const outId = page.url().split('/games/')[1].split(/[?#]/)[0];
  expect((await diskNos([d[1].id]))[d[1].id]).toEqual({ gameId: outId, diskNo: 1 });
  // The set renumbered: old disk 3 is now disk 2.
  expect((await diskNos([d[2].id]))[d[2].id]).toEqual({ gameId: setId, diskNo: 2 });

  // A lone disk has no Disk set section and no "Move out of set": only
  // "Add to a disk set…".
  await expect(page.getByTestId('disk-set-section')).toHaveCount(0);
  await page.getByTestId(`disk-menu-${d[1].id}`).click();
  await expect(page.getByTestId(`disk-add-to-set-${d[1].id}`)).toBeVisible();
  await expect(page.getByTestId(`disk-move-out-${d[1].id}`)).toHaveCount(0);
  await expect(page.getByTestId(`disk-up-${d[1].id}`)).toHaveCount(0);
  await page.getByTestId(`disk-add-to-set-${d[1].id}`).click();

  const dialog = page.getByTestId('add-disks-dialog');
  await dialog.getByTestId('add-disks-search').fill(title);
  await dialog.getByTestId(`add-disks-pick-${setId}`).check();
  await dialog.getByTestId('add-disks-confirm').click();

  await expect(page).toHaveURL(new RegExp(`/games/${setId}$`));
  await expect(page.getByTestId(`disk-${d[1].id}`)).toContainText('Disk 3');
  expect(await gameExists(outId)).toBe(false);

  const toastEl = page.locator('[data-sonner-toast]').filter({ hasText: `Moved to ${title}` });
  await expect(toastEl).toBeVisible();
  await toastEl.getByRole('button', { name: 'Undo' }).click();

  // Undo recreates the lone title (a new id) and goes there.
  await expect(page).not.toHaveURL(new RegExp(`/games/${setId}$`));
  await expect(page.getByRole('heading', { level: 1, name: vols[1] }).first()).toBeVisible();
  const restoredId = page.url().split('/games/')[1].split(/[?#]/)[0];
  await expect(page.getByTestId(`disk-${d[1].id}`)).toBeVisible();
  const n = await diskNos(d.map((x) => x.id));
  expect(n[d[1].id]).toEqual({ gameId: restoredId, diskNo: 1 });
  expect(n[d[0].id]).toEqual({ gameId: setId, diskNo: 1 });
  expect(n[d[2].id]).toEqual({ gameId: setId, diskNo: 2 });
  expect((await orgGames(orgId)).map((g) => g.id).sort()).toEqual([setId, restoredId].sort());
});

test('Next follows the new order, and a board keeps the disk it holds (Review Focus 1)', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const set = await seedSet(orgId, `NextOrder ${runTag()}`, 3);
  const [a, b, c] = set.ids;

  const mount = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: b } });
  expect(mount.status()).toBe(200);
  const { version } = await mount.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: set.shas[1], mountedDiskId: b, version },
  })).status()).toBe(204);

  // Disk 2 becomes disk 1, through the title page.
  await page.goto(`/games/${set.gameId}`);
  await page.getByTestId(`disk-menu-${b}`).click();
  await page.getByTestId(`disk-up-${b}`).click();
  await expect(page.getByTestId(`disk-${b}`)).toContainText('Disk 1');
  await expect.poll(async () => (await diskNos([b]))[b].diskNo).toBe(1);

  const poll = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  expect(poll.desired.diskId).toBe(b);
  expect(poll.desired.diskNo).toBe(1);
  expect(poll.next.diskId).toBe(a);
  const [dev] = await getDb().select({
    desiredDiskId: devices.desiredDiskId, desiredDiskNo: devices.desiredDiskNo,
    mountedDiskId: devices.mountedDiskId, mountedDiskNo: devices.mountedDiskNo,
  }).from(devices).where(eq(devices.id, deviceId));
  expect(dev).toEqual({ desiredDiskId: b, desiredDiskNo: 1, mountedDiskId: b, mountedDiskNo: 1 });

  const next = await page.request.post(`/api/devices/${deviceId}/next`);
  expect(next.status()).toBe(200);
  expect(await next.json()).toEqual({ outcome: 'mounting', diskNo: 2, diskCount: 3 });
  const [after] = await getDb().select({ id: devices.desiredDiskId }).from(devices).where(eq(devices.id, deviceId));
  expect(after.id).toBe(a);
  void c;
});

test('org scoping: another org\'s title and disks answer 404', async ({ page, browser }) => {
  const { orgId } = await signUpFresh(page);
  const set = await seedSet(orgId, `Scoped ${runTag()}`, 2);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  try {
    const { orgId: orgB } = await signUpFresh(pageB);
    const mine = await seedDisk(orgB, { title: `Mine ${runTag()}`, diskNo: 1, sha256: sha(`${runTag()}-b`) });

    expect((await pageB.request.post(`/api/games/${set.gameId}/disks`, { data: { diskIds: [mine.diskId] } })).status()).toBe(404);
    expect((await pageB.request.post(`/api/games/${mine.gameId}/disks`, { data: { diskIds: [set.ids[0]] } })).status()).toBe(404);
    expect((await pageB.request.put(`/api/games/${set.gameId}/disk-order`, { data: { diskIds: [...set.ids].reverse() } })).status()).toBe(404);
    expect((await pageB.request.post(`/api/disks/${set.ids[0]}/move-out`)).status()).toBe(404);
  } finally {
    await ctxB.close();
  }
  const n = await diskNos(set.ids);
  expect(n[set.ids[0]]).toEqual({ gameId: set.gameId, diskNo: 1 });
  expect(n[set.ids[1]]).toEqual({ gameId: set.gameId, diskNo: 2 });
});
