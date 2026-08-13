import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ManualField, MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import type { DownloadClient } from '../clients/types.ts';
import { applyEdits, toEditableConfig } from '../config/editable.ts';
import { parseConfig, readConfigDocument, resolveSecrets } from '../config/load.ts';
import type { PickarrConfig } from '../config/schema.ts';
import type { JsonValue } from '../json.ts';
import {
  browsableGroup,
  browseGroups,
  getGroup,
  pickedGroups,
  type GroupRow,
} from '../db/groups.ts';
import { allDownloads, getDownload, resetForRetry } from '../db/downloads.ts';
import { failedFeedItems } from '../db/feed-items.ts';
import {
  enqueueMetadata,
  getGroupMetadata,
  metadataForGroups,
  queuedMetadataNextAt,
  type GroupMetadata,
} from '../db/metadata.ts';
import { getPerformer, performersForGroups, type PerformerRow } from '../db/performers.ts';
import { validateIdentity } from '../ingest/commit.ts';
import {
  dismissFeedItem,
  editGroup,
  editRelease,
  resolveFeedItem,
  type ManualDeps,
} from '../manual/operations.ts';
import { answerUnaskable, metadataAnswerability } from '../pipeline/metadata.ts';
import { pickRelease } from '../pipeline/pick.ts';
import type { PluginRegistry } from '../plugins/registry.ts';
import type { UntrackedEntry } from '../pipeline/reconcile.ts';
import {
  metadataViewOf,
  toDownloadView,
  toFailedItemView,
  toGroupView,
  type BrowseResponse,
  type ConfigResponse,
  type ConfigSaveResponse,
  type FailedResponse,
  type GroupEditResponse,
  type GroupView,
  type MetadataRequestResponse,
  type MetadataView,
  type PickResponse,
  type ReleaseEditResponse,
  type ResolveResponse,
} from './views.ts';

export interface ServerDeps {
  db: DatabaseSync;
  defaultClient: DownloadClient;
  untrackedFor(clientId: string): UntrackedEntry[];
  now(): number;
  /** Absolute path to the built SPA, or null to run API-only. */
  webRoot: string | null;
  registry: PluginRegistry;
  /**
   * The plugin configured for a feed, or null when that feed has left
   * configuration. Feeds name their plugin by *package* and stored rows name it
   * by *id*, so a feed item — which has neither a group nor a release yet — can
   * only be mapped to a plugin by something holding the feed list.
   */
  pluginForFeed(feedId: string): MediaTypePlugin | null;
  /**
   * Where `cacheImage` writes files, resolved once by `resolveArtworkDir` in
   * main.ts. Injected rather than recomputed here: `config.database.path` is
   * not otherwise anything this module needs to know about, and computing the
   * same default twice is how the two copies eventually disagree.
   */
  artworkDir: string;
  /**
   * Whether a metadata lookup could ever be produced right now — `true` only
   * when `config.metadata.enabled` and a `siteLookup` client both hold, the
   * same test main.ts already makes once at startup to decide whether to
   * register the worker's scheduler timer at all (`runMetadata !==
   * undefined`). Derived there and passed in here rather than re-derived from
   * config a second time, so the two decisions cannot drift apart.
   *
   * `POST /api/metadata/request` reads this to decide whether to queue at
   * all: queueing with no worker running to drain the queue would give the
   * SPA a row that polls forever at its 8s ceiling and is never answered.
   */
  metadataAvailable: boolean;
  /**
   * The `config.json` the Settings screen reads and writes — `PICKARR_CONFIG`,
   * resolved once in main.ts. Injected rather than re-read from the environment
   * here so a test can point the config routes at a temp directory, and so the
   * two places that name this file cannot disagree.
   */
  configPath: string;
  /**
   * The parsed document this process booted from, captured before anything
   * could rewrite it. Compared against the file on disk to answer
   * `restartRequired`; parsed rather than textual, so reindenting the file by
   * hand does not read as a pending restart.
   */
  bootConfigDocument: JsonValue;
  /**
   * The SQLite file `deps.db` was opened from, needed because the backup copy
   * is written beside it — same filesystem, so nothing crosses a device
   * boundary. `DatabaseSync` does not expose the path it was opened with, so
   * this cannot be recovered from `db`.
   */
  databasePath: string;
  /**
   * Shuts the process down cleanly so that whatever supervises it starts a new
   * one — in main.ts, the same function the signal handlers use.
   *
   * Injected so that `process.exit` stays out of the HTTP layer: a route that
   * called it directly could not be tested at all, and the one thing worth
   * testing here is that a restart is asked for exactly once.
   *
   * Temporarily optional, unlike `databasePath` above: `main.ts` already has
   * `config.database.path` in scope when it builds these deps, but it has
   * nothing to pass here yet — the `shutdown` function this will call is only
   * definable after `server` itself exists, which is `main.ts`'s ordering
   * problem to solve, not this route's. It becomes required once the restart
   * route is added and `main.ts` extracts `shutdown` to pass in.
   */
  requestRestart?(): void;
}

/**
 * The largest page `/api/browse` will ever hand back, and therefore the
 * largest batch of ids a client can ever have on screen at once to ask
 * `/api/metadata/request` about. Reused, not duplicated, as the cap on that
 * body: a second, independently-chosen number here would either be wrong (too
 * small for a real page) or pointless (bigger than any real request), and
 * would drift from this one the day only it changed.
 */
const MAX_PAGE_LIMIT = 100;

const browseQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(30),
  q: z.string().min(1).optional(),
});

const metadataRequestBodySchema = z.object({
  groupIds: z.array(z.number().int().positive()).max(MAX_PAGE_LIMIT),
});

const metadataQuerySchema = z.object({
  ids: z.string().min(1),
});

const POSTER_CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * A digit-only positive integer, stricter than `Number()`/`z.coerce.number()`.
 * Those accept `"+1"`, `"1e3"`, `"0x10"`, and surrounding whitespace, and —
 * worse — two different huge digit strings past `Number.MAX_SAFE_INTEGER`
 * ("9007199254740993" and "9007199254740992") silently collapse to the same
 * value. `/^\d+$/` plus `Number.isSafeInteger` rejects all of that at the
 * boundary, so a malformed id 400s instead of quietly meaning some other id.
 */
function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The same `"1,2,3"` format the SPA already builds cursors and ids with
 * elsewhere. `null` on anything that is not a positive integer, or on a list
 * longer than a browse page could ever put on screen at once — this is an
 * unauthenticated GET on a LAN-exposed service, and an unbounded id list
 * turns into an unbounded `IN (...)` built twice (once each for
 * `metadataForGroups` and `queuedMetadataNextAt`), which is wasted work at
 * best and `ERR_SQLITE_ERROR: too many SQL variables` at worst.
 */
function parseIds(raw: string): number[] | null {
  const parts = raw.split(',');
  if (parts.length > MAX_PAGE_LIMIT) return null;
  const ids: number[] = [];
  for (const part of parts) {
    const id = parsePositiveInt(part.trim());
    if (id === null) return null;
    ids.push(id);
  }
  return ids;
}

const failedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // A string rather than a coerced boolean: `z.coerce.boolean()` reads every
  // non-empty string as true, so `?includeDismissed=false` would show them.
  includeDismissed: z.string().optional(),
});

const pickBodySchema = z.object({ releaseId: z.number().int().positive() });
// `z.coerce.number()` used to sit here, and accepted `"+1"` and `"%201"`
// (a decoded leading space) as id 1 — no escape, since every id is used only
// as a bound SQL parameter or a lookup key, but not the id the caller sent
// either, which matters for the poster route, whose id names the very file
// on disk. `parsePositiveInt` rejects both instead of coercing them.
const idParamsSchema = z.object({
  id: z.string().transform((value, ctx) => {
    const parsed = parsePositiveInt(value);
    if (parsed === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a positive integer' });
      return z.NEVER;
    }
    return parsed;
  }),
});
const valuesBodySchema = z.object({ values: z.record(z.string(), z.string()) });
const previewBodySchema = z.object({
  plugin: z.string().min(1),
  values: z.record(z.string(), z.string()),
});

const secretEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keep') }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('literal'), value: z.string() }),
]);

// Shape only. Every *rule* about the values — port ranges, url formats, minimum
// key lengths, duplicate ids — belongs to `parseConfig`, which the handler runs
// on the merged document. Duplicating any of it here would give the same
// mistake two different error messages depending on which check saw it first.
const configSubmissionSchema = z.object({
  server: z.object({ port: z.number() }),
  database: z.object({ path: z.string() }),
  trashDir: z.string(),
  plugins: z.record(
    z.string(),
    z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  ),
  downloadClients: z.array(
    z.object({
      id: z.string(),
      type: z.literal('sabnzbd'),
      url: z.string(),
      apiKey: secretEditSchema,
      category: z.string(),
      importMode: z.enum(['move', 'copy']),
      pathMappings: z.array(z.object({ from: z.string(), to: z.string() })),
    }),
  ),
  feeds: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      plugin: z.string(),
      intervalSeconds: z.number(),
    }),
  ),
  siteLookup: z
    .object({ type: z.literal('theporndb'), apiKey: secretEditSchema, baseUrl: z.string() })
    .nullable(),
  metadata: z.object({
    enabled: z.boolean(),
    intervalSeconds: z.number(),
    perTick: z.number(),
    artworkDir: z.string().nullable(),
  }),
});

function parseCursor(raw: string | undefined): { listRankAt: number; id: number } | null {
  if (raw === undefined) return null;
  const [rank, id] = raw.split(':');
  const listRankAt = Number(rank);
  const groupId = Number(id);
  if (!Number.isFinite(listRankAt) || !Number.isFinite(groupId)) return null;
  return { listRankAt, id: groupId };
}

/** The same `"<sort key>:<id>"` format browse uses, over the failed list's own sort key. */
function parseFailedCursor(raw: string | undefined): { firstSeenAt: number; id: number } | null {
  if (raw === undefined) return null;
  const [seen, id] = raw.split(':');
  const firstSeenAt = Number(seen);
  const itemId = Number(id);
  if (!Number.isFinite(firstSeenAt) || !Number.isFinite(itemId)) return null;
  return { firstSeenAt, id: itemId };
}

/**
 * A plugin's field list, or nothing.
 *
 * Nothing when it cannot also *consume* the values: a form whose every submit
 * is a 409 from `resolveFeedItem` is worse than no form, and Browse already
 * hides its Edit control for such a plugin — the two screens have to agree.
 *
 * Guarded for the same reason `toManualValues` is in `views.ts`: the hook's
 * contract makes no promise not to throw, so a plugin that does loses its own
 * form rather than every plugin's.
 */
function fieldsFor(plugin: MediaTypePlugin): readonly ManualField[] | undefined {
  if (plugin.manualFields === undefined || plugin.fromManualValues === undefined) {
    return undefined;
  }
  try {
    return plugin.manualFields();
  } catch {
    return undefined;
  }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });
  const { db } = deps;

  // Wrapped rather than passed by reference so that a `ServerDeps` written with
  // method shorthand keeps its receiver.
  const manual: ManualDeps = {
    db,
    registry: deps.registry,
    pluginForFeed: (feedId) => deps.pluginForFeed(feedId),
    now: () => deps.now(),
  };

  /**
   * A group as the browse list would render it, prefill values and all.
   * `metadata` is the answer `metadataForGroups` already found for this group
   * and `performers` is its cast from `performersForGroups` — both read once
   * for the whole page by every caller below, never per group here, which is
   * the point: a second per-group query into `group_metadata` or
   * `group_performers` from inside this function would reintroduce exactly
   * the defect issue #31 records for `/api/downloads`.
   */
  const viewOf = (
    group: GroupRow,
    metadata: GroupMetadata | undefined,
    performers: readonly PerformerRow[],
  ): GroupView => toGroupView(db, group, deps.registry.byId(group.plugin), metadata, performers);

  /**
   * This one group's cast, in one query. Fine to call once per group from the
   * single-group call sites below (`groupAfter`, `listedAfter`, the pick
   * route): each is already one `getGroupMetadata` lookup for one group, not
   * the per-page loop `viewOf`'s other callers have to avoid.
   */
  const performersFor = (groupId: number): PerformerRow[] =>
    performersForGroups(db, [groupId]).get(groupId) ?? [];

  /**
   * The group a manual operation left behind, read back after it committed —
   * on a merge that is the target, not the group the request named. One group,
   * so one `getGroupMetadata` lookup here is not the per-page N+1 pattern
   * `viewOf`'s callers below have to avoid.
   */
  const groupAfter = (groupId: number): GroupView | null => {
    const group = getGroup(db, groupId);
    return group === null ? null : viewOf(group, getGroupMetadata(db, groupId), performersFor(groupId));
  };

  /**
   * The same group, read as the browse list sees it rather than as the database
   * does. Existence and standing are different questions with different
   * answers: a group that is gone is a 404, while a group that is still there
   * and no longer belongs in the list is a 200 whose payload is null — the
   * answer `/api/groups/:id/pick` already gives.
   */
  const listedAfter = (groupId: number): { missing: true } | { listed: GroupView | null } => {
    if (getGroup(db, groupId) === null) return { missing: true };
    const listed = browsableGroup(db, groupId);
    return {
      listed: listed === null ? null : viewOf(listed, getGroupMetadata(db, groupId), performersFor(groupId)),
    };
  };

  // An empty body with `content-type: application/json` reads as `{}` rather
  // than Fastify's default 400 (FST_ERR_CTP_EMPTY_JSON_BODY), which it raises
  // before any handler runs. `/api/downloads/:id/retry` takes no body at all,
  // so under the default every retry from a client that sets the header
  // unconditionally — as this project's own SPA did, for its whole life — was
  // refused by the framework for a rule the route does not have. Routes that
  // do want a body are unaffected: they validate it with zod and reject `{}`
  // themselves, with their own message.
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string | Buffer, done) => {
      const text = body.toString().trim();
      if (text.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(text) as unknown);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  server.get('/api/health', async () => ({ status: 'ok' }));

  /**
   * Reads the file fresh on every request rather than serving a cached copy, so
   * an edit made by hand on the host shows up here. A file that cannot be read,
   * parsed or validated is a 500 carrying the reason: there is no document to
   * fold edits into, and answering with a fabricated one would mean a later
   * save discarding whatever is actually on disk.
   */
  server.get('/api/config', async (_request, reply) => {
    let document: JsonValue;
    try {
      document = await readConfigDocument(deps.configPath);
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }

    let config: PickarrConfig;
    try {
      config = parseConfig(document, deps.configPath);
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }

    const rawOverride = process.env['PICKARR_PORT'];
    const override = rawOverride === undefined ? Number.NaN : Number.parseInt(rawOverride, 10);
    const response: ConfigResponse = {
      config: toEditableConfig(config),
      portOverride: Number.isNaN(override) ? null : override,
      restartRequired: !isDeepStrictEqual(document, deps.bootConfigDocument),
    };
    return response;
  });

  /**
   * Validate everything, then write once.
   *
   * The order is the substance: fold the submission over the document on disk,
   * run `parseConfig`, then *rehearse* `resolveSecrets` and throw the result
   * away, and only then touch the filesystem. Every check boot applies has
   * therefore been applied before a byte is written, which is what stops a save
   * from producing a config that crash-loops the container — and that matters
   * because `POST /api/restart` puts a boot behind a button.
   *
   * The write itself is temp-file-then-rename, so a process killed mid-save
   * leaves either the old file or the new one and never a truncated one.
   */
  server.put('/api/config', async (request, reply) => {
    const body = configSubmissionSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });

    let document: JsonValue;
    try {
      document = await readConfigDocument(deps.configPath);
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }

    const merged = applyEdits(document, body.data);
    if ('error' in merged) return reply.code(400).send({ error: merged.error });

    try {
      const candidate = parseConfig(merged.document, deps.configPath);
      // Discarded on purpose: this call is here for its failures, not its
      // result. It is what catches a `file:` reference that is missing or
      // empty — a document that parses but that boot cannot survive.
      await resolveSecrets(candidate);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const temporary = `${deps.configPath}.tmp-${process.pid}`;
    try {
      await writeFile(temporary, `${JSON.stringify(merged.document, null, 2)}\n`, 'utf8');
      await rename(temporary, deps.configPath);
    } catch (error) {
      // Best-effort: if the rename is what failed, the temp file is still
      // there, and leaving it beside a live config.json is its own small mess.
      await rm(temporary, { force: true });
      return reply.code(500).send({ error: `Could not write ${deps.configPath}: ${(error as Error).message}` });
    }

    const response: ConfigSaveResponse = { savedAt: deps.now(), restartRequired: true };
    return response;
  });

  server.get('/api/browse', async (request, reply) => {
    const query = browseQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });

    // Fetched one row past the requested page so a page that is exactly
    // `limit` long can be told apart from the last page: without the extra
    // row, "the page came back exactly `limit` long" is ambiguous between
    // "there is more" and "that was exactly everything left."
    const overFetched = browseGroups(db, {
      cursor: parseCursor(query.data.cursor),
      limit: query.data.limit + 1,
      search: query.data.q ?? null,
    });
    const hasMore = overFetched.length > query.data.limit;
    const groups = hasMore ? overFetched.slice(0, query.data.limit) : overFetched;

    // One query for the whole page, not one per group: see `metadataForGroups`
    // and the `viewOf` doc comment above. Issue #31 is the defect this must
    // not repeat.
    const metadata = metadataForGroups(db, groups.map((group) => group.id));
    const performers = performersForGroups(db, groups.map((group) => group.id));

    const last = groups.at(-1);
    const response: BrowseResponse = {
      groups: groups.map((group) => viewOf(group, metadata.get(group.id), performers.get(group.id) ?? [])),
      nextCursor: hasMore && last !== undefined ? `${last.listRankAt}:${last.id}` : null,
    };
    return response;
  });

  server.get('/api/picks', async () => {
    const groups = pickedGroups(db);
    const metadata = metadataForGroups(db, groups.map((group) => group.id));
    const performers = performersForGroups(db, groups.map((group) => group.id));
    return {
      groups: groups.map((group) => viewOf(group, metadata.get(group.id), performers.get(group.id) ?? [])),
    };
  });

  // The lazy half of this feature: browse never enqueues anything on its own
  // (a GET must stay a pure read), so the SPA asks for what it actually
  // rendered with an explicit POST, exactly like every other write here.
  server.post('/api/metadata/request', async (request, reply) => {
    const body = metadataRequestBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });

    const now = deps.now();
    const result: MetadataRequestResponse = {
      queued: 0,
      alreadyAnswered: 0,
      pending: 0,
      missing: 0,
      unavailable: 0,
    };
    const askable: number[] = [];

    for (const groupId of body.data.groupIds) {
      // Already settled — cheaper to notice here than to let `enqueueMetadata`
      // notice it again per id inside its own transaction below.
      if (getGroupMetadata(db, groupId) !== undefined) {
        result.alreadyAnswered += 1;
        continue;
      }

      const group = getGroup(db, groupId);
      // A group that no longer exists cannot be queued — `metadata_queue`'s
      // foreign key forbids it — and there is nothing to answer either, so
      // it is its own counter rather than folded into one of the other
      // ones: the caller needs to be able to tell "discarded" from
      // "accepted", and the five counters together are meant to sum to the
      // number of ids sent.
      if (group === null) {
        result.missing += 1;
        continue;
      }

      // No worker is running to ever drain a row this would create — see
      // `ServerDeps.metadataAvailable`. This is deliberately *not* answered
      // with `answerUnaskable`: unlike a plugin with no metadata hooks, this
      // is not a fact about the group, it is a fact about how Pickarr is
      // currently configured, and configuration can change. Caching it as a
      // permanent `state = 'none'` would mean turning metadata on later
      // never re-asks about a single group browsed while it was off.
      if (!deps.metadataAvailable) {
        result.unavailable += 1;
        continue;
      }

      const plugin = deps.registry.byId(group.plugin) ?? null;
      if (metadataAnswerability(plugin, group) === 'unaskable') {
        // Answered directly, the same way `lookUpOne` would answer it: never
        // queued, because the worker could only ever discard the row. From
        // the client's side the question is just as settled either way.
        answerUnaskable(db, groupId, now);
        result.alreadyAnswered += 1;
        continue;
      }
      askable.push(groupId);
    }

    // `enqueueMetadata` is itself idempotent — it treats an id that is
    // already answered or already waiting as `alreadyAnswered`/`pending`
    // rather than inserting a duplicate row — so a repeat of the same request
    // (the whole point of a lazy, client-driven trigger) is safe to re-issue.
    const enqueued = enqueueMetadata(db, askable, now);
    result.queued += enqueued.queued;
    result.alreadyAnswered += enqueued.alreadyAnswered;
    result.pending += enqueued.pending;
    return result;
  });

  server.get('/api/metadata', async (request, reply) => {
    const query = metadataQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });
    const ids = parseIds(query.data.ids);
    if (ids === null) return reply.code(400).send({ error: 'Invalid ids' });

    // Three queries total for however many ids were asked about — one for
    // answers, one for queue rows (and each pending id's next_at), one for
    // the cast — never a query per id.
    const answered = metadataForGroups(db, ids);
    const queuedNextAt = queuedMetadataNextAt(db, ids);
    const performers = performersForGroups(db, ids);
    const response: Record<number, MetadataView> = {};
    for (const id of ids) {
      response[id] = metadataViewOf(answered.get(id), performers.get(id) ?? [], queuedNextAt.get(id));
    }
    return response;
  });

  // Registered as its own route, deliberately not as a static handler pointed
  // at `deps.artworkDir`: a static handler serves anything under its root, and
  // `posterPath` is not the only thing in that directory forever (a `.part`
  // temp file mid-write, say). This route reads exactly one column and joins
  // it onto the directory itself — nothing caller-supplied ever reaches the
  // filesystem, since `posterPath` is always `<group_id>.<ext>` written by
  // `cacheImage`, and the id in the URL is validated as a positive integer by
  // `idParamsSchema` *before* it is used for anything, so a traversal attempt
  // in the id segment is rejected by zod and never reaches `getGroupMetadata`.
  //
  // Spec §11.1 says `sendFile`, and this reads the whole file into memory
  // instead — a deliberate deviation, not an oversight. `reply.sendFile`
  // streams from the root a `@fastify/static` instance is registered
  // against, and the only one already registered here is `deps.webRoot` (the
  // built SPA); pointing it at the artwork directory too would need a second
  // `@fastify/static` registration and its own prefix, for a route that
  // still has to keep this handler's own existence check and 404 handling
  // either way. On a single-user LAN service with posters capped at 5 MiB
  // (see `cacheImage`), buffering one poster per request is not worth that
  // second registration. `Cache-Control` below is what actually matters at
  // this scale, since a browser can then skip re-reading the file at all.
  server.get('/api/groups/:id/poster', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });

    const metadata = getGroupMetadata(db, params.data.id);
    if (metadata === undefined || metadata.posterPath === null) {
      return reply.code(404).send({ error: 'No poster' });
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(join(deps.artworkDir, metadata.posterPath));
    } catch {
      // The row can outlive the file on disk — a volume wipe, a manual
      // cleanup of the artwork directory — and that is a 404 like any other
      // missing poster, not a 500.
      return reply.code(404).send({ error: 'No poster' });
    }

    const contentType = POSTER_CONTENT_TYPES[extname(metadata.posterPath)] ?? 'application/octet-stream';
    // The file at this id never changes content without the id's own
    // `group_metadata` row changing (a re-fetch after the row is cleared and
    // asked about again), so a day is cheap to cache and costs nothing when
    // it's wrong: the worst case is one stale poster for a day, on a scene
    // this feature never re-checks anyway (§2 of the design: metadata is
    // fetched once).
    return reply.type(contentType).header('cache-control', 'public, max-age=86400').send(bytes);
  });

  // The same shape as the poster route above, mirrored deliberately: the same
  // id validation (so a traversal attempt in the id segment is rejected by
  // zod before it ever reaches `getPerformer`), the same whole-file buffering
  // rather than a second `@fastify/static` registration, the same 404 rather
  // than 500 when the row's path and the file on disk disagree, and the same
  // day-long `Cache-Control` for the same reason: an avatar at this id never
  // changes without the performer row itself changing, which this feature
  // never re-checks on its own.
  server.get('/api/performers/:id/avatar', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });

    const performer = getPerformer(db, params.data.id);
    if (performer === null || performer.facePath === null) {
      return reply.code(404).send({ error: 'No avatar' });
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(join(deps.artworkDir, performer.facePath));
    } catch {
      return reply.code(404).send({ error: 'No avatar' });
    }

    const contentType = POSTER_CONTENT_TYPES[extname(performer.facePath)] ?? 'application/octet-stream';
    return reply.type(contentType).header('cache-control', 'public, max-age=86400').send(bytes);
  });

  // Identical to the avatar route above, except for which cached column it
  // reads — `image_path` rather than `face_path` — since the two are fetched
  // and cached independently and either can be present without the other.
  server.get('/api/performers/:id/image', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });

    const performer = getPerformer(db, params.data.id);
    if (performer === null || performer.imagePath === null) {
      return reply.code(404).send({ error: 'No image' });
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(join(deps.artworkDir, performer.imagePath));
    } catch {
      return reply.code(404).send({ error: 'No image' });
    }

    const contentType = POSTER_CONTENT_TYPES[extname(performer.imagePath)] ?? 'application/octet-stream';
    return reply.type(contentType).header('cache-control', 'public, max-age=86400').send(bytes);
  });

  server.post('/api/groups/:id/pick', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = pickBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const group = getGroup(db, params.data.id);
    if (group === null) return reply.code(404).send({ error: 'No such group' });

    // `kind` is not passed here: pickRelease derives it from the group's own
    // state internally (see pipeline/pick.ts). Accepting it from the caller
    // was removed in Task 11 — that was the entire point of the change, a
    // caller cannot get `kind` wrong if it cannot supply it.
    try {
      const download = await pickRelease(
        db,
        deps.defaultClient,
        { groupId: params.data.id, releaseId: body.data.releaseId },
        deps.now(),
      );
      // Read after the pick, not before: `markPicked` is what changes the
      // answer, and the answer is the whole point of returning it.
      const stillListed = browsableGroup(db, params.data.id);
      const response: PickResponse = {
        download: toDownloadView(db, download),
        group:
          stillListed === null
            ? null
            : viewOf(stillListed, getGroupMetadata(db, params.data.id), performersFor(params.data.id)),
      };
      return response;
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  server.get('/api/downloads', async () => ({
    tracked: allDownloads(db).map((download) => toDownloadView(db, download)),
    untracked: deps.untrackedFor(deps.defaultClient.id),
  }));

  // Retry is only ever meaningful for a `failed` row, and it is actively
  // dangerous for the others. Resetting a row that is still `queued`,
  // `downloading`, `completed` or `importing` races the reconcile tick that
  // owns it; resetting an `imported` upgrade re-runs an import whose work is
  // already done, which is the one operation in the system that starts by
  // moving files out of the library. The SPA only offers the control on a
  // failed row, but "the UI does not offer it" is not an access rule — the
  // API is the boundary, so the check belongs here.
  server.post('/api/downloads/:id/retry', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });
    const existing = getDownload(db, params.data.id);
    if (existing === null) {
      return reply.code(404).send({ error: 'No such download' });
    }
    if (existing.status !== 'failed') {
      return reply
        .code(409)
        .send({ error: `Only a failed download can be retried; this one is ${existing.status}` });
    }

    const download = resetForRetry(db, params.data.id, deps.now());
    if (download === null) return reply.code(404).send({ error: 'No such download' });
    return toDownloadView(db, download);
  });

  // The form schemas, keyed by plugin id because that is what a group row and a
  // `FailedItemView` both carry. A plugin with no usable field list is left out
  // entirely rather than mapped to an empty array: absence is already how the
  // SPA decides there is no form to offer.
  server.get('/api/manual-fields', async () => {
    const schemas: Record<string, readonly ManualField[]> = {};
    for (const plugin of deps.registry.all()) {
      const fields = fieldsFor(plugin);
      if (fields !== undefined) schemas[plugin.id] = fields;
    }
    return schemas;
  });

  server.get('/api/failed', async (request, reply) => {
    const query = failedQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });

    // Over-fetched by one for the same reason `/api/browse` is: a page that
    // comes back exactly `limit` long is otherwise ambiguous between "there is
    // more" and "that was exactly everything left."
    const overFetched = failedFeedItems(db, {
      cursor: parseFailedCursor(query.data.cursor),
      limit: query.data.limit + 1,
      includeDismissed: query.data.includeDismissed === '1',
    });
    const hasMore = overFetched.length > query.data.limit;
    const items = hasMore ? overFetched.slice(0, query.data.limit) : overFetched;

    const last = items.at(-1);
    const response: FailedResponse = {
      items: items.map((item) => toFailedItemView(item, deps.pluginForFeed(item.feedId))),
      nextCursor: hasMore && last !== undefined ? `${last.firstSeenAt}:${last.id}` : null,
    };
    return response;
  });

  // Each of the four routes below carries the status the operation chose rather
  // than deriving one: which refusal means 400, 404 or 409 is a rule about the
  // operation, and a second copy of it here would be free to drift from it.
  server.post('/api/feed-items/:id/resolve', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = valuesBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const result = resolveFeedItem(manual, params.data.id, body.data.values);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });

    const group = groupAfter(result.ok.groupId);
    if (group === null) return reply.code(404).send({ error: 'No such group' });
    const response: ResolveResponse = { group, joinedExisting: result.ok.joinedExisting };
    return response;
  });

  server.post('/api/feed-items/:id/dismiss', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });

    const result = dismissFeedItem(manual, params.data.id);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });
    return { id: params.data.id, dismissedAt: result.ok.dismissedAt };
  });

  server.patch('/api/groups/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = valuesBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const result = editGroup(manual, params.data.id, body.data.values);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });

    const group = groupAfter(result.ok.groupId);
    if (group === null) return reply.code(404).send({ error: 'No such group' });
    const response: GroupEditResponse = { group, mergedInto: result.ok.mergedInto };
    return response;
  });

  server.patch('/api/releases/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = valuesBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const result = editRelease(manual, params.data.id, body.data.values);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });

    // Read after the edit, and through `browsableGroup`: rescoring re-derives
    // the upgrade flag, and a picked group that was listed only because of that
    // flag leaves the browse list when the edit clears it. Answering with the
    // group anyway leaves the caller showing a card whose Pick button queues an
    // upgrade — trashing the live file for a release that just got worse.
    const after = listedAfter(result.ok.groupId);
    if ('missing' in after) return reply.code(404).send({ error: 'No such group' });
    const response: ReleaseEditResponse = { group: after.listed };
    return response;
  });

  // Writes nothing: it exists because a wrong manual identity is as durable as
  // a right one, and seeing the key before saving is the only guard against one.
  server.post('/api/manual-preview', async (request, reply) => {
    const body = previewBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });

    const plugin = deps.registry.byId(body.data.plugin);
    if (plugin === undefined) {
      return reply.code(404).send({ error: `No plugin loaded for id ${body.data.plugin}` });
    }
    const fromValues = plugin.fromManualValues;
    if (fromValues === undefined) {
      return reply
        .code(409)
        .send({ error: `plugin ${plugin.id} cannot build a release from typed values` });
    }

    // Rejected values answer 200 with `{ error }`, not a 4xx. The form calls
    // this on a debounce while the user is still typing, so a half-filled form
    // is the normal case and the plugin's complaint is a legitimate answer to
    // "what would these values produce?" — not a failed request. The SPA's
    // fetch helper throws on any non-2xx, which would turn every keystroke
    // before the last into an error. A malformed body above is a different
    // thing: the caller, not the values, is wrong.
    let built: { media: ParsedRelease } | { error: string };
    try {
      built = fromValues.call(plugin, body.data.values);
    } catch (error) {
      return { error: `plugin threw: ${(error as Error).message}` };
    }
    if ('error' in built) return { error: built.error };

    // The same identity checks a save would apply, so a preview cannot show a
    // key that a *group edit* would then refuse — `editGroup` runs exactly this
    // validator and nothing else.
    //
    // A resolve is not fully covered, and saying otherwise would overstate the
    // guard. `resolveFeedItem` goes through `validateParsed`, which is this
    // plus the quality half: it calls `plugin.score()` on the values and
    // refuses a score that is not a finite number. Those are quality-scoped
    // fields, and the identity key this returns is unaffected by them — so
    // what the preview shows is still right, but a resolve carrying the shown
    // key can still be refused for a reason the preview never asked about.
    const validated = validateIdentity(built.media);
    if ('error' in validated) return { error: validated.error };
    return { identityKey: validated.identity.identityKey };
  });

  if (deps.webRoot !== null) {
    void server.register(fastifyStatic, { root: deps.webRoot });
    // Any non-API path is a client route; hand back the SPA shell. This must
    // never shadow an API 404: the check below is the only thing keeping a
    // typo'd or removed API route from silently returning the SPA shell
    // instead of a 404, so it must stay in front of the sendFile fallback.
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return server;
}
