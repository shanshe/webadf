import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, blobs } from '@/db/schema/catalog';
import { makeSortTitle } from '@/lib/tosec';
import { tosecKey } from '@/lib/tosec-search';
import { signUpFresh } from './helpers';
import { seedDisk, cleanupSeeded } from './device-helpers';
import { seedProduction, cleanupDemozoo } from './demozoo-helpers';
import { seedTosecEntry, cleanupTosec } from './tosec-helpers';

/**
 * The title page's one "Find on Demozoo or TOSEC" box.
 *
 * tosec_entries is GLOBAL, not per org: every row seeded here carries a
 * per-run marker in its set_name (and its publisher), and cleanupTosec()
 * deletes exactly the ids seedTosecEntry recorded -- never anything else.
 */

test.afterAll(async () => {
  await cleanupDemozoo();
  await cleanupTosec();
  await cleanupSeeded();
});

const freshSha = () => createHash('sha256').update(randomUUID()).digest('hex');
const tag = () => Math.random().toString(36).slice(2, 8);

/**
 * One two-disk TOSEC release, plus an [a] alternate dump of disk 1: three
 * rows that must come back as ONE search result reading "2 disks". Each disk
 * carries its own sub-label AFTER the disk clause, as real TOSEC names do
 * ("(Disk 1 of 2)(Install)"), which must not split the release. Its title is
 * exactly `title`, which the search ranks first among matches.
 */
async function seedRelease(title: string, t: string) {
  const setName = `e2e-identify-search-${t}`;
  const publisher = `E2E Pub ${t}`;
  const base = `${title} (1993)(${publisher})`;
  for (const [n, label, flag] of [[1, '(Install)', ''], [1, '(Install)', '[a]'], [2, '(Extras)', '']] as const) {
    const gameName = `${base}(Disk ${n} of 2)${label}${flag}`;
    await seedTosecEntry({
      setName, gameName, romName: `${gameName}.adf`,
      title, sortTitle: makeSortTitle(title), year: 1993, publisher, diskNo: n, diskCount: 2,
    });
  }
  return { publisher, key: tosecKey(base), name: base };
}

test('a TOSEC release sets title, year and publisher on an unidentified title', async ({ page }) => {
  const user = await signUpFresh(page);
  const t = tag();
  const { gameId } = await seedDisk(user.orgId, { title: `unknown-${t}`, diskNo: 1, sha256: freshSha() });
  // Unique per run: the production DB holds the real TOSEC import, whose
  // releases could otherwise outrank the seed and push it past the limit.
  const title = `Identify Release ${t}`;
  const rel = await seedRelease(title, t);

  await page.goto(`/games/${gameId}`);
  const input = page.getByTestId('demozoo-search-input');
  await expect(input).toHaveAttribute('placeholder', 'Find on Demozoo or TOSEC');
  await input.fill(title);
  await page.getByTestId('identify-search-submit').click();

  // Three seeded rows, one release: EVERY TOSEC row naming the seed's
  // unique publisher is counted, so a disk left ungrouped (a second row with
  // another data-key) fails here instead of slipping past a key filter.
  await expect(page.getByTestId('tosec-search-result').first()).toBeVisible();
  await expect(page.getByTestId('tosec-search-result').filter({ hasText: rel.publisher })).toHaveCount(1);
  const row = page.locator(`[data-testid="tosec-search-result"][data-key="${rel.key}"]`);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('identify-search-result-tosec')).toHaveText('TOSEC');
  await expect(row).toContainText(rel.name);
  await expect(row).toContainText('2 disks');
  await expect(row).toContainText(rel.publisher);

  await row.getByTestId(`tosec-use-${rel.key}`).click();
  await expect(page.getByText('Details set from TOSEC')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

  const g = (await getDb().select().from(games).where(eq(games.id, gameId)))[0];
  expect(g.title).toBe(title);
  expect(g.year).toBe(1993);
  expect(g.publisher).toBe(rel.publisher);
  expect(g.metadataSource).toBe('human');
});

test('a TOSEC release with no year or publisher clears the old ones', async ({ page }) => {
  const user = await signUpFresh(page);
  const t = tag();
  const { gameId } = await seedDisk(user.orgId, { title: `old-${t}`, diskNo: 1, sha256: freshSha() });
  await getDb().update(games).set({ year: 1990, publisher: `Old Pub ${t}` }).where(eq(games.id, gameId));
  // TOSEC's "(19xx)(-)": year and publisher both unknown.
  const title = `Undated Release ${t}`;
  const gameName = `${title} (19xx)(-)`;
  await seedTosecEntry({
    setName: `e2e-identify-search-${t}`, gameName, romName: `${gameName}.adf`,
    title, sortTitle: makeSortTitle(title), year: null, publisher: '-',
  });

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('demozoo-search-input').fill(title);
  await page.getByTestId('identify-search-submit').click();
  const key = tosecKey(gameName);
  await page.getByTestId(`tosec-use-${key}`).click();
  await expect(page.getByText('Details set from TOSEC')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

  const g = (await getDb().select().from(games).where(eq(games.id, gameId)))[0];
  expect(g.title).toBe(title);
  expect(g.year).toBeNull();
  expect(g.publisher).toBeNull();
});

test('a query under two characters asks for more instead of saying nothing matched', async ({ page }) => {
  const user = await signUpFresh(page);
  const t = tag();
  const { gameId } = await seedDisk(user.orgId, { title: `short-${t}`, diskNo: 1, sha256: freshSha() });

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('demozoo-search-input').fill('w');
  await page.getByTestId('identify-search-submit').click();
  await expect(page.getByTestId('identify-search-status')).toHaveText('Type at least 2 characters to search.');
  await expect(page.getByText('Nothing on Demozoo or TOSEC with that title.')).toHaveCount(0);
});

test('a Demozoo result in the same box still links on "Use this"', async ({ page }) => {
  const user = await signUpFresh(page);
  const t = tag();
  const { gameId } = await seedDisk(user.orgId, { title: `demo-${t}`, diskNo: 1, sha256: freshSha() });
  const title = `Identify Demo ${t}`;
  const pid = await seedProduction({ title, releaseYear: 1992, groups: ['Spaceballs'] });

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('demozoo-search-input').fill(title);
  await page.getByTestId('identify-search-submit').click();

  const row = page.locator(`[data-testid="demozoo-search-result"][data-production-id="${pid}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('identify-search-result-demozoo')).toHaveText('Demozoo');
  await row.getByTestId('demozoo-use').click();

  await expect(page.getByTestId('demozoo-panel')).toHaveAttribute('data-link-source', 'confirmed');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
});

test('a title the scans know is a game searches TOSEC only', async ({ page }) => {
  const user = await signUpFresh(page);
  const t = tag();
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: `game-${t}`, diskNo: 1, sha256 });
  await getDb().update(blobs).set({ demozooState: 'skipped_game', demozooCheckedAt: new Date() }).where(eq(blobs.sha256, sha256));
  // The same title on both catalogs: only TOSEC's may be offered for a game.
  const title = `Gamekind ${t}`;
  const rel = await seedRelease(title, t);
  const pid = await seedProduction({ title });

  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId('demozoo-suggestions')).toHaveCount(0);
  const input = page.getByTestId('demozoo-search-input');
  await expect(input).toHaveAttribute('placeholder', 'Find on TOSEC');
  await input.fill(title);
  const response = page.waitForResponse((r) => r.url().includes('/api/identify/search'));
  await page.getByTestId('identify-search-submit').click();
  const res = await response;
  expect(new URL(res.url()).searchParams.get('sources')).toBe('tosec');
  expect((await res.json()).demozoo).toEqual([]);

  await expect(page.locator(`[data-testid="tosec-search-result"][data-key="${rel.key}"]`)).toBeVisible();
  await expect(page.locator(`[data-production-id="${pid}"]`)).toHaveCount(0);
  await expect(page.getByTestId('identify-search-result-demozoo')).toHaveCount(0);

  await page.getByTestId(`tosec-use-${rel.key}`).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  const g = (await getDb().select().from(games).where(eq(games.id, gameId)))[0];
  expect(g.metadataSource).toBe('human');
});

test('at 390px the box and a TOSEC result fit, with 44px controls and no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const user = await signUpFresh(page);
  const t = tag();
  const { gameId } = await seedDisk(user.orgId, { title: `narrow-${t}`, diskNo: 1, sha256: freshSha() });
  const rel = await seedRelease(`Narrow Release With A Long Name ${t}`, t);

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('demozoo-search-input').fill(`Narrow Release With A Long Name ${t}`);
  await page.getByTestId('identify-search-submit').click();
  const use = page.getByTestId(`tosec-use-${rel.key}`);
  await expect(use).toBeVisible();

  for (const loc of [page.getByTestId('demozoo-search-input'), page.getByTestId('identify-search-submit'), use]) {
    const b = (await loc.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  const row = (await page.locator(`[data-testid="tosec-search-result"][data-key="${rel.key}"]`).boundingBox())!;
  expect(row.x + row.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
