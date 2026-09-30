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
import type { Timers } from '../../src/jobs/dispatcher.ts';
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
import type { Secrets } from '../../src/secrets/instance.ts';

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
 * A `Secrets` that fails loudly if a test never meant to resolve a
 * credential. No test in this file reads a `download_client` row through
 * `readClientConfig`, so nothing here should reach the secrets chain --
 * `clients/config.test.ts` and `clients/reconcile-job.test.ts` are where a
 * real one is exercised.
 */
const unusedSecrets: Secrets = {
  get: async () => { throw new Error('secrets.get: not used by this test'); },
  saveSecret: () => { throw new Error('secrets.saveSecret: not used by this test'); },
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

/** One `setTimeout`/`setInterval` call, as the fake `Timers` below records it. */
interface TimerCall {
  handle: number;
  ms: number;
  fn: () => void;
}

/**
 * A `Timers` whose every call is logged rather than actually scheduled, the
 * same fake `dispatcher.test.ts`, `jobs/runner.test.ts` and `host.test.ts`
 * each build for `createDispatcher` -- duplicated here rather than imported,
 * since no file in this package shares a test-support module with another.
 * "Advancing the clock" in this file means invoking a logged `fn` directly,
 * never waiting on real time.
 */
function createFakeTimers(): { timers: Timers; setTimeoutCalls: TimerCall[] } {
  let nextHandle = 0;
  const setTimeoutCalls: TimerCall[] = [];
  const timers: Timers = {
    setTimeout(fn, ms) {
      const handle = ++nextHandle;
      setTimeoutCalls.push({ handle, ms, fn });
      return handle;
    },
    clearTimeout() {},
    setInterval(_fn, _ms) {
      const handle = ++nextHandle;
      // No test here drives the safety interval directly, so its own call
      // is recorded nowhere -- only its handle needs to exist, so `stop()`
      // has something to clear.
      return handle;
    },
    clearInterval() {},
  };
  return { timers, setTimeoutCalls };
}

/**
 * Fires the most recently armed timer without waiting for what it dispatches
 * to finish -- for the one test in this file (`images on different hosts are
 * fetched in parallel`) that needs to inspect a handler mid-flight, before
 * its own awaited fetches resolve. Every other call site wants `runDue`
 * below, which also waits.
 */
function fireLatest(setTimeoutCalls: readonly TimerCall[]): void {
  const fire = setTimeoutCalls.at(-1)?.fn;
  assert.ok(fire, 'no timer was armed for a due job');
  fire();
}

/**
 * Fires the most recently armed timer -- `Host.start()`'s dispatcher rearms
 * on every enqueue and after every fire, so whichever entry is latest is the
 * one standing for "whatever is next due" -- then waits for the dispatched
 * job (and anything it enqueues) to finish. The replacement for
 * `await host.runOnce()` throughout this file: where `runOnce()` returned a
 * claimed-something boolean, this returns nothing, because what a test needs
 * after it is never the fact that something ran but which row and in what
 * state it was left -- an effect assertion, not a return value.
 */
async function runDue(host: Host, setTimeoutCalls: readonly TimerCall[]): Promise<void> {
  fireLatest(setTimeoutCalls);
  await host.idle();
}

interface Harness {
  raw: DatabaseSync;
  host: Host;
  clock: Clock;
  service: FakeParserService;
  plugin: MediaPlugin;
  setTimeoutCalls: TimerCall[];
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
  const { timers, setTimeoutCalls } = createFakeTimers();
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
    downloads: () => unusedDownloads,
    secrets: unusedSecrets,
    artworkDir: opts.artworkDir ?? unusedArtworkDir,
    now: () => clock.now(),
    timers,
  });
  host.register(plugin);
  return { raw, host, clock, service, plugin, setTimeoutCalls };
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
      INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, lookup_state)
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
  lookupState: string;
  lookupStateDetail: string | null;
}

function rssItemState(raw: DatabaseSync, id: number): RssItemState {
  const row = only(
    rowsOf(raw, 'SELECT media_item_id, lookup_state, lookup_state_detail FROM rss_item WHERE id = ?', id),
    `rss item ${id}`,
  );
  return {
    mediaItemId: readIntegerOrNull(row, 'media_item_id'),
    lookupState: readText(row, 'lookup_state'),
    lookupStateDetail: readTextOrNull(row, 'lookup_state_detail'),
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
 *
 * Assumes `host.start()` has already armed a timer. Each iteration fires
 * whichever timer is currently latest -- the dispatcher rearms after every
 * fire and every enqueue, so that is always "whatever is next due" -- and
 * waits for it (and anything it enqueues) to finish, before checking whether
 * anything is still ready. A ready row already due at the current clock
 * value needs no clock movement, only another fire; one still in the future
 * needs the clock moved to meet it, which is what a real timer would have
 * waited out on its own.
 */
async function runToCompletion(host: Host, clock: Clock, raw: DatabaseSync, setTimeoutCalls: readonly TimerCall[]): Promise<void> {
  for (let guard = 0; guard < 50; guard += 1) {
    // eslint-disable-next-line no-await-in-loop -- each wave must finish before the next fire is chosen, since a handler may enqueue what the next wave needs to see
    await runDue(host, setTimeoutCalls);
    const due = nextDueAt(raw);
    if (due === undefined) return;
    if (due > clock.now()) clock.set(due);
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

test('a resolved entry writes the media item, its provider ref, its people, and the lookup state resolved', async () => {
  const grid = resolvedEntry(MOVIE, {
    lookupId: 'lk-grid',
    provider: 'tmdb',
    providerRef: GRID_REF,
    title: 'The Grid',
    releaseDate: '2019-04-02',
    description: 'A film about a grid.',
    people: [ADA, GRACE],
  });
  const { raw, host, service, setTimeoutCalls } = setup(script([grid]));
  const ids = given(raw, [MOVIE]);
  const itemId = only(ids, 'rss item');

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  // Read rather than ignored. A plugin whose `onNewRssItems` rejected would
  // otherwise pass for success, and every assertion below would then be
  // chasing the wrong cause.
  assert.deepEqual(outcome.failures, []);

  host.start();
  await runDue(host, setTimeoutCalls);
  // "a resolved entry leaves nothing queued" is what the `only(jobs(raw), ...)`
  // below proves: it throws if a second job exists.

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
  assert.equal(item.lookupState, 'resolved');
  assert.equal(item.lookupStateDetail, null, 'a resolved item has nothing to explain');
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

test('a refused entry is terminal: the lookup state refused, no retry enqueued, no media rows', async () => {
  // A refusal is a successful identification of a non-media file. Retrying it
  // forever, or surfacing it as a failure, are both wrong.
  const refusal = 'subtitle track, not media';
  const { raw, host, service, setTimeoutCalls } = setup(script([refusedEntry(SUBTITLE, { lookupId: 'lk-srt', refusal })]));
  const ids = given(raw, [SUBTITLE]);
  const itemId = only(ids, 'rss item');

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  host.start();
  await runDue(host, setTimeoutCalls);
  // "a refusal must not enqueue a retry" is what the `only(jobs(raw), ...)`
  // below proves: it throws if a second job exists.

  const item = rssItemState(raw, itemId);
  assert.equal(item.lookupState, 'refused', 'a refusal is not an unresolved item');
  // The service's own words, carried through: a refusal a reader cannot read
  // is indistinguishable from a failure.
  assert.equal(item.lookupStateDetail, refusal);
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

test('an unresolved entry records the lookup state unresolved and does not enqueue a retry', async () => {
  const { raw, host, setTimeoutCalls } = setup(script([unresolvedEntry(GIBBERISH, { lookupId: 'lk-zzz' })]));
  const ids = given(raw, [GIBBERISH]);
  const itemId = only(ids, 'rss item');

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  host.start();
  await runDue(host, setTimeoutCalls);
  // "an unresolved item is retried on request, not on a timer" is what the
  // `only(jobs(raw), ...)` below proves: it throws if a second job exists.

  const item = rssItemState(raw, itemId);
  assert.equal(item.lookupState, 'unresolved', 'a name the service did not recognise is not a refusal');
  assert.ok(item.lookupStateDetail, 'an unresolved item must record why it is unresolved');
  assert.match(item.lookupStateDetail, /did not recognise/);
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
  const { raw, host, service, setTimeoutCalls } = setup(script([first, partialEntry(SLOW, { lookupId: 'lk-slow' }), last]));
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
  host.start();
  await runDue(host, setTimeoutCalls);
  assert.deepEqual(service.batchRequests, [[first.name, SLOW, last.name]]);

  // Half one: the entries either side of the slow one are already finished.
  // One entry with no answer yet must not stall its siblings, and the entry
  // *after* it in the same batch is the one a response-level read loses.
  assert.equal(rssItemState(raw, firstId).lookupState, 'resolved');
  assert.equal(rssItemState(raw, lastId).lookupState, 'resolved');
  assert.equal(mediaItems(raw).length, 2, 'only the two answered entries have media rows');

  // The slow one is none of resolved, refused or unresolved: it has no answer.
  const slow = rssItemState(raw, slowId);
  assert.equal(slow.lookupState, 'pending');
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
  const { raw, host, clock, service, setTimeoutCalls } = setup(script(
    [partialEntry(SLOW, { lookupId: 'lk-slow' })],
    [['lk-slow', [partialEntry(SLOW, { lookupId: 'lk-slow' }), answer]]],
  ));
  const ids = given(raw, [SLOW]);
  const itemId = only(ids, 'rss item');

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  host.start();
  await runToCompletion(host, clock, raw, setTimeoutCalls);

  assert.deepEqual(service.pollRequests, ['lk-slow', 'lk-slow'], 'the first poll was answered "not yet"');

  const item = rssItemState(raw, itemId);
  assert.equal(item.lookupState, 'resolved');
  assert.equal(item.lookupStateDetail, null);
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
  const { raw, host, setTimeoutCalls } = setup(script([original, repack]));
  const ids = given(raw, [MOVIE, REPACK]);
  const firstId = ids.at(0);
  const secondId = ids.at(1);
  assert.ok(firstId);
  assert.ok(secondId);

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  host.start();
  await runDue(host, setTimeoutCalls);

  // One lookup job, and it finished -- the effect `runOnce() === false`
  // used to stand for: nothing else was left to claim after it.
  const job = only(jobs(raw), 'job');
  assert.equal(job.state, 'done');

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
  assert.equal(rssItemState(raw, firstId).lookupState, 'resolved');
  assert.equal(rssItemState(raw, secondId).lookupState, 'resolved');
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
    const { raw, host, setTimeoutCalls } = setup(script([grid]), { artworkDir, imagesFetch: images.fetch });
    const ids = given(raw, [MOVIE]);

    const outcome = await host.notifyNewRssItems(ids);
    assert.deepEqual(outcome.failures, []);
    host.start();
    await runDue(host, setTimeoutCalls); // the lookup job, which schedules the artwork job
    await runDue(host, setTimeoutCalls); // the artwork job it scheduled

    // The effect `runOnce() === false` used to stand for: nothing else was
    // left queued after the two jobs above.
    const finishedJobs = jobs(raw);
    assert.equal(finishedJobs.length, 2, 'only the lookup and the artwork job were ever created');
    assert.ok(finishedJobs.every((job) => job.state === 'done'), 'nothing must be left ready or running');

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
    const { raw, host, clock, setTimeoutCalls } = setup(script([grid]), { artworkDir, imagesFetch: images.fetch });
    const ids = given(raw, [MOVIE]);
    const itemId = only(ids, 'rss item');

    const outcome = await host.notifyNewRssItems(ids);
    assert.deepEqual(outcome.failures, []);
    host.start();
    await runToCompletion(host, clock, raw, setTimeoutCalls);

    // The lookup's own work is untouched: a media item, claimed and resolved.
    const media = only(mediaItems(raw), 'media item');
    assert.equal(media.title, 'The Grid');
    const item = rssItemState(raw, itemId);
    assert.equal(item.mediaItemId, media.id);
    assert.equal(item.lookupState, 'resolved', 'the lookup outcome must not be undone by the artwork job failing');

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
    const { raw, host, setTimeoutCalls } = setup(script([grid]), { artworkDir, imagesFetch: gated.fetch });
    const ids = given(raw, [MOVIE]);

    const outcome = await host.notifyNewRssItems(ids);
    assert.deepEqual(outcome.failures, []);
    host.start();
    await runDue(host, setTimeoutCalls); // the lookup job, which schedules the artwork job

    // Fired, not awaited via `idle()`: both hosts' requests should already be
    // in flight by the time this settles, and neither request in this test
    // ever resolves on its own -- a serialised implementation would leave the
    // second one never made at all. `host.idle()` is awaited further down,
    // only once both requests have been released.
    fireLatest(setTimeoutCalls);
    await flush();

    assert.equal(gated.inFlight(POSTER_URL), 1, 'the poster request must already be in flight');
    assert.equal(
      gated.inFlight(BACKGROUND_URL),
      1,
      'the background request must already be in flight -- proving it did not wait for the poster host',
    );

    gated.release(POSTER_URL);
    gated.release(BACKGROUND_URL);
    await host.idle();
    assert.equal(only(jobs(raw).filter((job) => job.kind === 'artwork'), 'artwork job').state, 'done', 'the artwork job must complete once both requests are released');

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
    const { raw, host, setTimeoutCalls } = setup(script([grid]), { artworkDir, imagesFetch: images.fetch });
    const ids = given(raw, [MOVIE]);

    const outcome = await host.notifyNewRssItems(ids);
    assert.deepEqual(outcome.failures, []);
    host.start();
    await runDue(host, setTimeoutCalls); // the lookup job, which schedules the artwork job
    // The artwork job itself still "runs" -- the effect below is state, not
    // whether it was merely claimed -- but it fails overall, because the
    // logo could not be measured.
    await runDue(host, setTimeoutCalls);
    const artworkJob = only(jobs(raw).filter((job) => job.kind === 'artwork'), 'artwork job');
    assert.equal(artworkJob.state, 'ready', 'the failed attempt must retry rather than dead-letter on its first try');
    assert.equal(artworkJob.attempts, 1, 'the attempt was charged even though the handler failed overall');

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
    const { raw, host, setTimeoutCalls } = setup(script([grid]), { artworkDir, imagesFetch: images.fetch });
    const ids = given(raw, [MOVIE]);

    await host.notifyNewRssItems(ids);
    host.start();
    await runDue(host, setTimeoutCalls); // the lookup job, which schedules the artwork job
    await runDue(host, setTimeoutCalls); // the artwork job

    const beforeRerun = {
      poster: artworkRows(raw, 'poster'),
      background: artworkRows(raw, 'background'),
      logo: artworkRows(raw, 'logo'),
    };
    const filesBeforeRerun = await readdir(artworkDir);
    assert.equal(filesBeforeRerun.length, 3);

    // Back to `ready`, exactly the state the crash sweep leaves a job the process
    // died holding -- see the crash test below -- and run the very same
    // payload through the very same handler a second time.
    const artworkJob = only(jobs(raw).filter((job) => job.kind === 'artwork'), 'artwork job');
    raw.prepare("UPDATE jobs SET state = 'ready' WHERE id = ?").run(artworkJob.id);
    // The row was flipped back to `ready` by a raw write, not through
    // anything that would have called `dispatcher.rearm()` on its own --
    // `host.start()` again is what notices it, the same re-arm-by-restart
    // pattern `host.test.ts`'s own crash-recovery tests use.
    host.start();
    await runDue(host, setTimeoutCalls);
    assert.equal(only(jobs(raw).filter((job) => job.kind === 'artwork'), 'artwork job').state, 'done', 'the re-run must claim the same job');

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

/**
 * The wall-clock columns `withoutClocks` drops. Named once rather than
 * repeated, so a table gaining another timestamp is a one-line change.
 */
const CLOCK_COLUMNS = new Set(['created_at', 'updated_at', 'run_at', 'started_at']);

/**
 * A `snapshot` with every wall-clock column dropped, for the crash test alone.
 *
 * The crash sweep readies its row one backoff step out rather than leaving
 * `run_at` where it was, so the crashed run resumes a second behind the clean
 * one and every timestamp written after that point is shifted by exactly that
 * step. Which values shifted is not recoverable from the values themselves --
 * a pre-crash `updated_at` of 1000 and a post-crash one of 1000 are the same
 * number -- so the comparison drops them and the shift is asserted directly
 * instead, in the two places it is legible: the readied row's own `run_at`,
 * and the finished job's offset from the clean run's. What must still match
 * row for row, ids included, is everything the flow *wrote*.
 *
 * Used nowhere else: every other caller of `snapshot` compares two runs of one
 * host on one clock, where the timestamps are load-bearing and identical.
 */
function withoutClocks(snap: Record<string, Row[]>): Record<string, Row[]> {
  return Object.fromEntries(Object.entries(snap).map(([table, rows]) => [
    table,
    rows.map((row) => Object.fromEntries(
      Object.entries(row).filter(([column]) => !CLOCK_COLUMNS.has(column)),
    )),
  ]));
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
  const { raw, host, setTimeoutCalls } = setup(script([grid]));
  const ids = given(raw, [MOVIE]);

  const outcome = await host.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);
  host.start();
  await runDue(host, setTimeoutCalls);
  assert.equal(only(jobs(raw), 'job').state, 'done', 'the first run must finish, not hang');

  const afterFirstRun = snapshot(raw);
  // A resolved entry writes to all five tables; a snapshot of five empty
  // tables would be equal to itself whatever the second run did.
  assert.equal(mediaItems(raw).length, 1);
  assert.equal(roles(raw).length, 2);

  // Back to `ready`, which is exactly the state the crash sweep leaves a job
  // the process died holding, and run the same payload through the same handler.
  const job = only(jobs(raw), 'job');
  raw.prepare("UPDATE jobs SET state = 'ready' WHERE id = ?").run(job.id);
  // The row was flipped back to `ready` by a raw write, not through anything
  // that would have called `dispatcher.rearm()` on its own -- `host.start()`
  // again is what notices it.
  host.start();
  await runDue(host, setTimeoutCalls);
  assert.equal(only(jobs(raw), 'job').state, 'done', 'the re-run must claim the same job');

  // `snapshot` leaves `jobs.attempts` out, which is the one column a second
  // run legitimately moves. Everything the handler wrote must be untouched:
  // not one extra media item, person, role or double_media row, and no
  // rewritten lookup state.
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
  clean.host.start();
  await runToCompletion(clean.host, clean.clock, clean.raw, clean.setTimeoutCalls);

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
  const dyingTimers = createFakeTimers();
  const dying = createHost({
    raw,
    db,
    fetch: createHostFetch({ fetch: hangOnFirstRequest(service.fetch) }),
    downloads: () => unusedDownloads,
    secrets: unusedSecrets,
    artworkDir: unusedArtworkDir,
    now: () => clock.now(),
    timers: dyingTimers.timers,
  });
  dying.register(plugin);
  const ids = given(raw, CRASH_FILENAMES);
  assert.deepEqual(ids, cleanIds, 'both runs must be looking at the same row ids');
  const outcome = await dying.notifyNewRssItems(ids);
  assert.deepEqual(outcome.unowned, []);
  assert.deepEqual(outcome.failures, []);

  // Claims the lookup and starts the handler, which hangs on the batch request
  // and never returns. `idle()` is deliberately never awaited here: this is
  // the process going away mid-handler, not a rejection the dispatcher could
  // catch, so nothing waits for the hung handler to settle.
  dying.start();
  fireLatest(dyingTimers.setTimeoutCalls);
  await flush();

  const claimed = only(jobs(raw), 'job');
  assert.equal(claimed.state, 'running');
  // One attempt consumed, by the claim, before the handler ran. Deliberately
  // below `DEFAULT_MAX_ATTEMPTS`: a job crashing on its last permitted attempt
  // is dead-lettered by the sweep instead, which would prove the opposite of
  // what this test is about.
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.attempts < DEFAULT_MAX_ATTEMPTS);

  // The restart: a new host over the same database, with its own fetch queue.
  const restartedTimers = createFakeTimers();
  const restarted = createHost({
    raw,
    db,
    fetch: createHostFetch({ fetch: service.fetch }),
    downloads: () => unusedDownloads,
    secrets: unusedSecrets,
    artworkDir: unusedArtworkDir,
    now: () => clock.now(),
    timers: restartedTimers.timers,
  });
  restarted.register(plugin);
  // Re-applying the plugin's migrations on restart runs none of them.
  assert.equal(migratePlugin(raw, DOUBLE_ID, plugin.migrations), 0, 'a restart must not re-run a migration');

  // A row left `running` belongs to nobody until the next `start()`'s crash
  // sweep hands it back, and that sweep is now the only recovery path there
  // is -- so this is the branch's one end-to-end run of
  // `crash -> start() sweep -> completion` through a real `Host` over a real
  // plugin. Both integration crash tests previously routed around it, through
  // a standalone `recover()` that production never called, which left the
  // composed path measured only by dispatcher unit tests.
  const stillRunning = only(jobs(raw), 'job');
  assert.equal(stillRunning.state, 'running', 'merely constructing a fresh host must not claim a row left running');
  assert.equal(restarted.start(), 1, 'the sweep is what hands a crashed row back');
  // `run-job.ts`'s claim is what stamps `started_at`, and `dying.start()`
  // above is what made this row's claim reach it -- the sweep must clear it
  // on the row it readies, or a `ready` row would misreport itself as
  // already started.
  const recovered = only(rowsOf(raw, 'SELECT started_at, run_at, state FROM jobs'), 'job');
  assert.equal(readIntegerOrNull(recovered, 'started_at'), null, 'a recovered ready row must not still claim to be running');
  assert.equal(String(recovered.state), 'ready');
  // The sweep backs the readied row off rather than leaving `run_at` where it
  // was, so a job kind that kills the process backs off across restarts
  // instead of re-crashing the instant the host comes back up. One attempt was
  // consumed, so this is `backoffMs(1)` past the sweep's own `now` -- still
  // `START`, since nothing has moved the clock since the crash.
  assert.equal(readIntegerOrNull(recovered, 'run_at'), START + 1000, 'the sweep readied it one backoff step out');
  // `runToCompletion` jumps the clock to meet whatever is next due, which is
  // what carries the readied row past its own backoff.
  await runToCompletion(restarted, clock, raw, restartedTimers.setTimeoutCalls);

  assert.deepEqual(withoutClocks(snapshot(raw)), withoutClocks(snapshot(clean.raw)));

  // The legitimate differences, asserted rather than ignored. First, the
  // crashed attempt was consumed, which is why the sweep must not reset the
  // count.
  assert.equal(lookupAttempts(raw), 2);
  assert.equal(lookupAttempts(clean.raw), 1);

  // Second, the whole crashed run finished exactly one backoff step behind
  // the clean one -- no more, which is what says the sweep's backoff is the
  // only clock difference the crash introduced.
  const crashedLookup = only(rowsOf(raw, "SELECT updated_at FROM jobs WHERE kind = 'lookup'"), 'lookup job');
  const cleanLookup = only(rowsOf(clean.raw, "SELECT updated_at FROM jobs WHERE kind = 'lookup'"), 'lookup job');
  assert.equal(
    readInteger(crashedLookup, 'updated_at') - readInteger(cleanLookup, 'updated_at'),
    1000,
    'the crash cost exactly backoffMs(1), and nothing else drifted',
  );
});
