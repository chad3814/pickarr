import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { planIdentityChange } from '../../src/manual/identity-plan.ts';
import {
  FILING,
  PLUGIN,
  makeDeps,
  ok,
  failure,
  seedMergePair,
  seedWithFile,
  seedWithTwoQualityFiles,
} from './fixtures.ts';

test('an unchanged identity plans nothing', async () => {
  const db = openTestDatabase();
  seedMergePair(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k1', title: 'A' }));

  assert.equal(plan.kind, 'none');
  assert.equal(plan.mergeInto, null);
  assert.deepEqual(plan.renames, []);
});

test('a changed display alone is display-only', async () => {
  const db = openTestDatabase();
  seedMergePair(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k1', title: 'Renamed' }));

  assert.equal(plan.kind, 'display-only');
});

test('a key belonging to no group is a rekey', async () => {
  const db = openTestDatabase();
  seedMergePair(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k9', title: 'A' }));

  assert.equal(plan.kind, 'rekey');
  assert.equal(plan.mergeInto, null);
});

test('a key belonging to another group is a merge, and names it', async () => {
  const db = openTestDatabase();
  seedMergePair(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.equal(plan.kind, 'merge');
  assert.deepEqual(plan.mergeInto, { id: 2, title: 'B' });
  assert.equal(plan.releasesMoving, 1);
  assert.equal(plan.downloadsMoving, 1);
});

test('an unpicked target adopts the source pick', async () => {
  const db = openTestDatabase();
  seedMergePair(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.deepEqual(plan.pick.surviving, { releaseId: 1, score: 1080, side: 'source' });
  assert.equal(plan.pick.superseded, null);
});

test('when both sides have a pick the higher score wins', async () => {
  const db = openTestDatabase();
  seedMergePair(db);
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.deepEqual(plan.pick.surviving, { releaseId: 2, score: 2160, side: 'target' });
  assert.deepEqual(plan.pick.superseded, { releaseId: 1, score: 1080 });
});

test('a tie between two picks goes to the target', async () => {
  const db = openTestDatabase();
  seedMergePair(db);
  db.prepare('UPDATE releases SET score = 1080 WHERE id = 2').run();
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.deepEqual(plan.pick.surviving, { releaseId: 2, score: 1080, side: 'target' });
});

test('a pick naming a release the merged group will not hold counts as no pick', async () => {
  const db = openTestDatabase();
  seedMergePair(db);
  db.prepare('UPDATE media_groups SET picked_release_id = 999 WHERE id = 1').run();

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.equal(plan.pick.surviving, null);
  assert.equal(plan.pick.superseded, null);
});

test('the digest changes when a displayed field changes', async () => {
  const db = openTestDatabase();
  seedMergePair(db);

  const first = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (3, 'f', 'g3', 'T3', 'https://i.invalid/3.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (3, 1, 3, '{"resolution":720}', 720, 100)`,
  ).run();
  const second = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.equal(second.releasesMoving, 2);
  assert.notEqual(first.digest, second.digest, 'one more release moving is a material change');
});

test('planning a group that does not exist is 404', async () => {
  const db = openTestDatabase();

  assert.equal(failure(await planIdentityChange(makeDeps(db), 77, { key: 'k1' })).status, 404);
});

test('a merge plans a rename for each live file, under its own releases quality', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.deepEqual(plan.renames, [
    {
      importedFileId: 1,
      from: join(libraryRoot, 'k1', '1080.mp4'),
      to: join(libraryRoot, 'k2', '1080.mp4'),
    },
  ]);
  assert.deepEqual(plan.blockers, []);
});

/**
 * With only one live file per group, that file's release quality and the
 * group's pick's quality are always the same value, so a planner that (by
 * mistake) used the pick's quality for every file would pass every other
 * rename test in this file undetected. `seedWithTwoQualityFiles` gives group 1
 * a second release at a different quality, so a rename that renders the wrong
 * file's resolution shows up as the wrong path rather than as a coincidence.
 */
test('each live file is renamed under its own release quality, not the picks', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithTwoQualityFiles(db, libraryRoot);

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k9', title: 'A' }),
  );

  assert.equal(plan.kind, 'rekey');
  assert.deepEqual(plan.renames, [
    {
      importedFileId: 1,
      from: join(libraryRoot, 'k1', '1080.mp4'),
      to: join(libraryRoot, 'k9', '1080.mp4'),
    },
    {
      importedFileId: 2,
      from: join(libraryRoot, 'k1', '2160.mp4'),
      to: join(libraryRoot, 'k9', '2160.mp4'),
    },
  ]);
  assert.deepEqual(plan.blockers, []);
});

test('a rename that would not move the file is dropped', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k1', title: 'Renamed' }),
  );

  assert.equal(plan.kind, 'display-only');
  assert.deepEqual(plan.renames, [], 'the template does not read the title, so nothing moves');
});

test('an occupied destination is a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);
  await mkdir(join(libraryRoot, 'k2'), { recursive: true });
  await writeFile(join(libraryRoot, 'k2', '1080.mp4'), 'someone else');

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0]!, /occupied/);
});

/**
 * The mirror of the test above, and the case trash-before-rename exists for: the
 * occupant *is* the superseded pick's file, which this same plan is already
 * trashing. Not a foreign occupant, and not a blocker — phase 2 of the apply
 * empties that path before phase 3 renames anything into it.
 *
 * This was a blocker until the applier was written (Task 7), which made the
 * commonest merge in the feature permanently unappliable: the design's stated
 * reason for trashing first is that "a superseded file frequently occupies the
 * exact path a renamed file wants", and refusing on it meant the ordering could
 * never be reached through the one situation it was ordered for.
 */
test('a destination occupied by a file this plan is trashing is not a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);
  // The target is picked on a release of the *same* resolution as the source's
  // pick but a lower score, so its own file sits at exactly the path the
  // surviving file is about to take, and it is the one that loses.
  db.prepare(
    `UPDATE releases SET quality = '{"resolution":1080}', score = 500 WHERE id = 2`,
  ).run();
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();
  await mkdir(join(libraryRoot, 'k2'), { recursive: true });
  await writeFile(join(libraryRoot, 'k2', '1080.mp4'), 'superseded');
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (2, 2, 2, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (2, 2, 2, '/dl/b.mp4', ?, 10, 100)`,
  ).run(join(libraryRoot, 'k2', '1080.mp4'));

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.trashing, [
    { importedFileId: 2, path: join(libraryRoot, 'k2', '1080.mp4') },
  ]);
  assert.deepEqual(plan.renames, [
    {
      importedFileId: 1,
      from: join(libraryRoot, 'k1', '1080.mp4'),
      to: join(libraryRoot, 'k2', '1080.mp4'),
    },
  ]);
});

test('a destination occupied by a directory is a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);
  await mkdir(join(libraryRoot, 'k2', '1080.mp4'), { recursive: true });

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.equal(plan.blockers.length, 1);
});

test('a file already gone from disk warns and is not renamed', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);
  await rm(join(libraryRoot, 'k1', '1080.mp4'));

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.deepEqual(plan.renames, []);
  assert.equal(plan.warnings.length, 1);
  assert.deepEqual(plan.blockers, []);
});

test('a superseded pick has its files trashed, not renamed', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);
  // Target picks release 2 (2160), which outscores the source's 1080.
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.deepEqual(plan.trashing, [
    { importedFileId: 1, path: join(libraryRoot, 'k1', '1080.mp4') },
  ]);
  assert.deepEqual(plan.renames, [], 'a file about to be trashed is never also renamed');
});

/**
 * The mirror of the test above: this time the *target*'s pick is the one a
 * higher-scoring source release supersedes, so the file the merge must trash
 * lives in group 2, not group 1. `liveFilesForOtherReleases` has to be asked
 * of both groups for this to come out right — asking only the source (as an
 * earlier, buggy version of this planner did, via a `-1` sentinel group id)
 * would silently drop the target's file from `trashing` entirely.
 */
test('a superseded pick on the target side has its files trashed too', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);

  // Give the target (group 2) a download and a live file of its own...
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (2, 2, 2, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  await mkdir(join(libraryRoot, 'k2'), { recursive: true });
  await writeFile(join(libraryRoot, 'k2', '2160.mp4'), 'data');
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (2, 2, 2, '/dl/b.mp4', ?, 4, 100)`,
  ).run(join(libraryRoot, 'k2', '2160.mp4'));

  // ...then flip which side outscores the other, so the merge keeps the
  // source's pick and supersedes the target's.
  db.prepare('UPDATE releases SET score = 2200 WHERE id = 1').run();
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.deepEqual(plan.pick.surviving, { releaseId: 1, score: 2200, side: 'source' });
  assert.deepEqual(plan.pick.superseded, { releaseId: 2, score: 2160 });
  assert.deepEqual(plan.trashing, [
    { importedFileId: 2, path: join(libraryRoot, 'k2', '2160.mp4') },
  ]);
  // Unlike the source-side sibling above, this is not a bare `[]`: group 1's
  // own file (importedFileId 1) is the *winning* pick here, and a merge still
  // relocates the winner's file into the target's directory — only the
  // trashed file (importedFileId 2, the target's loser) is excluded from
  // renames. That exclusion is the disjointness under test: id 2 appears in
  // `trashing` and must never also appear in `renames`.
  assert.deepEqual(plan.renames, [
    {
      importedFileId: 1,
      from: join(libraryRoot, 'k1', '1080.mp4'),
      to: join(libraryRoot, 'k2', '1080.mp4'),
    },
  ]);
  assert.ok(
    !plan.renames.some((r) => r.importedFileId === 2),
    'a file about to be trashed is never also renamed',
  );
});

/**
 * The merge shape the three trashing checks below need, and the only thing they
 * vary is what — if anything — sits at `doomedPath`. Local to this trio rather
 * than added to `fixtures.ts`: nothing else needs a doomed row whose file is
 * deliberately wrong, and the seed is only meaningful alongside the assertions
 * it sets up. The target is picked on a release the source's outscores, so it
 * is the *target's* file (imported file 2) that the merge dooms.
 */
async function seedDoomedTargetFile(
  db: DatabaseSync,
  libraryRoot: string,
  doomedPath: string,
): Promise<void> {
  await seedWithFile(db, libraryRoot);
  db.prepare('UPDATE releases SET score = 500 WHERE id = 2').run();
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (2, 2, 2, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (2, 2, 2, '/dl/b.mp4', ?, 5, 100)`,
  ).run(doomedPath);
}

/**
 * The trash side of the same fact the rename side has blocked all along. Before
 * this, a doomed row pointing at a directory sailed through planning and came
 * back as a `failed` entry from `trashFiles` — after the merge had already
 * committed — while the identical directory under a *renamed* row was refused
 * up front. The row stays in `trashing` either way; see `trashedPaths`.
 */
test('a doomed row that is not a regular file is a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  const doomedPath = join(libraryRoot, 'k2', '2160.mp4');
  await seedDoomedTargetFile(db, libraryRoot, doomedPath);
  await mkdir(doomedPath, { recursive: true });

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.equal(plan.blockers.length, 1, `unexpected blockers: ${JSON.stringify(plan.blockers)}`);
  assert.match(plan.blockers[0]!, /is not a regular file/);
  assert.equal(plan.trashing.length, 1, 'a blocked row still stands in the plan that blocked it');
});

test('a doomed row outside the library root is a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  const outside = await mkdtemp(join(tmpdir(), 'pickarr-outside-'));
  const doomedPath = join(outside, 'stray.mp4');
  await seedDoomedTargetFile(db, libraryRoot, doomedPath);
  await writeFile(doomedPath, 'stray');

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.equal(plan.blockers.length, 1, `unexpected blockers: ${JSON.stringify(plan.blockers)}`);
  assert.match(plan.blockers[0]!, /resolves outside the library root/);
  assert.equal(plan.trashing.length, 1);
});

/**
 * The guard against the two checks above over-reaching. A doomed file already
 * off disk is the one case `trashFiles` handles without complaint — it retires
 * the row with a null `trash_path` — so refusing the whole edit over it would
 * make a group nobody can correct out of a file an operator deleted by hand.
 */
test('a doomed row whose file is gone warns rather than blocks', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedDoomedTargetFile(db, libraryRoot, join(libraryRoot, 'k2', '2160.mp4'));

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.warnings.length, 1, `unexpected warnings: ${JSON.stringify(plan.warnings)}`);
  assert.match(plan.warnings[0]!, /already gone from disk/);
  assert.equal(plan.trashing.length, 1, 'phase 2 still has a row to retire');
});

test('the source file itself not being a regular file is a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);
  // Replace the live file with a directory at the same path. `lstatOrNull`
  // finds something there, so this does not take the "already gone" warning
  // path — it is the `pipeline/upgrade.ts`-style "not a regular file" refusal,
  // applied here to the source row's own file rather than to an occupant.
  await rm(join(libraryRoot, 'k1', '1080.mp4'));
  await mkdir(join(libraryRoot, 'k1', '1080.mp4'), { recursive: true });

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k9', title: 'A' }),
  );

  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0]!, /not a regular file/);
  assert.deepEqual(plan.renames, []);
});

/**
 * An imported file recorded outside the library root is the third §4.3
 * blocker branch. This is also, deliberately, the regression test for the
 * planner's `libraryRoot` needing `resolve()` before it is compared against:
 * the root is supplied here with a trailing separator, matching how it is
 * read from configuration (`plugins/registry.ts` accepts any non-empty
 * string) rather than the already-clean path `mkdtemp` hands back elsewhere
 * in this file. Before the planner resolved that root itself, the trailing
 * separator made `isContained`'s `target.startsWith(root + sep)` compare
 * against a doubled separator no in-root path could ever start with, so the
 * *legitimate* file below (`importedFileId: 1`) was blocked too — every
 * rename turned into a false "resolves outside the library root" refusal.
 * This test fails on that bug and passes with the fix.
 */
test('an imported file recorded outside the library root is a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);

  const outside = await mkdtemp(join(tmpdir(), 'pickarr-outside-'));
  const strayPath = join(outside, 'stray.mp4');
  await writeFile(strayPath, 'stray');
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (2, 1, 1, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (2, 2, 1, '/dl/stray.mp4', ?, 4, 100)`,
  ).run(strayPath);

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot + sep), 1, {
      key: 'k9',
      title: 'A',
    }),
  );

  assert.equal(plan.blockers.length, 1, `unexpected blockers: ${JSON.stringify(plan.blockers)}`);
  assert.match(plan.blockers[0]!, /resolves outside the library root/);
  assert.deepEqual(plan.renames, [
    {
      importedFileId: 1,
      from: join(libraryRoot, 'k1', '1080.mp4'),
      to: join(libraryRoot, 'k9', '1080.mp4'),
    },
  ]);
});

test('a live file the plugin refuses to place is a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);

  const plan = ok(
    await planIdentityChange(makeDeps(db, PLUGIN, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.equal(plan.blockers.length, 1, 'a file with nowhere to go must not be left stranded');
});

/**
 * A plugin is not trusted to keep its own destinations inside the library
 * (`resolveDestination` in `pipeline/import.ts` throws exactly on this case),
 * and `destinationFor` must turn that throw into a blocker rather than let it
 * reach `planIdentityChange`'s caller as an unhandled rejection — the same
 * treatment `buildRelease` gives a throwing `fromManualValues`. Asserting the
 * promise resolves, rather than trusting `await` to fail the test if it does
 * not, is the point of the test: an unguarded throw here would surface as a
 * 500 over the HTTP route this feeds, not as a shown blocker.
 */
test('a plugin destination that escapes the library root is a blocker, not a throw', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);

  const ESCAPING: MediaTypePlugin = {
    ...FILING,
    planImport: (media, files) => {
      const file = files[0];
      if (file === undefined) return null;
      return { files: [{ source: file.absolutePath, destination: '../../../escape.mp4' }] };
    },
  };

  let result: Awaited<ReturnType<typeof planIdentityChange>> | undefined;
  await assert.doesNotReject(async () => {
    result = await planIdentityChange(makeDeps(db, ESCAPING, libraryRoot), 1, {
      key: 'k2',
      title: 'A',
    });
  });

  const plan = ok(result!);
  assert.equal(plan.blockers.length, 1);
  assert.ok(
    plan.blockers[0]!.includes(join(libraryRoot, 'k1', '1080.mp4')),
    'the blocker must name the file it could not place',
  );
  assert.match(plan.blockers[0]!, /escapes the library root/);
  assert.deepEqual(plan.renames, []);
});

/** The mirror case: `planImport` itself throws, rather than returning a bad path. */
test('a plugin that throws while planning a file is a blocker, not a rejection', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);

  const THROWING: MediaTypePlugin = {
    ...FILING,
    planImport: () => {
      throw new Error('plugin exploded');
    },
  };

  let result: Awaited<ReturnType<typeof planIdentityChange>> | undefined;
  await assert.doesNotReject(async () => {
    result = await planIdentityChange(makeDeps(db, THROWING, libraryRoot), 1, {
      key: 'k2',
      title: 'A',
    });
  });

  const plan = ok(result!);
  assert.equal(plan.blockers.length, 1);
  assert.ok(
    plan.blockers[0]!.includes(join(libraryRoot, 'k1', '1080.mp4')),
    'the blocker must name the file it could not place',
  );
  assert.match(plan.blockers[0]!, /plugin exploded/);
});
