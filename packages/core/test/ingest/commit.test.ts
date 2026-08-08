import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  commitRelease,
  validateIdentity,
  validateParsed,
  type CommitOutcome,
  type PreparedRelease,
} from '../../src/ingest/commit.ts';
import { findGroup, getGroup } from '../../src/db/groups.ts';
import { getRelease } from '../../src/db/releases.ts';
import { insertFeedItem } from '../../src/db/feed-items.ts';

/** Scores by resolution, so a test can say "better" with a bigger number. */
const PLUGIN: MediaTypePlugin = {
  id: 'test',
  displayName: 'Test',
  parse: () => null,
  score: (quality) => quality.resolution ?? 0,
  planImport: () => null,
};

function parsed(identity: string, resolution: number): ParsedRelease {
  return {
    identityKey: identity,
    display: { title: identity, subtitle: 'Sub', fields: [{ label: 'L', value: identity }] },
    quality: { resolution },
  };
}

/**
 * Produces a value the compiler accepts as `DisplayFields` but that violates
 * the shape at runtime — what a third-party plugin can hand back, since
 * nothing type-checks a plugin's return value at the boundary.
 */
function malformedDisplay(json: string): DisplayFields {
  return JSON.parse(json) as DisplayFields;
}

function prepare(plugin: MediaTypePlugin, media: ParsedRelease): PreparedRelease {
  const outcome = validateParsed(plugin, media);
  assert.ok(!('error' in outcome), `expected a prepared release, got ${JSON.stringify(outcome)}`);
  return outcome.prepared;
}

let nextGuid = 0;
function feedItem(db: DatabaseSync, now: number): number {
  nextGuid += 1;
  const guid = `g${nextGuid}`;
  const id = insertFeedItem(db, {
    feedId: 'feed1',
    guid,
    rawTitle: guid,
    link: `https://indexer.invalid/${guid}.nzb`,
    publishedAt: null,
    firstSeenAt: now,
  });
  assert.notEqual(id, null);
  return id as number;
}

function pick(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = ? WHERE id = ?").run(
    releaseId,
    groupId,
  );
}

/** One arrival: a fresh feed item, validated, committed. */
function commit(
  db: DatabaseSync,
  identity: string,
  resolution: number,
  now: number,
): CommitOutcome {
  const prepared = prepare(PLUGIN, parsed(identity, resolution));
  return commitRelease(db, prepared, PLUGIN, feedItem(db, now), now);
}

test('commitRelease creates a group when the identity key is new', () => {
  const db = openTestDatabase();
  const outcome = commit(db, 'alpha', 1080, 1000);

  assert.equal(outcome.groupCreated, true);
  const group = findGroup(db, 'test', 'alpha');
  assert.equal(group?.id, outcome.groupId);
  assert.equal(group?.createdAt, 1000);
  assert.equal(group?.listRankAt, 1000);
  db.close();
});

test('commitRelease joins the existing group when the identity key is known', () => {
  const db = openTestDatabase();
  const first = commit(db, 'alpha', 1080, 1000);
  const second = commit(db, 'alpha', 2160, 5000);

  assert.equal(second.groupCreated, false);
  assert.equal(second.groupId, first.groupId);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 1);
  db.close();
});

test('commitRelease inserts a release against the feed item and returns its id', () => {
  const db = openTestDatabase();
  const feedItemId = feedItem(db, 1000);
  const prepared = prepare(PLUGIN, parsed('alpha', 1080));
  const outcome = commitRelease(db, prepared, PLUGIN, feedItemId, 1000);

  const release = getRelease(db, outcome.releaseId);
  assert.equal(release?.feedItemId, feedItemId);
  assert.equal(release?.groupId, outcome.groupId);
  assert.equal(release?.score, 1080);
  assert.equal(release?.createdAt, 1000);
  assert.deepEqual(JSON.parse(String(release?.quality)), { resolution: 1080 });
  db.close();
});

test('commitRelease flags an upgrade and bumps list_rank_at when a release beats the pick', () => {
  const db = openTestDatabase();
  const first = commit(db, 'alpha', 1080, 1000);
  pick(db, first.groupId, first.releaseId);

  const second = commit(db, 'alpha', 2160, 5000);

  assert.equal(second.upgradeFlagged, true);
  const group = getGroup(db, first.groupId);
  assert.equal(group?.upgradeReleaseId, second.releaseId);
  assert.equal(group?.listRankAt, 5000);
  db.close();
});

test('commitRelease leaves list_rank_at alone when the new release does not beat the pick', () => {
  const db = openTestDatabase();
  const first = commit(db, 'alpha', 2160, 1000);
  pick(db, first.groupId, first.releaseId);

  const second = commit(db, 'alpha', 720, 5000);

  assert.equal(second.upgradeFlagged, false);
  const group = getGroup(db, first.groupId);
  assert.equal(group?.upgradeReleaseId, null);
  assert.equal(group?.listRankAt, 1000);
  db.close();
});

// The bump guard is `score > pickedScore && score > flaggedScore` — strictly
// greater on both sides. A release that only ties the pick must earn nothing:
// no upgrade (flagUpgrade's own comparison is the same strict `>`, so a tie
// derives upgrade_release_id = NULL), and no bump either. Loosening the guard
// to `>=` would flag nothing (still correctly derived as NULL) while still
// moving list_rank_at — pinning the group to the top of browse on every
// duplicate-quality arrival, forever.
test('commitRelease flags nothing and does not bump list_rank_at when a release ties the pick', () => {
  const db = openTestDatabase();
  const first = commit(db, 'alpha', 1080, 1000);
  pick(db, first.groupId, first.releaseId);

  const second = commit(db, 'alpha', 1080, 5000);

  assert.equal(second.upgradeFlagged, false);
  const group = getGroup(db, first.groupId);
  assert.equal(group?.upgradeReleaseId, null);
  assert.equal(group?.listRankAt, 1000);
  db.close();
});

// `releaseScore` returns null both when the id is null and when it points at
// a row that no longer exists (picked_release_id carries no foreign key).
// The `?? Number.NEGATIVE_INFINITY` sentinel exists so that case still grants
// a bump to an arrival that scores zero or less. `?? 0` would instead compare
// the arrival against a phantom score of 0 and suppress a bump the real rule
// grants.
test('commitRelease bumps list_rank_at for a zero-score arrival when the picked release is dangling', () => {
  const db = openTestDatabase();
  const first = commit(db, 'alpha', 1080, 1000);
  const danglingReleaseId = first.releaseId + 999_000;
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = ? WHERE id = ?").run(
    danglingReleaseId,
    first.groupId,
  );

  const second = commit(db, 'alpha', 0, 5000);

  assert.equal(second.upgradeFlagged, true);
  const group = getGroup(db, first.groupId);
  assert.equal(group?.listRankAt, 5000);
  db.close();
});

test('validateParsed rejects an empty identityKey, naming the fault', () => {
  const outcome = validateParsed(PLUGIN, {
    identityKey: '',
    display: { title: 'Alpha', fields: [] },
    quality: {},
  });

  assert.ok('error' in outcome);
  assert.match(outcome.error, /identityKey/);
});

test('validateParsed rejects a non-array display.fields, naming the fault', () => {
  const outcome = validateParsed(PLUGIN, {
    identityKey: 'alpha',
    display: malformedDisplay('{"title":"Alpha"}'),
    quality: {},
  });

  assert.ok('error' in outcome);
  // The exact message, not merely /fields/: dropping this check does not make
  // the call succeed, it makes the loop below throw "display.fields is not
  // iterable" — which also says "fields", so a looser assertion passes on the
  // very bug the check exists to prevent.
  assert.equal(outcome.error, 'invalid parse result: display.fields must be an array');
});

test('validateParsed rejects a NaN score, naming the fault', () => {
  const plugin: MediaTypePlugin = { ...PLUGIN, score: () => Number.NaN };
  const outcome = validateParsed(plugin, parsed('alpha', 1080));

  assert.ok('error' in outcome);
  assert.match(outcome.error, /finite/);
});

// `score` is third-party code and this function is reachable from a request
// handler that has no guard of its own, where a throw would become a 500 and
// a rollback instead of a recorded parse error.
test('validateParsed reports a throwing score rather than propagating it', () => {
  const plugin: MediaTypePlugin = {
    ...PLUGIN,
    score: () => {
      throw new Error('score exploded');
    },
  };

  const outcome = validateParsed(plugin, parsed('alpha', 1080));

  assert.ok('error' in outcome);
  assert.equal(outcome.error, 'plugin threw: score exploded');
});

test('validateParsed rejects a non-string display.title, naming the fault', () => {
  const outcome = validateParsed(PLUGIN, {
    identityKey: 'alpha',
    display: malformedDisplay('{"title":123,"fields":[]}'),
    quality: {},
  });

  assert.ok('error' in outcome);
  assert.equal(outcome.error, 'invalid parse result: display.title must be a string');
});

test('validateParsed rejects an array quality, naming the fault', () => {
  const outcome = validateParsed(PLUGIN, {
    identityKey: 'alpha',
    display: { title: 'Alpha', fields: [] },
    quality: [] as unknown as ParsedRelease['quality'],
  });

  assert.ok('error' in outcome);
  assert.equal(outcome.error, 'invalid parse result: quality must be an object');
});

test('validateParsed rejects a display field with a non-string label, naming the fault', () => {
  const outcome = validateParsed(PLUGIN, {
    identityKey: 'alpha',
    display: malformedDisplay('{"title":"Alpha","fields":[{"label":123,"value":"x"}]}'),
    quality: {},
  });

  assert.ok('error' in outcome);
  assert.equal(
    outcome.error,
    'invalid parse result: display.fields elements must have string label and value',
  );
});

test('validateParsed rejects a display field with a non-string value, naming the fault', () => {
  const outcome = validateParsed(PLUGIN, {
    identityKey: 'alpha',
    display: malformedDisplay('{"title":"Alpha","fields":[{"label":"L","value":123}]}'),
    quality: {},
  });

  assert.ok('error' in outcome);
  assert.equal(
    outcome.error,
    'invalid parse result: display.fields elements must have string label and value',
  );
});

// The other fixture in this file (`parsed`) sets title, identity, and the
// sole field's value all to the same string and never sets `date` — so
// deleting the `date` branch, or the entire `fields` loop, in `searchTextFor`
// leaves every assertion in this file unchanged. Distinct values for every
// slot, checked against the exact join, is what makes each branch load-bearing.
test('searchTextFor composes title, subtitle, date, and every field value into one lowercase string', () => {
  const outcome = validateIdentity({
    identityKey: 'alpha',
    display: {
      title: 'The Title',
      subtitle: 'The Subtitle',
      date: '2024-01-01',
      fields: [
        { label: 'Source', value: 'BluRay' },
        { label: 'Codec', value: 'x265' },
      ],
    },
    quality: {},
  });

  assert.ok('identity' in outcome);
  assert.equal(outcome.identity.searchText, 'the title the subtitle 2024-01-01 bluray x265');
});
