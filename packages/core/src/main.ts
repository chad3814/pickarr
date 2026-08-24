import { realpathSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin } from '@pickarr/plugin-api';
import { loadConfig, readConfigDocument } from './config/load.ts';
import type { FeedConfig } from './config/schema.ts';
import { openDatabase } from './db/open.ts';
import { loadPlugins, type PluginRegistry } from './plugins/registry.ts';
import { createSabnzbdClient } from './clients/sabnzbd.ts';
import {
  createTpdbClient,
  type PerformerLookupClient,
  type SceneLookupClient,
  type SiteLookupClient,
} from './clients/theporndb.ts';
import type { DownloadClient } from './clients/types.ts';
import { knownSiteNames } from './db/sites.ts';
import { resolveSitesForBatch } from './pipeline/resolve-sites.ts';
import { fetchFeed } from './feeds/fetch-feed.ts';
import { ingestEntries } from './ingest/ingest.ts';
import { reconcileClient } from './pipeline/reconcile.ts';
import { importDownload } from './pipeline/import.ts';
import { recoverInterruptedWork } from './pipeline/recover.ts';
import { runRekeyOnBoot, type RekeyDeps } from './pipeline/rekey.ts';
import { createScheduler } from './pipeline/scheduler.ts';
import { createMetadataRunner } from './pipeline/metadata.ts';
import { createBackfillRunner } from './pipeline/backfill.ts';
import { createPerformerRunner } from './pipeline/performers.ts';
import type { ArtworkDeps } from './media/artwork.ts';
import { buildServer } from './http/server.ts';

const CONFIG_PATH = process.env['PICKARR_CONFIG'] ?? '/config/config.json';

function log(message: string): void {
  console.log(`[pickarr] ${message}`);
}

/**
 * `metadata.artworkDir`'s default when the config omits it: an `artwork/`
 * directory beside the SQLite database. That path already sits inside the
 * `/config` volume in the documented Docker setup, so cached posters survive
 * a container recreation without asking anyone for a new mount. Resolved
 * here rather than in the schema because it needs `database.path`, which
 * `metadataSchema` cannot see in isolation.
 */
export function resolveArtworkDir(databasePath: string, configured: string | undefined): string {
  return configured ?? join(dirname(databasePath), 'artwork');
}

/**
 * Resolves the plugin a metadata queue row's group actually belongs to.
 *
 * `media_groups.plugin` holds `plugin.id` (see commit.ts, which writes
 * `plugin: plugin.id`), never a package name, so this must go through
 * `registry.byId` — never `registry.byPackage`, which throws on a lookup key
 * it does not recognise as a package name. Wiring this to `byPackage` would
 * not fail quietly: it throws on every single row, `lookUpOne`'s catch turns
 * that into a deferral logged as `unexpected failure: ...`, and only once a
 * row has retried and failed `MAX_METADATA_ATTEMPTS` times does it finally
 * get answered `'none'`. The bug is real either way — every group ends up
 * with no plugin — but it announces itself as fifty rounds of retried
 * failures per row instead of as a crash, which is exactly the shape of
 * thing a glance at the logs is likely to miss.
 */
export function pluginById(registry: PluginRegistry): (id: string) => MediaTypePlugin | null {
  return (id) => registry.byId(id) ?? null;
}

/**
 * Composes the scene pass and the performer pass into the single closure the
 * scheduler's `runMetadata` slot expects, awaiting each in turn rather than
 * concurrently: both talk to the same rate-limited service, and running them
 * with `Promise.all` would double the instantaneous request rate `perTick`
 * exists to bound. Pulled out as its own pure function — rather than inlined
 * at the call site — so the one property that actually needs pinning (scenes
 * before performers) can be tested without `main()`'s config, database,
 * fetch and scheduler machinery.
 */
export function composeMetadataTick(
  runScenes: () => Promise<void>,
  runPerformers: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    await runScenes();
    await runPerformers();
  };
}

/**
 * The Task 6 wiring point: runs the re-key pass (or, once it has ever run,
 * its every-boot drift check) and turns whatever `runRekeyOnBoot` did into
 * the one boot-log line an operator reads to learn what happened to their
 * library. Exported, with its own `log` parameter, and kept to exactly this
 * — call `runRekeyOnBoot`, log, never rethrow — rather than folded inline
 * into `main()`, so this exact wiring can be exercised without booting a
 * whole server: see `main.test.ts`'s "startup test" for what breaks when the
 * `try`/`catch` below is removed.
 *
 * The `try`/`catch` is the whole point of this function existing separately
 * from `runRekeyOnBoot`. `migrate`'s own runner rethrows on failure by design
 * (`db/migrate.ts:69-80`) — correct for a schema change a broken database
 * cannot run without. This pass is different: it re-parses already-live user
 * data with the *current* parser, so a parser regression is a real
 * possibility here in a way it structurally is not for a migration, and it
 * must never be able to make the application unbootable. Every failure mode
 * `runRekeyOnBoot` cannot itself convert into a counted, logged outcome —
 * which per its own contract should be none of them, since `applyRekey`
 * already counts a per-group throw as `failed` rather than propagating it —
 * is logged here and swallowed instead.
 */
export async function runRekeyAtBoot(
  db: DatabaseSync,
  registry: PluginRegistry,
  deps: RekeyDeps,
  // Named distinctly from the module-level `log` below (not just `log`,
  // which `oxlint`'s no-shadow rule flags): this parameter is what makes the
  // function testable without a real console, and shadowing the very
  // function it stands in for in tests is exactly the confusion that rule
  // exists to catch.
  emitLog: (message: string) => void,
): Promise<void> {
  try {
    const outcome = await runRekeyOnBoot(db, registry, deps);
    if (outcome.report === null) {
      // The marker was already set: nothing was written this boot, only
      // `countDrift`'s read. `skippedDestinationExists` and friends do not
      // apply here — there is no report — so the only thing worth an
      // operator's attention is whether anything has drifted since the pass
      // last ran.
      emitLog(
        'rekey: marker already set, drift check only' +
          (outcome.drift > 0 ? ` — ${outcome.drift} group(s) no longer agree with a fresh parse` : ''),
      );
    } else {
      const r = outcome.report;
      // Why the pass ran, named before the counts. Since #5 this branch is
      // reachable in two forms, and the operator cannot tell them apart from
      // the numbers: a boot that renames files on an installation years past
      // its first one reads as a bug unless the line says the site list is
      // what changed.
      const why = outcome.reason === 'sites-changed' ? 'site inputs changed, ' : '';
      // Every bucket named explicitly, `skippedDestinationExists` included
      // and kept distinct from `failed` — see `RekeyReport`'s own doc comment
      // for why folding a correct refusal into the failure count would send
      // whoever reads this line hunting a bug that does not exist.
      emitLog(
        `rekey: ${why}moved ${r.moved} (${r.renamed} file(s) renamed), merged ${r.merged}, ` +
          `skipped ${r.skippedEdited} edited / ${r.skippedUnparsable} unparsable / ` +
          `${r.skippedCollision} collision / ${r.skippedDestinationExists} destination-exists, ` +
          `failed ${r.failed}` +
          (outcome.drift > 0 ? `, ${outcome.drift} group(s) still not agreeing with a fresh parse` : ''),
      );
    }
  } catch (error) {
    emitLog(`rekey: pass threw and was skipped, startup continuing — ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const config = await loadConfig(CONFIG_PATH);
  // Captured before the server can rewrite the file, and parsed rather than
  // held as text: `restartRequired` asks whether the *settings* changed, and a
  // reindent is not a settings change. Read through `readConfigDocument`
  // rather than a second `readFile` + `JSON.parse` here — that function
  // exists precisely so the "unreadable" and "not valid JSON" messages boot
  // and the config routes produce cannot drift, and a second copy of the
  // read-then-parse logic is exactly how they would.
  const bootConfigDocument = await readConfigDocument(CONFIG_PATH);
  const db = openDatabase(config.database.path);
  const registry = await loadPlugins(config);

  // Task 6: the re-key pass. Run here — after the plugins that parse titles
  // are loaded, before anything below reads a group's identity for real work
  // — so that whatever this boot's clients, scheduler and server end up
  // seeing is already whatever this pass leaves behind. `migrate` has
  // already run inside `openDatabase` above; this pass is deliberately not
  // part of that, since it runs the live parser rather than a fixed schema
  // change (see `runRekeyOnBoot`'s doc comment).
  //
  // This call MUST stay before `await server.listen(...)` below. `planRekey`
  // reads every group once and `applyRekey` acts on that single snapshot —
  // safe only because nothing else can be creating a download, an imported
  // file, or a group between the read and the write. Once `server.listen`
  // has run, incoming HTTP traffic can do exactly that, and the snapshot a
  // merge decided against stops being a fact about "now" by the time the
  // merge's delete actually runs (see the comment on the merge branch inside
  // `applyRekey`, which names this exact scenario). Moving this pass after
  // `listen` — to boot faster, or to start serving while it runs — would
  // reopen that window. The `groupHistory` re-check inside the merge's own
  // transaction (`rekey.ts`, Task 4a) is the backstop if that ordering is
  // ever violated: it turns a merge that raced a real write into a clean
  // `skipped-collision` rather than a deleted group with live history. It is
  // a backstop, not a substitute for keeping this above `listen` — it only
  // catches the merge case, not a `move` racing a concurrent import.
  await runRekeyAtBoot(
    db,
    registry,
    // The real implementations, wired here rather than defaulted inside
    // `pipeline/rekey.ts`: `rename` is `node:fs/promises`' own function,
    // unadapted, and `commit` is documented as having exactly one legitimate
    // body — see `RekeyDeps`'s own doc comment for why both exist as a seam
    // at all (a deterministic failure point for tests) rather than being
    // called directly.
    { now: () => Date.now(), rename, commit: (handle) => handle.exec('COMMIT') },
    log,
  );

  const clients = new Map<string, DownloadClient>();
  for (const clientConfig of config.downloadClients) {
    // A `case` per member is not exhaustive on its own — a `switch` with no
    // `default` and no arm that reads as `never` compiles cleanly even after
    // a third member is added to the union; it would just fall through this
    // loop having registered nothing, and the config that named it would
    // boot anyway. The `default` arm below is what actually makes an
    // unhandled type a compile error, via the assignment to `never`.
    switch (clientConfig.type) {
      case 'sabnzbd':
        clients.set(clientConfig.id, createSabnzbdClient(clientConfig));
        break;
      case 'qbittorrent':
        // Task 9 replaces this throw with createQbittorrentClient(clientConfig)
        // once Task 6 has built that factory. Unreachable today: parseConfig
        // (config/load.ts) is the only place a 'qbittorrent' client can come
        // from, and it lands in the same commit as this switch, so nothing
        // has configured one yet.
        throw new Error(
          `Download client ${clientConfig.id} is a qbittorrent client, which is not implemented yet`,
        );
      default: {
        const unhandled: never = clientConfig;
        throw new Error(`Unhandled download client type: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // The default a feed naming no client falls back to, and what makes that
  // fallback total: `configSchema` puts `.min(1)` on the array, so this is
  // unreachable, but every feed's client is resolved through it below and a
  // silent `undefined` there would turn each unannotated feed's picks into a
  // 400.
  const firstClientConfig = config.downloadClients[0];
  if (firstClientConfig === undefined) {
    throw new Error('downloadClients: at least one download client must be configured');
  }

  // One client, used for site lookup, scene metadata and performer search:
  // `createTpdbClient` already returns an object satisfying `SiteLookupClient`,
  // `SceneLookupClient` and `PerformerLookupClient`, and all three features read
  // the same `siteLookup` credentials, so a second instance would just be a
  // second, redundant holder of the same api key.
  let tpdbClient: (SiteLookupClient & SceneLookupClient & PerformerLookupClient) | undefined;
  if (config.siteLookup === undefined) {
    log('site lookup: not configured; date-at-end names use their first word as the site');
  } else {
    tpdbClient = createTpdbClient(config.siteLookup, fetch);
    log(`site lookup: ${config.siteLookup.type}`);
  }

  // Sites confirmed on previous runs are handed back to their plugins before
  // any feed is read, so a restart does not re-ask about what it already knows
  // and — more importantly — does not parse a name with less site information
  // than the run before it had.
  const seeded = knownSiteNames(db);
  if (seeded.length > 0) {
    for (const plugin of registry.all()) plugin.learnSites?.(seeded);
    log(`site lookup: seeded ${seeded.length} known site(s) from previous runs`);
  }

  const recovery = recoverInterruptedWork(db, Date.now());
  log(
    `recovery: ${recovery.importsReset} imports reset, ${recovery.pendingAddUrl} awaiting addurl`,
  );

  // Resolved unconditionally, not just when the worker is wired up: the HTTP
  // poster route needs to know this directory regardless of whether metadata
  // is currently enabled, since a poster cached during an earlier run must
  // stay servable after the feature is turned off.
  const artworkDir = resolveArtworkDir(config.database.path, config.metadata.artworkDir);

  // `runMetadata` stays `undefined` — and the scheduler never gets a third
  // timer — when the feature is off or there is no client to ask, exactly as
  // an absent `runMetadata` already means "don't register this timer" to
  // `createScheduler`. The "idle for want of credentials" case is logged
  // once, right here at startup, rather than from inside a tick that would
  // otherwise repeat it forever.
  let runMetadata: (() => Promise<void>) | undefined;
  if (!config.metadata.enabled) {
    log('metadata: disabled');
  } else if (tpdbClient === undefined) {
    log(
      'metadata: enabled but idle — no siteLookup client configured, so there are no ' +
        'ThePornDB credentials to look scenes up with',
    );
  } else {
    const client = tpdbClient;
    const artwork: ArtworkDeps = {
      dir: artworkDir,
      fetchImpl: fetch,
      log,
    };
    const pluginFor = pluginById(registry);
    // `createMetadataRunner` holds the cooldown a 429 sets across ticks, in
    // its own closure — see its doc comment in pipeline/metadata.ts for why
    // that has to happen here rather than being recomputed inside
    // `runMetadataPass` itself, which has no memory of the previous tick.
    const runScenes = createMetadataRunner({
      db,
      client,
      pluginFor,
      artwork,
      perTick: config.metadata.perTick,
      now: () => Date.now(),
      log,
    });
    // One tick drives both passes, in order. No second interval: a second
    // knob is a second thing to tune wrong, and both passes talk to the same
    // rate-limited service, so sharing one cadence is what keeps the
    // combined request rate predictable. "Predictable" is a bound, not a
    // constant, though: the scene pass can enqueue up to `perTick` rows and
    // the performer pass can then search them, so worst-case provider
    // requests in one tick is the *sum* of both passes' `perTick`, not
    // `perTick` itself. Scenes first — a performer search is the fallback for
    // a scene lookup that settled without a cast, so the pass that produces
    // those rows has to run before the pass that drains them. Each pass reads
    // `now()` fresh when it runs, so a row the scene pass just enqueued
    // (`next_at = now`) is already due by the time the performer pass reads
    // the queue moments later — it is searched in this same tick, not the
    // next one.
    const runPerformers = createPerformerRunner({
      db,
      client,
      pluginFor,
      // The same `artwork` the scene pass above gets, not a second one: both
      // passes cache into one directory under one key scheme
      // (`performerArtworkKey`), and two configurations of that is two places for
      // the path to be wrong.
      artwork,
      perTick: config.metadata.perTick,
      now: () => Date.now(),
      log,
    });
    runMetadata = composeMetadataTick(runScenes, runPerformers);
    log(
      `metadata: enabled, every ${config.metadata.intervalSeconds}s, ${config.metadata.perTick} per tick ` +
        '(performer search shares the same tick)',
    );
  }

  /**
   * Resolve the sites named by a batch of titles, and say what happened.
   *
   * Shared by the live poll and the backfill walk rather than duplicated, because
   * a backfilled title has to resolve its site by exactly the same rule: an
   * identity key outlives the tick, so an old release keyed without a site
   * lookup would land in a different group from the same scene arriving live —
   * one scene, two groups, and no way to notice.
   */
  async function resolveSitesFor(
    feed: FeedConfig,
    plugin: MediaTypePlugin,
    titles: readonly string[],
  ): Promise<void> {
    // Before parsing, not after: an identity key outlives the tick, so a
    // site learned too late cannot be applied without re-keying a group the
    // user may already have picked.
    const sites = await resolveSitesForBatch(
      { db, plugin, client: tpdbClient, now: () => Date.now(), log },
      [...titles],
    );
    if (sites.queried > 0 || sites.confirmed.length > 0) {
      log(
        `site lookup ${feed.id}: ${sites.confirmed.length} confirmed ` +
          `(${sites.queried} queried, ${sites.cached} cached)`,
      );
    }
    for (const title of sites.unresolved) {
      log(
        `site lookup ${feed.id}: unresolved, filing under its first word — ${title}. ` +
          'This identity key is durable; it will not change once lookups recover.',
      );
    }
  }

  // Absent unless some feed opted in, so an install that has not configured
  // backfill gets no timer at all rather than an hourly tick over nothing —
  // the same shape as `runMetadata` above.
  const walksHistory = config.feeds.some((feed) => feed.backfill !== undefined);
  const runBackfill = walksHistory
    ? createBackfillRunner({
        db,
        feeds: config.feeds,
        fetchPage: (feed, page) =>
          fetchFeed(feed, {
            page,
            // `exactOptionalPropertyTypes` again: `pagination: undefined` is not
            // assignable, and only a feed with a `backfill` block reaches here.
            ...(feed.backfill === undefined ? {} : { pagination: feed.backfill }),
          }),
        ingestPage: async (feed, entries, source) => {
          const plugin = registry.byPackage(feed.plugin);
          await resolveSitesFor(
            feed,
            plugin,
            entries.map((item) => item.title),
          );
          return ingestEntries(db, plugin, feed, entries, Date.now(), source);
        },
        now: () => Date.now(),
        log,
      })
    : undefined;

  const scheduler = createScheduler({
    db,
    feeds: config.feeds,
    clientIds: [...clients.keys()],
    log,
    // `exactOptionalPropertyTypes` forbids assigning `metadataIntervalMs:
    // undefined` outright, so the pair is spread in together rather than
    // listed as plain properties.
    ...(runMetadata === undefined
      ? {}
      : { runMetadata, metadataIntervalMs: config.metadata.intervalSeconds * 1000 }),
    ...(runBackfill === undefined ? {} : { runBackfill }),
    ingestFeed: async (feed) => {
      const plugin = registry.byPackage(feed.plugin);
      const entries = await fetchFeed(feed);
      await resolveSitesFor(
        feed,
        plugin,
        entries.map((entry) => entry.title),
      );
      return ingestEntries(db, plugin, feed, entries, Date.now());
    },
    reconcile: async (clientId) => {
      const client = clients.get(clientId);
      if (client === undefined) throw new Error(`No such client: ${clientId}`);
      return reconcileClient({
        db,
        client,
        now: () => Date.now(),
        log,
        importDownload: (download) =>
          importDownload(
            {
              db,
              registry,
              importMode: client.importMode,
              trashDir: config.trashDir,
              now: () => Date.now(),
            },
            download,
          ),
      });
    },
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = process.env['PICKARR_WEB_ROOT'] ?? resolve(join(here, 'web'));

  // Feeds name their plugin by package and the manual routes need it by feed
  // id, a mapping only configuration holds. Resolved once here rather than per
  // request: `loadConfig` has already refused any feed naming a package that is
  // not configured, and `loadPlugins` registered every configured package, so
  // every lookup below succeeds.
  const pluginsByFeed = new Map<string, MediaTypePlugin>(
    config.feeds.map((feed) => [feed.id, registry.byPackage(feed.plugin)]),
  );

  // The same mapping for download clients, and the reason the pick route can
  // reach a client other than the first one (#34).
  //
  // Every feed gets an entry, including one that names no client: the fallback
  // to `downloadClients[0]` is settled here rather than left to the lookup,
  // because a map that simply omitted unannotated feeds would answer null for
  // them and turn every pick on an ordinary single-client config into a 400.
  // That is the whole compatibility story — with one client configured, every
  // feed resolves to it and nothing about picking changes.
  //
  // `parseConfig` has already refused a feed naming a client that is not
  // configured, and `clients` was built from that same array, so the throw
  // below is a guard against this file drifting rather than a user-facing
  // error — it says the same thing `parseConfig` would, so a reader hitting
  // either recognises the other.
  const clientsByFeed = new Map<string, DownloadClient>(
    config.feeds.map((feed) => {
      const clientId = feed.downloadClient ?? firstClientConfig.id;
      const client = clients.get(clientId);
      if (client === undefined) {
        throw new Error(
          `Feed ${feed.id} references download client ${clientId}, which is not configured`,
        );
      }
      return [feed.id, client];
    }),
  );

  // `server` does not exist until `buildServer` below returns, so `shutdown`
  // (declared here, closing over a `server` binding it does not read until it
  // actually runs) cannot be built from it directly. `requestRestart` below
  // instead takes an arrow that calls `shutdown` by name, so the binding only
  // has to be resolved once `POST /api/restart` actually fires — by which
  // point `shutdown` is long since assigned.
  //
  // Declared and assigned *here* — before `buildServer` and `server.listen()`
  // — rather than after `server.listen()`, which is where this used to live.
  // A `const` is in its temporal dead zone from the top of the enclosing
  // block until its own initializer runs; the invariant this ordering
  // guarantees is that every path that can reach `requestRestart` (any
  // request the now-listening server accepts) finds `shutdown` already
  // assigned. Declaring it after `server.listen()` instead relied on there
  // being no `await` between that line and here to open a window where a
  // request could arrive first — true only by accident, and only until the
  // next `await` lands between them.
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    // A second trigger during teardown — a SIGTERM arriving while a requested
    // restart is already tearing down — must not start a second
    // `server.close()`.
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${reason}, shutting down`);
    scheduler.stop();
    // `close` is only ever called once from either branch below — not once
    // more if it also throws — because a database that already failed to
    // close is not fixed by asking it again, and a `catch` that could itself
    // throw would escape this handler.
    let dbClosed = false;
    const closeDb = (): void => {
      if (dbClosed) return;
      dbClosed = true;
      db.close();
    };
    void server
      .close()
      .then(() => {
        closeDb();
        // Zero, not one: this is a clean, intentional stop. Under the documented
        // `restart: unless-stopped` compose policy that is a restart; under
        // `restart: on-failure` it would not be, which is why the UI presents
        // this as an explicit action rather than something a save does silently.
        process.exit(0);
      })
      .catch((error: Error) => {
        // Without this, a rejected `close()` would leave `shuttingDown` true
        // forever: `db.close()` and `process.exit` above never run, so every
        // later signal or restart request is silently ignored. Exiting
        // non-zero (rather than falling through to the 0 above) does not
        // change anything about `restart: unless-stopped`, which restarts on
        // any exit code regardless — it matters for logs and monitoring,
        // which can tell a failed teardown from a clean one this way, and for
        // a deployment using `restart: on-failure` instead, where the exit
        // code is exactly what decides whether this container comes back.
        log(`shutdown failed: ${error.message}`);
        closeDb();
        process.exit(1);
      });
  };

  const server = buildServer({
    db,
    clientForFeed: (feedId) => clientsByFeed.get(feedId) ?? null,
    // Flattened over every configured client rather than asked of one, so the
    // Downloads screen shows the orphans of all of them. `untrackedFor` itself
    // is unchanged: the scheduler still keys its map per client, because that
    // is the granularity a reconcile tick produces.
    untrackedAll: () => [...clients.keys()].flatMap((id) => scheduler.untrackedFor(id)),
    now: () => Date.now(),
    webRoot,
    registry,
    pluginForFeed: (feedId) => pluginsByFeed.get(feedId) ?? null,
    artworkDir,
    // The same decision that governs whether the scheduler gets a metadata
    // timer at all: `runMetadata` stays `undefined` exactly when there is no
    // worker that could ever drain a `metadata_queue` row. Derived once, here,
    // rather than a second time from `config.metadata`/`tpdbClient` — two
    // copies of that decision are how they eventually disagree.
    metadataAvailable: runMetadata !== undefined,
    configPath: CONFIG_PATH,
    bootConfigDocument,
    databasePath: config.database.path,
    requestRestart: () => shutdown('restart requested'),
    trashDir: config.trashDir,
  });

  await server.listen({ port: config.server.port, host: '0.0.0.0' });
  log(`listening on ${config.server.port}`);

  scheduler.start();
  void scheduler.ingestAllNow();
  void scheduler.reconcileNow();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown(`${signal} received`));
  }
}

/**
 * Fallback for `import.meta.main` on a Node build where it is not yet a
 * boolean (see `isEntryPoint` below) — the same "is this the script Node was
 * actually asked to run" question, answered by comparing `argv[1]` against
 * this module's own path instead.
 *
 * Both sides are realpathed before comparing. `import.meta.url` already
 * names this module with symlinks resolved; `argv[1]` does not, so running
 * through a symlink (`node /some/link/main.js` pointing at this file) would
 * otherwise compare a resolved path against an unresolved one, find them
 * unequal, and boot into "imported, do nothing" — the worst outcome here,
 * since the process still exits 0 having started nothing.
 *
 * Wrapped in a `try`/`catch` so a missing or unreadable `argv[1]` cannot
 * itself throw during startup; either failure mode conservatively answers
 * "not the entry point" rather than crashing on what should be a yes/no
 * question.
 *
 * `realpathSync`, not `fs.promises.realpath`: this runs once at module load,
 * before anything else is on the event loop to be blocked by it — the same
 * exception this project's async-over-sync rule already carves out for
 * build-time and startup-time work that has nothing else to wait on.
 */
export function entryFromArgv(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// `import.meta.main` is symlink-correct and is what Node itself recommends
// for this check, but this package's `engines` field only requires Node
// >=24, and `import.meta.main` is `undefined` — not `false` — on 24.0 and
// 24.1, before it shipped. Trusting it unconditionally would make
// `isEntryPoint` falsy everywhere on those versions and the application
// would never start; checked at runtime with `typeof`, not by version
// number, since that is what actually determines whether the value means
// anything.
const isEntryPoint =
  typeof import.meta.main === 'boolean' ? import.meta.main : entryFromArgv();

if (isEntryPoint) {
  main().catch((error: Error) => {
    console.error(`[pickarr] fatal: ${error.message}`);
    process.exit(1);
  });
}
