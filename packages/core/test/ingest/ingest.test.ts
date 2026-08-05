import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { ingestEntries } from '../../src/ingest/ingest.ts';
import { findGroup, getGroup } from '../../src/db/groups.ts';
import type { FeedEntry } from '../../src/feeds/parse-rss.ts';
import type { FeedConfig } from '../../src/config/schema.ts';

const FEED: FeedConfig = {
  id: 'feed1',
  url: 'https://example.invalid/rss',
  plugin: 'pkg',
  intervalSeconds: 900,
};

/**
 * A plugin whose identity is the part of the title before "|" and whose score
 * is the number after it. Keeps the ingest tests about ingest rules rather
 * than about parsing.
 */
const PLUGIN: MediaTypePlugin = {
  id: 'test',
  displayName: 'Test',
  parse(name): ParsedRelease | null {
    const [identity, score] = name.split('|');
    if (identity === undefined || score === undefined) return null;
    if (identity === 'THROW') throw new Error('boom');
    return {
      identityKey: identity,
      display: { title: identity, subtitle: 'Sub', fields: [{ label: 'L', value: identity }] },
      quality: { resolution: Number(score) },
    };
  },
  score: (quality) => quality.resolution ?? 0,
  planImport: () => null,
};

function entry(guid: string, title: string): FeedEntry {
  return { guid, title, link: `https://indexer.invalid/${guid}.nzb`, publishedAt: null };
}

function pick(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = ? WHERE id = ?").run(
    releaseId,
    groupId,
  );
}

function latestReleaseId(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM releases').get();
  return Number(row?.['id']);
}

test('re-ingesting the same guid is a no-op', () => {
  const db = openTestDatabase();
  const entries = [entry('g1', 'alpha|1080')];
  const first = ingestEntries(db, PLUGIN, FEED, entries, 1000);
  const second = ingestEntries(db, PLUGIN, FEED, entries, 2000);

  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM releases').get()?.['n']), 1);
  db.close();
});

test('two releases with the same identity collate into one group', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080'), entry('g2', 'alpha|2160')], 1000);

  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM releases').get()?.['n']), 2);
  db.close();
});

test('different identities create separate groups', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080'), entry('g2', 'beta|1080')], 1000);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 2);
  db.close();
});

test('a new release on an unpicked group does not touch list_rank_at', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080')], 1000);
  ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|2160')], 5000);

  const group = findGroup(db, 'test', 'alpha');
  assert.equal(group?.listRankAt, 1000);
  assert.equal(group?.upgradeReleaseId, null);
  db.close();
});

test('a better release on a picked group flags an upgrade and bumps list_rank_at', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080')], 1000);
  const group = findGroup(db, 'test', 'alpha')!;
  pick(db, group.id, latestReleaseId(db));

  const result = ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|2160')], 5000);

  const updated = getGroup(db, group.id)!;
  assert.equal(result.upgradesFlagged, 1);
  assert.equal(updated.listRankAt, 5000);
  assert.equal(updated.createdAt, 1000);
  assert.equal(updated.upgradeReleaseId, latestReleaseId(db));
  db.close();
});

test('a worse release on a picked group changes nothing', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|2160')], 1000);
  const group = findGroup(db, 'test', 'alpha')!;
  pick(db, group.id, latestReleaseId(db));

  const result = ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|720')], 5000);

  const updated = getGroup(db, group.id)!;
  assert.equal(result.upgradesFlagged, 0);
  assert.equal(updated.listRankAt, 1000);
  assert.equal(updated.upgradeReleaseId, null);
  db.close();
});

test('an equal-scoring release on a picked group changes nothing', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080')], 1000);
  const group = findGroup(db, 'test', 'alpha')!;
  pick(db, group.id, latestReleaseId(db));

  ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|1080')], 5000);
  assert.equal(getGroup(db, group.id)?.upgradeReleaseId, null);
  db.close();
});

test('a release better than the pick but not the flagged upgrade is ignored', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|720')], 1000);
  const group = findGroup(db, 'test', 'alpha')!;
  pick(db, group.id, latestReleaseId(db));

  ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|2160')], 5000);
  const flagged = getGroup(db, group.id)!.upgradeReleaseId;

  ingestEntries(db, PLUGIN, FEED, [entry('g3', 'alpha|1080')], 9000);
  const after = getGroup(db, group.id)!;
  assert.equal(after.upgradeReleaseId, flagged);
  assert.equal(after.listRankAt, 5000);
  db.close();
});

test('a release better than the flagged upgrade replaces it and bumps again', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|720')], 1000);
  const group = findGroup(db, 'test', 'alpha')!;
  pick(db, group.id, latestReleaseId(db));

  ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|1080')], 5000);
  ingestEntries(db, PLUGIN, FEED, [entry('g3', 'alpha|2160')], 9000);

  const after = getGroup(db, group.id)!;
  assert.equal(after.upgradeReleaseId, latestReleaseId(db));
  assert.equal(after.listRankAt, 9000);
  db.close();
});

test('an unparseable name records a parse_error and creates no group', () => {
  const db = openTestDatabase();
  const result = ingestEntries(db, PLUGIN, FEED, [entry('g1', 'no-separator')], 1000);

  assert.equal(result.parseErrors, 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 0);
  assert.equal(
    db.prepare('SELECT parse_error FROM feed_items WHERE guid = ?').get('g1')?.['parse_error'],
    'unrecognized',
  );
  db.close();
});

test('a plugin that throws does not stop the batch', () => {
  const db = openTestDatabase();
  const result = ingestEntries(
    db,
    PLUGIN,
    FEED,
    [entry('g1', 'THROW|1080'), entry('g2', 'alpha|1080')],
    1000,
  );

  assert.equal(result.parseErrors, 1);
  assert.equal(result.releasesAdded, 1);
  assert.match(
    String(db.prepare('SELECT parse_error FROM feed_items WHERE guid = ?').get('g1')?.[
      'parse_error'
    ]),
    /boom/,
  );
  db.close();
});

// --- Plugin misbehaviour beyond parse() -------------------------------------
//
// Everything a plugin hands back crosses a boundary the type system does not
// police, so `parse` throwing is only one of the ways a plugin can be wrong.
// Each case below used to abort the whole batch — rolling back the poison
// entry's own feed_items row, so the same item re-threw on every subsequent
// tick and every later entry in the feed was never reached. The spec's promise
// is that plugin failures land in the worklist as a parse_error; these pin
// that promise to the plugin as a whole, not to one method of it.

/**
 * Produces a value the compiler accepts as `DisplayFields` but that violates
 * the shape at runtime — exactly what a third-party plugin can hand back,
 * since nothing type-checks a plugin's return value at the boundary.
 */
function malformedDisplay(json: string): DisplayFields {
  return JSON.parse(json) as DisplayFields;
}

test('a plugin whose score throws records a parse_error and lets later entries through', () => {
  const db = openTestDatabase();
  const plugin: MediaTypePlugin = {
    ...PLUGIN,
    score(quality) {
      if (quality.resolution === 666) throw new Error('score exploded');
      return quality.resolution ?? 0;
    },
  };

  const result = ingestEntries(
    db,
    plugin,
    FEED,
    [entry('g1', 'poison|666'), entry('g2', 'alpha|1080')],
    1000,
  );

  assert.equal(result.parseErrors, 1);
  assert.equal(result.releasesAdded, 1);
  assert.match(
    String(db.prepare('SELECT parse_error FROM feed_items WHERE guid = ?').get('g1')?.[
      'parse_error'
    ]),
    /score exploded/,
  );
  // The poison item is persisted, so the feed does not re-serve it forever.
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM feed_items').get()?.['n']), 2);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM releases').get()?.['n']), 1);
  db.close();
});

test('a plugin returning a non-finite score records a parse_error rather than a failed insert', () => {
  const db = openTestDatabase();
  const plugin: MediaTypePlugin = { ...PLUGIN, score: () => Number.NaN };

  const result = ingestEntries(db, plugin, FEED, [entry('g1', 'alpha|1080')], 1000);

  assert.equal(result.parseErrors, 1);
  assert.equal(result.releasesAdded, 0);
  assert.match(
    String(db.prepare('SELECT parse_error FROM feed_items WHERE guid = ?').get('g1')?.[
      'parse_error'
    ]),
    /finite/,
  );
  db.close();
});

test('a plugin returning a display with no fields records a parse_error', () => {
  const db = openTestDatabase();
  const plugin: MediaTypePlugin = {
    ...PLUGIN,
    parse: (name): ParsedRelease | null =>
      name.startsWith('poison')
        ? { identityKey: 'poison', display: malformedDisplay('{"title":"P"}'), quality: {} }
        : PLUGIN.parse(name),
  };

  const result = ingestEntries(
    db,
    plugin,
    FEED,
    [entry('g1', 'poison|1080'), entry('g2', 'beta|1080')],
    1000,
  );

  assert.equal(result.parseErrors, 1);
  assert.equal(result.releasesAdded, 1);
  assert.match(
    String(db.prepare('SELECT parse_error FROM feed_items WHERE guid = ?').get('g1')?.[
      'parse_error'
    ]),
    /fields/,
  );
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM feed_items').get()?.['n']), 2);
  db.close();
});

test('a plugin returning an empty identity key records a parse_error', () => {
  const db = openTestDatabase();
  const plugin: MediaTypePlugin = {
    ...PLUGIN,
    parse: (): ParsedRelease => ({
      identityKey: '',
      display: { title: 'Alpha', fields: [] },
      quality: {},
    }),
  };

  const result = ingestEntries(db, plugin, FEED, [entry('g1', 'alpha|1080')], 1000);

  assert.equal(result.parseErrors, 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 0);
  db.close();
});

test('groups are keyed by plugin id, not by feed', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080')], 1000);
  ingestEntries(db, PLUGIN, { ...FEED, id: 'feed2' }, [entry('g1', 'alpha|2160')], 2000);

  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM feed_items').get()?.['n']), 2);
  db.close();
});

test('search_text is lowercased and includes every display value', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'Alpha|1080')], 1000);
  const text = String(db.prepare('SELECT search_text FROM media_groups').get()?.['search_text']);
  assert.match(text, /alpha/);
  assert.match(text, /sub/);
  assert.equal(text, text.toLowerCase());
  db.close();
});
