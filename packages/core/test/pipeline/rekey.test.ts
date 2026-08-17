import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename as realRename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import createScenesPlugin from '@pickarr/plugin-scenes';
import { getGroup, markPicked } from '../../src/db/groups.ts';
import { filesForGroup } from '../../src/db/imported-files.ts';
import { recordMetadataAnswer } from '../../src/db/metadata.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import { recordDiscoveredSite } from '../../src/db/sites.ts';
import { validateIdentity } from '../../src/ingest/commit.ts';
import { lstatOrNull } from '../../src/pipeline/import.ts';
import { getAppState, setAppState } from '../../src/db/app-state.ts';
import {
  applyMove,
  applyRekey,
  countDrift,
  planRekey,
  REKEY_MARKER_KEY,
  runRekeyOnBoot,
  type RekeyDeps,
  type RekeyOutcome,
} from '../../src/pipeline/rekey.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';

const LIBRARY_ROOT = '/library';
const PACKAGE_NAME = '@pickarr/plugin-scenes-package';

/**
 * `byId` and `byPackage` are kept deliberately distinct here, as they are in
 * the real registry: `byId` is keyed on the plugin's own id ('scenes'),
 * `byPackage` on the config package name, and `media_groups.plugin` stores
 * only the former. A double that answered both the same way (as a permissive
 * stub elsewhere in this codebase does) would let `rekey.ts` resolve the
 * plugin by the wrong key without any test noticing — which is exactly the
 * defect Step 5 of the task brief exists to catch.
 *
 * `libraryRoot` defaults to the fixed placeholder every non-filesystem test
 * uses; Task 5's rename tests pass a real `mkdtemp` directory instead, since
 * they exercise `node:fs/promises` against actual files.
 */
function registryFor(plugin: MediaTypePlugin, libraryRoot: string = LIBRARY_ROOT): PluginRegistry {
  return {
    byPackage: (name) => {
      if (name !== PACKAGE_NAME) throw new Error(`No plugin registered for package ${name}`);
      return plugin;
    },
    byId: (id) => (id === plugin.id ? plugin : undefined),
    libraryRoot: () => libraryRoot,
    libraryRootById: () => libraryRoot,
    all: () => [plugin],
  };
}

/** A fresh plugin and registry per test, so `learnSites` state from one test can never leak into another. */
function setup(): { db: DatabaseSync; plugin: MediaTypePlugin; registry: PluginRegistry } {
  const db = openTestDatabase();
  const plugin = createScenesPlugin({}) as MediaTypePlugin;
  return { db, plugin, registry: registryFor(plugin) };
}

/**
 * The same fixture as `setup`, except `registry.libraryRootById` points at a
 * real, empty directory (`node:fs/promises` `mkdtemp`, per the task brief)
 * rather than the fixed `/library` placeholder — for the tests below that
 * exercise real renames rather than only the paths `planRekey` computes.
 * Callers are responsible for `rm(libraryRoot, { recursive: true })` when
 * done; there is no registration-based cleanup here because `node:test` has
 * no per-test teardown hook to hang it on.
 */
async function setupWithRealLibrary(): Promise<{
  db: DatabaseSync;
  plugin: MediaTypePlugin;
  registry: PluginRegistry;
  libraryRoot: string;
}> {
  const db = openTestDatabase();
  const plugin = createScenesPlugin({}) as MediaTypePlugin;
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-rekey-'));
  return { db, plugin, registry: registryFor(plugin, libraryRoot), libraryRoot };
}

/**
 * Asks the plugin itself where a file would land for a given identity —
 * exactly what `computeRenames` does internally, called here only to build a
 * real, correctly-located fixture file, never to predict a value the tests
 * below assert against. `extension` is fixed at `.mp4` throughout this
 * section so two calls for the same identity always agree on it.
 */
function realPlannedPath(
  plugin: MediaTypePlugin,
  libraryRoot: string,
  identityKey: string,
  displayJson: string,
): string {
  const media: ParsedRelease = {
    identityKey,
    display: JSON.parse(displayJson) as ParsedRelease['display'],
    quality: {},
  };
  const plan = plugin.planImport(media, [
    { absolutePath: '/source/placeholder.mp4', relativePath: 'placeholder.mp4', sizeBytes: 1 },
  ]);
  assert.ok(plan !== null, 'fixture identity must produce a plan');
  const file = plan?.files[0];
  assert.ok(file !== undefined, 'fixture plan must have a file');
  if (file === undefined) throw new Error('unreachable');
  return resolve(libraryRoot, file.destination);
}

/** A `RekeyDeps.rename` that fails every call, for the "rename throws" case. */
const REJECTING_RENAME: RekeyDeps['rename'] = () => Promise.reject(new Error('rename refused'));

/**
 * A `RekeyDeps.rename` that behaves exactly like the real thing except for
 * one specific `from` path, which it refuses — so a test can make the second
 * of two renames fail while the first genuinely succeeds on disk, and then
 * check that `applyMove` puts the first one back.
 */
function renameThatRefuses(refuseFrom: string): RekeyDeps['rename'] {
  return async (from, to) => {
    if (from === refuseFrom) throw new Error(`rename refused for ${from}`);
    await realRename(from, to);
  };
}

/**
 * `RekeyDeps.commit`'s only legitimate implementation — see the interface's
 * own doc comment for why there can only be one.
 */
const REAL_COMMIT: RekeyDeps['commit'] = (db) => db.exec('COMMIT');

/**
 * A `RekeyDeps.commit` that always throws, so `applyRekey test 18` can force
 * a commit failure deterministically. This is deliberately not a deferred
 * foreign key: a deferred FK trips wherever `COMMIT` ends up being called,
 * so it cannot tell "commit after the rename" from "commit before it" —
 * exactly the distinction `applyMove`'s ordering exists to get right, and
 * the reason an earlier version of this test's break-on-purpose evidence
 * did not hold. This fake throws regardless of where the call sits, and the
 * test asserts on the *disk and db state that results*, which does depend on
 * the ordering.
 */
const REJECTING_COMMIT: RekeyDeps['commit'] = () => {
  throw new Error('commit refused');
};

let nextFeedItemId = 1;

/**
 * Inserts a group and its earliest release directly, per the brief's Step 1:
 * the test states the database it means rather than driving ingest. `plugin`
 * defaults to the scenes plugin's own id so most fixtures need not repeat it.
 */
function groupWithRelease(
  db: DatabaseSync,
  opts: {
    rawTitle: string;
    identityKey: string;
    display: string;
    plugin?: string;
    editedAt?: number;
  },
): number {
  const feedItemId = nextFeedItemId++;
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, ?, ?, 1)`,
  ).run(feedItemId, `guid-${feedItemId}`, opts.rawTitle, `https://indexer.invalid/${feedItemId}`);

  const result = db
    .prepare(
      `INSERT INTO media_groups (plugin, identity_key, display, search_text, created_at, list_rank_at, edited_at)
       VALUES (?, ?, ?, 'search', 1, 1, ?)`,
    )
    .run(opts.plugin ?? 'scenes', opts.identityKey, opts.display, opts.editedAt ?? null);
  const groupId = Number(result.lastInsertRowid);

  db.prepare(
    `INSERT INTO releases (group_id, feed_item_id, quality, score, created_at)
     VALUES (?, ?, '{}', 1, 1)`,
  ).run(groupId, feedItemId);

  return groupId;
}

/** A group with no releases row at all — case 5, an unreachable raw title. */
function bareGroup(db: DatabaseSync, opts: { identityKey: string; display: string; plugin?: string }): number {
  const result = db
    .prepare(
      `INSERT INTO media_groups (plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (?, ?, ?, 'search', 1, 1)`,
    )
    .run(opts.plugin ?? 'scenes', opts.identityKey, opts.display);
  return Number(result.lastInsertRowid);
}

/**
 * Builds a fixture whose stored identity already agrees with what the plugin
 * parses today, by calling the plugin once at setup time. This is ordinary
 * test-fixture construction, not the case-2 exception below: nothing here is
 * *asserted* against the plugin's output, it only seeds a self-consistent
 * starting row for a group that is meant to need no repair.
 */
function agreeingIdentity(plugin: MediaTypePlugin, rawTitle: string): { identityKey: string; display: string } {
  const parsed = plugin.parse(rawTitle);
  assert.notEqual(parsed, null, `fixture title must parse: ${rawTitle}`);
  const validated = validateIdentity(parsed as ParsedRelease);
  assert.ok('identity' in validated, `fixture title must validate: ${rawTitle}`);
  const identity = (validated as { identity: { identityKey: string; displayJson: string } }).identity;
  return { identityKey: identity.identityKey, display: identity.displayJson };
}

function outcomeFor(proposals: { groupId: number; outcome: RekeyOutcome }[], groupId: number): RekeyOutcome {
  const found = proposals.find((proposal) => proposal.groupId === groupId);
  assert.ok(found !== undefined, `no proposal for group ${groupId}`);
  return found.outcome;
}

function addDownload(db: DatabaseSync, groupId: number, releaseId: number): number {
  const result = db
    .prepare(
      `INSERT INTO downloads (release_id, group_id, client_id, kind, status, created_at, updated_at)
       VALUES (?, ?, 'test-client', 'initial', 'imported', 1, 1)`,
    )
    .run(releaseId, groupId);
  return Number(result.lastInsertRowid);
}

function releaseIdFor(db: DatabaseSync, groupId: number): number {
  const row = db.prepare('SELECT id FROM releases WHERE group_id = ? ORDER BY id LIMIT 1').get(groupId);
  assert.ok(row !== undefined, `no release for group ${groupId}`);
  return Number((row as { id: number }).id);
}

/**
 * A second release on an existing group, with a score of its own. Needs a feed
 * item of its own too: `releases.feed_item_id` is UNIQUE, so two releases can
 * never share one. Never the group's *earliest* release, so the raw title
 * `planRekey` re-parses is still the one `groupWithRelease` inserted.
 */
function addRelease(db: DatabaseSync, groupId: number, opts: { rawTitle: string; score: number }): number {
  const feedItemId = nextFeedItemId++;
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, ?, ?, 1)`,
  ).run(feedItemId, `guid-${feedItemId}`, opts.rawTitle, `https://indexer.invalid/${feedItemId}`);
  const result = db
    .prepare(
      `INSERT INTO releases (group_id, feed_item_id, quality, score, created_at)
       VALUES (?, ?, '{}', ?, 1)`,
    )
    .run(groupId, feedItemId, opts.score);
  return Number(result.lastInsertRowid);
}

/**
 * `download_id` is a parameter rather than derived from `groupId` because the
 * two are independent columns, and the trashed-file test below depends on
 * their being able to disagree: it needs a group whose *only* history is a
 * trashed `imported_files` row, which is unreachable if the row's download
 * must also belong to that group.
 */
function addImportedFile(
  db: DatabaseSync,
  opts: { downloadId: number; groupId: number; destPath: string; trashedAt?: number },
): number {
  const trashedAt = opts.trashedAt ?? null;
  const result = db
    .prepare(
      `INSERT INTO imported_files
         (download_id, group_id, source_path, dest_path, size_bytes, trashed_at, trash_path, created_at)
       VALUES (?, ?, '/src/imported.mp4', ?, 12345, ?, ?, 1)`,
    )
    .run(opts.downloadId, opts.groupId, opts.destPath, trashedAt, trashedAt === null ? null : '/trash/old.mp4');
  return Number(result.lastInsertRowid);
}

/**
 * The collision the pass merges, as a fixture: a holder whose stored identity
 * already agrees with the parser, and a mover whose stored key does not but
 * whose title parses to the holder's. `Echo_Foxtrot` and `Echo.Foxtrot` reduce
 * to one slug, which is the mechanism behind the real pair this task exists
 * for — `ClubSweethearts.26.08.07.Foxy.Dreams.Solo.XXX.1080p` losing "Solo"
 * onto `ClubSweethearts.2026.08.07.Foxy.Dreams.720p` — without depending on
 * which suffix tokens the parser drops today.
 *
 * `moverFirst` exists for one test: ids come from insertion order, so it is
 * the only way to build a pair whose survivor is *not* the lower id.
 */
function collidingPair(
  db: DatabaseSync,
  plugin: MediaTypePlugin,
  opts: { date: string; name: string; moverFirst?: boolean },
): { holderId: number; moverId: number } {
  const holderRaw = `Site.${opts.date}.${opts.name}.XXX.1080p.MP4-GRP`;
  const moverRaw = `Site.${opts.date}.${opts.name.replaceAll('.', '_')}.XXX.2160p.MP4-GRP2`;
  const insertHolder = (): number =>
    groupWithRelease(db, { rawTitle: holderRaw, ...agreeingIdentity(plugin, holderRaw) });
  const insertMover = (): number =>
    groupWithRelease(db, {
      rawTitle: moverRaw,
      identityKey: `site:stale-mover:${opts.date}:${opts.name}`,
      display: '{"title":"stale mover","fields":[]}',
    });

  if (opts.moverFirst === true) {
    const moverId = insertMover();
    return { moverId, holderId: insertHolder() };
  }
  const holderId = insertHolder();
  return { holderId, moverId: insertMover() };
}

function releaseIdsFor(db: DatabaseSync, groupId: number): number[] {
  return db
    .prepare('SELECT id FROM releases WHERE group_id = ? ORDER BY id')
    .all(groupId)
    .map((row) => Number((row as { id: number }).id));
}

test('case 1: a stored key that already agrees with a fresh parse is unchanged', () => {
  const { db, plugin, registry } = setup();
  const rawTitle = 'Site.26.01.10.Alpha.Scene.XXX.1080p.MP4-GRP';
  const identity = agreeingIdentity(plugin, rawTitle);
  const groupId = groupWithRelease(db, { rawTitle, ...identity });

  const outcome = outcomeFor(planRekey(db, registry), groupId);
  assert.deepEqual(outcome, { kind: 'unchanged' });
});

test('case 2: a title carrying a trailing tag moves to whatever the plugin parses today', () => {
  const { db, plugin, registry } = setup();
  // "GERMAN" is a language suffix tag the current parser strips from the
  // title (see plugin-scenes' isLanguageSuffixToken); the key stored below
  // simulates what an older parser — one that kept it — would have written.
  const rawTitle = 'Site.26.01.11.Bravo.Scene.Name.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-01-11:bravo-scene-name-german',
    display: '{"title":"stale","fields":[]}',
  });

  // Sanctioned exception (brief, case 2): the property under test is
  // agreement with the parser, so the expected identity is obtained by
  // calling the plugin here, not by hardcoding a slug.
  const parsed = plugin.parse(rawTitle);
  assert.notEqual(parsed, null);
  const validated = validateIdentity(parsed as ParsedRelease);
  assert.ok('identity' in validated);
  const expected = (validated as { identity: { identityKey: string; displayJson: string; searchText: string } })
    .identity;

  const outcome = outcomeFor(planRekey(db, registry), groupId);
  assert.equal(outcome.kind, 'move');
  if (outcome.kind !== 'move') return;
  assert.equal(outcome.identityKey, expected.identityKey);
  assert.equal(outcome.displayJson, expected.displayJson);
  assert.equal(outcome.searchText, expected.searchText);
  assert.equal(outcome.displayChanged, true);
  assert.deepEqual(outcome.renames, []);
});

test('case 3: edited_at skips the group even though its title would move', () => {
  const { db, registry } = setup();
  const rawTitle = 'Site.26.01.12.Charlie.Scene.Name.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-01-12:charlie-scene-name-german',
    display: '{"title":"stale","fields":[]}',
    editedAt: 500,
  });

  const outcome = outcomeFor(planRekey(db, registry), groupId);
  assert.deepEqual(outcome, { kind: 'skipped-edited' });
});

test('case 4: a raw title the parser refuses is skipped-unparsable with a reason', () => {
  const { db, registry } = setup();
  const groupId = groupWithRelease(db, {
    rawTitle: 'hello',
    identityKey: 'whatever:something',
    display: '{"title":"whatever","fields":[]}',
  });

  const outcome = outcomeFor(planRekey(db, registry), groupId);
  assert.equal(outcome.kind, 'skipped-unparsable');
  if (outcome.kind !== 'skipped-unparsable') return;
  assert.equal(typeof outcome.reason, 'string');
  assert.ok(outcome.reason.length > 0);
});

test('case 5: a group with no releases row is skipped-unparsable', () => {
  const { db, registry } = setup();
  const groupId = bareGroup(db, {
    identityKey: 'whatever:something',
    display: '{"title":"whatever","fields":[]}',
  });

  const outcome = outcomeFor(planRekey(db, registry), groupId);
  assert.equal(outcome.kind, 'skipped-unparsable');
  if (outcome.kind !== 'skipped-unparsable') return;
  assert.ok(outcome.reason.length > 0);
});

test('case 6: two movers colliding with each other are both skipped-collision, each naming the other', () => {
  const { db, registry } = setup();
  // Both parse fresh (no site list) to "site:2026-02-01:charlie-delta"; only
  // the encode information differs, which the identity key never sees.
  const groupA = groupWithRelease(db, {
    rawTitle: 'Site.26.02.01.Charlie.Delta.XXX.1080p.MP4-GRP',
    identityKey: 'site:2026-02-01:charlie-delta-old-a',
    display: '{"title":"stale a","fields":[]}',
  });
  const groupB = groupWithRelease(db, {
    rawTitle: 'Site.26.02.01.Charlie.Delta.XXX.2160p.MP4-GRP2',
    identityKey: 'site:2026-02-01:charlie-delta-old-b',
    display: '{"title":"stale b","fields":[]}',
  });
  // "Both carrying history" per the brief; the mover-vs-mover rule does not
  // actually consult it, but the fixture matches the scenario it documents.
  addDownload(db, groupA, releaseIdFor(db, groupA));
  addDownload(db, groupB, releaseIdFor(db, groupB));

  const proposals = planRekey(db, registry);
  const outcomeA = outcomeFor(proposals, groupA);
  const outcomeB = outcomeFor(proposals, groupB);

  assert.equal(outcomeA.kind, 'skipped-collision');
  assert.equal(outcomeB.kind, 'skipped-collision');
  if (outcomeA.kind !== 'skipped-collision' || outcomeB.kind !== 'skipped-collision') return;
  assert.equal(outcomeA.withGroupId, groupB);
  assert.equal(outcomeB.withGroupId, groupA);
  assert.ok(outcomeA.reason.length > 0);
  assert.ok(outcomeB.reason.length > 0);
});

test('case 6a: a mover with no history merges into the group already holding its new key', () => {
  const { db, plugin, registry } = setup();
  const holderRaw = 'Site.26.02.02.Echo.Foxtrot.XXX.1080p.MP4-GRP';
  const holderIdentity = agreeingIdentity(plugin, holderRaw);
  const holderId = groupWithRelease(db, { rawTitle: holderRaw, ...holderIdentity });

  // Same scene, same site, same date, spelled with underscores instead of
  // dots — parses to the identical key the holder already occupies.
  const moverRaw = 'Site.26.02.02.Echo_Foxtrot.XXX.2160p.MP4-GRP2';
  const moverId = groupWithRelease(db, {
    rawTitle: moverRaw,
    identityKey: 'site:2026-02-02:echo-foxtrot-old-mover',
    display: '{"title":"stale mover","fields":[]}',
  });
  // Deliberately no downloads or imported_files rows: the mover has no history.

  const proposals = planRekey(db, registry);
  assert.deepEqual(outcomeFor(proposals, moverId), { kind: 'merge', intoGroupId: holderId });
  assert.deepEqual(outcomeFor(proposals, holderId), { kind: 'unchanged' });
});

test('case 6b: a mover with history is skipped-collision, never merged in the other direction', () => {
  const { db, plugin, registry } = setup();
  const holderRaw = 'Site.26.02.03.Golf.Hotel.XXX.1080p.MP4-GRP';
  const holderIdentity = agreeingIdentity(plugin, holderRaw);
  const holderId = groupWithRelease(db, { rawTitle: holderRaw, ...holderIdentity });

  const moverRaw = 'Site.26.02.03.Golf_Hotel.XXX.2160p.MP4-GRP2';
  const moverId = groupWithRelease(db, {
    rawTitle: moverRaw,
    identityKey: 'site:2026-02-03:golf-hotel-old-mover',
    display: '{"title":"stale mover","fields":[]}',
  });
  addDownload(db, moverId, releaseIdFor(db, moverId));

  const proposals = planRekey(db, registry);
  const moverOutcome = outcomeFor(proposals, moverId);
  assert.equal(moverOutcome.kind, 'skipped-collision');
  if (moverOutcome.kind !== 'skipped-collision') return;
  assert.equal(moverOutcome.withGroupId, holderId);
  assert.ok(moverOutcome.reason.length > 0);
  // The holder — which has no history of its own — is not merged away either;
  // the rule never reverses direction to make a merge possible.
  assert.deepEqual(outcomeFor(proposals, holderId), { kind: 'unchanged' });
});

test('case 7: an unchanged key with a corrected display is a move, not unchanged', () => {
  const { db, plugin, registry } = setup();
  const rawTitle = 'JulesJordan.26.03.01.Hotel.India.XXX.1080p.MP4-GRP';

  // Stored before the site was confirmed: the unresolved spelling reached
  // both the display and (harmlessly) the key's own site segment, which
  // collapses either spelling to the same comparison key.
  const unresolved = agreeingIdentity(plugin, rawTitle);
  const groupId = groupWithRelease(db, { rawTitle, ...unresolved });

  // The site is now confirmed, the way `discovered_sites` records it once
  // ThePornDB (or the user's config) has answered.
  recordDiscoveredSite(db, 'JulesJordan', { site: 'Jules Jordan' }, 'test', 1);

  const outcome = outcomeFor(planRekey(db, registry), groupId);
  assert.equal(outcome.kind, 'move');
  if (outcome.kind !== 'move') return;
  assert.equal(outcome.identityKey, unresolved.identityKey);
  assert.equal(outcome.displayChanged, true);
  assert.notEqual(outcome.displayJson, unresolved.display);
  assert.ok(outcome.displayJson.includes('Jules Jordan'));
  assert.deepEqual(outcome.renames, []);
});

test('case 8: a group whose plugin id the registry does not know is skipped-unparsable', () => {
  const { db, registry } = setup();
  const groupId = groupWithRelease(db, {
    rawTitle: 'Site.26.03.02.India.Juliet.XXX.1080p.MP4-GRP',
    identityKey: 'whatever:something',
    display: '{"title":"whatever","fields":[]}',
    plugin: 'no-such-plugin',
  });

  const outcome = outcomeFor(planRekey(db, registry), groupId);
  assert.equal(outcome.kind, 'skipped-unparsable');
  if (outcome.kind !== 'skipped-unparsable') return;
  assert.ok(outcome.reason.includes('no-such-plugin'));
});

test('case 9: renames cover live imported files and skip trashed ones', () => {
  const { db, registry } = setup();
  const rawTitle = 'Site.26.04.01.India.Juliet.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-04-01:india-juliet-german',
    display: '{"title":"stale","fields":[]}',
  });

  const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));

  const live = db
    .prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (?, ?, '/src/live.mp4', '/library/Site/old-name.mp4', 12345, 1)`,
    )
    .run(downloadId, groupId);
  const liveFileId = Number(live.lastInsertRowid);

  db.prepare(
    `INSERT INTO imported_files
       (download_id, group_id, source_path, dest_path, size_bytes, trashed_at, trash_path, created_at)
     VALUES (?, ?, '/src/trashed.mp4', '/library/Site/trashed-name.mp4', 999, 2, '/trash/old.mp4', 1)`,
  ).run(downloadId, groupId);

  const outcome = outcomeFor(planRekey(db, registry), groupId);
  assert.equal(outcome.kind, 'move');
  if (outcome.kind !== 'move') return;
  assert.equal(outcome.renames.length, 1);
  const rename = outcome.renames[0];
  assert.ok(rename !== undefined);
  if (rename === undefined) return;
  assert.equal(rename.fileId, liveFileId);
  assert.equal(rename.from, '/library/Site/old-name.mp4');
  assert.ok(rename.to.startsWith('/library/'));
  assert.ok(rename.to.endsWith('.mp4'));
  assert.notEqual(rename.to, rename.from);
});

test('case 9b: renames is empty for a moving group with no live imported files', () => {
  const { db, registry } = setup();
  const rawTitle = 'Site.26.04.02.Kilo.Lima.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-04-02:kilo-lima-german',
    display: '{"title":"stale","fields":[]}',
  });

  const outcome = outcomeFor(planRekey(db, registry), groupId);
  assert.equal(outcome.kind, 'move');
  if (outcome.kind !== 'move') return;
  assert.deepEqual(outcome.renames, []);
});

test('a destination that lexically escapes the library root is skipped, not renamed', () => {
  // Not reachable with the shipped plugin — nothing in it can turn an
  // identity key into a `..`-escaping or absolute destination — so this
  // drives `computeRenames` through a plugin double whose `planImport`
  // returns exactly the shape `pipeline/import.ts`'s `resolveDestination`
  // refuses at real import time. The point is that this pass refuses it too,
  // rather than handing it straight to `rename()`.
  const { db, plugin: realPlugin } = setup();
  const rawTitle = 'Site.26.05.03.Oscar.Papa.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-05-03:oscar-papa-german',
    display: '{"title":"stale","fields":[]}',
  });
  const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));
  db.prepare(
    `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
     VALUES (?, ?, '/src/live.mp4', '/library/Site/old-name.mp4', 12345, 1)`,
  ).run(downloadId, groupId);

  const escapingPlugin: MediaTypePlugin = {
    ...realPlugin,
    planImport: () => ({ files: [{ source: '/src/live.mp4', destination: '../../etc/evil.mp4' }] }),
  };
  const escapingRegistry = registryFor(escapingPlugin);

  const outcome = outcomeFor(planRekey(db, escapingRegistry), groupId);
  assert.equal(outcome.kind, 'skipped-unparsable');
  if (outcome.kind !== 'skipped-unparsable') return;
  assert.ok(outcome.reason.includes('escapes the library root'), outcome.reason);
});

test('a group with two live files where one destination cannot be computed is skipped, not moved', () => {
  const { db, registry } = setup();
  // Otherwise a clean move: GERMAN is the language suffix the current parser
  // strips (as in case 2/9), so the stored key is stale and this would move.
  const rawTitle = 'Site.26.05.01.Mike.November.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-05-01:mike-november-german',
    display: '{"title":"stale","fields":[]}',
  });
  const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));

  // One file whose destination the plugin can compute...
  db.prepare(
    `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
     VALUES (?, ?, '/src/live-a.mp4', '/library/Site/old-a.mp4', 12345, 1)`,
  ).run(downloadId, groupId);
  // ...and one it cannot: an extension `planSceneImport` does not recognize
  // as video, so it finds no importable file and returns null for this one.
  const unresolvable = db.prepare(
    `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
     VALUES (?, ?, '/src/live-b.nfo', '/library/Site/old-b.nfo', 999, 1)`,
  ).run(downloadId, groupId);
  const unresolvableFileId = Number(unresolvable.lastInsertRowid);

  const outcome = outcomeFor(planRekey(db, registry), groupId);
  assert.equal(outcome.kind, 'skipped-unparsable');
  if (outcome.kind !== 'skipped-unparsable') return;
  // The whole group is refused, not half-renamed — the reason names the
  // specific file that could not be planned, not just "something failed".
  assert.ok(outcome.reason.includes(`imported file ${unresolvableFileId}`));
  assert.ok(outcome.reason.includes('planImport returned null'));
});

test('3-way collision: two movers and a holder targeting one slot are each skipped-collision, never merged', () => {
  const { db, plugin, registry } = setup();
  const holderRaw = 'Site.26.02.04.Hotel.India.XXX.1080p.MP4-GRP';
  const holderIdentity = agreeingIdentity(plugin, holderRaw);
  const holderId = groupWithRelease(db, { rawTitle: holderRaw, ...holderIdentity });

  // Both movers parse fresh to the identical key the holder already owns;
  // only the encode information differs, which the identity key never sees.
  const mover1Raw = 'Site.26.02.04.Hotel_India.XXX.2160p.MP4-GRP2';
  const mover1Id = groupWithRelease(db, {
    rawTitle: mover1Raw,
    identityKey: 'site:2026-02-04:hotel-india-old-mover-1',
    display: '{"title":"stale mover 1","fields":[]}',
  });
  // Deliberately no history on this mover: a bare mover-vs-holder pair with
  // no history would merge (case 6a), so this is the case that most needs a
  // dedicated assertion — a *second* mover contending for the same slot must
  // still block the merge, because "the same scene" is not what a 3-way
  // pile-up means, and a wrong merge deletes a group.

  const mover2Raw = 'Site.26.02.04.Hotel-India.XXX.720p.MP4-GRP3';
  const mover2Id = groupWithRelease(db, {
    rawTitle: mover2Raw,
    identityKey: 'site:2026-02-04:hotel-india-old-mover-2',
    display: '{"title":"stale mover 2","fields":[]}',
  });

  const proposals = planRekey(db, registry);
  const holderOutcome = outcomeFor(proposals, holderId);
  const mover1Outcome = outcomeFor(proposals, mover1Id);
  const mover2Outcome = outcomeFor(proposals, mover2Id);

  assert.deepEqual(holderOutcome, { kind: 'unchanged' });
  assert.equal(mover1Outcome.kind, 'skipped-collision');
  assert.equal(mover2Outcome.kind, 'skipped-collision');
  // The assertion that matters most: neither history-free mover is merged
  // away just because it happens to have no history of its own.
  assert.notEqual(mover1Outcome.kind, 'merge');
  assert.notEqual(mover2Outcome.kind, 'merge');
});

// ---------------------------------------------------------------------------
// Task 4: applyRekey — the writer. planRekey above never touches the
// database; everything below proves the write half does exactly as much,
// and no more.
// ---------------------------------------------------------------------------

/**
 * A stopped clock, so the one timestamp a pass can move — `list_rank_at`, when
 * a merge brings the survivor something better than its pick — is a value the
 * tests can name outright instead of bounding against a wall clock they would
 * then be racing.
 */
const MERGE_NOW = 9_000_000;
// `rename` is the real `node:fs/promises` function: every test above this
// point produces `renames: []` (no live imported files), so it is never
// actually called by them — it is only wired up here so `DEPS` satisfies
// `RekeyDeps` without a stub that would silently paper over that fact.
const DEPS: RekeyDeps = { now: () => MERGE_NOW, rename: realRename, commit: REAL_COMMIT };

/**
 * Every table `clearGroupMetadata` clears, enumerated rather than counted, so
 * a future sixth table added there fails these tests by omission instead of
 * silently passing.
 *
 * This list has now gone stale three times — three, then four, then five —
 * each time a table was added to `clearGroupMetadata` without this literal
 * growing alongside it. A derived version (reading `sqlite_master` for every
 * table with a `group_id` column, say, or introspecting the statements
 * `clearGroupMetadata` runs) was considered and rejected: either it recovers
 * the same list `clearGroupMetadata` already encodes, which makes the
 * assertion tautological against the very function under test, or it widens
 * to "every table with a `group_id` foreign key" and starts failing on tables
 * (`downloads`, `imported_files`) that `clearGroupMetadata` deliberately does
 * *not* touch, per the no-cascade rationale on that function. A maintained
 * literal, wrong in an obvious and loud way (a `FOREIGN KEY constraint
 * failed` from `deleteGroup`, not a silently-passing test), beats either.
 * `performer_queue` is the fifth and newest (`db/metadata.ts:387`).
 *
 * The obligation this comment exists to state: the next table added to
 * `clearGroupMetadata` must be added here in the same change, and
 * `seedAllMetadataTables` below must be taught to seed a row in it.
 */
const METADATA_TABLES = [
  'group_metadata',
  'metadata_queue',
  'metadata_candidates',
  'group_performers',
  'performer_queue',
] as const;

/**
 * Leaves a row for `groupId` in all five `METADATA_TABLES`: an answer, a
 * rejected candidate recorded alongside it, a cast link, a metadata-queue row
 * inserted directly afterward, and a performer-queue row inserted directly
 * afterward too — mirroring the equivalent fixture in
 * `manual/operations.test.ts`. Both queue rows are added by hand rather than
 * through their own insert helpers: `recordMetadataAnswer` itself deletes the
 * metadata-queue row it answers, so it has to be re-added; and
 * `insertPerformerSearch` refuses to queue a group that already has a cast
 * (`groupHasCast`), which this group does, so it would silently no-op here.
 * The cast is deliberately non-empty: an empty `performers` array would leave
 * no row in `group_performers` at all, and a test built that way would pass
 * against a `clearGroupMetadata` that had never heard of that table.
 */
function seedAllMetadataTables(db: DatabaseSync, groupId: number): void {
  recordMetadataAnswer(db, {
    groupId,
    source: 'theporndb',
    confirmed: {
      sourceUuid: `source-uuid-${groupId}`,
      title: 'Some Scene',
      siteUuid: null,
      siteId: null,
      siteName: 'Site',
      date: '2020-01-01',
      performers: [
        {
          sourceUuid: `performer-uuid-${groupId}`,
          slug: `performer-${groupId}`,
          name: 'Some Performer',
          kind: 'performer',
          faceUrl: null,
          imageUrl: null,
        },
      ],
      durationSeconds: null,
      synopsis: null,
      posterUrl: null,
      slug: null,
    },
    nearMisses: [
      {
        candidate: {
          sourceUuid: `rejected-uuid-${groupId}`,
          title: 'Rejected Scene',
          siteUuid: null,
          siteId: null,
          siteName: 'Site',
          date: '2020-01-01',
          performers: [],
          durationSeconds: null,
          synopsis: null,
          posterUrl: null,
          slug: null,
        },
        reason: 'date outside window',
      },
    ],
    now: 1000,
  });
  db.prepare(
    `INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at)
     VALUES (?, 2000, 0, 2000)`,
  ).run(groupId);
  db.prepare(
    `INSERT INTO performer_queue (group_id, requested_at, attempts, next_at)
     VALUES (?, 2000, 0, 2000)`,
  ).run(groupId);
}

function assertMetadataTablesEmpty(db: DatabaseSync, groupId: number): void {
  for (const table of METADATA_TABLES) {
    const row = db.prepare(`SELECT 1 FROM ${table} WHERE group_id = ?`).get(groupId);
    assert.equal(row, undefined, `${table} must be cleared for group ${groupId}`);
  }
}

function assertMetadataTablesSurvive(db: DatabaseSync, groupId: number): void {
  for (const table of METADATA_TABLES) {
    const row = db.prepare(`SELECT 1 FROM ${table} WHERE group_id = ?`).get(groupId);
    assert.notEqual(row, undefined, `${table} must survive for group ${groupId}`);
  }
}

test('applyRekey test 1: a move proposal writes identity_key, display and search_text together', async () => {
  const { db, plugin, registry } = setup();
  const rawTitle = 'Site.26.06.01.November.Oscar.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-06-01:november-oscar-german',
    display: '{"title":"stale","fields":[]}',
  });

  // Sanctioned exception, as in planRekey's case 2 above: the property under
  // test is agreement with the parser, so the expected values come from
  // calling the plugin, not from a hardcoded slug.
  const parsed = plugin.parse(rawTitle);
  assert.notEqual(parsed, null);
  const validated = validateIdentity(parsed as ParsedRelease);
  assert.ok('identity' in validated);
  const expected = (validated as { identity: { identityKey: string; displayJson: string; searchText: string } })
    .identity;

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.moved, 1);

  const row = getGroup(db, groupId);
  assert.ok(row !== null);
  assert.equal(row?.identityKey, expected.identityKey);
  assert.equal(row?.display, expected.displayJson);
  assert.equal(row?.searchText, expected.searchText);
});

test('applyRekey test 2: a displayChanged move clears all four metadata tables', async () => {
  const { db, registry } = setup();
  const rawTitle = 'Site.26.06.02.Papa.Quebec.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-06-02:papa-quebec-german',
    display: '{"title":"stale","fields":[]}',
  });
  seedAllMetadataTables(db, groupId);

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.moved, 1, 'fixture must actually move, or the clear below proves nothing');

  assertMetadataTablesEmpty(db, groupId);
});

test('applyRekey test 3: a move whose display already matches the parse does not clear metadata', async () => {
  const { db, plugin, registry } = setup();
  const rawTitle = 'Site.26.06.03.Romeo.Sierra.XXX.1080p.MP4-GRP';
  const correct = agreeingIdentity(plugin, rawTitle);
  // Reachable: the stored key and the stored display are independent
  // columns, not derived from one another, so a group can carry a wrong key
  // next to an already-correct display. That is exactly the condition
  // `displayChanged` gates on — the mirror of planRekey's case 7 above,
  // which reaches "key survives, display doesn't"; this reaches "key moves,
  // display doesn't".
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-06-03:wrong-stored-key',
    display: correct.display,
  });
  seedAllMetadataTables(db, groupId);

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.moved, 1);
  const row = getGroup(db, groupId);
  assert.equal(row?.identityKey, correct.identityKey, 'the key must still move');

  assertMetadataTablesSurvive(db, groupId);
});

test('applyRekey test 4: an unchanged group is not written at all', async () => {
  const { db, plugin, registry } = setup();
  const rawTitle = 'Site.26.06.04.Sierra.Tango.XXX.1080p.MP4-GRP';
  const identity = agreeingIdentity(plugin, rawTitle);
  const groupId = groupWithRelease(db, { rawTitle, ...identity });

  // A value the writer would overwrite if it wrote at all. Comparing stored
  // vs. computed search_text would pass even on a bug that writes the
  // (already-correct) value back — this sentinel differs from what a write
  // would produce, so its survival is proof no write happened.
  const sentinel = 'SENTINEL-applyRekey-unchanged-search-text';
  db.prepare('UPDATE media_groups SET search_text = ? WHERE id = ?').run(sentinel, groupId);

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.moved, 0);
  const row = getGroup(db, groupId);
  assert.equal(row?.searchText, sentinel);
});

test('applyRekey test 5: skipped groups are untouched and each is counted', async () => {
  const { db, registry } = setup();

  const editedRaw = 'Site.26.06.05.Uniform.Victor.GERMAN.XXX.1080p.MP4-GRP';
  const editedId = groupWithRelease(db, {
    rawTitle: editedRaw,
    identityKey: 'site:2026-06-05:uniform-victor-german',
    display: '{"title":"stale edited","fields":[]}',
    editedAt: 500,
  });

  const unparsableId = groupWithRelease(db, {
    rawTitle: 'hello',
    identityKey: 'whatever:something',
    display: '{"title":"whatever","fields":[]}',
  });

  const collisionRawA = 'Site.26.06.06.Whiskey.Xray.XXX.1080p.MP4-GRP';
  const collisionRawB = 'Site.26.06.06.Whiskey.Xray.XXX.2160p.MP4-GRP2';
  const collisionA = groupWithRelease(db, {
    rawTitle: collisionRawA,
    identityKey: 'site:2026-06-06:whiskey-xray-old-a',
    display: '{"title":"stale a","fields":[]}',
  });
  const collisionB = groupWithRelease(db, {
    rawTitle: collisionRawB,
    identityKey: 'site:2026-06-06:whiskey-xray-old-b',
    display: '{"title":"stale b","fields":[]}',
  });
  addDownload(db, collisionA, releaseIdFor(db, collisionA));
  addDownload(db, collisionB, releaseIdFor(db, collisionB));

  const ids = [editedId, unparsableId, collisionA, collisionB];
  const before = ids.map((id) => getGroup(db, id));

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.skippedEdited, 1);
  assert.equal(report.skippedUnparsable, 1);
  assert.equal(report.skippedCollision, 2);
  assert.equal(report.moved, 0);

  const after = ids.map((id) => getGroup(db, id));
  assert.deepEqual(after, before);
});

test('applyRekey test 6: edited_at, list_rank_at, created_at and picked_release_id are untouched by a move', async () => {
  const { db, registry } = setup();
  const rawTitle = 'Site.26.06.07.Yankee.Zulu.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-06-07:yankee-zulu-german',
    display: '{"title":"stale","fields":[]}',
  });
  const releaseId = releaseIdFor(db, groupId);
  // Set to a real, non-null value rather than left at its default null, so
  // survival is a meaningful assertion and not a null-equals-null accident.
  db.prepare('UPDATE media_groups SET picked_release_id = ? WHERE id = ?').run(releaseId, groupId);

  const before = getGroup(db, groupId);
  assert.ok(before !== null);

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.moved, 1);

  const after = getGroup(db, groupId);
  assert.ok(after !== null);
  // A pass is not a human: stamping edited_at here would immunise this group
  // against the next re-key pass (migrations.ts:268-272).
  assert.equal(after?.editedAt, null);
  assert.equal(after?.listRankAt, before?.listRankAt);
  assert.equal(after?.createdAt, before?.createdAt);
  assert.equal(after?.pickedReleaseId, releaseId);
});

test('applyRekey test 7: a group whose write throws is counted in failed and does not stop the pass', async () => {
  const { db, plugin, registry } = setup();

  // Ordered deliberately: planRekey walks `media_groups` by ascending id, so
  // this group is applied and committed *before* the poisoned one is even
  // reached. It is the half of the brief's invariant a poison placed first
  // cannot exercise on its own — "a single poison row must not roll back 59
  // good ones" is about groups that already landed, not just ones still to
  // come. `fineAfter` below keeps that direction covered too.
  const fineBeforeRaw = 'Site.26.06.07.Yankee.Alpha.GERMAN.XXX.1080p.MP4-GRP0';
  const fineBeforeId = groupWithRelease(db, {
    rawTitle: fineBeforeRaw,
    identityKey: 'site:2026-06-07:yankee-alpha-german',
    display: '{"title":"stale fine before","fields":[]}',
  });
  // Sanctioned exception, as in test 1 above: the property under test is
  // that this group actually moved (to whatever the parser says today, not
  // to a hardcoded guess), so the expected key comes from calling the
  // plugin directly.
  const fineBeforeParsed = plugin.parse(fineBeforeRaw);
  assert.notEqual(fineBeforeParsed, null);
  const fineBeforeValidated = validateIdentity(fineBeforeParsed as ParsedRelease);
  assert.ok('identity' in fineBeforeValidated);
  const fineBeforeExpectedKey = (fineBeforeValidated as { identity: { identityKey: string } }).identity.identityKey;

  const poisonRaw = 'Site.26.06.08.Alpha.Bravo.GERMAN.XXX.1080p.MP4-GRP';
  const poisonedId = groupWithRelease(db, {
    rawTitle: poisonRaw,
    identityKey: 'site:2026-06-08:alpha-bravo-german',
    display: '{"title":"stale poison","fields":[]}',
  });
  const fineRaw = 'Site.26.06.09.Charlie.Delta.GERMAN.XXX.1080p.MP4-GRP2';
  const fineId = groupWithRelease(db, {
    rawTitle: fineRaw,
    identityKey: 'site:2026-06-09:charlie-delta-german',
    display: '{"title":"stale fine","fields":[]}',
  });

  // Poisoned deliberately, from outside the code under test — the same
  // technique `pipeline/metadata.test.ts` uses for the equivalent claim: a
  // trigger that aborts this one group's UPDATE, standing in for a broken
  // constraint or a full disk. `RAISE(ROLLBACK, ...)`, not `RAISE(ABORT,
  // ...)`: ABORT unwinds only the statement that raised it and leaves the
  // surrounding transaction open, so a regression that widens the
  // transaction to wrap the whole loop while still catching per group would
  // behave identically to correct code under an ABORT poison and this test
  // would stay green for the wrong reason. ROLLBACK aborts the whole active
  // transaction, which is what actually distinguishes "one transaction per
  // group" from "one transaction for the pass": under the latter, this
  // poison would take `fineBefore`'s already-committed write down with it.
  db.exec(
    `CREATE TRIGGER poison_rekey BEFORE UPDATE ON media_groups
     FOR EACH ROW WHEN NEW.id = ${poisonedId}
     BEGIN SELECT RAISE(ROLLBACK, 'poisoned row'); END;`,
  );

  const before = getGroup(db, poisonedId);

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.failed, 1);
  assert.equal(report.moved, 2, 'both the group before and the group behind the poisoned one must still move');

  const fineBeforeAfter = getGroup(db, fineBeforeId);
  assert.equal(
    fineBeforeAfter?.identityKey,
    fineBeforeExpectedKey,
    'a group already committed before the poisoned one must survive its rollback',
  );

  const poisonedAfter = getGroup(db, poisonedId);
  assert.equal(poisonedAfter?.identityKey, before?.identityKey, 'the poisoned group must be left at its old key');

  const fineAfter = getGroup(db, fineId);
  assert.notEqual(fineAfter?.identityKey, 'site:2026-06-09:charlie-delta-german');
});

test(
  'applyRekey test 7b: a mover into another mover\'s vacated slot can fail permanently — ' +
    'known gap, pinned as current behaviour',
  async () => {
    // This is the vacated-slot gap named at the bucketing code in `rekey.ts`
    // and in the re-key spec's failure section: `planRekey` buckets a mover
    // only by the slot it moves *into*, never by the slot it *vacates*, so it
    // sees no collision between a group moving away from slot K and a second
    // group moving into that same, still-occupied K. Not a fix — pinning what
    // the code does today so a future change to the bucketing has to notice
    // it changed this.
    const { db, plugin, registry } = setup();

    // Fixture setup only (not an assertion): call the plugin once, the same
    // way `agreeingIdentity` does, to get the exact key format the parser
    // uses today rather than guessing it.
    const sharedRawTitle = 'Site.26.06.10.Alpha.Bravo.XXX.1080p.MP4-GRP1';
    const vacatedSlotKey = agreeingIdentity(plugin, sharedRawTitle).identityKey;

    // Group B, inserted first (lower id): its raw title is `sharedRawTitle`,
    // so a fresh parse sends it to `vacatedSlotKey` — the slot group A
    // currently, uncontestedly, holds below. B's own stored key is unrelated
    // and stale, so B is a genuine mover targeting that slot.
    const groupB = groupWithRelease(db, {
      rawTitle: sharedRawTitle,
      identityKey: 'site:2026-06-11:mike-november-stale',
      display: '{"title":"stale b","fields":[]}',
    });

    // Group A, inserted second (higher id): its *current* stored key is
    // exactly `vacatedSlotKey` — B's destination — but its own raw title
    // parses fresh to a third, different key (GERMAN strips, as elsewhere in
    // this file), so A is also a genuine mover, moving away from the very
    // slot B is moving into.
    const rawA = 'Site.26.06.10.Zulu.Yankee.GERMAN.XXX.1080p.MP4-GRP2';
    const groupA = groupWithRelease(db, {
      rawTitle: rawA,
      identityKey: vacatedSlotKey,
      display: '{"title":"stale a","fields":[]}',
    });
    assert.ok(groupB < groupA, 'sanity: B must be applied before A for the gap to bite');

    // `planRekey` reports no collision at all: A's bucket is keyed on A's
    // fresh destination, not on `vacatedSlotKey`, so nothing is filed under
    // `vacatedSlotKey` except B. Both are proposed as plain, uncontested
    // `move`s.
    const proposals = planRekey(db, registry);
    assert.equal(outcomeFor(proposals, groupB).kind, 'move');
    assert.equal(outcomeFor(proposals, groupA).kind, 'move');

    // `applyRekey` applies in ascending group-id order, so B's `move` runs
    // first — while A's row still holds `vacatedSlotKey` — and collides with
    // it under `UNIQUE (plugin, identity_key)`. B is counted in `failed` and
    // left exactly as it was; A's own move then runs unopposed once B's
    // attempt has rolled back, and succeeds. Nothing revisits a `failed`
    // group (see `REKEY_MARKER_KEY`'s doc comment for the manual recovery
    // path), so B stays failed even though A's move, moments later, frees
    // the very slot B wanted.
    const report = await applyRekey(db, registry, DEPS);
    assert.equal(report.failed, 1, 'B collides with A, which has not moved yet');
    assert.equal(report.moved, 1, 'A moves once, unopposed, after B has already failed');

    const rowB = getGroup(db, groupB);
    assert.equal(rowB?.identityKey, 'site:2026-06-11:mike-november-stale', 'B is left exactly as it was');

    const rowA = getGroup(db, groupA);
    assert.notEqual(rowA?.identityKey, vacatedSlotKey, 'A did move away from the slot B wanted');
  },
);

// ---------------------------------------------------------------------------
// Task 4a: the merge. The only outcome in this pass that deletes a row, and
// the only one narrowing a spec decision rather than implementing it — see
// spec §5 for the two classes of collision and why exactly one of them is
// merged. Everything below is about which class a given pair falls in, and
// the answer is always read off `groupHistory`, never off the titles.
// ---------------------------------------------------------------------------

test('applyRekey test 8: a mover with no history folds into the holder, which keeps its key, pick and files', async () => {
  const { db, plugin, registry } = setup();
  const { holderId, moverId } = collidingPair(db, plugin, { date: '26.07.01', name: 'Foxy.Dreams' });

  // The holder is the group the owner's real 1137 is: picked, downloaded,
  // with a file in the library under its own name.
  const holderReleaseId = releaseIdFor(db, holderId);
  const holderDownloadId = addDownload(db, holderId, holderReleaseId);
  const holderFileId = addImportedFile(db, {
    downloadId: holderDownloadId,
    groupId: holderId,
    destPath: '/library/Site/holder.mp4',
  });
  markPicked(db, holderId, holderReleaseId);
  const holderBefore = getGroup(db, holderId);
  assert.ok(holderBefore !== null);

  // And the mover is 106: several releases, one of them better than anything
  // the holder has, and nothing else at all. Metadata on both, because the
  // source's must go before the delete can succeed (`group_id REFERENCES
  // media_groups` with no ON DELETE) and the survivor's must not.
  const moverExtraId = addRelease(db, moverId, { rawTitle: 'Site.26.07.01.Foxy_Dreams.XXX.1080p.MP4-WRB', score: 100 });
  const moverReleaseIds = releaseIdsFor(db, moverId);
  assert.equal(moverReleaseIds.length, 2, 'the mover must bring more than one release, or "every release moves" is untested');
  seedAllMetadataTables(db, moverId);
  seedAllMetadataTables(db, holderId);

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.merged, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.skippedCollision, 0);

  assert.equal(getGroup(db, moverId), null, 'the mover is gone');
  assert.deepEqual(
    releaseIdsFor(db, holderId),
    [holderReleaseId, ...moverReleaseIds].toSorted((a, b) => a - b),
    'every one of the mover\'s releases is now the holder\'s',
  );

  const holderAfter = getGroup(db, holderId);
  assert.ok(holderAfter !== null);
  assert.equal(holderAfter?.identityKey, holderBefore?.identityKey, 'the holder keeps the key it already held');
  assert.equal(holderAfter?.display, holderBefore?.display);
  assert.equal(holderAfter?.pickedReleaseId, holderReleaseId, 'the merge never re-picks');
  // The point of the whole exercise, stated as an assertion: the better
  // encode the user could not previously see is now flagged on the group they
  // actually have, and the group has moved up the list because of it.
  assert.equal(holderAfter?.upgradeReleaseId, moverExtraId);
  assert.equal(holderAfter?.listRankAt, MERGE_NOW);

  const holderFile = db.prepare('SELECT group_id FROM imported_files WHERE id = ?').get(holderFileId);
  assert.equal(Number((holderFile as { group_id: number }).group_id), holderId, 'the holder keeps its imported file');

  assertMetadataTablesEmpty(db, moverId);
  assertMetadataTablesSurvive(db, holderId);
});

// Tests 9 and 10 below assert only the final `skippedCollision`/`merged`
// counts, which two independent mechanisms can both produce: `planRekey`'s
// own history check (it never proposes `merge` for a mover with history in
// the first place) and `applyRekey`'s write-time re-check inside the merge
// transaction (see `rekey.ts`'s comment on why the history rule is asked
// twice). Since the fixtures here give both mechanisms the same answer,
// "these still pass" is not evidence either guard individually still fires —
// deleting one of the two would not fail either test. `applyRekey test 15`
// is what pins the re-check specifically, by making history appear only
// between plan and apply so the two mechanisms disagree.
test('applyRekey test 9: a mover with a download is not merged, and the holder is not merged away instead', async () => {
  const { db, plugin, registry } = setup();
  const { holderId, moverId } = collidingPair(db, plugin, { date: '26.07.02', name: 'Golf.Hotel' });
  const moverReleaseIds = releaseIdsFor(db, moverId);
  const holderReleaseIds = releaseIdsFor(db, holderId);
  addDownload(db, moverId, releaseIdFor(db, moverId));
  // The holder deliberately has none. This is the direction assertion: with
  // history on the mover and none on the holder, the one merge that would
  // still be possible is the reverse one, and the pass must refuse it rather
  // than delete the group that actually holds the key. Nothing in the rule
  // reads which group is moving; it reads what each would lose.

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.merged, 0);
  assert.equal(report.skippedCollision, 1);
  assert.equal(report.failed, 0);

  assert.notEqual(getGroup(db, moverId), null, 'the mover survives');
  assert.notEqual(getGroup(db, holderId), null, 'and so does the holder');
  assert.deepEqual(releaseIdsFor(db, moverId), moverReleaseIds, 'no releases moved either way');
  assert.deepEqual(releaseIdsFor(db, holderId), holderReleaseIds);
});

test('applyRekey test 10: a mover whose only history is a trashed imported file is not merged', async () => {
  const { db, plugin, registry } = setup();
  const { holderId, moverId } = collidingPair(db, plugin, { date: '26.07.03', name: 'India.Juliet' });

  // The download hangs off the holder on purpose. `groupHistory` answers
  // `imported-files` before it looks at downloads, so a mover carrying a
  // download of its own would be refused on that branch and this test would
  // pass without the trashed row ever mattering.
  const holderDownloadId = addDownload(db, holderId, releaseIdFor(db, holderId));
  addImportedFile(db, {
    downloadId: holderDownloadId,
    groupId: moverId,
    destPath: '/library/Site/mover-trashed.mp4',
    trashedAt: 5,
  });

  const report = await applyRekey(db, registry, DEPS);
  // A trashed file is still a file that was placed on disk under this group's
  // name, and the trash row records where it went. Merging would delete the
  // group that record points at.
  assert.equal(report.merged, 0);
  assert.equal(report.skippedCollision, 1);
  assert.notEqual(getGroup(db, moverId), null);
  assert.notEqual(getGroup(db, holderId), null);
});

test('applyRekey test 11: two groups that both carry history are a counted skipped-collision', async () => {
  const { db, plugin, registry } = setup();
  const { holderId, moverId } = collidingPair(db, plugin, { date: '26.07.04', name: 'Kilo.Lima' });
  const moverDownloadId = addDownload(db, moverId, releaseIdFor(db, moverId));
  addImportedFile(db, { downloadId: moverDownloadId, groupId: moverId, destPath: '/library/Site/mover.mp4' });
  const holderDownloadId = addDownload(db, holderId, releaseIdFor(db, holderId));
  addImportedFile(db, { downloadId: holderDownloadId, groupId: holderId, destPath: '/library/Site/holder.mp4' });

  // Spec §5's original class reaches here too: two genuinely different scenes
  // that collide only because the parser stopped distinguishing them will
  // ordinarily have files on both sides, and this is the outcome that keeps
  // them both.
  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.merged, 0);
  assert.equal(report.skippedCollision, 1);
  assert.notEqual(getGroup(db, moverId), null);
  assert.notEqual(getGroup(db, holderId), null);
});

test('applyRekey test 12: with neither group carrying history the holder survives, whatever the ids are', async () => {
  const { db, plugin, registry } = setup();
  // The holder survives **by construction, not by luck of row order**: it is
  // the group that already occupies the slot, and folding the other way would
  // additionally have to re-key the survivor into the freed slot, which is not
  // an operation `mergeGroupInto` performs. So there is no tiebreak to apply
  // when neither group has history — there are not two candidates.
  //
  // Inserted mover-first anyway, so the survivor is the *higher* id. That is
  // what makes this test able to fail: under a "lowest id wins" reading
  // (migration 4's last resort, `migrations.ts:254-260`, which was carried
  // into this task's brief in error) the mover would be the survivor here, and
  // the assertions below would catch it.
  const { holderId, moverId } = collidingPair(db, plugin, {
    date: '26.07.05',
    name: 'Mike.November',
    moverFirst: true,
  });
  assert.ok(moverId < holderId, 'the fixture only proves anything if the survivor is the higher id');
  const holderBefore = getGroup(db, holderId);

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.merged, 1);
  assert.equal(getGroup(db, moverId), null);
  assert.equal(getGroup(db, holderId)?.identityKey, holderBefore?.identityKey);
  // Nothing arrived that beats a pick the holder does not have, so the merge
  // is not an arrival and the list order stands.
  assert.equal(getGroup(db, holderId)?.listRankAt, holderBefore?.listRankAt);
});

test('applyRekey test 13: the surviving group is not stamped edited_at', async () => {
  const { db, plugin, registry } = setup();
  const { holderId, moverId } = collidingPair(db, plugin, { date: '26.07.06', name: 'Oscar.Papa' });

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.merged, 1);
  assert.equal(getGroup(db, moverId), null);
  // The manual merge this body was lifted from stamps the survivor, and its
  // comment justifies that by a human having named the scene. A pass is not a
  // human, and `edited_at` is what tells the *next* run of this pass to leave
  // a row alone (test 3, `migrations.ts:268-272`) — so stamping here would
  // exempt every merged-into group from every future parser fix.
  assert.equal(getGroup(db, holderId)?.editedAt, null);
});

test('applyRekey test 14: a merge that throws is counted in failed and does not stop the pass', async () => {
  const { db, plugin, registry } = setup();
  const poisoned = collidingPair(db, plugin, { date: '26.07.07', name: 'Quebec.Romeo' });
  const clean = collidingPair(db, plugin, { date: '26.07.08', name: 'Sierra.Tango' });
  seedAllMetadataTables(db, poisoned.moverId);
  const poisonedReleaseIds = releaseIdsFor(db, poisoned.moverId);

  // Poisoned from outside the code under test, as applyRekey test 7 does, and
  // aimed at the delete: that is the last statement of the merge, so a
  // rollback here has the largest amount of already-applied work to undo, and
  // the assertions below are how we know it undid all of it rather than
  // leaving the releases parked on a group the pass then failed to delete.
  db.exec(
    `CREATE TRIGGER poison_merge BEFORE DELETE ON media_groups
     FOR EACH ROW WHEN OLD.id = ${poisoned.moverId}
     BEGIN SELECT RAISE(ROLLBACK, 'poisoned merge'); END;`,
  );

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.failed, 1);
  assert.equal(report.merged, 1, 'the merge behind the poisoned one must still happen');

  assert.notEqual(getGroup(db, poisoned.moverId), null, 'the failed merge leaves its mover in place');
  assert.deepEqual(releaseIdsFor(db, poisoned.moverId), poisonedReleaseIds, 'and its releases with it');
  assertMetadataTablesSurvive(db, poisoned.moverId);

  assert.equal(getGroup(db, clean.moverId), null);
  assert.notEqual(getGroup(db, clean.holderId), null);
});

test('applyRekey test 15: history appearing between plan and apply skips the merge instead of failing it', async () => {
  const { db, plugin, registry } = setup();

  // Applied first — `planRekey` orders by group id and this one is inserted
  // before the pair — and used only as a place to hang the trigger below, so
  // that the download appears *after* the plan was computed and *before* the
  // merge it invalidates is reached. That window is the whole subject of this
  // test: `applyRekey` plans once and then writes, and the plan-time history
  // check is a snapshot of a moment that has passed by the time the delete
  // runs.
  const triggerRaw = 'Site.26.07.09.Uniform.Victor.GERMAN.XXX.1080p.MP4-GRP';
  const triggerId = groupWithRelease(db, {
    rawTitle: triggerRaw,
    identityKey: 'site:2026-07-09:uniform-victor-german',
    display: '{"title":"stale","fields":[]}',
  });

  const { holderId, moverId } = collidingPair(db, plugin, { date: '26.07.10', name: 'Whiskey.Xray' });
  const moverReleaseIds = releaseIdsFor(db, moverId);
  const moverReleaseId = releaseIdFor(db, moverId);
  assert.ok(triggerId < moverId, 'the trigger group must be applied before the merge it invalidates');

  db.exec(
    `CREATE TRIGGER late_history AFTER UPDATE ON media_groups
     FOR EACH ROW WHEN NEW.id = ${triggerId}
     BEGIN
       INSERT INTO downloads (release_id, group_id, client_id, kind, status, created_at, updated_at)
       VALUES (${moverReleaseId}, ${moverId}, 'late-client', 'initial', 'downloading', 1, 1);
     END;`,
  );

  const report = await applyRekey(db, registry, DEPS);
  assert.equal(report.moved, 1, 'the group carrying the trigger must actually be written, or nothing fires');
  const late = db.prepare('SELECT 1 FROM downloads WHERE group_id = ?').get(moverId);
  assert.notEqual(late, undefined, 'the download must exist by the end of the pass, or this proves nothing');

  // A clean refusal, not a foreign key blowing up inside the delete. The FKs
  // would have protected the download either way, but they would have done it
  // as a throw counted in `failed`, which says only that something broke.
  assert.equal(report.merged, 0);
  assert.equal(report.failed, 0, 'the re-check must catch this before the delete does');
  assert.equal(report.skippedCollision, 1);

  assert.notEqual(getGroup(db, moverId), null, 'the mover is not deleted');
  assert.notEqual(getGroup(db, holderId), null);
  assert.deepEqual(releaseIdsFor(db, moverId), moverReleaseIds, 'and keeps its releases');
});

// ---------------------------------------------------------------------------
// Task 5: file renames, inside the same transaction. Every test below uses a
// real `mkdtemp` directory and real files — the property under test is what
// happens on disk, which a fake filesystem cannot answer for.
// ---------------------------------------------------------------------------

test('applyRekey test 16: a move renames its live file on disk and updates dest_path', async () => {
  const { db, plugin, registry, libraryRoot } = await setupWithRealLibrary();
  try {
    const rawTitle = 'Site.26.08.01.Tango.Uniform.GERMAN.XXX.1080p.MP4-GRP';
    const staleKey = 'site:2026-08-01:tango-uniform-german';
    const staleDisplay = '{"title":"stale","fields":[]}';
    const groupId = groupWithRelease(db, { rawTitle, identityKey: staleKey, display: staleDisplay });
    const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));

    const fromPath = realPlannedPath(plugin, libraryRoot, staleKey, staleDisplay);
    await mkdir(dirname(fromPath), { recursive: true });
    await writeFile(fromPath, 'fake video bytes');
    const fileId = addImportedFile(db, { downloadId, groupId, destPath: fromPath });

    const report = await applyRekey(db, registry, { now: () => MERGE_NOW, rename: realRename, commit: REAL_COMMIT });
    assert.equal(report.moved, 1);
    assert.equal(report.renamed, 1);
    assert.equal(report.failed, 0);

    const row = filesForGroup(db, groupId).find((f) => f.id === fileId);
    assert.ok(row !== undefined);
    const toPath = row?.destPath;
    assert.ok(toPath !== undefined);
    if (toPath === undefined) return;
    assert.notEqual(toPath, fromPath, 'dest_path must hold the new path, not the old one');

    assert.equal(await lstatOrNull(fromPath), null, 'the old path must be gone');
    assert.notEqual(await lstatOrNull(toPath), null, 'the file must exist at its new path');
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test('applyRekey test 17: a rename that throws leaves the file, dest_path and identity_key untouched', async () => {
  const { db, plugin, registry, libraryRoot } = await setupWithRealLibrary();
  try {
    const rawTitle = 'Site.26.08.02.Uniform.Victor.GERMAN.XXX.1080p.MP4-GRP';
    const staleKey = 'site:2026-08-02:uniform-victor-german';
    const staleDisplay = '{"title":"stale","fields":[]}';
    const groupId = groupWithRelease(db, { rawTitle, identityKey: staleKey, display: staleDisplay });
    const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));

    const fromPath = realPlannedPath(plugin, libraryRoot, staleKey, staleDisplay);
    await mkdir(dirname(fromPath), { recursive: true });
    await writeFile(fromPath, 'fake video bytes');
    addImportedFile(db, { downloadId, groupId, destPath: fromPath });

    const report = await applyRekey(db, registry, { now: () => MERGE_NOW, rename: REJECTING_RENAME, commit: REAL_COMMIT });
    assert.equal(report.failed, 1);
    assert.equal(report.moved, 0);
    assert.equal(report.renamed, 0);

    const group = getGroup(db, groupId);
    assert.equal(group?.identityKey, staleKey, 'the key must be left alone');

    const row = filesForGroup(db, groupId)[0];
    assert.ok(row !== undefined);
    assert.equal(row?.destPath, fromPath, 'dest_path must be left alone');

    assert.notEqual(await lstatOrNull(fromPath), null, 'the file must still be at its original path');
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test('applyRekey test 18: a commit that fails after a successful rename renames the file back', async () => {
  const { db, plugin, registry, libraryRoot } = await setupWithRealLibrary();
  try {
    const rawTitle = 'Site.26.08.03.Victor.Whiskey.GERMAN.XXX.1080p.MP4-GRP';
    const staleKey = 'site:2026-08-03:victor-whiskey-german';
    const staleDisplay = '{"title":"stale","fields":[]}';
    const groupId = groupWithRelease(db, { rawTitle, identityKey: staleKey, display: staleDisplay });
    const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));

    const fromPath = realPlannedPath(plugin, libraryRoot, staleKey, staleDisplay);
    await mkdir(dirname(fromPath), { recursive: true });
    await writeFile(fromPath, 'fake video bytes');
    const fileId = addImportedFile(db, { downloadId, groupId, destPath: fromPath });

    // Sanctioned exception, as elsewhere in this file: the property under
    // test is what happens to the file once the commit fails, not what the
    // new identity is, so the expected `to` path is obtained by calling the
    // plugin, not by hardcoding one.
    const parsed = plugin.parse(rawTitle);
    assert.notEqual(parsed, null);
    const validated = validateIdentity(parsed as ParsedRelease);
    assert.ok('identity' in validated);
    const newIdentity = (validated as { identity: { identityKey: string; displayJson: string } }).identity;
    const toPath = realPlannedPath(plugin, libraryRoot, newIdentity.identityKey, newIdentity.displayJson);

    // `REJECTING_COMMIT`, not a deferred-FK trigger: a deferred foreign key
    // violation surfaces wherever `COMMIT` is next called, which cannot tell
    // "committed after the rename" from "committed before it" — the ordering
    // this test exists to guard. `REJECTING_COMMIT` throws unconditionally,
    // so the assertions below are what actually pin the ordering: they read
    // the disk and db state a commit failure must leave behind, not merely
    // whether one was thrown.
    const report = await applyRekey(db, registry, { now: () => MERGE_NOW, rename: realRename, commit: REJECTING_COMMIT });
    assert.equal(report.failed, 1);
    assert.equal(report.moved, 0);
    assert.equal(report.renamed, 0);

    const group = getGroup(db, groupId);
    assert.equal(group?.identityKey, staleKey, 'the identity must be rolled back');

    const row = filesForGroup(db, groupId).find((f) => f.id === fileId);
    assert.equal(row?.destPath, fromPath, 'dest_path must be rolled back');

    assert.notEqual(await lstatOrNull(fromPath), null, 'the file must be back at its original path');
    assert.equal(await lstatOrNull(toPath), null, 'nothing must remain at the path the failed commit claimed');
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test('applyRekey test 19: a destination that already exists on disk is skipped without overwriting it', async () => {
  const { db, plugin, registry, libraryRoot } = await setupWithRealLibrary();
  try {
    const rawTitle = 'Site.26.08.04.Whiskey.Xray.GERMAN.XXX.1080p.MP4-GRP';
    const staleKey = 'site:2026-08-04:whiskey-xray-german';
    const staleDisplay = '{"title":"stale","fields":[]}';
    const groupId = groupWithRelease(db, { rawTitle, identityKey: staleKey, display: staleDisplay });
    const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));

    const fromPath = realPlannedPath(plugin, libraryRoot, staleKey, staleDisplay);
    await mkdir(dirname(fromPath), { recursive: true });
    await writeFile(fromPath, 'original file bytes');
    const fileId = addImportedFile(db, { downloadId, groupId, destPath: fromPath });

    const parsed = plugin.parse(rawTitle);
    assert.notEqual(parsed, null);
    const validated = validateIdentity(parsed as ParsedRelease);
    assert.ok('identity' in validated);
    const newIdentity = (validated as { identity: { identityKey: string; displayJson: string } }).identity;
    const toPath = realPlannedPath(plugin, libraryRoot, newIdentity.identityKey, newIdentity.displayJson);
    await mkdir(dirname(toPath), { recursive: true });
    await writeFile(toPath, 'PRE-EXISTING');

    const report = await applyRekey(db, registry, { now: () => MERGE_NOW, rename: realRename, commit: REAL_COMMIT });
    assert.equal(
      report.skippedDestinationExists,
      1,
      'a pre-occupied destination must be counted, not silently ignored',
    );
    assert.equal(report.failed, 0, 'a correct refusal is not a failure — nothing here threw');
    assert.equal(report.moved, 0);
    assert.equal(report.renamed, 0);

    const group = getGroup(db, groupId);
    assert.equal(group?.identityKey, staleKey, 'the key must be left alone');

    const row = filesForGroup(db, groupId).find((f) => f.id === fileId);
    assert.equal(row?.destPath, fromPath, 'dest_path must be left alone');

    assert.equal(await readFile(fromPath, 'utf8'), 'original file bytes', 'the source file must be untouched');
    assert.equal(
      await readFile(toPath, 'utf8'),
      'PRE-EXISTING',
      'rename(2) silently replaces an existing destination — the pre-existing file must survive',
    );
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test('applyRekey test 20: a move never rewrites trash_path, only a live row\'s own dest_path', async () => {
  const { db, plugin, registry, libraryRoot } = await setupWithRealLibrary();
  try {
    const rawTitle = 'Site.26.08.05.Xray.Yankee.GERMAN.XXX.1080p.MP4-GRP';
    const staleKey = 'site:2026-08-05:xray-yankee-german';
    const staleDisplay = '{"title":"stale","fields":[]}';
    const groupId = groupWithRelease(db, { rawTitle, identityKey: staleKey, display: staleDisplay });
    const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));

    const fromPath = realPlannedPath(plugin, libraryRoot, staleKey, staleDisplay);
    await mkdir(dirname(fromPath), { recursive: true });
    await writeFile(fromPath, 'live bytes');
    const liveFileId = addImportedFile(db, { downloadId, groupId, destPath: fromPath });

    const trashedFileId = addImportedFile(db, {
      downloadId,
      groupId,
      destPath: '/library/Site/trashed-name.mp4',
      trashedAt: 123,
    });

    const report = await applyRekey(db, registry, { now: () => MERGE_NOW, rename: realRename, commit: REAL_COMMIT });
    assert.equal(report.moved, 1);
    assert.equal(report.renamed, 1, 'only the live file counts, never the trashed one');

    const rows = filesForGroup(db, groupId);
    const liveRow = rows.find((f) => f.id === liveFileId);
    const trashedRow = rows.find((f) => f.id === trashedFileId);
    assert.ok(liveRow !== undefined && trashedRow !== undefined);

    assert.notEqual(liveRow?.destPath, fromPath, 'the live file must have moved');
    assert.equal(
      trashedRow?.destPath,
      '/library/Site/trashed-name.mp4',
      "a trashed row's dest_path is history, not a live path to keep in sync",
    );
    assert.equal(trashedRow?.trashPath, '/trash/old.mp4', 'trash_path must never be rewritten by a move');
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test('applyRekey test 21: a group with two live files renames both, or neither if one fails', async () => {
  const { db, plugin, registry, libraryRoot } = await setupWithRealLibrary();
  try {
    // Group A: both files must succeed.
    const rawTitleA = 'Site.26.08.06.Yankee.Zulu.GERMAN.XXX.1080p.MP4-GRP';
    const staleKeyA = 'site:2026-08-06:yankee-zulu-german';
    const staleDisplayA = '{"title":"stale a","fields":[]}';
    const groupIdA = groupWithRelease(db, { rawTitle: rawTitleA, identityKey: staleKeyA, display: staleDisplayA });
    const downloadA = addDownload(db, groupIdA, releaseIdFor(db, groupIdA));

    const fromMp4A = realPlannedPath(plugin, libraryRoot, staleKeyA, staleDisplayA);
    await mkdir(dirname(fromMp4A), { recursive: true });
    await writeFile(fromMp4A, 'mp4 bytes');
    const fileMp4AId = addImportedFile(db, { downloadId: downloadA, groupId: groupIdA, destPath: fromMp4A });

    const fromMkvA = fromMp4A.replace(/\.mp4$/, '.mkv');
    assert.notEqual(fromMkvA, fromMp4A);
    await writeFile(fromMkvA, 'mkv bytes');
    const fileMkvAId = addImportedFile(db, { downloadId: downloadA, groupId: groupIdA, destPath: fromMkvA });

    const successReport = await applyRekey(db, registry, { now: () => MERGE_NOW, rename: realRename, commit: REAL_COMMIT });
    assert.equal(successReport.moved, 1);
    assert.equal(successReport.renamed, 2, 'both live files must be counted');

    const rowsA = filesForGroup(db, groupIdA);
    const rowMp4A = rowsA.find((f) => f.id === fileMp4AId);
    const rowMkvA = rowsA.find((f) => f.id === fileMkvAId);
    assert.notEqual(rowMp4A?.destPath, fromMp4A);
    assert.notEqual(rowMkvA?.destPath, fromMkvA);
    assert.equal(await lstatOrNull(fromMp4A), null);
    assert.equal(await lstatOrNull(fromMkvA), null);

    // Group B: the second rename (the .mkv file, per `computeRenames`'
    // ascending-id order) is made to fail, and neither file must move.
    const rawTitleB = 'Site.26.08.07.Zulu.Alpha.GERMAN.XXX.1080p.MP4-GRP';
    const staleKeyB = 'site:2026-08-07:zulu-alpha-german';
    const staleDisplayB = '{"title":"stale b","fields":[]}';
    const groupIdB = groupWithRelease(db, { rawTitle: rawTitleB, identityKey: staleKeyB, display: staleDisplayB });
    const downloadB = addDownload(db, groupIdB, releaseIdFor(db, groupIdB));

    const fromMp4B = realPlannedPath(plugin, libraryRoot, staleKeyB, staleDisplayB);
    await mkdir(dirname(fromMp4B), { recursive: true });
    await writeFile(fromMp4B, 'mp4 bytes b');
    addImportedFile(db, { downloadId: downloadB, groupId: groupIdB, destPath: fromMp4B });

    const fromMkvB = fromMp4B.replace(/\.mp4$/, '.mkv');
    assert.notEqual(fromMkvB, fromMp4B);
    await writeFile(fromMkvB, 'mkv bytes b');
    addImportedFile(db, { downloadId: downloadB, groupId: groupIdB, destPath: fromMkvB });

    const failureReport = await applyRekey(db, registry, {
      now: () => MERGE_NOW,
      rename: renameThatRefuses(fromMkvB),
      commit: REAL_COMMIT,
    });
    assert.equal(failureReport.failed, 1);
    assert.equal(failureReport.moved, 0);
    assert.equal(failureReport.renamed, 0);

    const groupB = getGroup(db, groupIdB);
    assert.equal(groupB?.identityKey, staleKeyB, 'group B must be left at its old key');

    const rowsB = filesForGroup(db, groupIdB);
    for (const row of rowsB) {
      assert.ok(
        row.destPath === fromMp4B || row.destPath === fromMkvB,
        'neither file\'s dest_path may have moved',
      );
    }
    assert.notEqual(await lstatOrNull(fromMp4B), null, 'the first file must be back at its original path');
    assert.notEqual(await lstatOrNull(fromMkvB), null, 'the second file was never moved in the first place');
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 5 fix round 3: a display-only move (case 7's shape) whose group has a
// live file recomputes the identical destination for it — the file's own
// current path, not a collision. `computeRenames` must drop that entry
// rather than pass it to `applyMove` as a "rename" to nowhere, and
// `applyMove` must not abort the group even if one reaches it anyway. On the
// owner's real database this was 9 of 93 movers, permanently stuck: the pass
// runs once (marker-gated), so a group that hits this never gets a second
// chance to converge.
// ---------------------------------------------------------------------------

test('applyRekey test 22: a display-only move on a group with a live file writes identity/display/metadata and renames nothing', async () => {
  const { db, plugin, registry } = setup();
  const rawTitle = 'JulesJordan.26.08.08.Kilo.Lima.XXX.1080p.MP4-GRP';

  // Stored before the site was confirmed, exactly as in planRekey's case 7:
  // the unresolved spelling reaches the key's site segment too, but that
  // segment collapses either spelling to the same slug, so the key survives
  // and only the display corrects.
  const unresolved = agreeingIdentity(plugin, rawTitle);
  const groupId = groupWithRelease(db, { rawTitle, ...unresolved });
  const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));

  // The file already sits exactly where `computeRenames` will recompute it:
  // every path-template placeholder keys off `identityKey`
  // (`path-template.ts`), and the site confirmation below does not move the
  // key, so a real import under the unresolved spelling would have written
  // this same path. No real filesystem needed — this is a pure path-string
  // fixture, like `case 7` above.
  const plan = plugin.planImport(
    { identityKey: unresolved.identityKey, display: JSON.parse(unresolved.display) as ParsedRelease['display'], quality: {} },
    [{ absolutePath: '/src/scene.mp4', relativePath: 'scene.mp4', sizeBytes: 12345 }],
  );
  assert.ok(plan !== null);
  const currentFile = plan?.files[0];
  assert.ok(currentFile !== undefined);
  if (currentFile === undefined) return;
  const currentPath = resolve(LIBRARY_ROOT, currentFile.destination);
  const fileId = addImportedFile(db, { downloadId, groupId, destPath: currentPath });

  seedAllMetadataTables(db, groupId);
  recordDiscoveredSite(db, 'JulesJordan', { site: 'Jules Jordan' }, 'test', 1);

  // Proof that no rename was attempted, not merely that none was needed: an
  // unconditionally-rejecting `rename` would fail the whole group if
  // `applyMove` tried to use it for this file.
  const report = await applyRekey(db, registry, {
    now: () => MERGE_NOW,
    rename: REJECTING_RENAME,
    commit: REAL_COMMIT,
  });
  assert.equal(report.moved, 1);
  assert.equal(report.renamed, 0);
  assert.equal(report.failed, 0);
  assert.equal(report.skippedDestinationExists, 0);

  const group = getGroup(db, groupId);
  assert.equal(group?.identityKey, unresolved.identityKey, 'the key does not move');
  assert.ok(group?.display.includes('Jules Jordan'), 'the display is corrected');
  assertMetadataTablesEmpty(db, groupId);

  const row = filesForGroup(db, groupId).find((f) => f.id === fileId);
  assert.equal(row?.destPath, currentPath, 'dest_path is untouched because nothing moved');
});

test('applyMove: a same-path rename entry reaching it directly is a no-op, not an abort', async () => {
  const { db } = setup();
  const identityKey = 'site:2026-08-09:november-oscar';
  const displayJson = '{"title":"already correct","fields":[]}';
  const groupId = groupWithRelease(db, {
    rawTitle: 'Site.26.08.09.November.Oscar.XXX.1080p.MP4-GRP',
    identityKey,
    display: displayJson,
  });
  const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));
  const samePath = '/library/Site/november-oscar.mp4';
  const fileId = addImportedFile(db, { downloadId, groupId, destPath: samePath });

  // Hand-built rather than planned: the point of this test is that
  // `applyMove` itself refuses to treat a same-path entry as a collision,
  // independent of whether `computeRenames` would ever hand it one after
  // the fix above — see the guard's own comment in `rekey.ts`.
  const outcome: Extract<RekeyOutcome, { kind: 'move' }> = {
    kind: 'move',
    identityKey,
    displayJson,
    searchText: 'already correct',
    displayChanged: false,
    renames: [{ fileId, from: samePath, to: samePath }],
  };

  // A rejecting `rename` proves the entry is skipped rather than merely
  // surviving as a same-path POSIX no-op rename that happened to succeed.
  const renamedCount = await applyMove(db, groupId, outcome, {
    now: () => MERGE_NOW,
    rename: REJECTING_RENAME,
    commit: REAL_COMMIT,
  });

  assert.equal(renamedCount, 0, 'the same-path entry is not counted as a rename, and nothing aborted the group');

  const group = getGroup(db, groupId);
  assert.equal(group?.identityKey, identityKey);

  const row = filesForGroup(db, groupId).find((f) => f.id === fileId);
  assert.equal(row?.destPath, samePath);
});

// ---------------------------------------------------------------------------
// Task 6: runRekeyOnBoot / countDrift — the boot wiring. Everything above
// tests planRekey and applyRekey directly, without an app_state marker in the
// picture at all; everything below tests the marker that decides whether a
// given boot writes anything.
// ---------------------------------------------------------------------------

/**
 * A `RekeyDeps.now` that always throws, for test 3 below. Safe to use across
 * a whole `applyRekey` call only when the fixture has no colliding groups:
 * `deps.now()` is called nowhere inside `applyRekey` except inside the merge
 * branch's own try/catch (see `applyRekey`'s module comment), so with no
 * merge to trigger, this throws for the first time exactly where test 3
 * means it to — `runRekeyOnBoot`'s own, uncaught, call to `deps.now()` for
 * the marker's `updated_at`.
 */
const THROWING_NOW: RekeyDeps['now'] = () => {
  throw new Error('clock unavailable');
};

test('runRekeyOnBoot test 1: with no marker, the pass applies and then writes the marker', async () => {
  const { db, plugin, registry } = setup();
  assert.equal(getAppState(db, REKEY_MARKER_KEY), null);

  const rawTitle = 'Site.26.09.01.Alpha.Boot.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-09-01:alpha-boot-german',
    display: '{"title":"stale","fields":[]}',
  });
  // Sanctioned exception, as elsewhere in this file: the property under test
  // is that the pass actually ran, not what today's parser says, so this only
  // asserts the plugin still parses the title, never a hardcoded slug.
  assert.notEqual(plugin.parse(rawTitle), null);

  const outcome = await runRekeyOnBoot(db, registry, DEPS);
  assert.equal(outcome.applied, true);
  assert.ok(outcome.report !== null);
  assert.equal(outcome.report?.moved, 1);

  const row = getGroup(db, groupId);
  assert.notEqual(row?.identityKey, 'site:2026-09-01:alpha-boot-german', 'the group must actually have moved');

  assert.notEqual(getAppState(db, REKEY_MARKER_KEY), null, 'the marker must be written after applying');
});

test('runRekeyOnBoot test 2: with the marker present, the pass does not apply — proven by a sentinel', async () => {
  const { db, registry } = setup();
  const rawTitle = 'Site.26.09.02.Bravo.Boot.GERMAN.XXX.1080p.MP4-GRP';
  const groupId = groupWithRelease(db, {
    rawTitle,
    identityKey: 'site:2026-09-02:bravo-boot-german',
    display: '{"title":"stale","fields":[]}',
  });
  setAppState(db, REKEY_MARKER_KEY, 'done', 1);

  // Same sentinel technique as applyRekey test 4: a value the writer would
  // clobber if it ran at all, not an equality check against the (already
  // stale) stored value, which would pass even on a bug that ran the pass
  // and happened to leave this particular column alone.
  const sentinel = 'SENTINEL-runRekeyOnBoot-marker-set-search-text';
  db.prepare('UPDATE media_groups SET search_text = ? WHERE id = ?').run(sentinel, groupId);

  const outcome = await runRekeyOnBoot(db, registry, DEPS);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.report, null);
  assert.equal(outcome.drift, 1, 'this group would move if the pass ran, so it is counted as drift');

  const row = getGroup(db, groupId);
  assert.equal(row?.identityKey, 'site:2026-09-02:bravo-boot-german', 'the key must be untouched');
  assert.equal(row?.searchText, sentinel, 'the sentinel surviving proves nothing was written');
});

test('runRekeyOnBoot test 3: a throw before the marker write leaves it unset, and a second run finishes cleanly', async () => {
  // Ruling (overrides the brief): the brief's original test 3 asked for the
  // marker to be written "in the same transaction as the final batch". There
  // is no batch — Task 4 commits one group's transaction at a time,
  // deliberately, so a single poison row cannot roll back the groups that
  // already landed — and inventing one here would undo that. What this
  // proves instead: the marker write is its own transaction, *after* every
  // group's own transaction has already committed, so an interruption
  // between "every group committed" and "marker written" just leaves the
  // marker unset. The next boot reruns `runRekeyOnBoot` from the top, reads
  // every already-moved group as `unchanged`, and only redoes whatever is
  // genuinely still outstanding — nothing, in this fixture, since the
  // interrupted run already finished writing both groups. Safe because the
  // pass converges (see `runRekeyOnBoot`'s own comment, and Task 7).
  const { db, registry } = setup();
  const rawTitleA = 'Site.26.09.03.Charlie.Boot.GERMAN.XXX.1080p.MP4-GRP';
  const groupA = groupWithRelease(db, {
    rawTitle: rawTitleA,
    identityKey: 'site:2026-09-03:charlie-boot-german',
    display: '{"title":"stale a","fields":[]}',
  });
  const rawTitleB = 'Site.26.09.04.Delta.Boot.GERMAN.XXX.1080p.MP4-GRP2';
  const groupB = groupWithRelease(db, {
    rawTitle: rawTitleB,
    identityKey: 'site:2026-09-04:delta-boot-german',
    display: '{"title":"stale b","fields":[]}',
  });

  await assert.rejects(
    () => runRekeyOnBoot(db, registry, { now: THROWING_NOW, rename: realRename, commit: REAL_COMMIT }),
    /clock unavailable/,
  );

  assert.equal(getAppState(db, REKEY_MARKER_KEY), null, 'the marker must not be written');
  // The groups themselves were already committed, each in its own
  // transaction, before the throw — proof this interrupted the marker write,
  // not the pass itself.
  const rowA = getGroup(db, groupA);
  const rowB = getGroup(db, groupB);
  assert.notEqual(rowA?.identityKey, 'site:2026-09-03:charlie-boot-german');
  assert.notEqual(rowB?.identityKey, 'site:2026-09-04:delta-boot-german');

  // Second run: the marker is still unset, so it takes the apply path again —
  // and finds nothing left to do, because both groups already read
  // `unchanged`. "Finishes cleanly" here means exactly that: the marker gets
  // written this time, with zero further groups to move.
  const outcome = await runRekeyOnBoot(db, registry, DEPS);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.report?.moved, 0, 'both groups were already fixed by the interrupted run');
  assert.notEqual(getAppState(db, REKEY_MARKER_KEY), null, 'the second run must write the marker');
});

test('runRekeyOnBoot test 4: countDrift runs planRekey only, writes nothing, and ignores the marker', () => {
  const { db, plugin, registry } = setup();
  const movingRaw = 'Site.26.09.05.Echo.Boot.GERMAN.XXX.1080p.MP4-GRP';
  groupWithRelease(db, {
    rawTitle: movingRaw,
    identityKey: 'site:2026-09-05:echo-boot-german',
    display: '{"title":"stale","fields":[]}',
  });
  const stationaryRaw = 'Site.26.09.06.Foxtrot.Boot.XXX.1080p.MP4-GRP2';
  groupWithRelease(db, { rawTitle: stationaryRaw, ...agreeingIdentity(plugin, stationaryRaw) });

  const before = db.prepare('SELECT id, identity_key, display, search_text FROM media_groups ORDER BY id').all();

  assert.equal(countDrift(db, registry), 1, 'only the moving group counts as drift');

  const after = db.prepare('SELECT id, identity_key, display, search_text FROM media_groups ORDER BY id').all();
  assert.deepEqual(after, before, 'countDrift must write nothing, ever');

  // The marker's presence must not change the answer at all: countDrift is a
  // pure read over planRekey's own output, never gated on app_state — the
  // gating on the marker belongs entirely to runRekeyOnBoot, one level up.
  setAppState(db, REKEY_MARKER_KEY, 'done', 1);
  assert.equal(countDrift(db, registry), 1);
});

test('runRekeyOnBoot test 5: a hand-edited group contributes zero drift, in the read-only check and the applied count alike', async () => {
  // Fix round 1: `skippedEdited` was originally folded into drift, which
  // gives the number a permanent floor — a hand-edited group is skipped
  // forever, by design (migrations.ts:268-272), so counting it as
  // "diverging" would report it as such at every single boot for the life
  // of the database. On the owner's real data that floor is 33 groups: a
  // count that can never reach zero stops working as a signal.
  const { db, plugin, registry } = setup();

  // Would move if it weren't edited: the same "GERMAN" language-suffix
  // staleness used throughout this file (see case 2), but with editedAt set
  // so the pass must leave it alone forever regardless.
  const editedRaw = 'Site.26.09.07.Golf.Boot.GERMAN.XXX.1080p.MP4-GRP';
  groupWithRelease(db, {
    rawTitle: editedRaw,
    identityKey: 'site:2026-09-07:golf-boot-german',
    display: '{"title":"stale edited","fields":[]}',
    editedAt: 500,
  });

  // A second, genuinely moving group in the same fixture — so this test
  // proves the exclusion is targeted at skipped-edited specifically, not a
  // bug that zeroes out drift altogether.
  const movingRaw = 'Site.26.09.08.Hotel.Boot.GERMAN.XXX.1080p.MP4-GRP2';
  groupWithRelease(db, {
    rawTitle: movingRaw,
    identityKey: 'site:2026-09-08:hotel-boot-german',
    display: '{"title":"stale moving","fields":[]}',
  });

  // Read-only path (marker set): countDrift must see the edited group as
  // skipped-edited and exclude it, counting only the real mover.
  assert.equal(countDrift(db, registry), 1, 'the edited group must not count, only the moving one');

  // Applied path: a fresh database, so the marker is unset and applyRekey
  // actually runs. The mover gets fixed by this very pass, so it must not
  // still be reported as "not agreeing" once the pass is done — drift here
  // is zero, not one. (An earlier draft of this test asserted one, on the
  // reasoning that a fresh countDrift would also say one; that reasoning was
  // backwards, because `moved` is exactly the set of groups this boot just
  // repaired, and a fresh parse of a moved group now agrees with it. See the
  // parity check below and `runRekeyOnBoot`'s comment on the drift sum.)
  const fresh = setup();
  groupWithRelease(fresh.db, {
    rawTitle: editedRaw,
    identityKey: 'site:2026-09-07:golf-boot-german',
    display: '{"title":"stale edited","fields":[]}',
    editedAt: 500,
  });
  groupWithRelease(fresh.db, {
    rawTitle: movingRaw,
    identityKey: 'site:2026-09-08:hotel-boot-german',
    display: '{"title":"stale moving","fields":[]}',
  });
  assert.notEqual(plugin.parse(editedRaw), null, 'sanity: the edited title must still be parsable');

  const outcome = await runRekeyOnBoot(fresh.db, fresh.registry, DEPS);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.report?.skippedEdited, 1, 'the edited group must still be counted in the report');
  assert.equal(outcome.report?.moved, 1, 'sanity: the mover must have actually moved');
  assert.equal(outcome.drift, 0, 'the mover was just repaired, so nothing still disagrees');

  // Parity check: this is the property the drift sum is supposed to have —
  // a fresh, post-apply `countDrift` call must agree with the derived
  // number, because both are answering the same question ("what still
  // disagrees, right now") from the same, now-converged, database state.
  assert.equal(countDrift(fresh.db, fresh.registry), outcome.drift, "drift must match a fresh countDrift's answer");
});

test('runRekeyOnBoot test 6: a group that fails to apply still counts as drift, unlike one that moved', async () => {
  // This is the case the ruling in the fix-wave review called out by name:
  // `failed` names a group whose stored identity genuinely still disagrees
  // with a fresh parse (the write never landed), so it belongs in the same
  // sum as `skippedUnparsable`/`skippedCollision`/`skippedDestinationExists`
  // — unlike `moved`/`merged`, which this boot just repaired.
  const { db, plugin, registry, libraryRoot } = await setupWithRealLibrary();
  try {
    const rawTitle = 'Site.26.09.09.India.Boot.GERMAN.XXX.1080p.MP4-GRP';
    const staleKey = 'site:2026-09-09:india-boot-german';
    const staleDisplay = '{"title":"stale india","fields":[]}';
    const groupId = groupWithRelease(db, { rawTitle, identityKey: staleKey, display: staleDisplay });
    const downloadId = addDownload(db, groupId, releaseIdFor(db, groupId));

    const fromPath = realPlannedPath(plugin, libraryRoot, staleKey, staleDisplay);
    await mkdir(dirname(fromPath), { recursive: true });
    await writeFile(fromPath, 'fake video bytes');
    addImportedFile(db, { downloadId, groupId, destPath: fromPath });

    // `REJECTING_RENAME` forces `applyMove` to throw, which `applyRekey`
    // counts in `failed` rather than `moved` — see `applyRekey test 17`,
    // which pins the same rejection leaving the group untouched.
    const outcome = await runRekeyOnBoot(db, registry, { now: () => MERGE_NOW, rename: REJECTING_RENAME, commit: REAL_COMMIT });
    assert.equal(outcome.applied, true);
    assert.equal(outcome.report?.failed, 1, 'sanity: the rename must actually have failed');
    assert.equal(outcome.report?.moved, 0);
    assert.equal(outcome.drift, 1, 'a failed group still disagrees with a fresh parse, so it counts');

    assert.equal(
      countDrift(db, registry),
      outcome.drift,
      'a fresh countDrift must agree: the failed group still proposes a move',
    );
  } finally {
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
