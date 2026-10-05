/**
 * Queues the artwork job again for every resolved item of one plugin.
 *
 *   node packages/host/dist/backfill-artwork.js --plugin=xxx [--limit=200] [--dry-run] [--database=<path>]
 *
 * **Why this exists.** The artwork job runs exactly once per successful
 * identification (`applyResolved` in `@pickarr/openmetadata`'s engine) and
 * nothing re-runs it: no timer, no UI action. So a change to what a
 * provider source hands back -- every ThePornDB performer poster rather
 * than one, say -- reaches items identified *after* the change and no
 * others. This is the manual catch-up for the ones before it.
 *
 * **Where it runs.** Inside the container, through `docker exec`, which
 * is why it is a host entrypoint built into `dist` beside `bin.js` and
 * `healthcheck.js` rather than a file under `scripts/`: the runtime image
 * ships only `dist` and has no `tsx`. `docker exec` runs as root unless
 * told otherwise (see `Dockerfile`), so pass the host's `-u PUID:PGID`.
 * With no `--database` it resolves the path the way boot does, from
 * `PICKARR_DATABASE` or the config file `PICKARR_CONFIG` names, so inside
 * the container it needs nothing but `--plugin`.
 *
 * **What it writes.** One `jobs` row per item, through the same
 * `createRunner` the host's `JobQueue.enqueue` uses and under the plugin's
 * own id, which is what the dispatcher routes on. The payload is
 * `ArtworkJobPayload`, rebuilt from the database: `media_item` has
 * `provider` and `provider_ref`, `role` joined to `person` gives the cast,
 * and `kind` and `parents` -- which `media_item` does not store -- come
 * from each plugin's own tables through {@link PAYLOAD_RULES}.
 *
 * **What it does not do.** It does not wake the host. The dispatcher
 * re-arms on its own `enqueue`, not on a row another process inserted, so
 * these rows are picked up on the dispatcher's safety interval
 * (`SAFETY_INTERVAL_MS`, one minute) rather than at once. The exit line
 * says so. And it does not touch an item that already has an artwork job
 * `ready` or `running`, so running it twice queues nothing twice.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ArtworkJobPayload, ArtworkJobPerson } from '@pickarr/openmetadata';
import { ARTWORK_JOB } from '@pickarr/openmetadata';
import { openDatabase } from './db/open.ts';
import { DEFAULT_MAX_ATTEMPTS } from './host.ts';
import { createRunner } from './jobs/runner.ts';
import { SAFETY_INTERVAL_MS } from './jobs/dispatcher.ts';
import { resolveSettings } from './main.ts';

export interface BackfillArgs {
  readonly pluginId: string;
  readonly databasePath: string | undefined;
  readonly limit: number | undefined;
  readonly dryRun: boolean;
}

function usage(): never {
  throw new Error(
    'Usage: node packages/host/dist/backfill-artwork.js --plugin=<id> [--limit=<n>] [--dry-run] [--database=<path>]',
  );
}

export function parseArgs(argv: readonly string[]): BackfillArgs {
  let pluginId: string | undefined;
  let databasePath: string | undefined;
  let limit: number | undefined;
  let dryRun = false;

  for (const arg of argv) {
    if (arg.startsWith('--plugin=')) pluginId = arg.slice('--plugin='.length);
    else if (arg.startsWith('--database=')) databasePath = arg.slice('--database='.length);
    else if (arg.startsWith('--limit=')) {
      const text = arg.slice('--limit='.length);
      // `Number('')` is 0 and `Number('1e3')` is 1000; the regex keeps the
      // flag to plain digits so the message below can quote what was typed.
      if (!/^[1-9]\d*$/.test(text)) throw new Error(`--limit must be a positive integer, got "${text}"`);
      limit = Number(text);
    }
    else if (arg === '--dry-run') dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (pluginId === undefined || pluginId.length === 0) usage();
  return { pluginId, databasePath, limit, dryRun };
}

/** A resolved `media_item`: `provider` and `provider_ref` are both non-null by the query that reads it. */
interface ResolvedItem {
  readonly id: number;
  readonly provider: string;
  readonly providerRef: string;
}

/** The two payload fields `media_item` does not carry, as one plugin's tables record them. */
interface KindAndParents {
  readonly kind: ArtworkJobPayload['kind'];
  readonly parents: ArtworkJobPayload['parents'];
}

type PayloadRule = (raw: DatabaseSync, item: ResolvedItem) => KindAndParents;

/**
 * How each plugin's `kind` and `parents` are rebuilt.
 *
 * `movie` and `xxx` accept exactly one kind each -- their `apply` throws on
 * any other (`plugin-movie/src/apply.ts`, `plugin-xxx/src/apply.ts`) -- and
 * neither has ancestors, so both are constants. `tv` stored the kind in
 * `tv_release.kind` and the ancestry as `season_id`/`series_id`; the
 * parents go nearest first, which is the order `ArtworkParent` promises
 * and the TMDb source walks.
 *
 * A plugin missing from this map is refused by name rather than guessed
 * at: a wrong `kind` would be a 404 at the provider for every item, after
 * the job had already run.
 */
const PAYLOAD_RULES: Readonly<Record<string, PayloadRule>> = {
  movie: () => ({ kind: 'movie', parents: [] }),
  xxx: () => ({ kind: 'scene', parents: [] }),
  tv: (raw, item) => {
    const row = raw.prepare(`
      SELECT r.kind AS kind, season.provider_ref AS season_ref, series.provider_ref AS series_ref
      FROM tv_release r
      JOIN tv_series series ON series.id = r.series_id
      LEFT JOIN tv_season season ON season.id = r.season_id
      WHERE r.media_item_id = ?
    `).get(item.id) as { kind: string; season_ref: string | null; series_ref: string } | undefined;
    if (row === undefined) {
      throw new Error(`media_item ${String(item.id)} has no tv_release row`);
    }
    const parents: { kind: string; providerRef: string }[] = [];
    if (row.kind !== 'season' && row.season_ref !== null) parents.push({ kind: 'season', providerRef: row.season_ref });
    if (row.kind !== 'series') parents.push({ kind: 'series', providerRef: row.series_ref });
    return { kind: row.kind, parents };
  },
};

function resolvedItems(raw: DatabaseSync, pluginId: string): ResolvedItem[] {
  const rows = raw.prepare(`
    SELECT id, provider, provider_ref
    FROM media_item
    WHERE plugin_id = ? AND provider IS NOT NULL AND provider_ref IS NOT NULL
    ORDER BY id
  `).all(pluginId) as unknown as { id: number; provider: string; provider_ref: string }[];
  return rows.map((row) => ({ id: row.id, provider: row.provider, providerRef: row.provider_ref }));
}

/** Items with an artwork job that has not finished -- what a second run must not queue again. */
function alreadyQueued(raw: DatabaseSync, pluginId: string): Set<number> {
  const rows = raw.prepare(`
    SELECT json_extract(payload_json, '$.mediaItemId') AS media_item_id
    FROM jobs
    WHERE plugin_id = ? AND kind = ? AND state IN ('ready', 'running')
  `).all(pluginId, ARTWORK_JOB) as unknown as { media_item_id: number | null }[];
  return new Set(rows.map((row) => row.media_item_id).filter((id): id is number => id !== null));
}

/** The cast in billing order -- the order `attachPeople` wrote the roles in -- one entry per person. */
function people(raw: DatabaseSync, mediaItemId: number): ArtworkJobPerson[] {
  const rows = raw.prepare(`
    SELECT DISTINCT p.id AS person_id, p.provider_ref AS provider_ref, MIN(r.billing_order) AS billing
    FROM role r JOIN person p ON p.id = r.person_id
    WHERE r.media_item_id = ?
    GROUP BY p.id
    ORDER BY billing, p.id
  `).all(mediaItemId) as unknown as { person_id: number; provider_ref: string }[];
  return rows.map((row) => ({ personId: row.person_id, providerRef: row.provider_ref }));
}

export interface BackfillReport {
  /** Resolved items of the plugin, whether or not anything was queued for them. */
  readonly candidates: number;
  /** Rows written -- or, on a dry run, rows that would have been. */
  readonly queued: number;
  /** Candidates skipped for already having an unfinished artwork job. */
  readonly alreadyQueued: number;
}

export interface BackfillOptions {
  readonly pluginId: string;
  readonly dryRun: boolean;
  readonly limit?: number;
  readonly now: () => number;
}

export function backfillArtwork(raw: DatabaseSync, options: BackfillOptions): BackfillReport {
  const rule = PAYLOAD_RULES[options.pluginId];
  if (rule === undefined) {
    const known = Object.keys(PAYLOAD_RULES).toSorted().join(', ');
    throw new Error(`no artwork payload rule for plugin "${options.pluginId}"; known: ${known}`);
  }

  const items = resolvedItems(raw, options.pluginId);
  const pending = alreadyQueued(raw, options.pluginId);
  const runner = createRunner(raw, { now: options.now, defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS });

  // Every payload is built before any row is written, and the writes are
  // one transaction: a `tv` item with no `tv_release` row throws from its
  // rule, and a run that had already queued half the library before the
  // throw would leave the operator guessing which half.
  const payloads: ArtworkJobPayload[] = [];
  let skipped = 0;
  for (const item of items) {
    if (pending.has(item.id)) {
      skipped += 1;
      continue;
    }
    if (options.limit !== undefined && payloads.length >= options.limit) continue;
    const { kind, parents } = rule(raw, item);
    payloads.push({
      mediaItemId: item.id,
      kind,
      provider: item.provider,
      providerRef: item.providerRef,
      people: people(raw, item.id),
      parents,
    });
  }

  if (!options.dryRun) {
    raw.exec('BEGIN');
    try {
      for (const payload of payloads) runner.enqueue(options.pluginId, { kind: ARTWORK_JOB, payload });
      raw.exec('COMMIT');
    } catch (error) {
      raw.exec('ROLLBACK');
      throw error;
    }
  }

  return { candidates: items.length, queued: payloads.length, alreadyQueued: skipped };
}

export async function main(
  deps: { argv?: readonly string[]; env?: NodeJS.ProcessEnv; write?: (line: string) => void } = {},
): Promise<void> {
  const args = parseArgs(deps.argv ?? process.argv.slice(2));
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const databasePath = args.databasePath ?? (await resolveSettings(deps.env ?? process.env)).databasePath;

  const { raw } = openDatabase(databasePath);
  // The host has this file open and is writing to it. Five seconds is far
  // longer than any of its transactions and short enough that a genuinely
  // stuck lock surfaces as an error rather than a hang.
  raw.exec('PRAGMA busy_timeout = 5000');
  try {
    const report = backfillArtwork(raw, {
      pluginId: args.pluginId,
      dryRun: args.dryRun,
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      now: () => Date.now(),
    });
    const verb = args.dryRun ? 'would queue' : 'queued';
    write(
      `backfill-artwork: ${args.pluginId}: ${String(report.candidates)} resolved items, `
      + `${verb} ${String(report.queued)}, ${String(report.alreadyQueued)} already queued`,
    );
    if (!args.dryRun && report.queued > 0) {
      write(`backfill-artwork: a running host picks these up within ${String(SAFETY_INTERVAL_MS / 1000)}s`);
    }
  } finally {
    raw.close();
  }
}

// The same guard `healthcheck.ts` uses, for the same reason: this file is
// imported by its test, and only the process Node was asked to run should
// act. `engines.node >= 24` makes `import.meta.main` a boolean everywhere.
if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`backfill-artwork: ${message}\n`);
    process.exitCode = 1;
  });
}
