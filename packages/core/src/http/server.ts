import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { chmod, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { backup, type DatabaseSync } from 'node:sqlite';
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
import { getDownload, pageOfDownloads, resetForRetry } from '../db/downloads.ts';
import { failedFeedItems } from '../db/feed-items.ts';
import {
  enqueueMetadata,
  enqueueRefresh,
  getGroupMetadata,
  metadataForGroups,
  queuedMetadataNextAt,
  requeueMetadata,
  type GroupMetadata,
} from '../db/metadata.ts';
import { getPerformer, performersForGroups, type PerformerRow } from '../db/performers.ts';
import { validateIdentity } from '../ingest/commit.ts';
import { planIdentityChange } from '../manual/identity-plan.ts';
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
  toDownloadViews,
  toFailedItemView,
  toGroupView,
  type BrowseResponse,
  type ConfigResponse,
  type ConfigSaveResponse,
  type DownloadsResponse,
  type FailedResponse,
  type GroupEditResponse,
  type GroupView,
  type IdentityPlanResponse,
  type MetadataRequestResponse,
  type MetadataRequeryResponse,
  type MetadataView,
  type PickResponse,
  type ReleaseEditResponse,
  type ResolveResponse,
} from './views.ts';

export interface ServerDeps {
  db: DatabaseSync;
  /**
   * The download client a pick on this feed goes to, or null when that feed
   * has left configuration. Mirrors `pluginForFeed` below, and for the same
   * reason: only configuration holds the mapping, and a feed item has neither
   * a group nor a release to hang it off.
   *
   * This replaced a single `defaultClient`, which was `downloadClients[0]` and
   * the only client anything here could ever name — a second configured client
   * was polled, reconciled and imported from, but nothing could route a pick
   * to it (#34). A one-client config resolves every feed to that one client,
   * so it is unaffected.
   */
  clientForFeed(feedId: string): DownloadClient | null;
  /**
   * Every configured client's untracked entries, not one client's. Each entry
   * carries its own `clientId`, which is what keeps two clients' identically
   * `ref`-ed jobs apart downstream.
   */
  untrackedAll(): UntrackedEntry[];
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
   */
  requestRestart(): void;
  /**
   * `config.trashDir`, passed in rather than re-read here for the same reason
   * `artworkDir` is: this module has no other business knowing the config
   * document's shape, and a second read is how the two copies drift.
   */
  trashDir: string;
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

/**
 * The same two fields `browseQuerySchema` has, and deliberately no `q`. The
 * Downloads screen's search box still filters in the client; moving that term
 * into SQL changes what the box *means* — it would reach rows no page has
 * loaded — and belongs with the rest of issue #31 rather than smuggled in
 * behind the pagination.
 */
const downloadsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(30),
});

/**
 * How long a `'none'` answer stands before viewing the group asks again.
 *
 * A `'none'` is settled — the provider was asked and had nothing — but "had
 * nothing" is a fact about a moment, not forever: scenes are added to the
 * provider after release, so the answer for a fresh release is routinely no and
 * later yes. Without a window, `/api/metadata/request` treated the first no as
 * final and the group was never looked up again for the life of the database.
 *
 * Thirty-six hours rather than twenty-four so the re-ask does not land at the
 * same time of day it last ran — a group viewed each evening would otherwise sit
 * just under a 24-hour bar every time and never refresh at all. Long enough that
 * a library browsed daily costs one extra provider request per empty group every
 * day and a half, which the worker's own `perTick` already paces.
 */
const METADATA_RETRY_AFTER_MS = 36 * 60 * 60 * 1000;

/** Whether a recorded answer has gone stale enough to be worth asking again. */
function worthReasking(answer: GroupMetadata, now: number): boolean {
  // Only an empty answer. A confirmed scene is not re-asked at any age: that is
  // a different feature with a different cost, and folding it in here silently
  // would multiply provider traffic by the size of the library.
  return answer.state === 'none' && now - answer.fetchedAt >= METADATA_RETRY_AFTER_MS;
}

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
 * A digit-only non-negative integer, stricter than `Number()`/`z.coerce.number()`.
 * Those accept `"+1"`, `"1e3"`, `"0x10"`, and surrounding whitespace, and —
 * worse — two different huge digit strings past `Number.MAX_SAFE_INTEGER`
 * ("9007199254740993" and "9007199254740992") silently collapse to the same
 * value. `/^\d+$/` plus `Number.isSafeInteger` rejects all of that at the
 * boundary, so a malformed number 400s instead of quietly meaning some other one.
 */
function parseNonNegativeInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The above, minus zero: every id here is a SQLite rowid, and rowids start at 1.
 */
function parsePositiveInt(raw: string): number | null {
  const value = parseNonNegativeInt(raw);
  return value !== null && value > 0 ? value : null;
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
// `planDigest` is optional at the schema level because a display-only edit
// needs none — `editGroup` is what actually enforces which edits require one,
// and it is enforced there rather than here for the same reason the four
// routes above read their own status rather than a second copy of the rule.
const editBodySchema = z.object({
  values: z.record(z.string(), z.string()),
  planDigest: z.string().optional(),
});
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
      // Shape only, per the note above: whether this names a client the
      // `downloadClients` block actually configures is `parseConfig`'s
      // question, asked of the merged document.
      downloadClient: z.string(),
      // Shape only, per the note above: the `min(2)` on `pagesPerPass` and the
      // rest of the value rules stay in `feedBackfillSchema`, which
      // `parseConfig` runs over the merged document.
      backfill: z
        .object({
          style: z.enum(['newznab', 'page']),
          pageSize: z.number(),
          pagesPerPass: z.number(),
          maxPages: z.number(),
        })
        .nullable(),
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

/**
 * One page boundary, in the neutral shape both paginated lists share. `sortKey`
 * is whichever column that list orders on — `media_groups.list_rank_at` for
 * browse, `feed_items.first_seen_at` for failed — and the caller renames it to
 * its own column on the way into the query.
 */
interface KeysetCursor {
  sortKey: number;
  id: number;
}

/**
 * The `"<sort key>:<id>"` string a paginated route minted as its `nextCursor`,
 * or `null` when the text is not one of those.
 *
 * `null` means *malformed*, and both callers answer it with a 400. It used to
 * mean "start from the beginning", which is issue #33: the SPA appends each page
 * to what is already on screen and then pages on with the cursor it was handed,
 * so a cursor quietly refused here is answered with page one — whose
 * `nextCursor` is the one page two was fetched with, so the list serves the same
 * cards over and over and the scroll never terminates. A stale bookmark, a
 * hand-edited query or anything but the SPA is enough to reach that; the rule is
 * that a cursor must never silently name a page other than the one asked for.
 *
 * Where the boundary sits, deliberately:
 *
 * - `"100:2:3"` is refused. The previous `split(':')` into two bindings dropped
 *   everything after the second colon, so it read as the page after `100:2` — a
 *   real page, and not the one requested. What refuses it is the digits-only
 *   parse below, not the split direction: either half would fail that check
 *   whichever colon is split on. Splitting at the *last* one is only so that the
 *   id, the half whose format is fixed, is the one anchored. Note that a sort key
 *   containing a colon would not work here today regardless — the left half goes
 *   straight to `parseNonNegativeInt` — so a list that sorted on something
 *   colon-joined, as plugin ids and identity keys elsewhere here are, would need
 *   that parser changed too.
 * - Both halves are parsed digits-only, for `parseNonNegativeInt`'s reasons: a
 *   sort key of `"1e3"`, `"0x10"`, `"+1"` or `" 1"` is not something either
 *   route could have minted, and past `Number.MAX_SAFE_INTEGER` two different
 *   digit strings collapse onto one boundary, which would skip or repeat rows.
 * - The sort key may be `0` where the id may not: ids are rowids, but both sort
 *   keys are epoch-millisecond stamps taken from an injected clock, and `0` is a
 *   value such a clock hands out.
 * - A well-formed cursor whose row has since left the list is *not* malformed and
 *   is not rejected: the keyset comparison is `(sortKey, id)` against the index
 *   rather than a lookup of that row, so it still names the right boundary. Both
 *   ways a row leaves are ordinary and happen while a reader is paging — browse's
 *   groups are really deleted (`deleteGroup`, and the re-keying migrations), while
 *   a failed item is never deleted at all and instead stops matching
 *   `parse_error IS NOT NULL` once it is resolved. 400ing on either would break
 *   paging during normal operation.
 */
function parseCursor(raw: string): KeysetCursor | null {
  const separator = raw.lastIndexOf(':');
  if (separator === -1) return null;
  const sortKey = parseNonNegativeInt(raw.slice(0, separator));
  const id = parsePositiveInt(raw.slice(separator + 1));
  if (sortKey === null || id === null) return null;
  return { sortKey, id };
}

/**
 * The boundary a paginated route should read from: `null` when the caller sent
 * no cursor at all, which is the first-page request every list starts with, and
 * an error only when one was sent that cannot be read. Absence and
 * unreadability were the same answer before issue #33, which is exactly how a
 * broken cursor passed for a first page.
 */
function cursorFrom(raw: string | undefined): { cursor: KeysetCursor | null } | { error: string } {
  if (raw === undefined) return { cursor: null };
  const cursor = parseCursor(raw);
  return cursor === null ? { error: 'Invalid cursor' } : { cursor };
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
    trashDir: deps.trashDir,
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

    // `process.pid` alone is not unique enough: two overlapping saves in this
    // same process would both write `${configPath}.tmp-${pid}`, and whichever
    // `rename` loses would 500 with `ENOENT` for a save that otherwise
    // succeeded. `randomUUID()` gives each save its own file regardless of how
    // many are in flight at once.
    const temporary = `${deps.configPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      // Left to itself, `writeFile` creates the temp file at `0666 & ~umask`
      // and `rename` carries that mode onto `config.json` — silently widening
      // a file that holds literal api keys on every successful save. Matching
      // the mode already on disk keeps that permission the user's (or the
      // documented `chmod 600`'s) call, not this route's. A file that cannot
      // be stat'd (first-ever save, or the file went missing under us) gets
      // the restrictive default rather than the permissive one.
      let mode = 0o600;
      try {
        mode = (await stat(deps.configPath)).mode & 0o777;
      } catch {
        // New or unreadable: fall through to the restrictive default above.
      }
      // Both steps are load-bearing, for different reasons. The `mode` option
      // is applied by `open(O_CREAT)` itself, so the file never exists at the
      // default `0666 & ~umask` even momentarily — without it there is a
      // window, however short, where a config full of api keys is world-
      // readable in the config directory. But that option is *masked* by
      // umask, so it cannot widen: targeting `0640` under umask 027 creates
      // `0600`. The `chmod` is what lands the mode exactly, and it can only
      // ever run against a file this request created (the name carries a
      // `randomUUID`), so it cannot touch anything else.
      await writeFile(temporary, `${JSON.stringify(merged.document, null, 2)}\n`, {
        encoding: 'utf8',
        mode,
      });
      await chmod(temporary, mode);
      await rename(temporary, deps.configPath);
    } catch (error) {
      // Best-effort: if the rename is what failed, the temp file is still
      // there, and leaving it beside a live config.json is its own small mess.
      await rm(temporary, { force: true });
      return reply.code(500).send({ error: `Could not write ${deps.configPath}: ${(error as Error).message}` });
    }

    // Computed the same way `GET /api/config` computes it — against the
    // document this process booted from — so the two routes can never
    // contradict each other. A save that writes back exactly what boot saw
    // (including one that keeps every secret) needs no restart, and the SPA
    // reads both responses.
    const response: ConfigSaveResponse = {
      savedAt: deps.now(),
      restartRequired: !isDeepStrictEqual(merged.document, deps.bootConfigDocument),
    };
    return response;
  });

  /**
   * 202, then shut down — in that order, and that is the whole subtlety. The
   * restart is hung off the reply's `finish` event so the acknowledgement is on
   * the wire before teardown begins; restarting first would give the browser a
   * dropped connection, which is indistinguishable from a crash.
   */
  server.post('/api/restart', async (_request, reply) => {
    reply.raw.once('finish', () => {
      deps.requestRestart();
    });
    return reply.code(202).send({ restarting: true });
  });

  /**
   * A consistent copy of the database, streamed as a download.
   *
   * `backup` is SQLite's online backup API: it is safe against a WAL database
   * with writers active, which is the entire reason this is worth offering
   * instead of telling someone to `cp` the file and hope.
   *
   * The temporary file is unlinked as soon as its read stream is backed by an
   * open file handle. POSIX keeps the bytes alive until the last descriptor
   * closes, so the download still works while there is no longer a name for
   * the copy on disk — which means an aborted download, a disconnected
   * client, or a killed process cannot strand a multi-megabyte file in the
   * config volume. The one exception is a failed unlink itself: see the
   * inner catch below, which leaves the file in place on purpose rather than
   * failing a backup that has already succeeded.
   *
   * The handle is opened with `open()` and unlinked only once its own
   * `createReadStream()` exists, never by calling `createReadStream(path)`
   * and then unlinking the path: that function schedules the underlying
   * open on the libuv threadpool rather than performing it synchronously, so
   * an immediate `rm` can win the race and the deferred open then fails with
   * ENOENT. Going through the handle makes the open happen first, provably.
   *
   * `handle` is declared above the `try` rather than inside it, so the catch
   * below can close it if `open()` succeeded but a later step failed first.
   * `stream` is declared alongside it only so both can be typed together and
   * so it is in scope for the `return` after the `try`; the catch never
   * needs to touch `stream` itself — see the reachability note there.
   *
   * A GET, not a POST: it does not change the database, and a plain GET is what
   * lets the browser use the filename chosen below.
   */
  server.get('/api/database/backup', async (_request, reply) => {
    const stamp = new Date(deps.now()).toISOString().slice(0, 10);
    // `randomUUID()` alongside `process.pid`, for the same reason `PUT
    // /api/config`'s own temp file carries one: two backup requests landing
    // in this process within the same millisecond would otherwise both name
    // the same temp path and corrupt each other's copy.
    const temporary = join(
      dirname(deps.databasePath),
      `.pickarr-backup-${process.pid}-${randomUUID()}.tmp`,
    );

    let handle: FileHandle | undefined;
    let stream: ReadStream | undefined;
    let bytes: number;
    try {
      await backup(deps.db, temporary);
      handle = await open(temporary, 'r');
      bytes = (await handle.stat()).size;
      // Opened above, so the data survives losing its name; see the doc
      // comment above. The stream closes the handle itself once it ends, so
      // nothing on this path leaks a descriptor.
      stream = handle.createReadStream();
      try {
        await rm(temporary, { force: true });
      } catch {
        // Best-effort past this point on purpose: `stream` already holds its
        // own descriptor, so the backup is complete and servable either way.
        // Failing the whole request over a failed `rm` here would discard a
        // backup that actually succeeded, over a problem no worse than the
        // temp file occasionally outliving this one request instead of
        // disappearing the instant its descriptor opened. Logged, not just
        // swallowed: this is the one path where the file genuinely needs
        // pruning by hand, and silence here would be the only way to never
        // find that out.
        console.warn(`pickarr: could not remove backup temp file ${temporary}; leaving it in place`);
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      // `stream` is never reachable from here: everything from
      // `createReadStream()` onward either succeeds or is caught by the
      // inner catch above and never rethrows. So the only descriptor a
      // failure landing in this catch can find open is `handle` itself —
      // `open()` succeeded but `handle.stat()` (or, in principle,
      // `createReadStream()`) then threw.
      if (handle !== undefined) await handle.close().catch(() => {});
      return reply.code(500).send({ error: `Backup failed: ${(error as Error).message}` });
    }

    return reply
      .type('application/octet-stream')
      .header('content-disposition', `attachment; filename="pickarr-${stamp}.db"`)
      .header('content-length', bytes)
      .send(stream);
  });

  server.get('/api/browse', async (request, reply) => {
    const query = browseQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });
    const from = cursorFrom(query.data.cursor);
    if ('error' in from) return reply.code(400).send({ error: from.error });
    const { cursor } = from;

    // Fetched one row past the requested page so a page that is exactly
    // `limit` long can be told apart from the last page: without the extra
    // row, "the page came back exactly `limit` long" is ambiguous between
    // "there is more" and "that was exactly everything left."
    const overFetched = browseGroups(db, {
      cursor: cursor === null ? null : { listRankAt: cursor.sortKey, id: cursor.id },
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
      refreshed: [],
    };
    // Split, because the two lists cannot go through the same enqueue: an id
    // that has never been answered is `enqueueMetadata`'s business, and one
    // being deliberately re-asked despite its answer is `enqueueRefresh`'s.
    const askable: number[] = [];
    const refreshable: number[] = [];

    for (const groupId of body.data.groupIds) {
      const answer = getGroupMetadata(db, groupId);
      // Settled, and not yet stale enough to revisit — cheaper to notice here
      // than to let `enqueueMetadata` notice it again per id inside its own
      // transaction below.
      if (answer !== undefined && !worthReasking(answer, now)) {
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
        //
        // A stale `'none'` that is *still* unaskable lands here too, and is
        // simply re-answered — one cheap write per group per window, and no
        // provider request. Not special-cased out, because answerability is not
        // permanent: a group unaskable only because its site had not been
        // discovered yet becomes askable once it has, and this is the path that
        // notices.
        answerUnaskable(db, groupId, now);
        result.alreadyAnswered += 1;
        continue;
      }
      if (answer === undefined) askable.push(groupId);
      else refreshable.push(groupId);
    }

    // `enqueueMetadata` is itself idempotent — it treats an id that is
    // already answered or already waiting as `alreadyAnswered`/`pending`
    // rather than inserting a duplicate row — so a repeat of the same request
    // (the whole point of a lazy, client-driven trigger) is safe to re-issue.
    const enqueued = enqueueMetadata(db, askable, now);
    result.queued += enqueued.queued;
    result.alreadyAnswered += enqueued.alreadyAnswered;
    result.pending += enqueued.pending;

    // Every id in `refreshable` comes out of this holding a queue row — inserted
    // now, or already there from an earlier view — so the whole list is what the
    // SPA must start watching again, not just the freshly inserted half. An id
    // whose row was already waiting still has an answer coming that the client
    // has stopped listening for.
    const refreshed = enqueueRefresh(db, refreshable, now);
    result.queued += refreshed.queued;
    result.pending += refreshed.pending;
    result.refreshed = refreshable;
    return result;
  });

  // The per-card counterpart to the lazy trigger above: a settled group is
  // this route's precondition, not something it refuses, so — unlike
  // `/api/metadata/request` — `getGroupMetadata` is never consulted here to
  // short-circuit an id as already answered. Reuses that route's body schema
  // and id cap rather than declaring a second, identical one: the two bodies
  // are the same shape (a page's worth of group ids), and a second schema
  // here would just be a second place for the cap to drift from.
  server.post('/api/metadata/requery', async (request, reply) => {
    const body = metadataRequestBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });

    const now = deps.now();
    const result: MetadataRequeryResponse = {
      requeued: 0,
      missing: 0,
      unavailable: 0,
      unaskable: 0,
    };
    const askable: number[] = [];
    // `requeueMetadata` has no per-id existence check of its own (a missing
    // id would fail the insert via `metadata_queue`'s foreign key, and with
    // it the whole batch, since every id runs in one transaction) and no
    // dedup either — it reports `groupIds.length` back as `requeued`
    // directly, so a repeated id would inflate that count past the number of
    // rows actually touched. Deduping the request once, up front, satisfies
    // both: every id below is classified exactly once, and the list handed
    // to `requeueMetadata` can never repeat one.
    const seen = new Set<number>();

    for (const groupId of body.data.groupIds) {
      if (seen.has(groupId)) continue;
      seen.add(groupId);

      const group = getGroup(db, groupId);
      // Same reasoning as `/api/metadata/request`: a group that no longer
      // exists cannot be queued, and there is nothing to answer either.
      if (group === null) {
        result.missing += 1;
        continue;
      }

      // Same reasoning as `/api/metadata/request`: no worker is running to
      // ever drain a row this would create, and that is a fact about how
      // Pickarr is configured right now, not about the group — so it is
      // never written to `group_metadata` here either.
      if (!deps.metadataAvailable) {
        result.unavailable += 1;
        continue;
      }

      const plugin = deps.registry.byId(group.plugin) ?? null;
      if (metadataAnswerability(plugin, group) === 'unaskable') {
        // Deliberately *not* `answerUnaskable`, unlike `/api/metadata/request`
        // above: that call exists to settle a row that had no answer yet, and
        // this group already has one. Calling it again would just rewrite
        // `fetched_at` on a row that is never going to be re-asked.
        result.unaskable += 1;
        continue;
      }
      askable.push(groupId);
    }

    result.requeued = requeueMetadata(db, askable, now);
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
        (feedId) => deps.clientForFeed(feedId),
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

  server.get('/api/downloads', async (request, reply) => {
    const query = downloadsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });
    // Refused with the same message `/api/browse` and `/api/failed` use, from
    // the same parser: three lists paging identically, and a cursor rule that
    // held on only two of them would leave the third scrolling forever (#33).
    const from = cursorFrom(query.data.cursor);
    if ('error' in from) return reply.code(400).send({ error: from.error });
    const { cursor } = from;

    // Over-fetched by one for the reason the other two lists are: a page that
    // comes back exactly `limit` long is otherwise ambiguous between "there is
    // more" and "that was exactly everything left."
    const overFetched = pageOfDownloads(db, {
      cursor: cursor === null ? null : { createdAt: cursor.sortKey, id: cursor.id },
      limit: query.data.limit + 1,
    });
    const hasMore = overFetched.length > query.data.limit;
    const rows = hasMore ? overFetched.slice(0, query.data.limit) : overFetched;

    // One query for the whole page's groups, not one per row: this route is
    // what `metadataForGroups` and the `viewOf` doc comment above both point at
    // as the defect, and this is where it stops being one.
    const last = rows.at(-1);
    const response: DownloadsResponse = {
      tracked: toDownloadViews(db, rows),
      // Unpaginated, and staying that way. It is a read of the scheduler's
      // in-memory map (`untrackedAll`), bounded by what the clients are
      // actually running rather than by how much history the database holds,
      // and never a query. It rides on every page for the same reason: there is
      // no cheaper moment to send it.
      untracked: deps.untrackedAll(),
      nextCursor: hasMore && last !== undefined ? `${last.createdAt}:${last.id}` : null,
    };
    return response;
  });

  // Retry is only ever meaningful for a `failed` row, or a row the reconcile
  // tick has marked absent, and it is actively dangerous for the others.
  // Resetting a row that is still `queued`, `downloading` (and seen), `completed`
  // or `importing` races the reconcile tick that owns it; resetting an
  // `imported` upgrade re-runs an import whose work is already done, which is
  // the one operation in the system that starts by moving files out of the
  // library. An absent row is the exception: reconcile now never fails a
  // download purely for being missing from the client (a transient snapshot
  // gap must not read as "gone"), so a genuinely-lost download would
  // otherwise sit in `downloading` forever with no way back — no retry, and
  // (since `inFlightForRelease` excludes only `failed`) no way for its
  // release to be picked again either. Accepting `absentSince !== null` here
  // is what makes "never auto-fail" a safe policy instead of a trap. The SPA
  // only offers the control on a failed or absent row, but "the UI does not
  // offer it" is not an access rule — the API is the boundary, so the check
  // belongs here.
  server.post('/api/downloads/:id/retry', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });
    const existing = getDownload(db, params.data.id);
    if (existing === null) {
      return reply.code(404).send({ error: 'No such download' });
    }
    if (existing.status !== 'failed' && existing.absentSince === null) {
      return reply.code(409).send({
        error: `Only a failed or absent download can be retried; this one is ${existing.status}`,
      });
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
    // Refused for the same reason and with the same message `/api/browse` uses:
    // the two lists page identically, and a cursor rule that held on only one
    // of them would leave the other scrolling forever.
    const from = cursorFrom(query.data.cursor);
    if ('error' in from) return reply.code(400).send({ error: from.error });
    const { cursor } = from;

    // Over-fetched by one for the same reason `/api/browse` is: a page that
    // comes back exactly `limit` long is otherwise ambiguous between "there is
    // more" and "that was exactly everything left."
    const overFetched = failedFeedItems(db, {
      cursor: cursor === null ? null : { firstSeenAt: cursor.sortKey, id: cursor.id },
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

  // Each of the five routes below carries the status the operation chose rather
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

  /**
   * Everything an identity change would do, and nothing done. Writes nothing —
   * a POST only because the values are a form's worth of fields and belong in
   * a body, not because anything changes. `/api/manual-preview` further down
   * makes the same GET-vs-POST call for the same method-honesty reason.
   */
  server.post('/api/groups/:id/identity-plan', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = valuesBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const result = await planIdentityChange(manual, params.data.id, body.data.values);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });
    const response: IdentityPlanResponse = result.ok;
    return response;
  });

  server.patch('/api/groups/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = editBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    // `planDigest` is forwarded as-is, undefined and all: `editGroup` is what
    // decides whether this edit needed one, and a missing digest and a stale
    // one are the same refusal there for the same reason — both mean the user
    // did not confirm *this* plan.
    const result = await editGroup(manual, params.data.id, body.data.values, body.data.planDigest);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });

    const group = groupAfter(result.ok.groupId);
    if (group === null) return reply.code(404).send({ error: 'No such group' });
    const response: GroupEditResponse = {
      group,
      mergedInto: result.ok.mergedInto,
      renamed: result.ok.renamed,
      trashed: result.ok.trashed,
      failed: result.ok.failed,
    };
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
