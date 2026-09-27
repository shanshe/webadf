import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { diskVersions, diskWriteTracks } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { formatVolume } from '@/lib/adffs/format';
import { HD_TRACK_DATA_BYTES } from '@/lib/adfmfm';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, cleanupSeeded, pairDevice, authHeader } from './device-helpers';

test.afterAll(cleanupSeeded);

const HD_BYTES = 1_802_240;
const UNSUPPORTED = "Update the drive's firmware to play HD disks";
const fakeSha = () => createHash('sha256').update(randomUUID()).digest('hex');

// A synthetic HD ADF: the same bytes every run, so the blob store dedupes it.
// Never a real disk (adfmfm spec §14).
function hdAdf(): Buffer {
  const b = Buffer.alloc(HD_BYTES);
  let x = 0x0badf00d;
  for (let i = 0; i < b.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
}

// The CLI's path: check, presign, PUT, complete. Same as hfe-disks.spec.ts.
async function uploadViaApi(page: Page, bytes: Buffer, filename: string) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const check = await page.request.post('/api/ingest/check', { data: { hashes: [sha256] } });
  if (!(await check.json()).known.includes(sha256)) {
    const { uploads } = await (await page.request.post('/api/ingest/presign', {
      data: { files: [{ sha256, sizeBytes: bytes.length }] },
    })).json();
    const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(bytes) });
    expect(put.ok || put.status === 400).toBe(true); // 400: already stored by an earlier run
  }
  const res = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: bytes.length, filename }] },
  });
  expect(res.status()).toBe(200);
  return sha256;
}

test('an uploaded HD ADF is tagged HD everywhere its size shows, cannot be made writable, and the file browser says why', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await page.goto('/ingest');
  await page.getByTestId('file-input').setInputFiles({
    name: 'HD Test (1994)(Webadf).adf', mimeType: 'application/octet-stream', buffer: hdAdf(),
  });
  await expect(page.getByTestId('ingest-row').first().getByTestId('ingest-hd-tag')).toBeVisible();
  await expect.poll(() => getDb().select({ id: disks.id }).from(disks).where(eq(disks.orgId, orgId)),
    { timeout: 30_000 }).toHaveLength(1);
  const [d] = await getDb().select({ id: disks.id, gameId: disks.gameId, size: disks.sizeBytes, f: disks.imageFormat })
    .from(disks).where(eq(disks.orgId, orgId));
  expect(d).toMatchObject({ size: HD_BYTES, f: 'adf' });

  await page.goto(`/games/${d.gameId}`);
  await expect(page.getByTestId(`hd-tag-${d.id}`)).toBeVisible();
  const wp = page.getByTestId(`wp-${d.id}`);
  await expect(wp).toBeDisabled();
  await expect(wp).toHaveAttribute('data-protected', 'true');
  await expect(wp).toHaveAttribute('data-locked', 'true');

  await page.goto('/library?view=table');
  await expect(page.getByTestId('game-hd-tag')).toBeVisible();

  await page.goto(`/disks/${d.id}/files`);
  await expect(page.getByTestId('hd-not-browsable')).toHaveText("HD disks can't be browsed in the browser yet");
});

test('an HD disk mounts only on a board reporting playsHd, always goes write-protected, and is served as WFAD', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const sha256 = await uploadViaApi(page, hdAdf(), 'HD Mount (1994)(Webadf).adf');
  const [d] = await getDb().select({ id: disks.id, gameId: disks.gameId }).from(disks).where(eq(disks.orgId, orgId));
  // A writable row -- which the PATCH would refuse -- set directly: the board
  // must be sent write-protect anyway (spec §4.3).
  await getDb().update(disks).set({ writeProtected: false }).where(eq(disks.id, d.id));

  const report = (extra: Record<string, unknown>) => request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, ...extra },
  });
  const mount = () => page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: d.id } });

  // A board that has never reported playsHd: refused, and said why -- in the
  // API and in the game page's mount toast.
  let res = await mount();
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'hd_unsupported', reason: UNSUPPORTED });
  await page.goto(`/games/${d.gameId}`);
  await page.getByTestId(`mount-${d.id}`).click();
  await expect(page.getByText(UNSUPPORTED)).toBeVisible();

  // It reports the capability: accepted.
  expect((await report({ firmwareVersion: '9.9.9+e2e', playsHd: true })).status()).toBe(204);
  res = await mount();
  expect(res.status()).toBe(200);

  const poll = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  expect(poll.desired).toMatchObject({ sha256, diskId: d.id, writeProtected: true });

  const img = await request.get(`/api/device/image/${sha256}`, { headers: authHeader(token) });
  expect(img.status()).toBe(200);
  const body = await img.body();
  expect(img.headers()['content-length']).toBe('1802256');
  expect(body.length).toBe(1_802_256);
  // The spec's header table, byte for byte: WFAD, 1, 160, 22.
  expect([...body.subarray(0, 16)]).toEqual([0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0, 0xa0, 0, 0, 0, 0x16, 0, 0, 0]);
  expect(body.subarray(16).equals(hdAdf())).toBe(true);

  // A rollback to a build without the responder: refused again.
  expect((await report({ firmwareVersion: '9.9.8+e2e' })).status()).toBe(204);
  res = await mount();
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe('hd_unsupported');

  // Same board, same still-entitled sha256, fetched directly (not through
  // mount): the image route must refuse HD bytes to a board that cannot play
  // them, even though desiredSha256 was set before the rollback (F4).
  const rolledBack = await request.get(`/api/device/image/${sha256}`, { headers: authHeader(token) });
  expect(rolledBack.status()).toBe(422);
  expect(await rolledBack.json()).toEqual({ error: 'hd_unsupported', reason: UNSUPPORTED });
});

test('every write path refuses an HD disk by name, before reading a byte', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  // A digest with no blob behind it: a route that tried to read the bytes would answer 503, not 409.
  const { diskId } = await seedDisk(orgId, { title: 'HD RO', diskNo: 1, sha256: fakeSha(), sizeBytes: HD_BYTES });

  const off = await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } });
  expect(off.status()).toBe(409);
  expect((await off.json()).error).toBe('hd_read_only');
  expect((await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: true } })).status()).toBe(200);

  const mkdir = await page.request.post(`/api/disks/${diskId}/files`, { multipart: { parentBlock: '1760', name: 'x' } });
  expect(mkdir.status()).toBe(409);
  expect(await mkdir.json()).toMatchObject({ error: 'edit_failed', reason: 'hd_read_only' });

  const rename = await page.request.patch(`/api/disks/${diskId}/volume-name`, { data: { volumeName: 'X' } });
  expect(rename.status()).toBe(409);
  expect((await rename.json()).error).toBe('hd_read_only');

  const restore = await page.request.post(`/api/disks/${diskId}/restore`, { data: { seq: 0 } });
  expect(restore.status()).toBe(409);
  expect((await restore.json()).error).toBe('hd_read_only');

  const file = await page.request.get(`/api/disks/${diskId}/files/1760`);
  expect(file.status()).toBe(409);
  expect((await file.json()).error).toBe('hd_not_browsable');
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function upload(request: APIRequestContext, token: string,
                q: { diskId: string; mount: number; track: number; seq: number }, data: Uint8Array) {
  return request.post(
    `/api/device/write?disk=${q.diskId}&mount=${q.mount}&track=${q.track}&session=boot-1&seq=${q.seq}`,
    { headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.from(data) });
}

test('a board writes an HD disk: 11,264-byte tracks, a close, a version with 22 sectors changed', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const adf = formatVolume({ filesystem: 'FFS', volumeName: `HDW${runTag().slice(0, 8)}`, density: 'hd' });
  const original = sha(adf);
  await diskStore.put(original, adf);
  const { diskId } = await seedDisk(orgId, {
    title: `HD Write ${runTag()}`, diskNo: 1, sha256: original, sizeBytes: HD_BYTES, writeProtected: false,
  });
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, playsHd: true } })).status()).toBe(204);
  const { version: mount } = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: original, mountedDiskId: diskId, version: mount } })).status()).toBe(204);

  // Review Focus 1: a DD track's 5,632 bytes on an HD disk would overlay at
  // the wrong offset. Refused, and nothing staged.
  const dd = await upload(request, token, { diskId, mount, track: 0, seq: 1 }, new Uint8Array(5_632));
  expect(dd.status()).toBe(400);
  expect((await dd.json()).error).toBe('invalid_body');
  expect(await getDb().select().from(diskWriteTracks).where(eq(diskWriteTracks.deviceId, deviceId))).toEqual([]);

  // The last track: its bytes are the last 11,264 of the image (Review Focus 4).
  const written = new Uint8Array(HD_TRACK_DATA_BYTES).fill(0x5a);
  const up = await upload(request, token, { diskId, mount, track: 159, seq: 2 }, written);
  expect(up.status()).toBe(200);

  const expected = adf.slice();
  expected.set(written, 159 * HD_TRACK_DATA_BYTES);
  const want = sha(expected);
  const close = await request.post(
    `/api/device/write/close?disk=${diskId}&mount=${mount}&session=boot-1&seq=2&sha256=${want}`,
    { headers: authHeader(token) });
  expect(close.status()).toBe(200);
  expect((await close.json()).sha256).toBe(want);

  const rows = await getDb().select().from(diskVersions)
    .where(eq(diskVersions.diskId, diskId)).orderBy(asc(diskVersions.seq));
  expect(rows.map((r) => [r.seq, r.source])).toEqual([[0, 'original'], [1, 'amiga']]);
  expect(rows[1].sectorCount).toBe(22);
  const [disk] = await getDb().select().from(disks).where(eq(disks.id, diskId));
  expect(disk.sha256).toBe(want);
  expect(disk.sizeBytes).toBe(HD_BYTES);

  // The new head goes back to the board as WFAD, like any HD disk.
  const img = await request.get(`/api/device/image/${want}`, { headers: authHeader(token) });
  expect(img.status()).toBe(200);
  expect(img.headers()['content-length']).toBe('1802256');
});

test('an NFC tap of an HD disk on a board without playsHd is refused, not dropped', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: 'HD Tap', diskNo: 1, sha256: fakeSha(), sizeBytes: HD_BYTES });
  const res = await request.post('/api/device/tap', { headers: authHeader(token), data: { diskId } });
  expect(res.status()).toBe(200);
  // 'too_long': the one refusal a pre-1.4.0 board shows (src/lib/nfc/rules.ts tapRefusalOutcome).
  expect((await res.json()).outcome).toBe('too_long');
});
