/**
 * The lookup flow, shared by every plugin built on this package.
 *
 * The branch below is the whole reason this is one engine and not three
 * plugins: the order the outcomes are read in is a correctness property, not a
 * style, and `PluginContext`'s own documentation warns about two of them.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import type {
  DownloadedFile,
  ImportPlacement,
  JobHandler,
  MediaPlugin,
  MediaType,
  Migration,
  PluginContext,
  PluginTokens,
  SyncedTable,
  TokenValues,
} from '@pickarr/contract';
import { eq, inArray } from 'drizzle-orm';
import { drizzle as createDrizzle } from 'drizzle-orm/node-sqlite';
import type { ArtworkJobPayload, ArtworkJobPerson } from './artwork/job.ts';
import { ARTWORK_JOB, createArtworkJob } from './artwork/job.ts';
import type { LookupCategory, SecretResolver } from './types.ts';
import type { LookupEnvelope, Media, MediaSuggestions } from './types.ts';
import { MAX_BATCH, createLookupClient } from './client.ts';
import { lookupTable, lookupTableMigration } from './table.ts';
import { lookupJsonFor } from './lookupJson.ts';
import { isPlaced, recordPlacement } from './placement.ts';
import { select } from './select.ts';
import type { Expectation } from './select.ts';

export const LOOKUP_JOB = 'lookup';
export const POLL_JOB = 'poll';

/** How long a poll waits before asking again. */
export const POLL_DELAY_MS = 30_000;

/**
 * How many polls one lookup may spend.
 *
 * A poll that answers "not yet" enqueues the *next* poll, so the job runner's
 * `attempts` never rises and nothing else bounds the sequence. Twenty polls at
 * thirty seconds is ten minutes, after which the item is left `unresolved`
 * naming its lookup id -- visible, rather than `pending` forever.
 */
export const MAX_POLLS = 20;

export type LookupDb = ReturnType<typeof createDrizzle>;
export type LookupStateTable = ReturnType<typeof lookupTable>;

/** What a plugin is handed for its own rows. `raw` is already narrowed. */
export interface ApplyArgs {
  readonly media: Media;
  readonly mediaItemId: number;
  readonly raw: DatabaseSync;
  readonly ctx: PluginContext;
  readonly now: number;
}

/** Which rss item an answer is about, and how many polls it has already cost. */
export interface ApplyTarget {
  readonly rssItemId: number;
  readonly filename: string;
  readonly polls: number;
}

export interface EnvelopeDeps {
  readonly pluginId: string;
  readonly ctx: PluginContext;
  readonly raw: DatabaseSync;
  readonly db: LookupDb;
  readonly table: LookupStateTable;
  readonly now: number;
  /** The plugin's pre-flight. See `LookupPluginSpec.check`. */
  check(media: Media): void;
  apply(args: ApplyArgs): Promise<void>;
}

/**
 * What to tell a human about a name the service did not recognise.
 *
 * A lookup for something the provider has not indexed fails the same way as
 * one we misread, and `suggestions` is how the two are told apart: "we have
 * never seen this" against "we know the site, not the scene".
 */
export function describeUnresolved(filename: string, suggestions: MediaSuggestions | null): string {
  const parts: string[] = [];
  if (suggestions !== null) {
    if (suggestions.site !== null) parts.push(`site ${suggestions.site.name}`);
    if (suggestions.performers.length > 0) {
      parts.push(`performers ${suggestions.performers.map((person) => person.name).join(', ')}`);
    }
  }
  if (parts.length === 0) return `the lookup service did not recognise "${filename}"`;
  return `the lookup service recognised ${parts.join(' and ')} in "${filename}", but not the item itself`;
}

/**
 * The service's people, de-duplicated by the provider's own person id as they
 * are written, in the order the service gave them -- and the rows it wrote,
 * for the artwork job to fetch pictures for.
 *
 * **Returning them rather than `void` is what makes the artwork payload
 * truthful.** `ArtworkJobPayload.people` has to name people the database
 * actually holds, and `MediaWriter.upsertPerson` is the only thing that
 * decides that: it is keyed on `provider_ref`, so the answer's list of
 * *parts* is not the list of *people* -- a cast member who also directs
 * appears twice in `media.people` and is one `person` row. Building the
 * payload from `media.people` here would name that person twice and fetch
 * the same picture twice, and it could not name them at all in the
 * vocabulary the writer needs: `attachPersonImage` takes a `personId`, and
 * `media.people` carries no id, only the provider's ref.
 *
 * So the de-duplication is on `providerRef`, which is the key the upsert
 * itself dedupes on: one entry per person row written, in the order each
 * ref **first appears in `media.people`** -- list order, not billing order.
 * The two coincide whenever the service billing-orders its answer, and
 * nothing here makes them coincide: a person whose non-billed part arrived
 * first would be emitted at that part's position.
 *
 * That is fine, and deliberately unsorted. Nothing downstream reads this
 * order -- `./artwork/job.ts` passes the refs to `imagesFor` as a list to
 * look up and attaches each picture by its own `personId` -- so there is no
 * promise here for a sort to keep. The roles themselves are a separate
 * matter and do keep their order: `attachRole` above is called once per
 * entry, in the order the service gave them, which is what carries
 * `billingOrder` to the database.
 */
async function attachPeople(
  media: Media,
  mediaItemId: number,
  ctx: PluginContext,
): Promise<ArtworkJobPerson[]> {
  const written = new Map<string, ArtworkJobPerson>();
  for (const person of media.people) {
    // eslint-disable-next-line no-await-in-loop -- one person at a time: `attachRole` needs the id this upsert returns, and the roles have to land in billing order
    const personId = await ctx.media.upsertPerson({ name: person.name, providerRef: person.providerRef });
    // eslint-disable-next-line no-await-in-loop -- see above; this is the same person's own role
    await ctx.media.attachRole(mediaItemId, {
      personId,
      role: person.role,
      name: person.characterName,
      billingOrder: person.billingOrder,
    });
    if (!written.has(person.providerRef)) {
      written.set(person.providerRef, { personId, providerRef: person.providerRef });
    }
  }
  return [...written.values()];
}

/**
 * A resolved answer, in the one order that survives a lost dedup race.
 *
 * The media item is created late -- after the answer arrived -- so no outcome
 * that identifies nothing has a row to clean up. `MediaWriter` does offer
 * `updateMediaItem`, so creating early is implementable; it would only add a
 * row to drop on every refusal.
 *
 * There are **four** such outcomes, not the three `applyEnvelope`'s branch
 * reads: the fourth is the plugin refusing an answer it cannot represent, and
 * `deps.check` below is why that one also lands before anything is written.
 * An answer whose `kind` cannot belong to this plugin's category used to be
 * refused inside `spec.apply` -- by which point the media item existed, held
 * the provider-ref claim, and had the rss item relinked to it, with the
 * resolution left `pending` forever and nothing on any path to undo any of
 * it. The pre-flight is deliberately cheap and synchronous: it reads the
 * answer and nothing else, so there is no failure of its own for it to add.
 */
async function applyResolved(
  envelope: LookupEnvelope,
  media: Media,
  target: ApplyTarget,
  deps: EnvelopeDeps,
): Promise<void> {
  const { ctx } = deps;
  deps.check(media);

  const mine = await ctx.media.createMediaItem({
    pluginId: deps.pluginId,
    title: media.title,
    releaseDate: media.releaseDate,
    description: media.overview,
  });

  const claim = await ctx.media.claimProviderRef(mine, media.provider, media.providerRef);
  if (claim.dropped !== null) {
    // Lost the race. Nothing points at our row yet -- the rss item is linked
    // below, to whichever row kept the reference -- so dropping it now leaves
    // nothing dangling.
    await ctx.media.dropMediaItem(claim.dropped);
  }
  await ctx.media.relinkRssItem(target.rssItemId, claim.kept);

  await deps.db.update(deps.table)
    .set({
      mediaItemId: claim.kept,
      lookupId: envelope.lookupId,
      providerRef: media.providerRef,
      confidence: envelope.confidence,
      updatedAt: deps.now,
    })
    .where(eq(deps.table.rssItemId, target.rssItemId));

  // Against `claim.kept`, which may be a row another item wrote: every write
  // a plugin's `apply` makes is an upsert keyed on the media item or a
  // provider reference, so re-applying the winner's own answer is a no-op
  // rather than a duplicate.
  await deps.apply({ media, mediaItemId: claim.kept, raw: deps.raw, ctx, now: deps.now });
  const people = await attachPeople(media, claim.kept, ctx);
  // `null` for the answer, and by the time this runs there is nothing left
  // to clear: `relinkRssItem` above already cleared `lookup_json` in the
  // same statement that set `media_item_id`, because a stored answer is
  // only reachable while a release is unmatched. Passing `null` anyway is
  // not ceremony -- `setResolution`'s fourth argument is required exactly
  // so no branch can forget what it means to do, and a resolved release
  // carrying an answer would be a contradiction whichever statement wrote
  // it.
  //
  // **This line used to be the clear, and that was the bug.** `apply` and
  // `attachPeople` sit between the link and here; a throw in either left
  // the row linked with its answer retained, and the job retries and then
  // dead-letters, so a persistently failing `apply` stranded it for good
  // on a row `/unmatched` no longer shows.
  await ctx.media.setResolution(target.rssItemId, 'resolved', null, null);

  // Artwork, in a job of its own and enqueued last.
  //
  // **Last, because a job that ran before the line above could read this
  // release mid-identification.** That is not theoretical: `host.ts`'s
  // `JobQueue.enqueue` re-arms the dispatcher on the spot, and the
  // dispatcher runs eight jobs at once by default, so the artwork handler
  // can start before the handler that queued it has returned.
  //
  // **Caught, because a failure to queue artwork must not un-identify the
  // release.** That is the whole premise of `./artwork/job.ts` being a
  // separate job: the item is identified by the statement above, and
  // letting this throw would fail the lookup job, put it on the runner's
  // backoff curve and re-run every write here -- all of them idempotent, so
  // the retry is harmless and also pointless, and after the last attempt
  // the job dead-letters over a missing poster. What is lost instead is
  // this item's artwork until it is identified again, which is what the log
  // line says.
  try {
    const payload: ArtworkJobPayload = {
      mediaItemId: claim.kept,
      kind: media.kind,
      provider: media.provider,
      providerRef: media.providerRef,
      people,
      // The ancestors, nearest first as the service ordered them, so a
      // source can answer a kind it has no endpoint for from the nearest
      // one it does -- which is the whole of a television library's
      // artwork, since a tv lookup resolves to `episode`, `season` or
      // `series` and TMDB addresses only the last.
      //
      // Filtered to this item's own provider: a parent's `providerRef` is
      // only meaningful to the provider that issued it, and the source
      // being asked is the one `media.provider` names. Nothing observed
      // here emits a mixed set -- `MediaParent` simply carries its own
      // `provider`, so the filter is what makes "same provider" true
      // rather than assumed.
      parents: media.parents
        .filter((parent) => parent.provider === media.provider)
        .map((parent) => ({ kind: parent.kind, providerRef: parent.providerRef })),
    };
    await ctx.jobs.enqueue({ kind: ARTWORK_JOB, payload });
  } catch (error) {
    ctx.log('the artwork job could not be queued, so this item has no pictures until it is identified again', {
      mediaItemId: claim.kept,
      // The message rather than the `Error`: the host's `redactDetail`
      // walks string values only, so an error object placed here would
      // reach the sink unredacted. The same shape `logged` below uses.
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * One answer, applied. The five outcomes, in the one order that reads them
 * correctly.
 */
export async function applyEnvelope(
  envelope: LookupEnvelope,
  target: ApplyTarget,
  deps: EnvelopeDeps,
): Promise<void> {
  const { ctx } = deps;

  // The service's own id for this lookup, recorded before the branch below
  // decides anything. §4.1 justifies the column as "what a poll asks about,
  // and what a support question quotes", and written only on the resolved
  // path it was null for exactly the rows anyone asks about: an item that
  // polled for ten minutes, or one that ended `unresolved` or `refused`. The
  // resolved path writes the same value again as part of its own row update
  // (§3.4's step 5), which is one statement rather than a column it would
  // otherwise have to leave to this one.
  await deps.db.update(deps.table)
    .set({ lookupId: envelope.lookupId, updatedAt: deps.now })
    .where(eq(deps.table.rssItemId, target.rssItemId));

  // 1. Not here yet -- read FIRST, and per answer rather than per response. A
  //    batch always answers HTTP 200, and a partial entry carries the state it
  //    *expects* to reach, so neither the response arriving nor this entry's
  //    own state says whether the answer is present.
  if (envelope.partial || envelope.state === 'pending') {
    const polls = target.polls + 1;
    if (polls > MAX_POLLS) {
      // The service never finished, so the last envelope it sent is the only
      // record of how far it got -- `lookupJsonFor` is what a reader of
      // `/unmatched` sees instead of a bare "gave up" sentence.
      await ctx.media.setResolution(
        target.rssItemId,
        'unresolved',
        `the lookup service never finished lookup ${envelope.lookupId} for "${target.filename}"`,
        lookupJsonFor(envelope),
      );
      return;
    }
    await ctx.jobs.enqueue({
      kind: POLL_JOB,
      payload: { lookupId: envelope.lookupId, rssItemId: target.rssItemId, polls },
      runAt: deps.now + POLL_DELAY_MS,
    });
    // The resolution stays `pending`: nothing is known about this item yet.
    return;
  }

  // 2. A non-media file, successfully identified. Terminal: folding this into
  //    `unresolved` would retry a subtitle forever and show it to a reader as
  //    a problem they cannot fix.
  if (envelope.refusal !== null) {
    // The refusal sentence says *that* the name was rejected; the envelope
    // behind `lookupJsonFor` is what the service actually saw, which is what
    // `/unmatched` shows for the second question a reader asks.
    await ctx.media.setResolution(target.rssItemId, 'refused', envelope.refusal, lookupJsonFor(envelope));
    return;
  }

  // 3. Not an error either: the name was not recognised, which is the state a
  //    human might fix. Nothing is enqueued -- a retry happens on request.
  if (envelope.state === 'unresolved') {
    await ctx.media.setResolution(
      target.rssItemId,
      'unresolved',
      describeUnresolved(target.filename, envelope.suggestions),
      lookupJsonFor(envelope),
    );
    return;
  }

  // 4. Impossible per the document, which requires `media` on every envelope
  //    and fills it for a resolved one. Thrown rather than skipped: a resolved
  //    answer this code cannot use is a service change, and a job that failed
  //    is how anyone finds out.
  if (envelope.media === null) {
    throw new Error(`openmetadata: lookup ${envelope.lookupId} resolved with no media`);
  }

  // 5. The answer.
  await applyResolved(envelope, envelope.media, target, deps);
}

export interface LookupPluginSpec {
  /** Also the required prefix for every table this plugin declares. */
  readonly id: string;
  readonly mediaType: MediaType;
  /** The wire category. `movies` for `mediaType: 'movie'` -- the one asymmetry. */
  readonly category: LookupCategory;
  /**
   * This plugin's own migrations, from version 2 up: version 1 is the engine's
   * state table, prepended by `createLookupPlugin`.
   */
  readonly migrations: readonly Migration[];
  /** Job handlers beyond the engine's `lookup` and `poll`. */
  readonly jobs?: Readonly<Record<string, JobHandler>>;
  /**
   * The pre-flight: throws for an answer this plugin cannot represent.
   *
   * Called at the top of the resolved branch, **before** the shared
   * `media_item` row is created and its provider reference claimed, because
   * that is the only point at which refusing costs nothing. A plugin that
   * only refused inside `apply` would leave a media item holding the claim,
   * an rss item relinked to it, and a resolution stuck `pending` while its
   * job dead-lettered -- the write order (§3.4) and the per-plugin guards
   * (§4.3-4.5) were specified separately and neither saw the other.
   *
   * Synchronous, and it must stay cheap: it reads the answer and nothing
   * else. Anything that could fail for a reason of its own belongs in
   * `apply`, where a failure is a job to retry rather than a verdict on the
   * answer.
   *
   * **Required, not optional**, and that is the whole point of it. Every
   * plugin here also guards inside `apply`, which keeps a direct caller of
   * `apply` honest -- but it means a plugin that defined `apply` and forgot
   * `check` would still refuse the answer, just one write too late, and
   * silently reintroduce the very defect this hook exists to close. An
   * optional hook makes forgetting it a thing the compiler permits. A plugin
   * that genuinely refuses nothing writes an empty body and says so in a
   * comment.
   */
  check(media: Media): void;
  /** The plugin's own rows for one resolved answer. Must be idempotent. */
  apply(args: ApplyArgs): Promise<void>;
  /**
   * What a finished download of this matched media item should hold
   * (design spec 2026-09-22 §6): one video file, or a pack of episodes.
   * Asked only for a matched release -- an unmatched one is copied whole.
   * A throw leaves the row `completed` for the next tick, like a resolver's.
   *
   * **Required, not optional**, for the reason `check` is: a default would
   * be a guess, and either guess is wrong for someone. Defaulting to
   * `single` refuses every season pack `too-many-video-files` forever;
   * defaulting to episodes refuses every film `episode-marker-missing`. The
   * plugin is the only party that knows which it asked for.
   */
  expects(file: DownloadedFile, ctx: PluginContext): Promise<Expectation>;
  /**
   * The tables this plugin contributes to a client's replica (design spec
   * §6). Optional and defaulting to none below -- a plugin built on this
   * engine that declares nothing keeps working unchanged, which is what let
   * the three plugins here adopt `synced` one at a time rather than all at
   * once.
   */
  readonly synced?: readonly SyncedTable<unknown>[];
  /**
   * What this plugin's library path shape may name (design spec §3).
   *
   * **Required, not optional like `synced` above.** `synced` defaults to
   * none and a plugin that declares nothing keeps working; an empty token
   * list is not inert in the same way. `media/destinations.ts` validates a
   * shape by resolving it against a probe value for each declared token, so
   * a plugin declaring none would have every shape naming any token refused
   * `unknown-token` -- and a shape naming none at all refused
   * `empty-filename` -- leaving the settings screen an empty token list and
   * nothing saying the plugin is why. The engine cannot supply a sensible
   * default either: what a shape may name is exactly the thing only the
   * plugin knows.
   *
   * **A map of resolvers, not a list of names** ({@link PluginTokens}), so
   * a spec cannot declare `{season}` and leave nothing to resolve it: the
   * key and the function are one entry. `onDownloadedFile` below builds the
   * values map from `Object.entries` of this very object, and
   * `media/destinations.ts` validates a saved shape against `Object.keys`
   * of it, so the set the host accepts and the set the plugin answers
   * cannot differ.
   *
   * **Called once per placed entry during an import.** A download may be a
   * directory, and `onDownloadedFile` resolves every token again for each
   * entry it places, with `file.path` (and `sizeBytes`) set to *that
   * entry's* rather than the download's. So anything that differs from one
   * file to the next -- the filename, the extension, which episode of a pack
   * this file is -- must be derived from `file.path`; a value read only from
   * the plugin's tables is the same for every entry, and every entry of a
   * pack would resolve to one destination.
   */
  readonly tokens: PluginTokens;
}

export interface LookupPluginDeps {
  now: () => number;
  baseUrl: string;
  resolveSecret: SecretResolver;
}

/**
 * `PluginContext.db` is `unknown` by contract: the host has never seen this
 * plugin's schema, so it cannot hand back a handle typed to it. Narrowed once,
 * here, at the cost of a runtime check -- there is no compile-time route from
 * `unknown` to a connection.
 */
function asDatabase(db: unknown): DatabaseSync {
  if (!(db instanceof DatabaseSync)) {
    throw new TypeError('openmetadata: ctx.db is not a node:sqlite DatabaseSync');
  }
  return db;
}

/** One Drizzle handle per connection, remembered rather than rebuilt per entry point. */
const handles = new WeakMap<DatabaseSync, LookupDb>();

function ownTables(ctx: PluginContext): { raw: DatabaseSync; db: LookupDb } {
  const raw = asDatabase(ctx.db);
  const existing = handles.get(raw);
  if (existing !== undefined) return { raw, db: existing };
  const db = createDrizzle({ client: raw });
  handles.set(raw, db);
  return { raw, db };
}

function readInteger(row: Record<string, SQLOutputValue>, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') throw new TypeError(`openmetadata: column ${column} is not an integer`);
  return value;
}

function readText(row: Record<string, SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new TypeError(`openmetadata: column ${column} is not text`);
  return value;
}

/**
 * The filenames to look up, in the caller's order.
 *
 * Hand-written SQL against a table this plugin does not own, and still
 * `ctx.db` rather than `ctx.read`: `MediaReader` reaches rss items only
 * *through* a media item (`rssItemsFor`), and these have none yet -- they are
 * exactly the items a poll just delivered and this lookup is about to
 * identify.
 *
 * The caller's order rather than the database's, because that order decides
 * which of two items claiming one provider reference wins the dedup.
 */
function readRssItems(raw: DatabaseSync, ids: readonly number[]): { id: number; filename: string }[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = raw.prepare(`SELECT id, filename FROM rss_item WHERE id IN (${placeholders})`).all(...ids);
  const byId = new Map(rows.map((row) => [readInteger(row, 'id'), readText(row, 'filename')]));
  return ids.map((id) => {
    const filename = byId.get(id);
    if (filename === undefined) throw new Error(`openmetadata: rss item ${id} does not exist`);
    return { id, filename };
  });
}

function readLookupPayload(payload: unknown): number[] {
  if (typeof payload !== 'object' || payload === null || !('rssItemIds' in payload)) {
    throw new TypeError('openmetadata: a lookup payload must carry rssItemIds');
  }
  const ids: unknown = payload.rssItemIds;
  if (!Array.isArray(ids)) throw new TypeError('openmetadata: rssItemIds is not an array');
  return ids.map((id: unknown) => {
    if (typeof id !== 'number') throw new TypeError('openmetadata: rssItemIds holds a non-number');
    return id;
  });
}

function readPollPayload(payload: unknown): { lookupId: string; rssItemId: number; polls: number } {
  if (typeof payload !== 'object' || payload === null
    || !('lookupId' in payload) || !('rssItemId' in payload) || !('polls' in payload)) {
    throw new TypeError('openmetadata: a poll payload must carry lookupId, rssItemId and polls');
  }
  const { lookupId, rssItemId, polls } = payload;
  if (typeof lookupId !== 'string' || typeof rssItemId !== 'number' || typeof polls !== 'number') {
    throw new TypeError('openmetadata: a poll payload must carry lookupId, rssItemId and polls');
  }
  return { lookupId, rssItemId, polls };
}

/**
 * The url without its query, for a log line.
 *
 * The key travels in a header and never in a url, so this is not redaction of
 * a credential -- it is keeping a log line short and stable. `@pickarr/host`'s
 * own `redactUrl` does the credential case, and this package cannot import it.
 */
function loggableUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(an unparseable url)';
  }
}

/**
 * Runs one request, naming the status when it fails.
 *
 * `FetchFailedError` carries a numeric `status` and is not exported to
 * plugins, so the status is read structurally rather than by `instanceof`: a
 * 401 (a bad or revoked key), a 429 and a 503 are all worth telling apart in a
 * log, and none of them is worth swallowing -- the throw is what fails the job
 * and puts it on the runner's backoff curve.
 */
async function logged<T>(ctx: PluginContext, baseUrl: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const status = error instanceof Error && 'status' in error && typeof error.status === 'number'
      ? error.status
      : null;
    ctx.log('a lookup request failed', {
      url: loggableUrl(baseUrl),
      status: status ?? 'none',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Every token the plugin declares, resolved, keyed by the name it was
 * declared under.
 *
 * **Built from the declaration itself, which is the whole guard.** The keys
 * of the result are `Object.keys(tokens)` by construction, and
 * `media/destinations.ts` validates a saved shape against the same
 * `Object.keys(plugin.tokens)` -- so a token a shape may name is a token
 * this map has a value for, and there is no way to write one without the
 * other. That is the replacement for a test: `tokens` was `readonly
 * string[]` and nothing in the tree checked that a declared name had a
 * resolver, because no single place held both.
 *
 * `Promise.all` rather than a loop: the resolvers are independent by
 * construction -- each is handed the same `(file, ctx)` and nothing else --
 * and every read behind them is `node:sqlite`, which is synchronous anyway.
 *
 * **A resolver that throws is not caught here.** `null` is how a resolver
 * says "this release has nothing to put there"; a throw means something is
 * wrong, and it leaves the download row `completed` for the next tick,
 * which is what design spec §7 asks of a fault.
 */
async function resolveTokens(
  tokens: PluginTokens,
  file: DownloadedFile,
  ctx: PluginContext,
): Promise<TokenValues> {
  const entries = Object.entries(tokens);
  const resolved = await Promise.all(entries.map(async ([, resolve]) => resolve(file, ctx)));
  return Object.fromEntries(entries.map(([name], index) => [name, resolved[index] ?? null]));
}

/**
 * Logs a refused download by ids and code and throws, so `deliverCompleted`
 * leaves the row `completed` for the next tick. `never`, so a caller's
 * narrowing continues past it.
 *
 * **The ids and the verdict, never `file.path`.** Importer design spec §7:
 * no path, url or credential reaches a log line. This detail goes to the
 * host's **stdout** -- `ctx.log` is `console.log`, built at
 * `host/src/host.ts` -- and so does the message of the throw below, through
 * `deliverCompleted`'s catch. Neither reaches `last_error`;
 * `clients/deliver.ts` never calls `failRow`, and `host/src/errors.ts` has
 * the full audit of which host messages a browser can be shown. Stdout is
 * enough: §7's rule is about a log line. This line did log the path, and
 * had to: until `DownloadedFile` carried `rssItemId` and `mediaItemId`
 * there was nothing else here that identified the file. A refusal code and
 * an `errno` are neither a path nor derived from one -- `media/import.ts`
 * is where that is enforced rather than hoped for.
 *
 * **Thrown, having been returned as a value**: `deliverCompleted` treats a
 * throw as "leave the row `completed` and try next tick", which is exactly
 * what design spec §5 and §7 require of every refusal here -- a listing the
 * filesystem refused, a destination that already exists, a shape an
 * operator has yet to fix, a root not mounted yet. The message names the
 * rule and the plugin and carries nothing else, because `deliverCompleted`
 * logs it.
 */
function refuseDownload(
  ctx: PluginContext,
  pluginId: string,
  file: DownloadedFile,
  refusal: string,
  errno: string | null,
): never {
  ctx.log('could not put a finished download in the library', {
    rssItemId: file.rssItemId,
    mediaItemId: file.mediaItemId,
    refusal,
    errno,
  });
  throw new Error(`${pluginId}: this download was not imported (${refusal})`);
}

/**
 * A complete `MediaPlugin` from a spec.
 *
 * Everything the three media types share is here; what they do not share is
 * `spec.apply` and `spec.migrations`. See the slice's spec for why the flow is
 * shared rather than copied: the branch order in `applyEnvelope` is the part
 * that is subtle, and three copies of it would be three chances to get it
 * wrong.
 */
export function createLookupPlugin(spec: LookupPluginSpec, deps: LookupPluginDeps): MediaPlugin {
  const table = lookupTable(spec.id);

  function envelopeDeps(ctx: PluginContext, raw: DatabaseSync, db: LookupDb): EnvelopeDeps {
    return {
      pluginId: spec.id,
      ctx,
      raw,
      db,
      table,
      now: deps.now(),
      check: spec.check,
      apply: spec.apply,
    };
  }

  function clientFor(ctx: PluginContext, signal?: AbortSignal) {
    // Two shapes rather than one literal with `signal: undefined`:
    // `exactOptionalPropertyTypes` makes those different things.
    return signal === undefined
      ? createLookupClient({ fetch: ctx.fetch, baseUrl: deps.baseUrl, resolveSecret: deps.resolveSecret })
      : createLookupClient({ fetch: ctx.fetch, baseUrl: deps.baseUrl, resolveSecret: deps.resolveSecret, signal });
  }

  const lookup: JobHandler = async (job, ctx, signal) => {
    const { raw, db } = ownTables(ctx);
    const items = readRssItems(raw, readLookupPayload(job.payload));
    const answers = await logged(ctx, deps.baseUrl, () =>
      clientFor(ctx, signal).batch(spec.category, items.map((item) => item.filename)));

    for (const [index, item] of items.entries()) {
      const envelope = answers[index];
      if (envelope === undefined) {
        // `batch` already refuses a length mismatch; this is the compiler's
        // own question about an indexed read, answered rather than asserted.
        throw new Error(`openmetadata: no answer for "${item.filename}"`);
      }
      // eslint-disable-next-line no-await-in-loop -- answers are applied in the order they were asked for, because that order decides which of two items claiming one provider ref wins the dedup
      await applyEnvelope(
        envelope,
        { rssItemId: item.id, filename: item.filename, polls: 0 },
        envelopeDeps(ctx, raw, db),
      );
    }
  };

  // One handler for the plugin's whole life, not one per job: it caches a
  // provider registry per `HostFetch` and reports an unregistered provider
  // once rather than once per release. See `createArtworkJob`.
  const artwork = createArtworkJob({ resolveSecret: deps.resolveSecret });

  const poll: JobHandler = async (job, ctx, signal) => {
    const { raw, db } = ownTables(ctx);
    // The rss item comes from the payload, never from `job.id`: both are
    // numbers, so the wrong one compiles and quietly resolves a stranger.
    const { lookupId, rssItemId, polls } = readPollPayload(job.payload);
    const [item] = readRssItems(raw, [rssItemId]);
    if (item === undefined) throw new Error(`openmetadata: rss item ${rssItemId} does not exist`);
    const envelope = await logged(ctx, deps.baseUrl, () => clientFor(ctx, signal).poll(lookupId));
    // The same branch as the batch, so a poll that is still partial enqueues
    // the next one through the very code that enqueued this one.
    await applyEnvelope(
      envelope,
      { rssItemId, filename: item.filename, polls },
      envelopeDeps(ctx, raw, db),
    );
  };

  return {
    id: spec.id,
    mediaType: spec.mediaType,
    migrations: [lookupTableMigration(spec.id), ...spec.migrations],
    jobs: { ...spec.jobs, [LOOKUP_JOB]: lookup, [POLL_JOB]: poll, [ARTWORK_JOB]: artwork },
    // Defaults to empty: `LookupPluginSpec.synced` is optional, so a spec
    // that declares nothing still produces a valid `MediaPlugin`, whose own
    // `synced` is required.
    synced: spec.synced ?? [],
    tokens: spec.tokens,

    async onNewRssItems(ids, ctx) {
      if (ids.length === 0) return;
      const { db } = ownTables(ctx);
      const at = deps.now();

      // `DO NOTHING`, not a plain insert, because this whole call is offered
      // again after it fails. `feeds/reader.ts` marks *nothing* delivered
      // when a plugin's `onNewRssItems` rejects -- a feed names exactly one
      // plugin, so a failure is all-or-nothing for the batch -- and every
      // undelivered row is re-offered on the next poll. So if the insert
      // below succeeded and the enqueue loop after it then failed (or the
      // process died between chunks), a plain insert would meet its own rows
      // on the retry, throw `UNIQUE constraint failed`, and throw again on
      // every later poll: that feed would never deliver another item, with
      // nothing but a log line to say so.
      //
      // Tolerating the conflict is what makes the re-invocation a recovery
      // rather than a wedge: the rows are already there and are unchanged by
      // the second insert, the loop below enqueues a fresh lookup job, and
      // the `lookup_job_id` update points every row in the chunk at it. The
      // only cost is a duplicate lookup job for rows the first call did get
      // as far as enqueuing for, which identifies the same items twice and
      // writes the same rows twice -- every write downstream of here is an
      // upsert or a claim for exactly that reason.
      await db.insert(table).values(ids.map((rssItemId) => ({
        rssItemId,
        mediaItemId: null,
        lookupJobId: null,
        lookupId: null,
        providerRef: null,
        confidence: null,
        createdAt: at,
        updatedAt: at,
      }))).onConflictDoNothing();

      // One job per chunk the service will accept, so a poll that delivered
      // three hundred names does not enqueue a job that cannot be sent as one
      // request. `enqueue`'s return is recorded rather than discarded: a job
      // id nothing keeps is a job nobody can trace back to the rows it is
      // identifying.
      for (let start = 0; start < ids.length; start += MAX_BATCH) {
        const chunk = ids.slice(start, start + MAX_BATCH);
        // eslint-disable-next-line no-await-in-loop -- each chunk's job id is recorded on its own rows before the next chunk is enqueued, so a crash between chunks leaves no row pointing at a job that covers different items
        const jobId = await ctx.jobs.enqueue({ kind: LOOKUP_JOB, payload: { rssItemIds: [...chunk] } });
        // eslint-disable-next-line no-await-in-loop -- see above
        await db.update(table)
          .set({ lookupJobId: jobId, updatedAt: at })
          .where(inArray(table.rssItemId, [...chunk]));
      }
    },

    async onDownloadedFile(file, ctx) {
      // The whole of importing: list the download, choose which entries
      // belong in the library, resolve this plugin's declared tokens from
      // its own tables for each, and hand both to the host, which owns
      // `plugin_destination` and the copy. See `contract/src/library.ts`
      // for why the copy is not here.
      //
      // `resolveTokens` is passed rather than called: the host takes the
      // unmatched branch for a release nothing matched, where there is no
      // title to shape a path from and every query below would ask this
      // plugin's tables for rows that do not exist.
      const { raw } = ownTables(ctx);
      const listing = await ctx.library.list(file);
      if ('refusal' in listing) refuseDownload(ctx, spec.id, file, listing.refusal, listing.errno);

      // Spec §4.3: nothing matched, so there is nothing to ask the plugin
      // and nothing to judge the download against -- it is copied whole.
      const expectation = file.mediaItemId === null ? 'unmatched' : await spec.expects(file, ctx);
      // Copied whole is still something: an unmatched download that lists
      // nothing would otherwise return with no copy made, and
      // `deliverCompleted` would mark the row delivered with no file
      // anywhere. A matched one already refuses this through `select`.
      if (expectation === 'unmatched' && listing.length === 0) {
        refuseDownload(ctx, spec.id, file, 'no-video-file', null);
      }
      const selection = select(listing, expectation);
      if ('refusal' in selection) refuseDownload(ctx, spec.id, file, selection.refusal, null);

      let copied = 0;
      let alreadyPlaced = 0;
      let placed: ImportPlacement['placed'] | null = null;
      for (const entry of selection.chosen) {
        // Spec §7: a retry skips what an earlier attempt placed, so a pack
        // that stopped at ENOSPC resumes instead of refusing its own copies.
        if (isPlaced(raw, spec.id, file.rssItemId, entry.relativePath)) {
          alreadyPlaced += 1;
          continue;
        }
        // Tokens resolve over the entry, not the download, so `{filename}`
        // and `{ext}` describe the file being copied rather than its folder.
        const entryFile: DownloadedFile = { ...file, path: entry.path, sizeBytes: entry.sizeBytes };
        // eslint-disable-next-line no-await-in-loop -- one copy at a time, stopping at the first refusal, so a retry resumes in order
        const outcome = await ctx.library.place(file, entry, async () => resolveTokens(spec.tokens, entryFile, ctx));
        if ('refusal' in outcome) refuseDownload(ctx, spec.id, file, outcome.refusal, outcome.errno);
        recordPlacement(raw, spec.id, file.rssItemId, entry.relativePath, deps.now());
        copied += 1;
        placed = outcome.placed;
      }

      ctx.log('a download finished', {
        rssItemId: file.rssItemId,
        mediaItemId: file.mediaItemId,
        listed: listing.length,
        chosen: selection.chosen.length,
        copied,
        alreadyPlaced,
        placed,
      });
    },

    async onDownloadRequest(rssItemId, ctx) {
      // An rss item and nothing else. This used to join `rss_item` to
      // `rss_feed` to read `download_client_id`, and throw when it was
      // `NULL` -- which is every feed created through the settings UI --
      // because `DownloadSubmission` then required a client id and that
      // column's `NULL` ("the host's default") had no way to be said.
      // `DownloadSubmission` carries no client id at all now, so the
      // question is `submit`'s alone and it answers it through the host's
      // `selectClientForFeed`, the same policy every other path used all
      // along. Nothing here reads a host column to get there.
      const reference = await ctx.downloads.submit({ rssItemId });
      ctx.log('submitted a download', { rssItemId, reference });
    },
  };
}
