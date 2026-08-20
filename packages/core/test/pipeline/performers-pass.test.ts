import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { GroupIdentity, MediaTypePlugin, MetadataPerformer } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { RateLimited, type PerformerSearchPage } from '../../src/clients/theporndb.ts';
import { duePerformerQueue, insertPerformerSearch } from '../../src/db/performer-queue.ts';
import { performersForGroups } from '../../src/db/performers.ts';
import {
  MAX_PERFORMER_ATTEMPTS,
  createPerformerRunner,
  runPerformerPass,
  type PerformerPassDeps,
} from '../../src/pipeline/performers.ts';

/** One picked group, titled so the two-word rule has something to cut. */
function seedGroup(db: DatabaseSync, id: number, title: string): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, ?, ?, 1)`,
  ).run(id, `g${id}`, title, `https://indexer.invalid/${id}.nzb`);
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               created_at, list_rank_at)
     VALUES (?, 'test', ?, ?, ?, 'picked', 1, 1)`,
  ).run(id, `k${id}`, JSON.stringify({ title, subtitle: 'Some Site', fields: [] }), `g${id}`);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (?, ?, ?, '{}', 100, 1)`,
  ).run(id, id, id);
}

/** Gives the group a cast, the way a confirmed scene answer does. */
function giveCast(db: DatabaseSync, groupId: number): void {
  db.prepare(
    `INSERT INTO performers (id, source, source_uuid, slug, name, kind, fetched_at)
     VALUES (?, 'theporndb', ?, 'someone', 'Someone', 'performer', 1)`,
  ).run(groupId, `uuid-${groupId}`);
  db.prepare(
    'INSERT INTO group_performers (group_id, performer_id, position) VALUES (?, ?, 0)',
  ).run(groupId, groupId);
}

/**
 * A plugin whose `performerQuery` behaves as told. `undefined` stands for a
 * plugin that does not implement the method at all, which is how a media type
 * with no notion of performers opts out.
 */
function pluginWith(
  performerQuery: ((identity: GroupIdentity) => string | null) | undefined,
): MediaTypePlugin {
  // A real minimal plugin, the shape `metadata.test.ts:577` uses — not a cast
  // through `unknown`. If `MediaTypePlugin` gains a required member this fails to
  // typecheck, which is the signal you want; a cast would hide it.
  const plugin: MediaTypePlugin = {
    id: 'test',
    displayName: 'Test',
    parse: () => null,
    score: () => 0,
    planImport: () => null,
  };
  return performerQuery === undefined ? plugin : { ...plugin, performerQuery };
}

/** A search result carrying just the fields the match rule reads. */
function found(name: string, aliases: string[] = []): PerformerSearchPage['results'][number] {
  return {
    performer: {
      sourceUuid: `uuid-${name}`,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      kind: 'performer',
      faceUrl: null,
      imageUrl: null,
    } satisfies MetadataPerformer,
    aliases,
  };
}

/**
 * Deps whose client answers with `pages` in call order, or throws whatever is at
 * that position. One array rather than a stub object so a test can say "the first
 * call is rate limited, the second would have succeeded" and prove the second
 * never happened.
 */
function deps(
  db: DatabaseSync,
  answers: readonly (PerformerSearchPage | Error)[],
  overrides: Partial<PerformerPassDeps> = {},
): PerformerPassDeps & { calls: string[]; logged: string[] } {
  const calls: string[] = [];
  const logged: string[] = [];
  let index = 0;
  return {
    db,
    client: {
      source: 'theporndb',
      async searchPerformers(query: string) {
        calls.push(query);
        const answer = answers[index] ?? { results: [], truncated: false };
        index += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    pluginFor: () => pluginWith((identity) => identity.display.title.split(' ').slice(0, 2).join(' ')),
    perTick: 10,
    now: () => 1000,
    log: (message) => logged.push(message),
    // Refuses to be called, the way `metadata.test.ts`'s `unusedArtwork` does:
    // every test written before artwork caching existed passes performers with
    // no urls, so any fetch at all would be one nothing asked for.
    artwork: {
      dir: '/tmp/pickarr-performer-pass-unused-artwork',
      fetchImpl: () => {
        throw new Error('fetchImpl should not be called in this test');
      },
      log: () => undefined,
    },
    calls,
    logged,
    ...overrides,
  };
}

/** Serves `image/jpeg` for every request, recording the url each call asked for. */
function trackingFetchJpeg(fetched: string[]) {
  return (url: string) => {
    fetched.push(url);
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
  };
}

function castOf(db: DatabaseSync, groupId: number): string[] {
  return (performersForGroups(db, [groupId]).get(groupId) ?? []).map((row) => row.name);
}

test('a single exact match is linked and the row is settled', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [{ results: [found('Jessica Jaymes')], truncated: false }]));

  assert.equal(result.linked, 1);
  assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('an alias-only match is linked, since that is what the filename carried', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessi Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  await runPerformerPass(deps(db, [
    { results: [found('Jessica Jaymes', ['Jessi Jaymes'])], truncated: false },
  ]));

  assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
  db.close();
});

test('no match settles the row without writing anything', async () => {
  // A search that ran and matched nothing IS an answer. Leaving the row queued
  // would spend one request per pass forever rediscovering the same silence.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [{ results: [found('Someone Else')], truncated: false }]));

  assert.equal(result.unmatched, 1);
  assert.deepEqual(castOf(db, 1), []);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM performers').get()?.['n'], 0);
  db.close();
});

test('an ambiguous result settles the row without writing anything', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  await runPerformerPass(deps(db, [
    { results: [found('Jessica Jaymes'), found('Jessica Jaymes')], truncated: false },
  ]));

  assert.deepEqual(castOf(db, 1), []);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('a cast that appeared between enqueue and drain is not clobbered', async () => {
  // The guard the spec calls out. `setGroupPerformers` deletes before it inserts,
  // so without the re-check inside the writing transaction a one-name guess
  // arriving a moment after a confirmed scene REPLACES the real cast. Queue
  // first, then attach the cast, then run — which is the real ordering, since a
  // metadata refetch can land at any point after the enqueue.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  giveCast(db, 1);

  await runPerformerPass(deps(db, [{ results: [found('Jessica Jaymes')], truncated: false }]));

  assert.deepEqual(castOf(db, 1), ['Someone'], 'the confirmed cast must survive');
  assert.deepEqual(duePerformerQueue(db, 9999, 10), [], 'and the row is still settled');
  db.close();
});

test('a 429 breaks the pass, leaving the rows behind it untouched', async () => {
  // A rate limit is a fact about the service, not about one row. Asking the rest
  // anyway would spend one request per row rediscovering a limit already known.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  seedGroup(db, 2, 'Someone Else Entirely');
  insertPerformerSearch(db, 1, 100);
  insertPerformerSearch(db, 2, 200);

  const passDeps = deps(db, [new RateLimited(120_000), { results: [found('Someone Else')], truncated: false }]);
  const result = await runPerformerPass(passDeps);

  assert.equal(result.looked, 1);
  assert.equal(result.cooldownUntil, 1000 + 120_000);
  assert.deepEqual(passDeps.calls, ['Jessica Jaymes'], 'the second row was never asked');
  assert.deepEqual(duePerformerQueue(db, 9999, 10).map((row) => row.groupId), [1, 2]);
  assert.equal(duePerformerQueue(db, 9999, 10)[0]?.attempts, 0, 'a 429 is not the row failing');
  db.close();
});

test('the cooldown is measured from when the 429 landed, not from when the pass began', async () => {
  // A pass can spend several sequential requests before one is refused, so a
  // cooldown computed from the clock captured at the top of the pass expires
  // earlier than the provider asked for — and the next tick spends a request
  // re-learning the same limit. `lookUpOne` reads the clock again for this
  // reason; so does this pass.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  let clock = 1000;
  const passDeps = deps(db, [], {
    now: () => clock,
    client: {
      source: 'theporndb',
      async searchPerformers() {
        clock += 4000;
        throw new RateLimited(120_000);
      },
    },
  });

  const result = await runPerformerPass(passDeps);

  assert.equal(result.cooldownUntil, 5000 + 120_000, 'the full 120s from when the 429 landed');
  db.close();
});

test('an ordinary failure defers the row with its message', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [new Error('returned HTTP 503 Service Unavailable')]));

  assert.equal(result.deferred, 1);
  const row = duePerformerQueue(db, 9_999_999_999, 10)[0];
  assert.equal(row?.attempts, 1);
  assert.ok(row?.lastError?.includes('503'));
  assert.ok(row !== undefined && row.nextAt > 1000, 'and it is pushed into the future');
  db.close();
});

test('a row that has failed too often is given up on rather than deferred forever', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  db.prepare('UPDATE performer_queue SET attempts = ? WHERE group_id = 1')
    .run(MAX_PERFORMER_ATTEMPTS - 1);

  await runPerformerPass(deps(db, [new Error('still broken')]));

  assert.deepEqual(duePerformerQueue(db, 9_999_999_999, 10), []);
  assert.deepEqual(castOf(db, 1), []);
  db.close();
});

test('a row whose own write throws still has its attempts bumped', async () => {
  // The poison-row defect `runMetadataPass` documents having had: rows drain in
  // (requested_at, group_id) order, so a row whose attempts never moved would
  // abort every pass on the same row and nothing behind it would ever be looked
  // at. The trigger is the same shape of failure a constraint or a full disk
  // produces — the search succeeded, the write cannot.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  seedGroup(db, 2, 'Someone Else Entirely');
  insertPerformerSearch(db, 1, 100);
  insertPerformerSearch(db, 2, 200);
  db.exec(`CREATE TRIGGER no_link BEFORE INSERT ON group_performers
           BEGIN SELECT RAISE(ABORT, 'link write refused'); END`);

  // Group 2's answer names nobody its query asked for, deliberately: the trigger
  // refuses *every* link write, so a group 2 that matched would defer too and the
  // count below could no longer tell "one row failed and the pass carried on"
  // apart from "the pass failed on both".
  const passDeps = deps(db, [
    { results: [found('Jessica Jaymes')], truncated: false },
    { results: [found('Nobody At All')], truncated: false },
  ]);
  const result = await runPerformerPass(passDeps);

  assert.equal(result.deferred, 1, 'the failing row deferred rather than throwing');
  assert.equal(duePerformerQueue(db, 9_999_999_999, 10).find((row) => row.groupId === 1)?.attempts, 1);
  // Group 2 was still reached in this same pass, and settled normally — asserted
  // both ways round, because `calls` alone only proves it was asked. Its removal
  // additionally pins that a COMMIT still lands after the earlier row's
  // ROLLBACK, which is the half a botched rollback would break.
  assert.deepEqual(passDeps.calls, ['Jessica Jaymes', 'Someone Else']);
  assert.deepEqual(
    duePerformerQueue(db, 9_999_999_999, 10).map((row) => row.groupId),
    [1],
    'group 1 is still queued for its retry; group 2 is gone, settled',
  );
  db.close();
});

test('a query that has gone away settles the row rather than retrying forever', async () => {
  // The query is rebuilt each pass rather than stored, so a title corrected by
  // hand to a single word leaves nothing to ask. That is not a failure to retry.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  const passDeps = deps(db, [], { pluginFor: () => pluginWith(() => null) });

  await runPerformerPass(passDeps);

  assert.deepEqual(passDeps.calls, []);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('a truncated page is judged, and the truncation is logged rather than silent', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const passDeps = deps(db, [{ results: [found('Jessica Jaymes')], truncated: true }]);
  await runPerformerPass(passDeps);

  assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
  assert.ok(passDeps.logged.some((line) => line.includes('one page')));
  db.close();
});

test('no client means no pass and no queue read', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  // The queue table is parked under another name across the call, so "it did not
  // read the queue" is something this test establishes rather than something a
  // reader has to confirm by inspecting the order of two lines: a pass that
  // reached `duePerformerQueue` would throw `no such table` instead of answering
  // zeros. Renamed back afterwards so the row assertion below can still see it.
  db.exec('ALTER TABLE performer_queue RENAME TO performer_queue_parked');
  const result = await runPerformerPass(deps(db, [], { client: undefined }));
  db.exec('ALTER TABLE performer_queue_parked RENAME TO performer_queue');

  assert.deepEqual(result, { looked: 0, linked: 0, unmatched: 0, deferred: 0, cooldownUntil: null });
  assert.deepEqual(duePerformerQueue(db, 9999, 10).map((row) => row.groupId), [1]);
  db.close();
});

test('createPerformerRunner makes no request inside a cooldown, and says so once', async () => {
  // A multi-hour cooldown at a five-second interval would otherwise write
  // thousands of identical lines.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  const passDeps = deps(db, [new RateLimited(120_000)]);
  const run = createPerformerRunner(passDeps);

  // Three ticks, not two, and that is what makes the count below mean anything:
  // the first runs the pass and takes the 429, the second is the tick that says
  // it is skipping, and the third is the one that must say nothing. Counting the
  // skip line — "cooling down", the only line the skip writes — is the only way
  // to tell once-per-cooldown from once-per-tick. The pass's own summary line
  // says "cooldown until", so matching that substring instead would count the
  // summary and hold at one however often the skip fired.
  await run();
  await run();
  await run();

  assert.deepEqual(passDeps.calls, ['Jessica Jaymes'], 'only the first tick asked');
  assert.equal(
    passDeps.logged.filter((line) => line.includes('cooling down')).length,
    1,
    'the skip is announced once per cooldown, not once per tick',
  );
  db.close();
});

test('the runner asks again once a cooldown lapses, and announces the next one afresh', async () => {
  // The other half of `loggedSkip`: it is cleared on the tick that resumes, so a
  // second cooldown is announced rather than silently swallowed because an
  // earlier one had already been reported. A frozen clock cannot see either
  // behaviour — no tick ever reaches the far side of a cooldown — so this one
  // advances.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  let clock = 1000;
  // A 429 leaves the row's next_at alone, so the same row is due again on the
  // tick that resumes; both answers are refusals, which is what gives a second
  // cooldown to announce.
  const passDeps = deps(db, [new RateLimited(120_000), new RateLimited(120_000)], {
    now: () => clock,
  });
  const run = createPerformerRunner(passDeps);

  await run();
  clock = 60_000;
  await run();
  assert.deepEqual(passDeps.calls, ['Jessica Jaymes'], 'still inside the first cooldown');
  assert.equal(passDeps.logged.filter((line) => line.includes('cooling down')).length, 1);

  clock = 200_000;
  await run();
  assert.deepEqual(
    passDeps.calls,
    ['Jessica Jaymes', 'Jessica Jaymes'],
    'the cooldown lapsed, so the row was asked again',
  );

  clock = 250_000;
  await run();
  assert.deepEqual(passDeps.calls, ['Jessica Jaymes', 'Jessica Jaymes'], 'and a new cooldown holds');
  assert.equal(
    passDeps.logged.filter((line) => line.includes('cooling down')).length,
    2,
    'the second cooldown is announced too, not swallowed by the first',
  );
  db.close();
});

// Artwork. Reported live: "if a performer is retrieved from the performer_queue
// they don't seem to have an avatar image."
//
// The search result carries `face`/`image` urls and `upsertPerformers` stores
// them, so the row knew where the avatar was — but nothing fetched it. The only
// caching loop lived inside the *scene* pass's `lookUpOne`, and it runs before
// `enqueuePerformerSearch` is even called for that group, so it structurally
// cannot see the performer this pass is about to link. `hasAvatar` reads
// `face_path !== null`, so every search-found performer rendered nameless.

/** A search result that carries artwork urls, unlike `found` above. */
function foundWithArtwork(name: string, faceUrl: string | null, imageUrl: string | null) {
  const result = found(name);
  return { ...result, performer: { ...result.performer, faceUrl, imageUrl } };
}

function artworkOf(db: DatabaseSync, groupId: number): { facePath: string | null; imagePath: string | null }[] {
  return (performersForGroups(db, [groupId]).get(groupId) ?? []).map((row) => ({
    facePath: row.facePath,
    imagePath: row.imagePath,
  }));
}

test('a linked performer has its face and image cached, not merely its urls recorded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-performer-artwork-'));
  try {
    const db = openTestDatabase();
    seedGroup(db, 1, 'Jessica Jaymes Loves It');
    insertPerformerSearch(db, 1, 100);

    const fetched: string[] = [];
    const result = await runPerformerPass(
      deps(
        db,
        [{ results: [foundWithArtwork('Jessica Jaymes', 'https://p.invalid/face.jpg', 'https://p.invalid/full.jpg')], truncated: false }],
        { artwork: { dir, fetchImpl: trackingFetchJpeg(fetched), log: () => undefined } },
      ),
    );

    assert.equal(result.linked, 1);
    assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
    assert.deepEqual(
      fetched.toSorted(),
      ['https://p.invalid/face.jpg', 'https://p.invalid/full.jpg'],
      'both urls the result carried must be fetched',
    );
    const [artwork] = artworkOf(db, 1);
    assert.ok(artwork !== undefined);
    assert.notEqual(artwork.facePath, null, 'face_path is what `hasAvatar` reads');
    assert.notEqual(artwork.imagePath, null);

    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a performer the result gave no urls for is linked with no fetch attempted', async () => {
  // The common shape for a performer the provider holds no images of. A fetch of
  // `null` would be a crash, and a link withheld for want of an avatar would
  // lose a correct cast over decoration.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const fetched: string[] = [];
  const result = await runPerformerPass(
    deps(db, [{ results: [found('Jessica Jaymes')], truncated: false }], {
      artwork: { dir: '/tmp/pickarr-unused-artwork', fetchImpl: trackingFetchJpeg(fetched), log: () => undefined },
    }),
  );

  assert.equal(result.linked, 1);
  assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
  assert.deepEqual(fetched, [], 'nothing to fetch, so nothing fetched');
  db.close();
});

test('an avatar that 404s costs the image, never the cast', async () => {
  // `cacheImage` never throws, and the link is already committed before any
  // fetch is attempted. A provider serving a dead image url must not undo a
  // correct match.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-performer-artwork-'));
  try {
    const db = openTestDatabase();
    seedGroup(db, 1, 'Jessica Jaymes Loves It');
    insertPerformerSearch(db, 1, 100);

    const result = await runPerformerPass(
      deps(
        db,
        [{ results: [foundWithArtwork('Jessica Jaymes', 'https://p.invalid/gone.jpg', null)], truncated: false }],
        {
          artwork: {
            dir,
            fetchImpl: () => Promise.resolve(new Response(null, { status: 404 })),
            log: () => undefined,
          },
        },
      ),
    );

    assert.equal(result.linked, 1, 'the cast survives a failed avatar');
    assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
    const [artwork] = artworkOf(db, 1);
    assert.equal(artwork?.facePath, null, 'nothing was stored, so nothing claims to be cached');
    // The row keeps its `face_url`, so a later pass over this performer can try
    // again rather than treating the 404 as final.
    assert.deepEqual(duePerformerQueue(db, 9999, 10), [], 'and the queue row is still settled');

    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a performer already holding both images is not refetched', async () => {
  // Two groups can name one performer, and this pass will reach the second after
  // the first has already cached the files. Refetching would spend two provider
  // requests per already-answered performer, forever — the same guard the scene
  // pass's own loop documents at length.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-performer-artwork-'));
  try {
    const db = openTestDatabase();
    seedGroup(db, 1, 'Jessica Jaymes Loves It');
    seedGroup(db, 2, 'Jessica Jaymes Again Now');
    insertPerformerSearch(db, 1, 100);
    insertPerformerSearch(db, 2, 100);

    const fetched: string[] = [];
    const page = {
      results: [foundWithArtwork('Jessica Jaymes', 'https://p.invalid/face.jpg', 'https://p.invalid/full.jpg')],
      truncated: false,
    };
    await runPerformerPass(
      deps(db, [page, page], {
        artwork: { dir, fetchImpl: trackingFetchJpeg(fetched), log: () => undefined },
      }),
    );

    // Two rows, one performer, two images — fetched once each, not twice.
    assert.deepEqual(fetched.toSorted(), ['https://p.invalid/face.jpg', 'https://p.invalid/full.jpg']);

    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
