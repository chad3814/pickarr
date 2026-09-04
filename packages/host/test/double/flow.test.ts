/**
 * The contract's five lookup outcomes, driven end to end through the
 * test-double plugin: resolved, refused, unresolved, an answer that has not
 * arrived yet and the poll that collects it, the dedup, and a crash in the
 * middle of it all. Also the artwork job a resolved entry can schedule: the
 * double's first caller of `attachPoster`/`attachBackground`/`attachLogo`,
 * and the first workload the per-hostname fetch queue actually has to pace.
 *
 * These are the only tests that exercise the whole contract at once, so they
 * assert on rows rather than on calls: what a plugin wrote is the observable
 * the host promises, and a mock's call log would pass just as happily against
 * a `MediaWriter` that wrote nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { DownloadClients, MediaPlugin } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost, migratePlugin } from '../../src/db/migrate.ts';
import { createHostFetch } from '../../src/fetch/queue.ts';
import { createHost, DEFAULT_MAX_ATTEMPTS } from '../../src/host.ts';
import type { Host } from '../../src/host.ts';
import {
  createDoublePlugin,
  createFakeParserService,
  DOUBLE_ID,
  PARSER_ORIGIN,
  partialEntry,
  POLL_DELAY_MS,
  refusedEntry,
  resolvedEntry,
  unresolvedEntry,
} from './plugin.ts';
import type { FakeParserService, LookupEntry, LookupImage, LookupPerson, ParserScript } from './plugin.ts';
import { gifBytes } from '../support/gif.ts';

/** Where every run's clock starts, so expected `run_at` values can be written down. */
const START = 1_000;

interface Clock {
  now(): number;
  /** Jumps to an exact moment. Nothing here waits on wall time. */
  set(at: number): void;
}

function createClock(): Clock {
  let value = START;
  return { now: () => value, set: (at) => { value = at; } };
}

/** A `DownloadClients` that fails loudly: the new-items flow submits nothing. */
const unusedDownloads: DownloadClients = {
  submit: async () => { throw new Error('downloads.submit: not used by these tests'); },
};

/**
 * What every test that never attaches artwork passes to `setup` -- see the
 * identical constant in `host.test.ts`. The tests below that do attach
 * artwork pass `setup` a real temp directory instead (`withArtworkDir`).
 */
const unusedArtworkDir = '/nonexistent/pickarr-test-artwork-unused';

const ADA: LookupPerson = {
  name: 'Ada Lovelace',
  providerRef: 'person:1',
  role: 'cast',
  characterName: 'The Countess',
  billingOrder: 0,
};

const GRACE: LookupPerson = {
  name: 'Grace Hopper',
  providerRef: 'person:2',
  role: 'director',
  characterName: null,
  billingOrder: null,
};

const MOVIE = 'the.grid.2019.1080p.mkv';
const SUBTITLE = 'the.grid.2019.1080p.srt';
const GIBBERISH = 'zzz-qqq-0000.mkv';
const SLOW = 'the.long.wait.2021.1080p.mkv';
const REPACK = 'the.grid.2019.repack.1080p.mkv';

const GRID_REF = 'movie:512';

function movieEntry(name: string, ref: string, title: string): LookupEntry {
  return resolvedEntry(name, {
    lookupId: `lk-${ref}`,
    provider: 'tmdb',
    providerRef: `movie:${ref}`,
    title,
    releaseDate: null,
    description: null,
    people: [],
  });
}

function script(
  entries: readonly LookupEntry[],
  polls: readonly (readonly [string, readonly LookupEntry[]])[] = [],
): ParserScript {
  return { batch: new Map(entries.map((entry) => [entry.name, entry])), polls: new Map(polls) };
}

interface Harness {
  raw: DatabaseSync;
  host: Host;
  clock: Clock;
  service: FakeParserService;
  plugin: MediaPlugin;
}

/**
 * The url a fetch call was made with, whatever form it arrived in --
 * `plugin.ts` has an identical private helper; this file needs its own
 * because that one is not exported.
 */
function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Routes a request by origin to the fake parser service or to a fake image
 * host, so one `createHostFetch` -- and therefore one shared per-hostname
 * queue -- serves both fakes through the single `fetch` a host is built
 * with, exactly as a real host's own would.
 */
function combineFetch(parser: typeof globalThis.fetch, images: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const url = new URL(requestUrl(input));
    return url.origin === PARSER_ORIGIN ? parser(input, init) : images(input, init);
  };
}

function setup(
  parserScript: ParserScript,
  opts: { artworkDir?: string; imagesFetch?: typeof globalThis.fetch } = {},
): Harness {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const clock = createClock();
  const service = createFakeParserService(parserScript);
  const plugin = createDoublePlugin({ now: () => clock.now() });
  const host = createHost({
    raw,
    db,
    // The fake service reaches the plugin through the real fetch queue, so
    // its per-hostname serialisation is part of what these tests run.
    // `globalThis.fetch` is never touched. A test that also scripts artwork
    // hands `imagesFetch` in, and `combineFetch` is what lets both fakes
    // share this one queue.
    fetch: createHostFetch({
      fetch: opts.imagesFetch ? combineFetch(service.fetch, opts.imagesFetch) : service.fetch,
    }),
    downloads: unusedDownloads,
    artworkDir: opts.artworkDir ?? unusedArtworkDir,
    now: () => clock.now(),
  });
  host.register(plugin);
  return { raw, host, clock, service, plugin };
}

/** One feed owned by the double, and one rss item per filename, in order. */
function given(raw: DatabaseSync, filenames: readonly string[]): number[] {
  const feed = raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES (?, 'the double feed', 'https://feed.test/double', 0, 0)
  `).run(DOUBLE_ID);
  const feedId = Number(feed.lastInsertRowid);
  return filenames.map((filename) => {
    const item = raw.prepare(`
      INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
      VALUES (?, ?, ?, 0, 0, 'nzb', 'pending')
    `).run(feedId, filename, `https://feed.test/${filename}`);
    return Number(item.lastInsertRowid);
  });
}

type Row = Record<string, SQLOutputValue>;

function rowsOf(raw: DatabaseSync, sql: string, ...params: number[]): Row[] {
  return raw.prepare(sql).all(...params);
}

function readInteger(row: Row, column: string): number {
  const value = row[column];
  assert.equal(typeof value, 'number', `column ${column} is not an integer`);
  return Number(value);
}

function readIntegerOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null) return null;
  return readInteger(row, column);
}

function readText(row: Row, column: string): string {
  const value = row[column];
  assert.equal(typeof value, 'string', `column ${column} is not text`);
  return String(value);
}

function readTextOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  return readText(row, column);
}

/** The single row a query was expected to answer with, or a failure naming what was missing. */
function only<T>(items: readonly T[], what: string): T {
  assert.equal(items.length, 1, `expected exactly one ${what}, found ${items.length}`);
  const first = items.at(0);
  assert.ok(first, `expected exactly one ${what}`);
  return first;
}

interface MediaItemState {
  id: number;
  provider: string | null;
  providerRef: string | null;
  title: string;
  releaseDate: string | null;
  description: string | null;
}

function mediaItems(raw: DatabaseSync): MediaItemState[] {
  return rowsOf(
    raw,
    'SELECT id, provider, provider_ref, title, release_date, description FROM media_item ORDER BY id',
  ).map((row) => ({
    id: readInteger(row, 'id'),
    provider: readTextOrNull(row, 'provider'),
    providerRef: readTextOrNull(row, 'provider_ref'),
    title: readText(row, 'title'),
    releaseDate: readTextOrNull(row, 'release_date'),
    description: readTextOrNull(row, 'description'),
  }));
}

interface RssItemState {
  mediaItemId: number | null;
  resolution: string;
  resolutionDetail: string | null;
}

function rssItemState(raw: DatabaseSync, id: number): RssItemState {
  const row = only(
    rowsOf(raw, 'SELECT media_item_id, resolution, resolution_detail FROM rss_item WHERE id = ?', id),
    `rss item ${id}`,
  );
  return {
    mediaItemId: readIntegerOrNull(row, 'media_item_id'),
    resolution: readText(row, 'resolution'),
    resolutionDetail: readTextOrNull(row, 'resolution_detail'),
  };
}

interface JobState {
  id: number;
  kind: string;
  payload: unknown;
  state: string;
  attempts: number;
  runAt: number;
}

function jobs(raw: DatabaseSync): JobState[] {
  return rowsOf(
    raw,
    'SELECT id, kind, payload_json, state, attempts, run_at FROM jobs ORDER BY id',
  ).map((row) => {
    const payload: unknown = JSON.parse(readText(row, 'payload_json'));
    return {
      id: readInteger(row, 'id'),
      kind: readText(row, 'kind'),
      payload,
      state: readText(row, 'state'),
      attempts: readInteger(row, 'attempts'),
      runAt: readInteger(row, 'run_at'),
    };
  });
}

interface DoubleRow {
  rssItemId: number;
  mediaItemId: number | null;
  lookupJobId: number | null;
  providerRef: string | null;
}

function doubleRows(raw: DatabaseSync): DoubleRow[] {
  return rowsOf(
    raw,
    'SELECT rss_item_id, media_item_id, lookup_job_id, provider_ref FROM double_media ORDER BY id',
  ).map((row) => ({
    rssItemId: readInteger(row, 'rss_item_id'),
    mediaItemId: readIntegerOrNull(row, 'media_item_id'),
    lookupJobId: readIntegerOrNull(row, 'lookup_job_id'),
    providerRef: readTextOrNull(row, 'provider_ref'),
  }));
}

interface PersonState {
  id: number;
  name: string;
  providerRef: string;
}

function persons(raw: DatabaseSync): PersonState[] {
  return rowsOf(raw, 'SELECT id, name, provider_ref FROM person ORDER BY id').map((row) => ({
    id: readInteger(row, 'id'),
    name: readText(row, 'name'),
    providerRef: readText(row, 'provider_ref'),
  }));
}

interface RoleState {
  mediaItemId: number;
  personId: number;
  role: string;
  name: string | null;
  billingOrder: number | null;
}

function roles(raw: DatabaseSync): RoleState[] {
  return rowsOf(
    raw,
    'SELECT media_item_id, person_id, role, name, billing_order FROM role ORDER BY id',
  ).map((row) => ({
    mediaItemId: readInteger(row, 'media_item_id'),
    personId: readInteger(row, 'person_id'),
    role: readText(row, 'role'),
    name: readTextOrNull(row, 'name'),
    billingOrder: readIntegerOrNull(row, 'billing_order'),
  }));
}

function nextDueAt(raw: DatabaseSync): number | undefined {
  const row = rowsOf(raw, "SELECT MIN(run_at) AS due FROM jobs WHERE state = 'ready'").at(0);
  if (row === undefined) return undefined;
  const due = row['due'];
  // `MIN` over no rows answers one row holding NULL, which is "nothing due".
  return typeof due === 'number' ? due : undefined;
}

/**
 * Runs every job the queue holds, jumping the clock to the moment the next one
 * is due rather than sleeping. Deterministic on purpose: the crash test
 * compares two runs row for row, which only holds if both moved the clock the
 * same way.
 */
async function runToCompletion(host: Host, clock: Clock, raw: DatabaseSync): Promise<void> {
  for (let guard = 0; guard < 50; guard += 1) {
    // eslint-disable-next-line no-await-in-loop -- a queue drains one job at a time; claiming one at a time is the whole of what `runOnce` offers
    if (await host.runOnce()) continue;
    const due = nextDueAt(raw);
    if (due === undefined) return;
    clock.set(due);
  }
  throw new Error('runToCompletion: the queue never drained');
}

/**
 * A minimal, valid GIF: `image-size` reads width and height straight out of
 * the logical screen descriptor (bytes 6-9), with no CRC or pixel data
 * needed. The same construction `store.test.ts` and `writer.test.ts` use --
 * reused rather than invented a third time.
 */

/** Not a GIF, a PNG, or anything else `image-size` recognises -- what a truncated download or an html error page served as 200 looks like. */
const UNMEASURABLE_BYTES = new TextEncoder().encode('<html>not an image</html>');

/** A fresh artwork directory per test, removed afterward so a test that attaches artwork does not leave files behind. */
async function withArtworkDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-flow-artwork-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface ArtworkRow {
  mediaItemId: number;
  title: string | null;
  language: string | null;
  url: string;
  width: number;
  height: number;
  path: string | null;
}

function artworkRows(raw: DatabaseSync, table: 'poster' | 'background' | 'logo'): ArtworkRow[] {
  return rowsOf(
    raw,
    `SELECT media_item_id, title, language, url, width, height, path FROM ${table} ORDER BY id`,
  ).map((row) => ({
    mediaItemId: readInteger(row, 'media_item_id'),
    title: readTextOrNull(row, 'title'),
    language: readTextOrNull(row, 'language'),
    url: readText(row, 'url'),
    width: readInteger(row, 'width'),
    height: readInteger(row, 'height'),
    path: readTextOrNull(row, 'path'),
  }));
}

/**
 * A fake image host that answers every request immediately from a fixed
 * script, and records every url it was asked for. `bytesByUrl` can map a url
 * to `UNMEASURABLE_BYTES` just as easily as to a real image -- this fake
 * does not care what `image-size` will make of what it serves.
 */
interface FakeImages {
  fetch: typeof globalThis.fetch;
  requests: readonly string[];
}

function createFakeImages(bytesByUrl: ReadonlyMap<string, Uint8Array>): FakeImages {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = requestUrl(input);
    requests.push(url);
    const bytes = bytesByUrl.get(url);
    if (bytes === undefined) {
      throw new Error(`fake images: nothing scripted for ${url}`);
    }
    return new Response(bytes, { status: 200 });
  };
  return { fetch, requests };
}

/**
 * A fake image host that never settles a request on its own: the test
 * releases it explicitly, once it has seen what it needs to see. This is
 * what lets a test assert two requests are in flight *at once* without
 * measuring elapsed time -- a serialised implementation would leave the
 * second request never made at all until the test releases the first.
 */
interface GatedImages {
  fetch: typeof globalThis.fetch;
  /** How many requests for this exact url are currently unreleased. */
  inFlight(url: string): number;
  /** Lets the oldest unreleased request for this url resolve, with its scripted bytes. */
  release(url: string): void;
}

function createGatedImages(bytesByUrl: ReadonlyMap<string, Uint8Array>): GatedImages {
  const inFlightCounts = new Map<string, number>();
  const pending = new Map<string, Array<() => void>>();

  const fetch: typeof globalThis.fetch = (input) => new Promise<Response>((resolve) => {
    const url = requestUrl(input);
    inFlightCounts.set(url, (inFlightCounts.get(url) ?? 0) + 1);
    const queue = pending.get(url) ?? [];
    queue.push(() => {
      inFlightCounts.set(url, (inFlightCounts.get(url) ?? 1) - 1);
      const bytes = bytesByUrl.get(url);
      if (bytes === undefined) throw new Error(`gated images: nothing scripted for ${url}`);
      resolve(new Response(bytes, { status: 200 }));
    });
    pending.set(url, queue);
  });

  return {
    fetch,
    inFlight: (url) => inFlightCounts.get(url) ?? 0,
    release: (url) => {
      const release = pending.get(url)?.shift();
      if (release === undefined) throw new Error(`gated images: no pending request for ${url}`);
      release();
    },
  };
}

test('a resolved entry writes the media item, its provider ref, its people, and resolution resolved', async () => {
  const grid = resolvedEntry(MOVIE, {
    lookupId: 'lk-grid',
    provider: 'tmdb',
    providerRef: GRID_REF,
    title: 'The Grid',
    releaseDate: '2019-04-02',
    description: 'A film about a grid.',
    people: [ADA, GRACE],
  });
  const { raw, host, service } = setup(script([grid]));
  const ids = given(raw, [MOVIE]);
  const itemId = only(ids, 'rss item');

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  // Read rather than ignored. A plugin whose `onNewRssItems` rejected would
  // otherwise pass for success, and every assertion below would then be
  // chasing the wrong cause.
  assert.deepEqual(outcome.failures, []);

  assert.equal(await host.runOnce(), true, 'the lookup job must be ready to run');
  assert.equal(await host.runOnce(), false, 'a resolved entry leaves nothing queued');

  // The double asked the service about the filename, not the row id.
  assert.deepEqual(service.batchRequests, [[MOVIE]]);
  assert.deepEqual(service.pollRequests, []);

  const media = only(mediaItems(raw), 'media item');
  assert.equal(media.provider, 'tmdb');
  assert.equal(media.providerRef, GRID_REF);
  assert.equal(media.title, 'The Grid');
  assert.equal(media.releaseDate, '2019-04-02');
  assert.equal(media.description, 'A film about a grid.');

  const item = rssItemState(raw, itemId);
  assert.equal(item.resolution, 'resolved');
  assert.equal(item.resolutionDetail, null, 'a resolved item has nothing to explain');
  assert.equal(item.mediaItemId, media.id);

  // People are de-duplicated on the provider's own person id, and each role
  // names the person id `upsertPerson` answered with -- not a row position.
  const people = persons(raw);
  assert.deepEqual(
    people.map((person) => [person.name, person.providerRef]),
    [['Ada Lovelace', 'person:1'], ['Grace Hopper', 'person:2']],
  );
  const ada = people.at(0);
  const grace = people.at(1);
  assert.ok(ada);
  assert.ok(grace);
  assert.deepEqual(roles(raw), [
    { mediaItemId: media.id, personId: ada.id, role: 'cast', name: 'The Countess', billingOrder: 0 },
    { mediaItemId: media.id, personId: grace.id, role: 'director', name: null, billingOrder: null },
  ]);

  const job = only(jobs(raw), 'job');
  assert.equal(job.kind, 'lookup');
  assert.equal(job.state, 'done');
  assert.deepEqual(job.payload, { rssItemIds: [itemId] });

  const own = only(doubleRows(raw), 'double_media row');
  assert.equal(own.rssItemId, itemId);
  assert.equal(own.mediaItemId, media.id);
  assert.equal(own.providerRef, `tmdb:${GRID_REF}`);
  // The id `JobQueue.enqueue` returned, kept rather than discarded.
  assert.equal(own.lookupJobId, job.id);
});

test('a refused entry is terminal: resolution refused, no retry enqueued, no media rows', async () => {
  // A refusal is a successful identification of a non-media file. Retrying it
  // forever, or surfacing it as a failure, are both wrong.
  const refusal = 'subtitle track, not media';
  const { raw, host, service } = setup(script([refusedEntry(SUBTITLE, { lookupId: 'lk-srt', refusal })]));
  const ids = given(raw, [SUBTITLE]);
  const itemId = only(ids, 'rss item');

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  assert.equal(await host.runOnce(), true);
  assert.equal(await host.runOnce(), false, 'a refusal must not enqueue a retry');

  const item = rssItemState(raw, itemId);
  assert.equal(item.resolution, 'refused', 'a refusal is not an unresolved item');
  // The service's own words, carried through: a refusal a reader cannot read
  // is indistinguishable from a failure.
  assert.equal(item.resolutionDetail, refusal);
  assert.equal(item.mediaItemId, null);

  assert.deepEqual(mediaItems(raw), [], 'a refused file is not media, so it has no media row');
  assert.deepEqual(persons(raw), []);
  assert.deepEqual(roles(raw), []);
  assert.deepEqual(service.pollRequests, []);

  // The lookup itself finished. A refusal that threw instead would leave this
  // row `ready` with a backoff -- the retry-forever mistake, one job later.
  const job = only(jobs(raw), 'job');
  assert.equal(job.kind, 'lookup');
  assert.equal(job.state, 'done');
  assert.equal(job.attempts, 1);
});

test('an unresolved entry records resolution unresolved and does not enqueue a retry', async () => {
  const { raw, host } = setup(script([unresolvedEntry(GIBBERISH, { lookupId: 'lk-zzz' })]));
  const ids = given(raw, [GIBBERISH]);
  const itemId = only(ids, 'rss item');

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  assert.equal(await host.runOnce(), true);
  assert.equal(await host.runOnce(), false, 'an unresolved item is retried on request, not on a timer');

  const item = rssItemState(raw, itemId);
  assert.equal(item.resolution, 'unresolved', 'a name the service did not recognise is not a refusal');
  assert.ok(item.resolutionDetail, 'an unresolved item must record why it is unresolved');
  assert.match(item.resolutionDetail, /did not recognise/);
  assert.equal(item.mediaItemId, null);
  assert.deepEqual(mediaItems(raw), []);

  const job = only(jobs(raw), 'job');
  assert.equal(job.kind, 'lookup');
  assert.equal(job.state, 'done');
  assert.equal(job.attempts, 1);
});

test('a partial entry enqueues a poll job carrying its lookupId, and its siblings proceed immediately', async () => {
  const first = movieEntry('first.2001.1080p.mkv', '1', 'First');
  const last = movieEntry('last.2003.1080p.mkv', '3', 'Last');
  const { raw, host, service } = setup(script([first, partialEntry(SLOW, { lookupId: 'lk-slow' }), last]));
  const ids = given(raw, [first.name, SLOW, last.name]);
  const firstId = ids.at(0);
  const slowId = ids.at(1);
  const lastId = ids.at(2);
  assert.ok(firstId);
  assert.ok(slowId);
  assert.ok(lastId);

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  // The lookup only. Nothing drains the poll, so what the lookup left behind
  // stays visible.
  assert.equal(await host.runOnce(), true);
  assert.deepEqual(service.batchRequests, [[first.name, SLOW, last.name]]);

  // Half one: the entries either side of the slow one are already finished.
  // One entry with no answer yet must not stall its siblings, and the entry
  // *after* it in the same batch is the one a response-level read loses.
  assert.equal(rssItemState(raw, firstId).resolution, 'resolved');
  assert.equal(rssItemState(raw, lastId).resolution, 'resolved');
  assert.equal(mediaItems(raw).length, 2, 'only the two answered entries have media rows');

  // The slow one is none of resolved, refused or unresolved: it has no answer.
  const slow = rssItemState(raw, slowId);
  assert.equal(slow.resolution, 'pending');
  assert.equal(slow.mediaItemId, null);

  // Half two: the poll exists and carries that entry's own lookup id. Without
  // it nothing knows which of the service's outstanding lookups to ask about.
  const pollJob = only(jobs(raw).filter((job) => job.kind === 'poll'), 'poll job');
  assert.deepEqual(pollJob.payload, { lookupId: 'lk-slow', rssItemId: slowId });
  assert.equal(pollJob.state, 'ready');
  assert.equal(pollJob.runAt, START + POLL_DELAY_MS, 'a poll waits before asking again');
  assert.deepEqual(service.pollRequests, [], 'nothing has polled yet');
});

test('the poll job completes the item once the fake service answers', async () => {
  // The service says "not yet" one more time before it answers at all, so the
  // poll has to be able to enqueue its own successor.
  const answer = movieEntry(SLOW, 'slow', 'The Long Wait');
  const { raw, host, clock, service } = setup(script(
    [partialEntry(SLOW, { lookupId: 'lk-slow' })],
    [['lk-slow', [partialEntry(SLOW, { lookupId: 'lk-slow' }), answer]]],
  ));
  const ids = given(raw, [SLOW]);
  const itemId = only(ids, 'rss item');

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  await runToCompletion(host, clock, raw);

  assert.deepEqual(service.pollRequests, ['lk-slow', 'lk-slow'], 'the first poll was answered "not yet"');

  const item = rssItemState(raw, itemId);
  assert.equal(item.resolution, 'resolved');
  assert.equal(item.resolutionDetail, null);
  const media = only(mediaItems(raw), 'media item');
  assert.equal(item.mediaItemId, media.id);
  assert.equal(media.providerRef, 'movie:slow');
  assert.equal(media.title, 'The Long Wait');
  assert.equal(only(doubleRows(raw), 'double_media row').mediaItemId, media.id);

  const all = jobs(raw);
  assert.deepEqual(
    all.map((job) => [job.kind, job.state]),
    [['lookup', 'done'], ['poll', 'done'], ['poll', 'done']],
  );
  const second = all.at(2);
  assert.ok(second);
  assert.equal(second.runAt, START + 2 * POLL_DELAY_MS, 'each poll waits again before re-asking');
});

test('two rss items resolving to one provider ref end up sharing one media item', async () => {
  const original = resolvedEntry(MOVIE, {
    lookupId: 'lk-a',
    provider: 'tmdb',
    providerRef: GRID_REF,
    title: 'The Grid',
    releaseDate: '2019-04-02',
    description: null,
    people: [ADA, GRACE],
  });
  const repack = resolvedEntry(REPACK, {
    lookupId: 'lk-b',
    provider: 'tmdb',
    providerRef: GRID_REF,
    title: 'The Grid (repack)',
    releaseDate: '2019-04-02',
    description: null,
    // The same cast as the entry above, because a repack of a film is that
    // film. Disjoint casts would make this test pass against an
    // implementation that duplicated every shared person: the loser's people
    // are re-attached to the winner, so an overlap is the only fixture in
    // which the duplicate is observable at all.
    people: [ADA, GRACE],
  });
  const { raw, host } = setup(script([original, repack]));
  const ids = given(raw, [MOVIE, REPACK]);
  const firstId = ids.at(0);
  const secondId = ids.at(1);
  assert.ok(firstId);
  assert.ok(secondId);

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  assert.equal(await host.runOnce(), true);
  assert.equal(await host.runOnce(), false);

  // One survivor: whichever item claimed the reference first. `only` is what
  // says the loser was deleted rather than merely left unclaimed -- an
  // unclaimed duplicate would still be a second row here -- and the title
  // says which of the two survived.
  const media = only(mediaItems(raw), 'media item');
  assert.equal(media.title, 'The Grid');
  assert.equal(media.provider, 'tmdb');
  assert.equal(media.providerRef, GRID_REF);

  // Both rss items point at the survivor, and so do the double's own rows.
  assert.equal(rssItemState(raw, firstId).mediaItemId, media.id);
  assert.equal(rssItemState(raw, secondId).mediaItemId, media.id);
  assert.equal(rssItemState(raw, firstId).resolution, 'resolved');
  assert.equal(rssItemState(raw, secondId).resolution, 'resolved');
  assert.deepEqual(doubleRows(raw).map((row) => row.mediaItemId), [media.id, media.id]);

  // Both answers' people land on the one survivor, once each. The loser's
  // people are attached to the *winner's* media item, so a cast the two
  // answers share arrives twice and only `attachRole`'s upsert keeps it to
  // one row per part.
  const people = persons(raw);
  assert.deepEqual(people.map((person) => person.name), ['Ada Lovelace', 'Grace Hopper']);
  const ada = people.at(0);
  const grace = people.at(1);
  assert.ok(ada);
  assert.ok(grace);
  assert.deepEqual(roles(raw), [
    { mediaItemId: media.id, personId: ada.id, role: 'cast', name: 'The Countess', billingOrder: 0 },
    { mediaItemId: media.id, personId: grace.id, role: 'director', name: null, billingOrder: null },
  ]);
});

const POSTER_URL = 'https://images-a.test/poster.gif';
const BACKGROUND_URL = 'https://images-b.test/background.gif';
const LOGO_URL = 'https://images-c.test/logo.gif';

/** A resolved entry that also schedules an artwork job, for the tests below that need one. */
function movieWithImages(name: string, ref: string, title: string, images: readonly LookupImage[]): LookupEntry {
  return resolvedEntry(name, {
    lookupId: `lk-${ref}`,
    provider: 'tmdb',
    providerRef: `movie:${ref}`,
    title,
    releaseDate: null,
    description: null,
    people: [],
    images,
  });
}

test('a resolved entry gets its poster, background and logo attached', async () => {
  await withArtworkDir(async (artworkDir) => {
    const images = createFakeImages(new Map([
      [POSTER_URL, gifBytes(300, 450)],
      [BACKGROUND_URL, gifBytes(1920, 1080)],
      [LOGO_URL, gifBytes(512, 128)],
    ]));
    const grid = movieWithImages(MOVIE, '512', 'The Grid', [
      { role: 'poster', url: POSTER_URL, title: 'Poster art', language: 'en' },
      { role: 'background', url: BACKGROUND_URL, title: null, language: null },
      { role: 'logo', url: LOGO_URL, title: null, language: null },
    ]);
    const { raw, host } = setup(script([grid]), { artworkDir, imagesFetch: images.fetch });
    const ids = given(raw, [MOVIE]);

    const outcome = await host.notifyNewRssItems(ids);
    assert.deepEqual(outcome.failures, []);
    assert.equal(await host.runOnce(), true, 'the lookup job must run');
    assert.equal(await host.runOnce(), true, 'the artwork job it scheduled must run');
    assert.equal(await host.runOnce(), false, 'nothing else must be queued');

    const media = only(mediaItems(raw), 'media item');

    const poster = only(artworkRows(raw, 'poster'), 'poster row');
    assert.equal(poster.mediaItemId, media.id);
    assert.equal(poster.url, POSTER_URL);
    assert.equal(poster.title, 'Poster art');
    assert.equal(poster.language, 'en');
    assert.equal(poster.width, 300);
    assert.equal(poster.height, 450);
    assert.ok(poster.path?.startsWith(artworkDir), 'the cached file must live in the artwork directory');

    const background = only(artworkRows(raw, 'background'), 'background row');
    assert.equal(background.mediaItemId, media.id);
    assert.equal(background.width, 1920);
    assert.equal(background.height, 1080);

    const logo = only(artworkRows(raw, 'logo'), 'logo row');
    assert.equal(logo.mediaItemId, media.id);
    assert.equal(logo.width, 512);
    assert.equal(logo.height, 128);

    const files = await readdir(artworkDir);
    assert.equal(files.length, 3, 'one cached file per image');
  });
});

test('artwork runs as its own job, so a failed image does not undo a resolved item', async () => {
  await withArtworkDir(async (artworkDir) => {
    // The service can never measure this: exhausting the artwork job's
    // attempts must leave a media item with no artwork, never no media item.
    const images = createFakeImages(new Map([[POSTER_URL, UNMEASURABLE_BYTES]]));
    const grid = movieWithImages(MOVIE, '512', 'The Grid', [
      { role: 'poster', url: POSTER_URL, title: null, language: null },
    ]);
    const { raw, host, clock } = setup(script([grid]), { artworkDir, imagesFetch: images.fetch });
    const ids = given(raw, [MOVIE]);
    const itemId = only(ids, 'rss item');

    const outcome = await host.notifyNewRssItems(ids);
    assert.deepEqual(outcome.failures, []);
    await runToCompletion(host, clock, raw);

    // The lookup's own work is untouched: a media item, claimed and resolved.
    const media = only(mediaItems(raw), 'media item');
    assert.equal(media.title, 'The Grid');
    const item = rssItemState(raw, itemId);
    assert.equal(item.mediaItemId, media.id);
    assert.equal(item.resolution, 'resolved', 'the lookup outcome must not be undone by the artwork job failing');

    // The artwork job itself is what failed, and dead-lettered on its own.
    const artworkJob = only(jobs(raw).filter((job) => job.kind === 'artwork'), 'artwork job');
    assert.equal(artworkJob.state, 'dead');
    assert.equal(artworkJob.attempts, DEFAULT_MAX_ATTEMPTS);
    assert.deepEqual(artworkRows(raw, 'poster'), [], 'an image that never measures must never get a row');
  });
});

test('images on different hosts are fetched in parallel', async () => {
  await withArtworkDir(async (artworkDir) => {
    const gated = createGatedImages(new Map([
      [POSTER_URL, gifBytes(300, 450)],
      [BACKGROUND_URL, gifBytes(1920, 1080)],
    ]));
    const grid = movieWithImages(MOVIE, '512', 'The Grid', [
      { role: 'poster', url: POSTER_URL, title: null, language: null },
      { role: 'background', url: BACKGROUND_URL, title: null, language: null },
    ]);
    const { raw, host } = setup(script([grid]), { artworkDir, imagesFetch: gated.fetch });
    const ids = given(raw, [MOVIE]);

    const outcome = await host.notifyNewRssItems(ids);
    assert.deepEqual(outcome.failures, []);
    assert.equal(await host.runOnce(), true, 'the lookup job must run');

    // Started, not awaited: both hosts' requests should already be in flight
    // by the time this settles, and neither request in this test ever
    // resolves on its own -- a serialised implementation would leave the
    // second one never made at all.
    const artworkRun = host.runOnce();
    await flush();

    assert.equal(gated.inFlight(POSTER_URL), 1, 'the poster request must already be in flight');
    assert.equal(
      gated.inFlight(BACKGROUND_URL),
      1,
      'the background request must already be in flight -- proving it did not wait for the poster host',
    );

    gated.release(POSTER_URL);
    gated.release(BACKGROUND_URL);
    assert.equal(await artworkRun, true, 'the artwork job must complete once both requests are released');

    assert.equal(only(artworkRows(raw, 'poster'), 'poster row').width, 300);
    assert.equal(only(artworkRows(raw, 'background'), 'background row').width, 1920);
  });
});

test('an image the service offers but the host cannot measure leaves the other two attached', async () => {
  await withArtworkDir(async (artworkDir) => {
    const images = createFakeImages(new Map([
      [POSTER_URL, gifBytes(300, 450)],
      [BACKGROUND_URL, gifBytes(1920, 1080)],
      [LOGO_URL, UNMEASURABLE_BYTES],
    ]));
    const grid = movieWithImages(MOVIE, '512', 'The Grid', [
      { role: 'poster', url: POSTER_URL, title: null, language: null },
      { role: 'background', url: BACKGROUND_URL, title: null, language: null },
      { role: 'logo', url: LOGO_URL, title: null, language: null },
    ]);
    const { raw, host } = setup(script([grid]), { artworkDir, imagesFetch: images.fetch });
    const ids = given(raw, [MOVIE]);

    const outcome = await host.notifyNewRssItems(ids);
    assert.deepEqual(outcome.failures, []);
    assert.equal(await host.runOnce(), true, 'the lookup job must run');
    // The artwork job itself still "runs" -- `runOnce` only reports whether a
    // job was claimed, not whether its handler succeeded -- but it fails,
    // because the logo could not be measured.
    assert.equal(await host.runOnce(), true, 'the artwork job attempt runs, even though it will fail overall');

    assert.equal(only(artworkRows(raw, 'poster'), 'poster row').width, 300);
    assert.equal(only(artworkRows(raw, 'background'), 'background row').width, 1920);
    assert.deepEqual(artworkRows(raw, 'logo'), [], 'the unmeasurable image must have produced no row');
  });
});

test('re-running the artwork job attaches nothing new', async () => {
  await withArtworkDir(async (artworkDir) => {
    const images = createFakeImages(new Map([
      [POSTER_URL, gifBytes(300, 450)],
      [BACKGROUND_URL, gifBytes(1920, 1080)],
      [LOGO_URL, gifBytes(512, 128)],
    ]));
    const grid = movieWithImages(MOVIE, '512', 'The Grid', [
      { role: 'poster', url: POSTER_URL, title: null, language: null },
      { role: 'background', url: BACKGROUND_URL, title: null, language: null },
      { role: 'logo', url: LOGO_URL, title: null, language: null },
    ]);
    const { raw, host } = setup(script([grid]), { artworkDir, imagesFetch: images.fetch });
    const ids = given(raw, [MOVIE]);

    await host.notifyNewRssItems(ids);
    assert.equal(await host.runOnce(), true, 'the lookup job must run');
    assert.equal(await host.runOnce(), true, 'the artwork job must run');

    const beforeRerun = {
      poster: artworkRows(raw, 'poster'),
      background: artworkRows(raw, 'background'),
      logo: artworkRows(raw, 'logo'),
    };
    const filesBeforeRerun = await readdir(artworkDir);
    assert.equal(filesBeforeRerun.length, 3);

    // Back to `ready`, exactly the state `recover` leaves a job the process
    // died holding -- see the crash test below -- and run the very same
    // payload through the very same handler a second time.
    const artworkJob = only(jobs(raw).filter((job) => job.kind === 'artwork'), 'artwork job');
    raw.prepare("UPDATE jobs SET state = 'ready' WHERE id = ?").run(artworkJob.id);
    assert.equal(await host.runOnce(), true, 'the re-run must claim the same job');

    assert.deepEqual(artworkRows(raw, 'poster'), beforeRerun.poster, 'one row, not two');
    assert.deepEqual(artworkRows(raw, 'background'), beforeRerun.background, 'one row, not two');
    assert.deepEqual(artworkRows(raw, 'logo'), beforeRerun.logo, 'one row, not two');

    const filesAfterRerun = await readdir(artworkDir);
    assert.deepEqual(filesAfterRerun, filesBeforeRerun, 'one file per image, not two');
  });
});

/** Every outcome in one batch, so the crash resumes the whole flow rather than one branch of it. */
const CRASH_FILENAMES = [MOVIE, SUBTITLE, GIBBERISH, SLOW, REPACK];

function crashScript(): ParserScript {
  return script(
    [
      resolvedEntry(MOVIE, {
        lookupId: 'lk-a',
        provider: 'tmdb',
        providerRef: GRID_REF,
        title: 'The Grid',
        releaseDate: '2019-04-02',
        description: null,
        people: [ADA],
      }),
      refusedEntry(SUBTITLE, { lookupId: 'lk-srt', refusal: 'subtitle track, not media' }),
      unresolvedEntry(GIBBERISH, { lookupId: 'lk-zzz' }),
      partialEntry(SLOW, { lookupId: 'lk-slow' }),
      resolvedEntry(REPACK, {
        lookupId: 'lk-b',
        provider: 'tmdb',
        providerRef: GRID_REF,
        title: 'The Grid (repack)',
        releaseDate: '2019-04-02',
        description: null,
        people: [GRACE],
      }),
    ],
    [['lk-slow', [movieEntry(SLOW, 'slow', 'The Long Wait')]]],
  );
}

/**
 * A fetch that never answers its first request and delegates every later one.
 * That first request is the process dying mid-lookup: the job had been claimed
 * and the handler had written nothing when it stopped.
 */
function hangOnFirstRequest(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  let hung = false;
  return (input, init) => {
    if (hung) return inner(input, init);
    hung = true;
    // Never settles, so the handler holding it never continues.
    return new Promise<Response>(() => undefined);
  };
}

/** Lets the abandoned handler get as far as the request it hangs on. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

/**
 * Every row the flow wrote, ordered, with `jobs.attempts` left out. The
 * crashed run consumed one attempt more than the clean one; that is the
 * crash's signature, asserted on its own below, rather than a divergence in
 * what the flow produced. Everything else must match, ids included: both runs
 * insert the same rows in the same order into a fresh database.
 */
function snapshot(raw: DatabaseSync): Record<string, Row[]> {
  return {
    mediaItem: rowsOf(raw, 'SELECT * FROM media_item ORDER BY id'),
    rssItem: rowsOf(raw, 'SELECT * FROM rss_item ORDER BY id'),
    person: rowsOf(raw, 'SELECT * FROM person ORDER BY id'),
    role: rowsOf(raw, 'SELECT * FROM role ORDER BY id'),
    doubleMedia: rowsOf(raw, 'SELECT * FROM double_media ORDER BY id'),
    jobs: rowsOf(raw, `
      SELECT id, plugin_id, kind, payload_json, max_attempts, run_at, state, last_error, created_at, updated_at
        FROM jobs ORDER BY id
    `),
  };
}

function lookupAttempts(raw: DatabaseSync): number {
  return only(jobs(raw).filter((job) => job.kind === 'lookup'), 'lookup job').attempts;
}

test('a handler that runs to completion twice does not double-write', async () => {
  // The property the contract requires of every handler, because crash
  // recovery re-runs a job that was already claimed. The crash test below
  // does not cover it and cannot: it hangs the *first* request, so the
  // abandoned handler had written nothing, and its snapshot equality proves
  // the flow resumes rather than that re-running work already done is safe.
  // This test lets the handler finish, then hands it the same job again.
  const grid = resolvedEntry(MOVIE, {
    lookupId: 'lk-grid',
    provider: 'tmdb',
    providerRef: GRID_REF,
    title: 'The Grid',
    releaseDate: '2019-04-02',
    description: 'A film about a grid.',
    people: [ADA, GRACE],
  });
  const { raw, host } = setup(script([grid]));
  const ids = given(raw, [MOVIE]);

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);
  assert.equal(await host.runOnce(), true, 'the lookup must run the first time');
  assert.equal(only(jobs(raw), 'job').state, 'done', 'the first run must finish, not hang');

  const afterFirstRun = snapshot(raw);
  // A resolved entry writes to all five tables; a snapshot of five empty
  // tables would be equal to itself whatever the second run did.
  assert.equal(mediaItems(raw).length, 1);
  assert.equal(roles(raw).length, 2);

  // Back to `ready`, which is exactly the state `recover` leaves a job the
  // process died holding, and run the same payload through the same handler.
  const job = only(jobs(raw), 'job');
  raw.prepare("UPDATE jobs SET state = 'ready' WHERE id = ?").run(job.id);
  assert.equal(await host.runOnce(), true, 'the re-run must claim the same job');

  // `snapshot` leaves `jobs.attempts` out, which is the one column a second
  // run legitimately moves. Everything the handler wrote must be untouched:
  // not one extra media item, person, role or double_media row, and no
  // rewritten resolution.
  assert.deepEqual(snapshot(raw), afterFirstRun);
  assert.equal(lookupAttempts(raw), 2, 'the re-run consumed a second attempt');
});

test('the whole flow resumes after a simulated crash mid-lookup', async () => {
  // The run to be matched. An actual second run rather than a hand-written
  // expectation, so the two cannot drift apart.
  const clean = setup(crashScript());
  const cleanIds = given(clean.raw, CRASH_FILENAMES);
  const cleanOutcome = await clean.host.notifyNewRssItems(cleanIds);
  assert.deepEqual(cleanOutcome.unowned, []);
  assert.deepEqual(cleanOutcome.failures, []);
  await runToCompletion(clean.host, clean.clock, clean.raw);

  // The run that dies: its own database, the same script, the same clock.
  const service = createFakeParserService(crashScript());
  const clock = createClock();
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const plugin = createDoublePlugin({ now: () => clock.now() });

  // The dying process's fetch queue dies with it, and that matters:
  // `createHostFetch` serialises per hostname, so the request that hangs
  // below holds its hostname's only slot until `queue.ts`'s thirty-second
  // timeout aborts it and releases it -- far longer than this test, or a
  // restart, is willing to wait. So the restart below builds its own queue,
  // exactly as a real restarted process would.
  const dying = createHost({
    raw,
    db,
    fetch: createHostFetch({ fetch: hangOnFirstRequest(service.fetch) }),
    downloads: unusedDownloads,
    artworkDir: unusedArtworkDir,
    now: () => clock.now(),
  });
  dying.register(plugin);
  const ids = given(raw, CRASH_FILENAMES);
  assert.deepEqual(ids, cleanIds, 'both runs must be looking at the same row ids');
  const outcome = await dying.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  // Claims the lookup and starts the handler, which hangs on the batch request
  // and never returns. The promise is deliberately dropped: this is the
  // process going away mid-handler, not a rejection the runner could catch.
  void dying.runOnce();
  await flush();

  const claimed = only(jobs(raw), 'job');
  assert.equal(claimed.state, 'running');
  // One attempt consumed, by the claim, before the handler ran. Deliberately
  // below `DEFAULT_MAX_ATTEMPTS`: a job crashing on its last permitted attempt
  // is dead-lettered by `recover` instead, which would prove the opposite of
  // what this test is about.
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.attempts < DEFAULT_MAX_ATTEMPTS);

  // The restart: a new host over the same database, with its own fetch queue.
  const restarted = createHost({
    raw,
    db,
    fetch: createHostFetch({ fetch: service.fetch }),
    downloads: unusedDownloads,
    artworkDir: unusedArtworkDir,
    now: () => clock.now(),
  });
  restarted.register(plugin);
  // Re-applying the plugin's migrations on restart runs none of them.
  assert.equal(migratePlugin(raw, DOUBLE_ID, plugin.migrations), 0, 'a restart must not re-run a migration');

  // A row left `running` belongs to nobody until `recover` hands it back.
  assert.equal(await restarted.runOnce(), false, 'a job left running is not claimable');
  assert.equal(restarted.recover(), 1);
  await runToCompletion(restarted, clock, raw);

  assert.deepEqual(snapshot(raw), snapshot(clean.raw));

  // The one legitimate difference, asserted rather than ignored: the crashed
  // attempt was consumed, which is why `recover` must not reset the count.
  assert.equal(lookupAttempts(raw), 2);
  assert.equal(lookupAttempts(clean.raw), 1);
});
