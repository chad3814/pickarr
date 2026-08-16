import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import createScenesPlugin from '@pickarr/plugin-scenes';
import { openTestDatabase } from '../../src/db/open.ts';
import { recordDiscoveredSite } from '../../src/db/sites.ts';
import { validateIdentity } from '../../src/ingest/commit.ts';
import { planRekey, type RekeyOutcome } from '../../src/pipeline/rekey.ts';
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
 */
function registryFor(plugin: MediaTypePlugin): PluginRegistry {
  return {
    byPackage: (name) => {
      if (name !== PACKAGE_NAME) throw new Error(`No plugin registered for package ${name}`);
      return plugin;
    },
    byId: (id) => (id === plugin.id ? plugin : undefined),
    libraryRoot: () => LIBRARY_ROOT,
    libraryRootById: () => LIBRARY_ROOT,
    all: () => [plugin],
  };
}

/** A fresh plugin and registry per test, so `learnSites` state from one test can never leak into another. */
function setup(): { db: DatabaseSync; plugin: MediaTypePlugin; registry: PluginRegistry } {
  const db = openTestDatabase();
  const plugin = createScenesPlugin({}) as MediaTypePlugin;
  return { db, plugin, registry: registryFor(plugin) };
}

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
