import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../src/harness.ts';

/**
 * The case this feature exists for. A dateless release is picked and imported;
 * a dated re-encode of the same scene arrives and lands in its own group,
 * because the date is part of the identity key. Adding the date to the picked
 * group is the correction that joins them, and it was refused outright until
 * the identity-change work of 2026-08-16.
 *
 * `SomeSite` is not a placeholder left unresolved — it is seeded into
 * `harness.ts`'s scene-plugin config (`KNOWN_SITES`) as the one site name the
 * dateless shape is allowed to recognise. `parseSceneRelease`'s dateless form
 * refuses outright unless the leading run is a *known* site (see
 * `packages/plugin-scenes/src/parse.ts`'s `parseDatelessForm`), and nothing in
 * this harness otherwise teaches it one — the site-lookup pipeline that would,
 * in production, learn a site from a confirmed metadata match is not wired
 * into any e2e test. Without the seed, the very release this bug is about
 * would be refused before ever reaching a group.
 */
const DATELESS = 'SomeSite.Title.Of.Scene.1080p.MP4-WRB';
const DATED = 'SomeSite.26.08.14.Title.Of.Scene.2160p.MP4-WRB';

test('adding a date to a picked group merges it into the dated one', async ({ page, harness }) => {
  // --- 1. The dateless release arrives, is picked, and its download imports. ---
  const ingested = harness.ingest([DATELESS]);
  expect(ingested.parseErrors).toBe(0);

  await page.goto('/');
  const dateless = page
    .locator('article.media-card')
    .filter({ has: page.getByRole('heading', { name: 'Title Of Scene' }) });
  await expect(dateless).toHaveCount(1);
  await dateless.getByRole('button', { name: 'Pick' }).click();

  // Only observable once the pick has reached the download client, which is
  // what hands back the ref the fake "completed" history entry has to name.
  await expect.poll(() => harness.client.added.length).toBe(1);
  const added = harness.client.added[0];
  if (added === undefined) throw new Error('the pick never reached the download client');

  // A real file on disk, exactly as a finished SABnzbd job leaves one: the
  // import pipeline `stat`s the storage path for real, so a fabricated row
  // with nothing behind it would fail import rather than exercise it.
  const downloadDir = join(harness.workDir, 'downloads', 'job-1080p');
  await mkdir(downloadDir, { recursive: true });
  const sourceFile = join(downloadDir, 'scene.mp4');
  await writeFile(sourceFile, '1080p bytes');

  harness.client.setSnapshot({
    queue: [],
    history: [
      {
        ref: added.ref,
        name: added.name,
        outcome: 'completed',
        storagePath: downloadDir,
        failMessage: null,
        category: null,
      },
    ],
    complete: true,
  });
  const reconciled = await harness.reconcile();
  expect(reconciled.imported).toBe(1);

  // The path `planSceneImport`'s default template renders for a release with
  // no anchor: `{sitename}/{sitename}.{titledots}.{resolution}-{group}`, the
  // `{date}{episode}` slot dropped entirely because both are empty.
  const datelessPath = join(harness.libraryRoot, 'somesite', 'somesite.title.of.scene.1080p-WRB.mp4');
  await expect(stat(datelessPath)).resolves.toBeTruthy();

  // --- 2. The dated 2160p re-encode of the same scene arrives on its own. ---
  const secondIngest = harness.ingest([DATED]);
  expect(secondIngest.parseErrors).toBe(0);

  // This is the bug, proved rather than asserted from the database: the two
  // releases now live as two separate groups, one on each list, because
  // `state = 'picked'` takes the first off Browse (`BROWSABLE` in
  // `db/groups.ts`) the instant it was picked, well before its download ever
  // finished. There is no single page both could appear on at once — the
  // "two separate cards" the bug produces are these two, on two different
  // screens, and that split apart is exactly what a shared identity key
  // would have prevented.
  await page.goto('/');
  const browseCards = page.locator('article.media-card');
  await expect(browseCards).toHaveCount(1);
  await expect(browseCards.getByRole('heading', { name: 'Title Of Scene' })).toHaveCount(1);
  // A provider *is* configured — `harness.ts` sets `metadataAvailable: true`
  // and wires `createFakeMetadataClient()` for every test — but this spec never
  // calls `setCandidates` or `runMetadataPass`, so nothing ever drains the
  // queue and no answer is recorded for this group. With no confirmed answer
  // there is no provider date, and the parsed date (`display.date`) left the
  // card in this phase, so the line shows only the site.
  //
  // The date is named in a negative rather than left to fall out of
  // `toHaveText('SomeSite')`, which is what stood here. That form pins the
  // whole composition of the line — it fails for any part added later — while
  // never mentioning the string it is meant to be excluding. This pins the
  // phase-2 rule itself, and the positive beside it stops the negative being
  // satisfied by a line that disappeared.
  await expect(browseCards.locator('p.card-context')).toContainText('SomeSite');
  await expect(browseCards.locator('p.card-context')).not.toContainText('2026-08-14');
  await expect(browseCards.locator('li.release-row').filter({ hasText: DATED })).toHaveCount(1);

  await page.goto('/picks');
  const picksCards = page.locator('article.media-card');
  await expect(picksCards).toHaveCount(1);
  await expect(picksCards.getByRole('heading', { name: 'Title Of Scene' })).toHaveCount(1);
  await expect(picksCards.locator('li.release-row').filter({ hasText: DATELESS })).toHaveCount(1);
  // No upgrade yet: the 2160p release belongs to a different group entirely,
  // so nothing here has anything to compare it against.
  await expect(picksCards.locator('span.badge')).toHaveCount(0);

  // --- 3. On Picks, edit the picked group's identity to carry the date. ---
  const pickedCard = picksCards;
  await pickedCard.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = pickedCard.locator('form.manual-form');
  // Everything else — Site, Scene, Title order, quality — is already correct;
  // this is exactly the correction a user makes: naming what already
  // separates this scene from the rest of the site.
  await form.getByLabel('Anchor', { exact: true }).selectOption('date');
  await form.getByLabel('Date', { exact: true }).fill('2026-08-14');
  await form.getByRole('button', { name: 'Save' }).click();

  // --- 4. The confirmation names the merge target and the file it moves. ---
  const dialog = page.getByRole('dialog', { name: 'Confirm identity change' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This will merge into');
  await expect(dialog).toContainText('Title Of Scene');
  await expect(dialog).toContainText('moving 1 release(s) and 1 download(s)');

  const datedPath = join(
    harness.libraryRoot,
    'somesite',
    'somesite.2026.08.14.title.of.scene.1080p-WRB.mp4',
  );
  await expect(dialog.locator('h3', { hasText: 'Files renamed' })).toBeVisible();
  const renameRow = dialog.locator('li').filter({ hasText: '→' });
  await expect(renameRow).toHaveCount(1);
  await expect(renameRow).toContainText(datelessPath);
  await expect(renameRow).toContainText(datedPath);
  // Nothing here should block the save: the destination is free and the file
  // it names is really on disk.
  await expect(dialog.locator('p.error')).toHaveCount(0);

  // --- 5. Confirm. ---
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toHaveCount(0);

  // --- 6. One group remains, holding both releases; the 2160p is the ---
  // upgrade; the imported file sits under the dated path, moved for real. ---
  await expect(page.locator('article.media-card')).toHaveCount(1);
  const merged = page.locator('article.media-card');
  await expect(merged.getByRole('heading', { name: 'Title Of Scene' })).toHaveCount(1);
  // Same as above: still no provider answer post-merge, so still no date on
  // the card — only the site the context line does have.
  await expect(merged.locator('p.card-context')).toHaveText('SomeSite');
  await expect(merged.locator('span.badge')).toHaveText('Upgrade available');

  const releases = merged.locator('li.release-row');
  await expect(releases).toHaveCount(2);
  const survivingRow = releases.filter({ hasText: DATELESS });
  await expect(survivingRow).toHaveCount(1);
  await expect(survivingRow.locator('.release-current')).toHaveText('Current');
  const upgradeRow = releases.filter({ hasText: DATED });
  await expect(upgradeRow).toHaveCount(1);
  await expect(upgradeRow.getByRole('button', { name: 'Pick' })).toBeVisible();

  // Browse now shows the same, single, survivor — reachable through the
  // upgrade flag rather than `state = 'new'` — and nothing was left behind
  // there under the old identity.
  await page.goto('/');
  await expect(page.locator('article.media-card')).toHaveCount(1);

  // The filesystem, not just the database, moved: `importMode: 'move'` means
  // the old path must be gone, not merely superseded.
  await expect(stat(datedPath)).resolves.toBeTruthy();
  await expect(stat(datelessPath)).rejects.toThrow();
  await expect(readFile(datedPath, 'utf8')).resolves.toBe('1080p bytes');
});
