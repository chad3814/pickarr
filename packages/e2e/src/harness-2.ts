/**
 * The 2.0 browser harness: a real Chromium driving the real built SPA
 * against a real in-process host, over a real socket.
 *
 * **Boots `createReadServer` directly, not `main`.** `main` is the shipped
 * process entry point -- it opens the database, migrates it, registers the
 * three real plugins, arms the job dispatcher, and only then builds the read
 * server -- and it returns nothing a test could close: no handle to the
 * server, none to the dispatcher's timers, and it installs a `SIGINT`/`SIGTERM`
 * listener per call that nothing ever removes. Calling it once per spec would
 * leak a listener and a live dispatcher per test and could keep the whole
 * `npm run e2e` process from exiting. `createReadServer` is exported from
 * `@pickarr/host` for exactly this: this harness assembles the same
 * `ReadServerDeps` `main` does, by hand, and gets back a `close()` it can
 * actually call.
 *
 * **`media_item` needs no plugin registered in the sync registry, and a TV
 * headline does.** `media_item` -- the one table the shell's three counts read
 * (`useCounts.ts`'s `CATEGORIES`) -- is a *host* synced table
 * (`HOST_SYNCED_TABLES`), synced with no plugin involved at all.
 * `seedMediaItem` below inserts into it directly, the same seam
 * `packages/host/test/api/sync-route.test.ts`'s own `seedMediaItem` uses, so
 * a spec can grow the replica's source of truth with no feed, no lookup
 * service and no job to produce one. (`stubPlugin`, below, is *also*
 * registered on the `Host` this file builds for `addFeed`, a different map
 * from the sync registry's -- see that paragraph.)
 *
 * What `media_item` alone is not enough for is the line a collapsed TV card
 * reads. `plugin-tv`'s browser card builds `<series> SxxEyy <title>` out of
 * this item's `tv_release` row (`packages/plugin-tv/src/browser.tsx`, design
 * spec §4, acceptance 1), and while every `stubPlugin` declared
 * `migrations: []` and `synced: []` there was no such table in this
 * harness's database and nothing replicating it to the browser -- so every
 * TV card here fell back to `item.title` and rendered text byte-identical to
 * the shared card the plugin cards replaced. That is why acceptance 1 went
 * six tasks with a green suite and no browser evidence at all.
 * {@link PLUGIN_SCHEMA} therefore gives the `tv` stub `@pickarr/plugin-tv`'s
 * own `TV_MIGRATIONS` and `TV_SYNCED`, and {@link Harness.seedTvRelease}
 * writes a row into them.
 *
 * **Importing `@pickarr/plugin-tv`'s package root here is deliberate.** The
 * rule that a plugin may only be reached through its `/browser` subpath
 * binds `packages/web/src`, whose bundle cannot carry `node:sqlite` and
 * whose own test enforces it (`packages/web/test/plugins/registry.test.ts`).
 * This file runs in Node beside the host, and `@pickarr/host` imports the
 * same root.
 *
 * **`createSyncRegistry` is built after every `register`, never before.**
 * `assertSyncable` (`sync/registry.ts`) reads `PRAGMA table_info` for each
 * declared table, and a plugin's tables do not exist until `register` has
 * run `migratePlugin` for it. `main.ts` states that order as load-bearing;
 * this file was free to ignore it only while its plugins declared nothing.
 *
 * **The `Host` this file builds for `addFeed` is deliberately never
 * started.** `createHost` gets real `fetch`/`downloads`/`secrets` wiring and
 * three registered `stubPlugin`s, so `Host.addFeed`'s own `isRegistered`
 * check accepts the same three categories `AddFeed.tsx`'s form offers --
 * but `host.start()` is never called anywhere in this file. `Host.addFeed`
 * still calls `schedulePoll`, which still enqueues a `poll` job row, but
 * `schedulePoll`'s own `if (started) dispatcher.rearm()` guard (`host.ts`)
 * means an unstarted host's enqueue arms no timer, so that job never runs.
 * The write path this harness exists to test does not need it to:
 * `rss_feed` reaching a client's replica goes through that table's own
 * `AFTER INSERT` trigger into `sync_log` (`sync/log.ts`'s
 * `installSyncTriggers`), committed synchronously with the insert itself,
 * and `/api/sync`'s tail is what a client polls from there -- neither step
 * depends on anything having polled the feed's own url. **A spec that needs
 * that poll to actually dispatch -- fetching a feed, inserting `rss_item`
 * rows, notifying a plugin -- will hang to Playwright's own timeout here,
 * not fail with a message naming the gap:** nothing in this harness ever
 * runs that job, and nothing at the call site says so.
 *
 * **A pick is the one write path here that needs no job, so the unstarted
 * dispatcher costs it nothing.** `addFeed` and `addDownloadClient` each
 * schedule follow-up work (a poll, a reconcile) that never dispatches.
 * `requestDownload` schedules none: it calls the owning plugin's
 * `onDownloadRequest` inline, that calls `ctx.downloads.submit`, and
 * `createDownloadClients` resolves the client, inserts the `submitting`
 * row, calls the adapter and updates the row to `submitted` -- all before
 * `POST /api/picks` answers. What the unstarted dispatcher *does* cost a
 * pick is everything after the submission: the `reconcile` job that would
 * later carry the row from `submitted` through `downloading` to
 * `completed` never runs, so a download row created here stays at whatever
 * status `submit` left it at, forever.
 *
 * **The claim token is read from the database, not from a boot log.** The
 * task brief for this harness said to capture it off `main`'s stdout; that
 * premise does not hold here, on two independent grounds. First, this
 * harness boots `createReadServer` directly and never calls `main`, so there
 * is no boot log to scrape in the first place. Second, even where `main` does
 * run, `ensureClaimToken(raw, at)` -- exported from `@pickarr/host` for this
 * reason -- generates the token on first call and re-offers the same one on
 * every call after, until `spendClaimToken` spends it (its own docblock,
 * `auth/claim.ts`); the boot log's line is one more caller of that same
 * function, not a second source of truth. Reading it directly is also the
 * only choice that does not couple this suite to the wording of a log line.
 *
 * **Bound to `127.0.0.1`, not the wildcard `0.0.0.0` `main` binds by
 * default.** A browser has to *connect* to whatever address this reports,
 * and a listener told to bind every interface is not guaranteed to answer a
 * loopback connection identically on every platform this suite might run on
 * -- `127.0.0.1` is unambiguous.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test as base } from '@playwright/test';
import type { MediaPlugin, Migration, PluginContext, SyncedTable } from '@pickarr/contract';
import {
  createAuth,
  createDownloadClients,
  randomIndex,
  createHost,
  createHostFetch,
  createReadServer,
  createSyncRegistry,
  ensureClaimToken,
  ensureSyncGeneration,
  migrateHost,
  openDatabase,
  type Host,
  type ReadServer,
} from '@pickarr/host';
import { TV_MIGRATIONS, TV_SYNCED } from '@pickarr/plugin-tv';
import { webDist } from './paths.ts';

/**
 * Obviously synthetic, and not a real secret -- see
 * `packages/host/test/api/server.test.ts`'s own doc on constants shaped like
 * this one. Fixed rather than random: nothing here needs a secret that
 * differs per test, since every test gets its own database and therefore its
 * own cookie jar under it regardless.
 */
const AUTH_SECRET = 'placeholder-not-a-real-signing-secret-for-e2e-tests';

/** A `log` that drops every line. Nothing in this suite asserts on the host's own log. */
const dropLine = (): void => {};

/** `Host`'s and `createDownloadClients`'s own clock. Module scope, like `dropLine` above: it captures nothing from `boot()`, so nothing here needs rebuilding per test. */
const now = (): number => Date.now();

/** The three categories the shell has tabs for (`shell/useCounts.ts`'s `CATEGORIES`). */
export type Category = 'tv' | 'movie' | 'xxx';

/**
 * The schema each stub plugin declares as its own: television's real one,
 * and nothing for the other two.
 *
 * **Asymmetric on purpose, and the asymmetry is the point.** `tv` is the
 * only category any spec here reads a plugin-owned row back through, so it
 * is the only one that needs a table to read -- and giving the other two
 * their real schemas would replicate `movie_detail`, `xxx_scene` and
 * `xxx_site` to every browser in the suite for nothing. If a spec ever
 * needs a movie or scene row, the entry to change is here and the import is
 * the same shape.
 *
 * `TV_MIGRATIONS`' one migration is version 2, not 1 -- version 1 is the
 * lookup engine's own state table, which `createLookupPlugin` prepends and
 * this harness has no engine to prepend it (`plugin-tv/src/migrations.ts`'s
 * own doc). `migratePlugin` applies every version it holds no
 * `plugin_migrations` row for, in sorted order, and asks for no contiguity
 * at all, so a list starting at 2 applies cleanly; what it does enforce is
 * the `<pluginId>_` prefix on every table `up()` creates, which all three
 * of television's carry.
 */
const PLUGIN_SCHEMA: Record<Category, {
  migrations: readonly Migration[];
  synced: readonly SyncedTable<unknown>[];
}> = {
  tv: { migrations: TV_MIGRATIONS, synced: TV_SYNCED },
  movie: { migrations: [], synced: [] },
  xxx: { migrations: [], synced: [] },
};

/**
 * A `MediaPlugin` that does the least possible beyond its own schema
 * ({@link PLUGIN_SCHEMA}): no job handlers, and a no-op for two of the three
 * callbacks `Host` ever invokes. Registered once per category (below) so
 * `feeds/add.ts`'s own `isRegistered` check -- reached through
 * `Host.addFeed`, the real validator this harness now wires to
 * `POST /api/feeds` -- accepts the same three plugin ids `AddFeed.tsx`'s
 * form offers (`CATEGORIES`, `shell/useCounts.ts`), the same way a real
 * `createTvPlugin` et al. would. A stub is enough for those two: no spec in
 * this file ever polls a feed to completion, so nothing here needs
 * `onNewRssItems` to do anything but resolve -- the plugin-owned rows a
 * spec *does* read come from {@link Harness.seedTvRelease}'s direct
 * inserts, not from a notification. This is the same "no plugin is needed
 * beyond what `isRegistered` checks" the module doc's `media_item`
 * paragraph already argues, applied to `addFeed`'s own gate instead.
 *
 * **`onDownloadRequest` is the exception, and it submits for real.** It was
 * empty until the picks slice, which is why `createReadServer`'s
 * `requestPick` wiring below used to carry a comment saying a pick here
 * "writes no download row". It writes one now: `ctx.downloads.submit` is
 * the host's real `createDownloadClients` (built in `boot`), so a pick
 * runs the same resolution, the same insert and the same adapter call
 * `main`'s plugins do. That is the whole reason the `see the status
 * appear` spec can exist -- a plugin that resolved without submitting
 * would leave the browser with nothing to replicate, and a spec written
 * against it could only ever prove that `POST /api/picks` answered.
 *
 * The real plugins' `onDownloadRequest` is this same call and one `ctx.log`
 * beside it (`packages/openmetadata/src/engine.ts`, the base all three of
 * `plugin-tv`, `plugin-movie` and `plugin-xxx` are built from), so this
 * stub is not a simplification of the submission path -- it is that path,
 * minus a log line this harness drops anyway (`dropLine`).
 */
function stubPlugin(id: Category): MediaPlugin {
  return {
    id,
    mediaType: id,
    migrations: PLUGIN_SCHEMA[id].migrations,
    jobs: {},
    synced: PLUGIN_SCHEMA[id].synced,
    // No library path shape is configured in an end-to-end run, so there is
    // nothing here for a token to appear in.
    tokens: {},
    async onNewRssItems() {},
    async onDownloadedFile() {},
    async onDownloadRequest(rssItemId: number, ctx: PluginContext) {
      await ctx.downloads.submit({ rssItemId });
    },
  };
}

/**
 * Obviously synthetic, and not a real credential -- the same shape and the
 * same reasoning as `AUTH_SECRET` above.
 *
 * **Unlike `tests/shell.spec.ts`'s own `API_KEY`, this one is never typed
 * into a form**, so it never reaches a Playwright action log or a DOM
 * snapshot: `seedPickableRelease` below hands it to `Host.addDownloadClient`
 * in process. It crosses no wire the browser can see and is written to the
 * harness's in-memory `Secrets` and nowhere else.
 */
const QBITTORRENT_API_KEY = 'placeholder-not-a-real-qbittorrent-api-key';

/**
 * A magnet whose infohash is 40 hex characters, which is what
 * `qbittorrent.ts`'s `MAGNET_BTIH_PATTERN` requires before `submit` will
 * answer a reference without a second `/torrents/info` round trip.
 *
 * A literal rather than a generated hash: the value ends up in
 * `torrent_download.client_ref`, so a fixed one makes that column the same
 * from run to run and greppable from here. Nothing needs it unique --
 * every test gets its own database, and the unique index over
 * `(download_client_id, client_ref)` therefore has one row to police.
 */
const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

/**
 * A 1x1 PNG, decoded once at module scope: the smallest bytes
 * `api/artwork-route.ts` will answer a poster request with.
 *
 * **The content matters in exactly two ways and no others.** The eight-byte
 * PNG signature is what `readArtwork` sniffs to choose a content type -- it
 * stores none, deliberately (that module's own doc) -- and the bytes have to
 * decode, or Chromium raises `error` on the `<img>` and
 * `library/MediaItemCard.tsx`'s `onError` removes the element from the DOM
 * for good. That latch is why an e2e poster has to be real: a 404 or a
 * corrupt file does not leave a broken image to measure, it leaves no image
 * at all, and `posterFailed` never resets.
 *
 * Its 1x1 dimensions are not the frame the operator sees. `library.css`'s
 * `article img` rule fixes the frame at `--size-poster` by `2 / 3` with
 * `object-fit: cover`, so what this image contributes to layout is nothing --
 * which is the property the poster pin in `tests/shell.spec.ts` measures.
 */
const POSTER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAE/wH+6CVCqwAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * The `provider` every row {@link Harness.seedTvRelease} writes claims, and
 * the prefix of every `provider_ref` it mints.
 *
 * `tv_series` and `tv_season` both carry `provider`/`provider_ref` as `NOT
 * NULL` under a unique index (`plugin-tv/src/migrations.ts`), so a seeded row
 * needs a pair, and no real provider answered for these: naming the harness
 * says so at the row rather than leaving `tmdb` on data no lookup service
 * ever produced.
 */
const SEED_PROVIDER = 'e2e-harness';

/**
 * `tv_release.kind` for a release naming these numbers.
 *
 * **Derived from the numbers rather than taken as an argument, for the same
 * reason `plugin-tv/src/headline.ts` refuses to branch on `kind` at all**:
 * the three kinds differ from each other only in which of the two numbers is
 * present, so a caller free to pass any `kind` could seed a row whose `kind`
 * and numbers disagree -- which is a fixture no lookup service writes
 * (`plugin-tv/src/apply.ts`'s `checkTv`/`applyTv`). The column is `NOT NULL`
 * and `sync.ts`'s `tvKind` throws on any value outside these three, so it
 * cannot be left blank or filled with a placeholder either.
 */
function tvKindFor(seasonNumber: number | null, episodeNumber: number | null): 'series' | 'season' | 'episode' {
  if (episodeNumber !== null) return 'episode';
  if (seasonNumber !== null) return 'season';
  return 'series';
}

/** A listening fake, and the one call that stops it. */
interface FakeClient {
  origin: string;
  close(): Promise<void>;
}

/**
 * The least qBittorrent that `clients/qbittorrent.ts`'s `submit` will
 * accept, on its own ephemeral loopback port.
 *
 * **One route, because a magnet submission makes exactly one request.**
 * `submit` POSTs to `/api/v2/torrents/add`, treats every body that is not
 * `Fails.` as success (`isAddRefusalBody`'s own doc on why it fails *open*),
 * and then -- because `infohashFromMagnet` already answered -- returns that
 * infohash without calling `/torrents/info` at all. `Ok.` is what a real
 * server sends, so nothing here depends on the fail-open branch.
 *
 * It answers 404 to everything else on purpose rather than 200: a change
 * that made this suite's submission take the `.torrent` path, or reach for
 * a snapshot, would then fail loudly with a `FetchFailedError` instead of
 * quietly succeeding against a fake that agrees with anything.
 *
 * **It checks no credential.** `readClientConfig` resolving the api key out
 * of the harness's `Secrets`, and the adapter attaching it, are covered by
 * `packages/host/test/clients/config.test.ts` and `qbittorrent.test.ts`;
 * asserting the header here would only put the credential in a second
 * place. What this fake exists for is to be reachable, so the row reaches
 * `submitted` rather than `failed`.
 */
async function startFakeQbittorrent(): Promise<FakeClient> {
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/api/v2/torrents/add') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('Ok.');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not a route this fake serves');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  // `Server.address()` is `string | AddressInfo | null` -- a pipe, a socket,
  // or nothing bound. Narrowed rather than asserted: this one listened on a
  // TCP port a line ago, so the other two are unreachable, and a check says
  // that without claiming it.
  if (address === null || typeof address === 'string') {
    throw new Error('the fake download client bound no TCP port');
  }
  const { port } = address;

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve, reject) => {
      // `Server.close()` stops new connections and then *waits* for the
      // sockets it already has, and Node's own fetch keeps a connection
      // alive after the response. This makes teardown depend on nothing but
      // itself.
      //
      // **Not a fix for an observed hang, and it would be easy to write
      // that here.** Measured by deleting this line and running the picking
      // spec: it passed in 9.65s against 9.2s with the line in, so nothing
      // in this suite is currently waiting on an idle socket. What the line
      // buys is that a future spec which picks twice, or picks and then
      // does something slower, cannot start paying for one.
      server.closeAllConnections();
      server.close((err) => { if (err) reject(err); else resolve(); });
    }),
  };
}

/** What one pick needs on the server before a browser can make it. */
export interface PickableRelease {
  /** The `media_item` the card renders, and whose title expands it. */
  mediaItemId: number;
  /** The `rss_item` the release row renders, and the id a pick names. */
  rssItemId: number;
}

export interface Harness {
  /** The origin the in-process host bound. Every navigation in a spec starts here. */
  origin: string;
  /**
   * This install's claim token -- see this module's doc for why it is read
   * this way rather than from a log.
   */
  claimToken: string;
  /**
   * Inserts one `media_item` row directly and returns its id. `pluginId` is
   * one of the shell's three real categories, not the host suite's synthetic
   * `'alpha'`: `useCounts.ts` only ever calls `countByPlugin('media_item',
   * category)` for `category` in `CATEGORIES` (`'tv' | 'movie' | 'xxx'`), so
   * a row under any other `pluginId` value matches none of the three
   * `by_table_plugin_updated` key ranges those calls count over, and would
   * be counted by none of the three tabs.
   */
  seedMediaItem(pluginId: Category, title: string): number;
  /**
   * One television media item and the `tv_release` row that gives its
   * collapsed card a headline -- the series, the season and episode numbers,
   * and, optionally, a poster the `<img>` will actually load. Returns the
   * `media_item` id.
   *
   * **Every insert happens in one synchronous call**: nothing here `await`s,
   * so the host's own `/api/sync` handler cannot run between two of these
   * inserts and a browser sees all of them or none.
   *
   * **The poster is what makes that mandatory.** One 404 latches
   * `MediaItemCard`'s `posterFailed` and the `<img>` is gone for the life of
   * the card, so the `poster` row has to reach the replica in the same batch
   * as the `media_item` it belongs to or there is nothing left to measure.
   *
   * **The `tv_release` half used to be mandatory too, and is not any more.**
   * A card whose `media_item` arrived in an earlier batch than its
   * `tv_release` used to render `item.title` and never correct itself, since
   * nothing woke `library/usePluginRows.ts`. That was a real client defect,
   * found while writing this method and fixed in this task's fix round 1:
   * the hook now subscribes to inserts on each declared table, so a late
   * `tv_release` reaches the card with no remount
   * (`packages/web/test/library/Category.test.tsx`'s `a plugin row that
   * replicates in a later batch than its media item still reaches the
   * card`). The seed stays atomic anyway, because what the browser spec
   * asserts is the headline on a row **nobody has expanded and nothing has
   * woken** -- which is acceptance 1 -- and a two-call seed would quietly
   * turn it into an assertion about the recovery path instead.
   *
   * Callers therefore get one method rather than a composable
   * `seedPoster(mediaItemId)` beside a `seedTvRelease(mediaItemId)`. Two
   * calls would still be safe back to back -- both would be synchronous --
   * but nothing at either call site would say that an `await` between them
   * is what breaks the spec.
   *
   * **`withPoster` is required rather than defaulted**, the same reason
   * `seedPickableRelease`'s `withDownloadClient` is: a spec that omitted it
   * would get one behaviour or the other with nothing at the call site
   * saying which. `false` leaves the item with no `poster` row, which is the
   * 404 every other spec in this suite renders a card under.
   *
   * `seasonNumber` and `episodeNumber` are `number | null` rather than
   * optional because both are genuinely nullable in `tv_release` and a
   * series pack names neither (`plugin-tv/src/apply.ts`); {@link tvKindFor}
   * turns whichever are present into the row's `kind`.
   */
  seedTvRelease(input: {
    title: string;
    seriesTitle: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    withPoster: boolean;
  }): number;
  /**
   * Everything a pick needs that a browser cannot create for itself: a
   * torrent download client pointed at this test's fake qBittorrent, a
   * torrent feed, a `media_item` to expand, and one `rss_item` under it
   * with no download of its own -- which is what gives that release a
   * `Pick` button (`ReleaseList.tsx`, picks design §2).
   *
   * **The client and the feed go through `Host`'s own writers, the rss item
   * does not.** `addDownloadClient` is the only thing that knows the
   * credential-name scheme `readClientConfig` reads back, so writing that
   * row by hand would be a second copy of it that could drift; `addFeed`
   * is already wired into this harness for `POST /api/feeds`. There is no
   * equivalent writer for an `rss_item` -- they arrive from a feed poll,
   * and this harness never dispatches one (see the module doc) -- so that
   * one is a direct insert, the same seam `seedMediaItem` uses.
   *
   * **The feed names no download client**, which is deliberately the case
   * picks design §5 says fails today: a UI-created feed always has
   * `download_client_id` NULL, and the pick only succeeds because
   * `selectClientForFeed` finds the one client of the feed's type. With
   * exactly one client there is no draw to make, so nothing here depends
   * on `randomIndex`.
   */
  seedPickableRelease(input: {
    pluginId: Category;
    title: string;
    filename: string;
    resolution: string;
    /**
     * Whether to create the torrent client the pick needs. Required rather
     * than defaulted, for the reason every other required dependency in
     * this file is: a spec that omitted it would get one behaviour or the
     * other with nothing at the call site saying which.
     *
     * `false` leaves the install with no client of the feed's type at all,
     * so `selectClientForFeed` raises `NoClientOfTypeError` and the pick
     * comes back as the `no-client-of-type` refusal -- the one refusal a
     * browser can be driven to without a second feed, a second client or a
     * second pick.
     */
    withDownloadClient: boolean;
  }): Promise<PickableRelease>;
}

interface Booted {
  raw: DatabaseSync;
  dir: string;
  server: ReadServer;
  host: Host;
  qbittorrent: FakeClient;
  /** The file {@link Harness.seedTvRelease}'s `withPoster` points a `poster` row at. */
  posterPath: string;
}

/**
 * One database, one listener, per test -- never shared, so one spec's rows
 * and one spec's session can never leak into another's assertions.
 */
async function boot(): Promise<Booted> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-e2e-'));
  const { raw, db } = openDatabase(join(dir, 'pickarr.db'));
  migrateHost(raw);

  // Started for every test, not only the one that picks: one listener on an
  // ephemeral loopback port costs about nothing, and a fixture that boots a
  // different host depending on which spec uses it is two arrangements to
  // keep in step. Nothing reaches it unless a spec calls
  // `seedPickableRelease` and then presses `Pick`.
  const qbittorrent = await startFakeQbittorrent();

  // Written for every test, on the same reasoning as the fake client above:
  // one 70-byte file costs about nothing, and the alternative is an `await`
  // in the middle of a seed. `seedTvRelease` has to insert the `media_item`
  // and the `poster` row that names this file in one synchronous call -- see
  // its own doc for why -- so the bytes cannot be written at the moment the
  // row is, and the only other place to put the write is here.
  const artworkDir = join(dir, 'artwork');
  await mkdir(artworkDir, { recursive: true });
  // `.bin`, matching `artwork/store.ts`'s own naming: the suffix is
  // deliberately not the measured type, because `readArtwork` sniffs the
  // magic bytes on every request and stores no content type at all.
  const posterPath = join(artworkDir, 'seeded-poster.bin');
  await writeFile(posterPath, POSTER_PNG);

  const generation = ensureSyncGeneration(raw, Date.now());

  const hostFetch = createHostFetch({ fetch: globalThis.fetch });

  // An in-memory `Secrets`, not the host's own `createSecrets`: that one is
  // not exported from `@pickarr/host`, and the chain it builds (environment,
  // then the secrets directory, then the `secret` table) has nothing to
  // contribute here -- no spec sets a `PICKARR_SECRET_*` variable or mounts
  // a secrets directory.
  //
  // **`saveSecret` stores rather than discarding, and that is not
  // decoration.** `addDownloadClient` (wired below) hands it the credential
  // out of a POST body and writes only the generated name to the row, so a
  // `saveSecret` that dropped the value would leave every client this
  // harness creates naming a secret nothing can resolve -- a row that reads
  // as configured and fails on first use, which is precisely the failure
  // the name indirection exists to make impossible. Resolving it here keeps
  // the harness's host behaving like `main`'s.
  const storedSecrets = new Map<string, string>();
  const secrets = {
    async get(name: string): Promise<string> {
      const value = storedSecrets.get(name);
      if (value === undefined) throw new Error(`no secret configured for ${name}`);
      return value;
    },
    saveSecret(name: string, value: string): void {
      storedSecrets.set(name, value);
    },
  };

  const host = createHost({
    raw,
    db,
    fetch: hostFetch,
    // A factory, not a built object -- `createHost`'s own doc on why:
    // supplying `secrets` (below) is what keeps this the one `Secrets`
    // instance the whole host resolves credentials through.
    downloads: (deps) => createDownloadClients({ raw, fetch: hostFetch, secrets: deps, now, chooseIndex: randomIndex, log: dropLine }),
    secrets,
    now,
    artworkDir,
  });
  // `stubPlugin`'s own doc: enough for `Host.addFeed`'s `isRegistered`
  // check to accept the same three ids `AddFeed.tsx`'s form offers.
  const plugins = (['tv', 'movie', 'xxx'] as const).map((category) => stubPlugin(category));
  for (const plugin of plugins) host.register(plugin);

  // After every `register`, never before -- `main.ts` does these same two in
  // this same order (`:857`, then `:863`), and this module's own doc says why:
  // `createSyncRegistry` runs `assertSyncable` over each declared table,
  // which reads `PRAGMA table_info`, and `tv_release` does not exist until
  // `register` has run `migratePlugin`. The same plugin objects are handed to
  // both, so the registry cannot describe a different set than the host
  // registered.
  const registry = createSyncRegistry(raw, plugins);

  const server = await createReadServer({
    raw,
    pluginIdForType: () => undefined,
    // `Host.addFeed` -- the same method `main.ts` wires to this exact
    // route. See this module's own doc ("The `Host` this file builds for
    // `addFeed` is deliberately never started") for why the poll it
    // schedules never runs, and why that is fine for what this harness
    // tests.
    addFeed: (input) => host.addFeed(input),
    // `Host.addDownloadClient`, wired exactly as `main.ts` wires it. The
    // host this file builds is deliberately never started, so the reconcile
    // this schedules is a row in `jobs` that no dispatcher ever picks up --
    // the same arrangement `addFeed`'s poll is already in, and fine for the
    // same reason: what a spec observes is the row that was created, not
    // the job.
    addDownloadClient: (input) => host.addDownloadClient(input),
    // `Host.requestPick`, wired exactly as `main.ts` wires it. What a spec
    // can observe through it is *wider* than through the two above, which
    // is the opposite of what this comment said while `stubPlugin`'s
    // `onDownloadRequest` was empty. `addFeed` and `addDownloadClient` each
    // finish their visible work in the request and leave the rest to a job
    // no dispatcher here ever runs; a pick has no job at all. The whole of
    // it -- the plugin callback, `selectClientForFeed`, the `submitting`
    // insert, the adapter's request to the fake client, and the update to
    // `submitted` -- happens inside this call, so a spec that watches a
    // download row appear in the browser is watching all of it.
    requestPick: (rssItemId) => host.requestPick(rssItemId),
    // The three mapping writes, wired exactly as `main.ts` wires them.
    // Unlike `addFeed` and `addDownloadClient` these schedule nothing at
    // all, so the "job no dispatcher here ever runs" caveat above does not
    // apply to them: the whole of what a spec can observe -- the row, and
    // what `mapClientPath` resolves next -- is done inside the request.
    addMapping: (input) => host.addMapping(input),
    editMapping: (id, input) => host.editMapping(id, input),
    removeMapping: (id) => host.removeMapping(id),
    saveDestination: (pluginId, input) => host.saveDestination(pluginId, input),
    registry,
    generation,
    host: '127.0.0.1',
    port: 0,
    webRoot: webDist,
    // A function of the bound origin, exactly as `main` builds it -- see
    // `ReadServerDeps.authFor`'s own doc for why `baseURL` cannot be known
    // until the listener has bound.
    authFor: (baseURL) => createAuth({
      raw,
      db,
      // Empty, matching a host with no proxy and no alternate name: the
      // suite drives the bound loopback origin, which `isPlaceableOrigin`
      // trusts on sight without any of these being set.
      trustedOrigins: [],
      trustedProxies: [],
      ipAddressHeaders: undefined,
      secret: AUTH_SECRET,
      baseURL,
      publicUrl: undefined,
      log: dropLine,
    }),
    log: dropLine,
  });

  return { raw, dir, server, host, qbittorrent, posterPath };
}

/**
 * Playwright's own `test`, extended with one fixture: a fresh host, a fresh
 * temp database, and this install's claim token, torn down after the test
 * whether it passed or failed.
 *
 * **Depends on `context`, not just on being handed `page` inside a test
 * body.** Without that dependency, this fixture's own teardown and
 * Playwright's built-in `page`/`context` teardown race each other with no
 * defined order -- measured directly (a task 8 fix-round review), by
 * instrumenting both: this fixture's `finally` ran, then the tab actually
 * closed **38ms later**. In that window a still-open tab's own sync loop can
 * fire one more request into a server whose database this fixture has
 * already closed underneath it. The request fails with `ERR_INVALID_STATE`,
 * and Better Auth's own internal logger -- which bypasses the `log: dropLine`
 * this file injects, the same way `packages/host/src/auth/instance.ts`'s
 * `AuthDeps.log` doc already documents it bypassing other message kinds --
 * prints the failing query and **its bound parameters, including a live
 * session token**, straight to the console. That is a Global Constraint
 * violation ("no credential in any message or log"), reproducible, in code
 * this task wrote.
 *
 * The fix is to make this fixture responsible for quiescing the browser side
 * itself, rather than leaving it to whichever of two independent teardowns
 * happens to run first: depending on `context` guarantees `context` outlives
 * this fixture (a dependency always tears down after its dependent), so this
 * fixture's own `finally` can call `context.close()` -- which closes every
 * page open in it, not just the fixture's own `page`, so it also covers a
 * spec that opened a second tab by hand (`context.newPage()`, the "two tabs"
 * spec) -- and know nothing in the browser can issue a further request once
 * that resolves. Playwright's own later `page`/`context` teardown then finds
 * both already closed, which is harmless (`close()` is idempotent).
 *
 * This narrows the window to nothing observable rather than closing a
 * theoretical one: a request already dispatched into the server's socket
 * before `context.close()` was called could in principle still be mid-flight
 * when `raw.close()` runs a line later. Nothing in this suite has reproduced
 * that after this fix across many runs (see the task report for the count),
 * and `context.close()` first is what removes the dominant, actually-observed
 * trigger -- a tab's own live timer firing a *new* request during teardown.
 */
export const test = base.extend<{ harness: Harness }>({
  harness: async ({ context }, use) => {
    const { raw, dir, server, host, qbittorrent, posterPath } = await boot();
    try {
      const claimToken = ensureClaimToken(raw, Date.now());
      function seedMediaItem(pluginId: Category, title: string): number {
        const at = Date.now();
        const info = raw.prepare(
          'INSERT INTO media_item (plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?)',
        ).run(pluginId, at, at, title);
        return Number(info.lastInsertRowid);
      }

      // Synchronous from end to end -- see `Harness.seedTvRelease`'s own doc
      // for why nothing in here may `await`.
      function seedTvRelease(
        { title, seriesTitle, seasonNumber, episodeNumber, withPoster }: {
          title: string;
          seriesTitle: string;
          seasonNumber: number | null;
          episodeNumber: number | null;
          withPoster: boolean;
        },
      ): number {
        const at = Date.now();
        const mediaItemId = seedMediaItem('tv', title);
        if (withPoster) {
          // `width`/`height` are the real 1x1 of `POSTER_PNG`, not the frame
          // the card renders: nothing reads these two back (`poster` is not
          // a synced table -- artwork is not replicated, design spec §1.2),
          // and recording the frame's numbers here would be a measurement of
          // the wrong thing written into a `NOT NULL` column.
          //
          // `url` is `.invalid` (RFC 2606) for the same reason
          // `seedPickableRelease`'s feed url is: it is under a unique index
          // with `media_item_id`, so it needs a value, and nothing should be
          // able to resolve it even if some future change did try.
          raw.prepare(
            'INSERT INTO poster (media_item_id, url, width, height, created_at, path) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(mediaItemId, `http://artwork.invalid/${String(mediaItemId)}.png`, 1, 1, at, posterPath);
        }
        const series = raw.prepare(`
          INSERT INTO tv_series (provider, provider_ref, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(SEED_PROVIDER, `series-${String(mediaItemId)}`, seriesTitle, at, at);
        const seriesId = Number(series.lastInsertRowid);
        // A season row only where there is a season number to put in it.
        // `tv_release.season_id` is nullable and `sync.ts` reaches it by a
        // *left* join, so a null here reads back as `seasonNumber: null` --
        // which is exactly what a series pack looks like.
        const seasonId = seasonNumber === null ? null : Number(raw.prepare(`
          INSERT INTO tv_season (series_id, provider, provider_ref, season_number, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(seriesId, SEED_PROVIDER, `season-${String(mediaItemId)}`, seasonNumber, at, at).lastInsertRowid);
        raw.prepare(`
          INSERT INTO tv_release
            (media_item_id, kind, series_id, season_id, episode_number, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          mediaItemId,
          tvKindFor(seasonNumber, episodeNumber),
          seriesId,
          seasonId,
          episodeNumber,
          at,
          at,
        );
        return mediaItemId;
      }

      await use({
        origin: `http://${server.host}:${server.port}`,
        claimToken,
        seedMediaItem,
        seedTvRelease,
        async seedPickableRelease({ pluginId, title, filename, resolution, withDownloadClient }) {
          if (withDownloadClient) {
            const client = await host.addDownloadClient({
              name: `${pluginId} seedbox`,
              implementation: 'qbittorrent',
              url: qbittorrent.origin,
              // Blank, so `clients/add.ts`'s `nullIfBlank` writes `NULL` and
              // the adapter sends no `category` parameter at all -- the case
              // `normalizeCategory` exists for. A category here would be a
              // value this fake would have to agree with for no gain.
              category: '',
              apiKey: QBITTORRENT_API_KEY,
              username: '',
              password: '',
            });
            // Every refusal from either writer is a mistake in this harness,
            // not an outcome a spec is meant to see, so both are turned into
            // a throw naming the code. The alternative -- letting the spec
            // fail later on a missing button -- points at the browser for a
            // fault that happened in Node.
            if ('refusal' in client) {
              throw new Error(`the harness could not create a download client: ${client.refusal}`);
            }
          }

          const feed = await host.addFeed({
            pluginId,
            name: `${pluginId} feed`,
            // `.invalid` is the reserved TLD (RFC 2606), so nothing can
            // resolve it even if some future change did arm the dispatcher
            // -- and `rss_feed` is a synced table, so whatever goes here
            // reaches the browser's replica. A feed url can carry a private
            // tracker's passkey (`feeds/add.ts`'s own note on why the
            // `duplicate-url` refusal names none), which is reason enough
            // for this one to be obviously nobody's.
            url: `http://feeds.invalid/${pluginId}.xml`,
            downloadType: 'torrent',
            // Any value inside `feeds/add.ts`'s `MIN_POLL_INTERVAL_S` ..
            // `MAX_POLL_INTERVAL_S` window will do, since nothing here ever
            // polls: the poll `addFeed` schedules is a `jobs` row an
            // unstarted host never arms (see this module's doc). A value
            // outside the window would be refused, and the throw above
            // would name `bad-poll-interval` rather than leaving it to be
            // debugged from a browser.
            pollIntervalS: 3_600,
          });
          if ('refusal' in feed) {
            throw new Error(`the harness could not create a feed: ${feed.refusal}`);
          }

          const mediaItemId = seedMediaItem(pluginId, title);
          const at = Date.now();
          // `media_item_id` set and no download row: that pair is exactly
          // what puts this release in `ReleaseList` with a `Pick` button
          // rather than a status (`ReleaseList.tsx`, picks design §2).
          const info = raw.prepare(`
            INSERT INTO rss_item
              (feed_id, filename, link, created_at, updated_at, download_type, media_item_id, resolution)
            VALUES (?, ?, ?, ?, ?, 'torrent', ?, ?)
          `).run(feed.id, filename, MAGNET, at, at, mediaItemId, resolution);

          return { mediaItemId, rssItemId: Number(info.lastInsertRowid) };
        },
      });
    } finally {
      // Every page this test has open, closed first -- see this fixture's
      // own doc for why this has to run before the server and the database
      // do, and why `context.close()` rather than `page.close()`.
      await context.close();
      await server.close();
      // After the read server rather than before it: the only thing that
      // ever dials this fake is an adapter call made while serving
      // `POST /api/picks`, so once that server is closed there is nothing
      // left that could reach it. Ordered, not raced.
      await qbittorrent.close();
      raw.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
});
