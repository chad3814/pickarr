/**
 * A test-double media plugin, and the fake parser service it talks to.
 *
 * The contract in `@pickarr/contract` was designed before any real plugin
 * existed, so this double is its only consumer. It therefore implements the
 * whole new-items flow rather than a happy path: every lookup outcome the
 * service can answer with — resolved, refused, unresolved and not-yet-answered
 * — has a branch here, and `flow.test.ts` drives all of them.
 *
 * It depends on `@pickarr/contract`, `drizzle-orm` and `node:sqlite` and on
 * nothing from `../../src`. That is deliberate: a double that reached into the
 * host's own modules would prove the host composes with itself rather than
 * that the contract is sufficient for a plugin written against it.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { eq, inArray } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  ImageInit,
  JobHandler,
  MediaPlugin,
  MediaType,
  Migration,
  PluginContext,
  PluginTokens,
} from '@pickarr/contract';

/** Also the required prefix for every table this plugin declares. */
export const DOUBLE_ID = 'double';

/** The category the double sends the parser service, which is its own media type. */
const MEDIA_TYPE: MediaType = 'movie';

export const PARSER_ORIGIN = 'https://parser.test';
export const LOOKUP_PATH = '/api/v1/lookup';

/** How long a poll waits before asking the service again. */
export const POLL_DELAY_MS = 5_000;

/**
 * The double's own row: what it knows about one rss item's identification.
 *
 * Keyed per rss item rather than per media item, because the dedup points two
 * rss items at a single media item — a per-media-item key would make the
 * loser's row collide with the winner's.
 *
 * `.references()` is absent on purpose. The migration below carries the
 * foreign keys, and their targets are the host's tables, whose Drizzle objects
 * a plugin has no business importing.
 */
export const doubleMedia = sqliteTable('double_media', {
  id: integer('id').primaryKey(),
  rssItemId: integer('rss_item_id').notNull(),
  /** Null until a lookup resolves: nothing identifies the item before then. */
  mediaItemId: integer('media_item_id'),
  /** The job that will identify it — the id `JobQueue.enqueue` returned. */
  lookupJobId: integer('lookup_job_id'),
  /** `provider:ref`, copied onto the double's own row once a claim settles. */
  providerRef: text('provider_ref'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * One table, one migration. Every name starts with `double_` because
 * `migratePlugin` enforces the plugin's id as the prefix and rejects a
 * migration that creates anything else.
 */
const MIGRATIONS: readonly Migration[] = [{
  version: 1,
  up: (db) => db.exec(`
CREATE TABLE double_media (
  id            INTEGER PRIMARY KEY,
  rss_item_id   INTEGER NOT NULL REFERENCES rss_item (id),
  media_item_id INTEGER REFERENCES media_item (id),
  lookup_job_id INTEGER,
  provider_ref  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX double_media_rss_item ON double_media (rss_item_id);
`),
}];

/** One person the service named, with the part they played. */
export interface LookupPerson {
  name: string;
  /** The provider's own person id, which is what de-duplicates people. */
  providerRef: string;
  role: string;
  /** The character's name where the provider gives one. */
  characterName: string | null;
  billingOrder: number | null;
}

/**
 * One image the service offers for a resolved entry, and which artwork slot
 * it fills. The double asks for nothing beyond what `ImageInit` itself needs
 * plus the slot, because the slot is what picks `attachPoster`,
 * `attachBackground` or `attachLogo` -- the service does not hand back
 * anything shaped like a contract type, this is just the double's own wire
 * shape for the fake service's answer.
 */
export interface LookupImage {
  role: 'poster' | 'background' | 'logo';
  url: string;
  title: string | null;
  language: string | null;
}

/**
 * One name's answer.
 *
 * `partial` is separate from `status` and has to be read first. A partial
 * entry carries the status it *expects* to reach, not one it has reached: the
 * service knows the lookup will resolve, it just ran out of time before
 * filling in the payload. Trusting `status` alone would treat a blank answer
 * as a finished one.
 */
export interface LookupEntry {
  /** Echoed back, so a caller can match answers to the names it sent. */
  name: string;
  /** The service's own id for this lookup, which a poll asks about. */
  lookupId: string;
  status: 'resolved' | 'unresolved';
  /** True when the answer is not here yet. */
  partial: boolean;
  /** Set when the name was identified as something that is not media. */
  refusal: string | null;
  provider: string | null;
  providerRef: string | null;
  title: string | null;
  releaseDate: string | null;
  description: string | null;
  people: readonly LookupPerson[];
  /** Empty for every outcome but a resolved one -- nothing else has artwork to offer. */
  images: readonly LookupImage[];
}

/** What `POST /api/v1/lookup` answers. Always with HTTP 200 — see `LookupEntry.partial`. */
export interface LookupBatchResponse {
  results: readonly LookupEntry[];
}

/** What `GET /api/v1/lookup/{id}` answers. */
export interface LookupPollResponse {
  result: LookupEntry;
}

/** The fields a resolved answer carries beyond the ones every entry has. */
export interface ResolvedFields {
  lookupId: string;
  provider: string;
  providerRef: string;
  title: string;
  releaseDate: string | null;
  description: string | null;
  people: readonly LookupPerson[];
  /** Absent or empty for the many tests that have nothing to do with artwork. */
  images?: readonly LookupImage[];
}

export function resolvedEntry(name: string, fields: ResolvedFields): LookupEntry {
  return {
    name,
    lookupId: fields.lookupId,
    status: 'resolved',
    partial: false,
    refusal: null,
    provider: fields.provider,
    providerRef: fields.providerRef,
    title: fields.title,
    releaseDate: fields.releaseDate,
    description: fields.description,
    people: fields.people,
    images: fields.images ?? [],
  };
}

/**
 * A non-media file, successfully identified as one. `status` is `resolved`,
 * because identifying a subtitle *is* a successful identification.
 */
export function refusedEntry(name: string, fields: { lookupId: string; refusal: string }): LookupEntry {
  return {
    name,
    lookupId: fields.lookupId,
    status: 'resolved',
    partial: false,
    refusal: fields.refusal,
    provider: null,
    providerRef: null,
    title: null,
    releaseDate: null,
    description: null,
    people: [],
    images: [],
  };
}

export function unresolvedEntry(name: string, fields: { lookupId: string }): LookupEntry {
  return {
    name,
    lookupId: fields.lookupId,
    status: 'unresolved',
    partial: false,
    refusal: null,
    provider: null,
    providerRef: null,
    title: null,
    releaseDate: null,
    description: null,
    people: [],
    images: [],
  };
}

/** An answer that has not arrived: `status` is what it expects, nothing else is filled in. */
export function partialEntry(name: string, fields: { lookupId: string }): LookupEntry {
  return {
    name,
    lookupId: fields.lookupId,
    status: 'resolved',
    partial: true,
    refusal: null,
    provider: null,
    providerRef: null,
    title: null,
    releaseDate: null,
    description: null,
    people: [],
    images: [],
  };
}

/** What the fake service answers, by name for a batch and by lookup id for a poll. */
export interface ParserScript {
  /** Keyed by filename. A name the double asks about that is absent here is a test bug. */
  batch: ReadonlyMap<string, LookupEntry>;
  /** Keyed by lookup id: successive poll answers, one consumed per `GET`. */
  polls: ReadonlyMap<string, readonly LookupEntry[]>;
}

export interface FakeParserService {
  /**
   * Hand this to `createHostFetch({ fetch })`. Nothing here touches
   * `globalThis.fetch`, so no test has to put it back.
   */
  readonly fetch: typeof globalThis.fetch;
  /** Live view: the names each batch `POST` asked about, one array per request. */
  readonly batchRequests: readonly (readonly string[])[];
  /** Live view: the lookup ids each poll `GET` asked about, in order. */
  readonly pollRequests: readonly string[];
}

function urlOf(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The names a batch request asked about, read back out of the body the double sent. */
function readRequestedNames(body: RequestInit['body']): string[] {
  if (typeof body !== 'string') {
    throw new TypeError('fake parser service: a batch request must carry a JSON string body');
  }
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || !('items' in parsed)) {
    throw new TypeError('fake parser service: a batch request body must carry items');
  }
  const items: unknown = parsed.items;
  if (!Array.isArray(items)) {
    throw new TypeError('fake parser service: items is not an array');
  }
  return items.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('name' in item) || typeof item.name !== 'string') {
      throw new TypeError('fake parser service: an item carries no name');
    }
    return item.name;
  });
}

function jsonResponse(body: LookupBatchResponse | LookupPollResponse): Response {
  // 200 whatever the entries say. A batch never answers 202: the per-entry
  // `partial` flag is the only place "not yet" is reported.
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export function createFakeParserService(script: ParserScript): FakeParserService {
  const batchRequests: string[][] = [];
  const pollRequests: string[] = [];
  // Copied, so consuming an answer does not mutate the caller's script.
  const remaining = new Map<string, LookupEntry[]>(
    Array.from(script.polls, ([lookupId, answers]) => [lookupId, [...answers]]),
  );

  const serviceFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(urlOf(input));
    if (url.origin !== PARSER_ORIGIN) {
      throw new Error(`fake parser service: unexpected origin ${url.origin}`);
    }
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.pathname === LOOKUP_PATH) {
      const names = readRequestedNames(init?.body);
      batchRequests.push(names);
      return jsonResponse({
        results: names.map((name) => {
          const entry = script.batch.get(name);
          if (entry === undefined) {
            throw new Error(`fake parser service: nothing scripted for "${name}"`);
          }
          return entry;
        }),
      });
    }

    const pollPrefix = `${LOOKUP_PATH}/`;
    if (method === 'GET' && url.pathname.startsWith(pollPrefix)) {
      const lookupId = url.pathname.slice(pollPrefix.length);
      pollRequests.push(lookupId);
      const answer = remaining.get(lookupId)?.shift();
      if (answer === undefined) {
        throw new Error(`fake parser service: no poll answer left for lookup ${lookupId}`);
      }
      return jsonResponse({ result: answer });
    }

    throw new Error(`fake parser service: unexpected ${method} ${url.pathname}`);
  };

  return { fetch: serviceFetch, batchRequests, pollRequests };
}

type DoubleDb = ReturnType<typeof drizzle>;

/**
 * `PluginContext.db` is `unknown` by contract: the host has never seen this
 * plugin's schema, so it cannot hand back a handle typed to it. The plugin
 * narrows the connection once, here, and pays for it with a runtime check —
 * there is no compile-time route from `unknown` to a connection.
 */
function asDatabase(db: unknown): DatabaseSync {
  if (!(db instanceof DatabaseSync)) {
    throw new TypeError('double: ctx.db is not a node:sqlite DatabaseSync');
  }
  return db;
}

/**
 * One Drizzle handle per connection, remembered rather than rebuilt on every
 * entry point. `drizzle({ client })` wraps the connection it is given, so
 * rebuilding is harmless — just pointless work on a hot path.
 */
const handles = new WeakMap<DatabaseSync, DoubleDb>();

function ownTables(ctx: PluginContext): { raw: DatabaseSync; db: DoubleDb } {
  const raw = asDatabase(ctx.db);
  const existing = handles.get(raw);
  if (existing !== undefined) return { raw, db: existing };
  const db = drizzle({ client: raw });
  handles.set(raw, db);
  return { raw, db };
}

function readInteger(row: Record<string, SQLOutputValue>, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') {
    throw new TypeError(`double: column ${column} is not an integer`);
  }
  return value;
}

function readText(row: Record<string, SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new TypeError(`double: column ${column} is not text`);
  }
  return value;
}

interface RssItemName {
  id: number;
  filename: string;
}

/**
 * The filenames to look up.
 *
 * Hand-written SQL against a table the plugin does not own, and still
 * `ctx.db` now that `ctx.read` exists: `MediaReader` reaches rss items only
 * *through* a media item (`rssItemsFor`), and these ids have none yet -- they
 * are exactly the items a feed poll just delivered and this lookup is about
 * to identify. So this remains the one route to a column a plugin needs and
 * cannot write. A `rssItemsByIds` on the reader would close it; nothing in
 * the read API's spec asks for one.
 */
function readRssItems(raw: DatabaseSync, ids: readonly number[]): RssItemName[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = raw.prepare(`SELECT id, filename FROM rss_item WHERE id IN (${placeholders})`).all(...ids);
  const byId = new Map(rows.map((row) => [readInteger(row, 'id'), readText(row, 'filename')]));
  // Answered in the caller's order rather than the database's, so the order
  // the double sends names in — and therefore which of two items claiming one
  // provider ref wins the dedup — is the caller's, not sqlite's.
  return ids.map((id) => {
    const filename = byId.get(id);
    if (filename === undefined) {
      throw new Error(`double: rss item ${id} does not exist`);
    }
    return { id, filename };
  });
}

function readLookupPayload(payload: unknown): number[] {
  if (typeof payload !== 'object' || payload === null || !('rssItemIds' in payload)) {
    throw new TypeError('double: a lookup payload must carry rssItemIds');
  }
  const ids: unknown = payload.rssItemIds;
  if (!Array.isArray(ids)) {
    throw new TypeError('double: rssItemIds is not an array');
  }
  return ids.map((id: unknown) => {
    if (typeof id !== 'number') {
      throw new TypeError('double: rssItemIds holds a non-number');
    }
    return id;
  });
}

function readPollPayload(payload: unknown): { lookupId: string; rssItemId: number } {
  if (typeof payload !== 'object' || payload === null
    || !('lookupId' in payload) || !('rssItemId' in payload)) {
    throw new TypeError('double: a poll payload must carry lookupId and rssItemId');
  }
  const { lookupId, rssItemId } = payload;
  if (typeof lookupId !== 'string' || typeof rssItemId !== 'number') {
    throw new TypeError('double: a poll payload must carry lookupId and rssItemId');
  }
  return { lookupId, rssItemId };
}

/** `role`'s three literals are not a type `!==` narrows `unknown` to on its own -- this is what does. */
function isImageRole(value: unknown): value is LookupImage['role'] {
  return value === 'poster' || value === 'background' || value === 'logo';
}

/** Narrows one element of an artwork payload's `images` array, thrown at whichever field is malformed. */
function readLookupImage(value: unknown): LookupImage {
  if (typeof value !== 'object' || value === null
    || !('role' in value) || !('url' in value) || !('title' in value) || !('language' in value)) {
    throw new TypeError('double: an artwork payload image is missing a field');
  }
  const { role, url, title, language } = value;
  if (
    !isImageRole(role)
    || typeof url !== 'string'
    || (title !== null && typeof title !== 'string')
    || (language !== null && typeof language !== 'string')
  ) {
    throw new TypeError('double: an artwork payload image has a malformed field');
  }
  return { role, url, title, language };
}

function readArtworkPayload(payload: unknown): { mediaItemId: number; images: LookupImage[] } {
  if (typeof payload !== 'object' || payload === null
    || !('mediaItemId' in payload) || !('images' in payload)) {
    throw new TypeError('double: an artwork payload must carry mediaItemId and images');
  }
  const { mediaItemId, images } = payload;
  if (typeof mediaItemId !== 'number' || !Array.isArray(images)) {
    throw new TypeError('double: an artwork payload must carry mediaItemId and images');
  }
  return { mediaItemId, images: images.map((image: unknown) => readLookupImage(image)) };
}

/** The service's people, de-duplicated by the provider's own person id as they are written. */
async function attachPeople(
  people: readonly LookupPerson[],
  mediaItemId: number,
  ctx: PluginContext,
): Promise<void> {
  for (const person of people) {
    // eslint-disable-next-line no-await-in-loop -- one person at a time: `attachRole` below needs the id this upsert returns, and the role rows have to land in billing order
    const personId = await ctx.media.upsertPerson({ name: person.name, providerRef: person.providerRef });
    // eslint-disable-next-line no-await-in-loop -- see above; this is the same person's own role
    await ctx.media.attachRole(mediaItemId, {
      personId,
      role: person.role,
      name: person.characterName,
      billingOrder: person.billingOrder,
    });
  }
}

/** The last segment of a local path, under either separator. */
function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * What this double's own shape could name, and how each name resolves.
 *
 * Kept short and unlike any shipped plugin's list: the double stands in for
 * a plugin, not for `plugin-movie`. Each resolver reads something the double
 * really has, so a flow test that configures a destination gets a real path
 * rather than three nulls -- and so the double models `PluginTokens`'
 * property that a declared name always has a function behind it.
 */
const TOKENS: PluginTokens = {
  title: async (file, ctx) => (
    file.mediaItemId === null ? null : (await ctx.read.mediaItem(file.mediaItemId))?.title ?? null
  ),
  filename: async (file) => {
    const name = baseName(file.path);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? name : name.slice(0, dot);
  },
  ext: async (file) => {
    const name = baseName(file.path);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
  },
};

export function createDoublePlugin(deps: { now: () => number }): MediaPlugin {
  async function applyResolved(
    entry: LookupEntry,
    rssItemId: number,
    ctx: PluginContext,
    db: DoubleDb,
  ): Promise<void> {
    const { provider, providerRef, title } = entry;
    if (provider === null || providerRef === null || title === null) {
      throw new Error(`double: the service resolved "${entry.name}" without a provider reference`);
    }
    const at = deps.now();

    // Created here rather than when the item arrived. `MediaWriter` now has
    // `updateMediaItem`, so creating early and filling in on resolve is also
    // implementable -- this double simply does not do it. Creating late keeps
    // the refusal and unresolved branches from having a row to clean up at all,
    // which is the cheaper shape for a double; a real plugin that wants an item
    // to exist while a lookup is in flight should create early instead.
    const mine = await ctx.media.createMediaItem({
      pluginId: DOUBLE_ID,
      title,
      releaseDate: entry.releaseDate,
      description: entry.description,
    });

    const claim = await ctx.media.claimProviderRef(mine, provider, providerRef);
    if (claim.dropped !== null) {
      // Lost the dedup race. Nothing points at our row — the rss item is
      // linked below, to whichever item kept the reference — so dropping it
      // now leaves nothing dangling.
      await ctx.media.dropMediaItem(claim.dropped);
    }
    await ctx.media.relinkRssItem(rssItemId, claim.kept);
    await db.update(doubleMedia)
      .set({ mediaItemId: claim.kept, providerRef: `${provider}:${providerRef}`, updatedAt: at })
      .where(eq(doubleMedia.rssItemId, rssItemId));

    await attachPeople(entry.people, claim.kept, ctx);
    // `null`, `null`: no detail for a resolved answer, and no envelope to
    // store either -- this double's `LookupEntry` predates
    // `@pickarr/openmetadata`'s `LookupEnvelope`/`lookupJsonFor` and carries
    // nothing to serialise there, and clearing with `null` is still correct
    // for a retry that resolves after an earlier failed attempt.
    await ctx.media.setLookupState(rssItemId, 'resolved', null, null);

    // A separate job, not fetched inline here, and only when the service
    // actually offered something: enqueuing an empty job would still be
    // correct but would give every plugin test an extra job row to filter
    // out. The point of the separation is retry isolation -- everything
    // above this line has already committed the media item, its provider
    // claim and its lookup state, so an image that never downloads, or one
    // `image-size` refuses to measure, can exhaust its own job's attempts
    // and dead-letter without touching any of that.
    if (entry.images.length > 0) {
      await ctx.jobs.enqueue({ kind: 'artwork', payload: { mediaItemId: claim.kept, images: entry.images } });
    }
  }

  /** The four outcomes, in the one order that reads them correctly. */
  async function applyEntry(
    entry: LookupEntry,
    rssItemId: number,
    ctx: PluginContext,
    db: DoubleDb,
  ): Promise<void> {
    // `partial` first, and per entry rather than once for the response. A
    // batch always answers HTTP 200, and a partial entry carries the status it
    // expects to reach, so neither the response arriving nor this entry's own
    // status says whether the answer is here.
    if (entry.partial) {
      await ctx.jobs.enqueue({
        kind: 'poll',
        payload: { lookupId: entry.lookupId, rssItemId },
        runAt: deps.now() + POLL_DELAY_MS,
      });
      // The lookup state stays `pending`: nothing is known about this item yet.
      return;
    }

    if (entry.refusal !== null) {
      // A refusal is the service successfully identifying a non-media file.
      // Terminal: no retry, and no media rows to write. Folding it into
      // `unresolved` would retry a subtitle forever and show it to a reader
      // as a problem they cannot fix.
      // `null`: as above, this double has no envelope shape to store.
      await ctx.media.setLookupState(rssItemId, 'refused', entry.refusal, null);
      return;
    }

    if (entry.status === 'unresolved') {
      // Not an error either: the name was not recognised, which is the state a
      // human might fix. Nothing is enqueued — a retry happens on request.
      await ctx.media.setLookupState(
        rssItemId,
        'unresolved',
        `the parser service did not recognise "${entry.name}"`,
        null,
      );
      return;
    }

    await applyResolved(entry, rssItemId, ctx, db);
  }

  const lookup: JobHandler = async (job, ctx) => {
    const { raw, db } = ownTables(ctx);
    const items = readRssItems(raw, readLookupPayload(job.payload));

    // One request for the whole batch. It answers HTTP 200 even when some
    // entries have no answer yet, so `ctx.fetch.json` resolving proves only
    // that the response arrived.
    const body = await ctx.fetch.json<LookupBatchResponse>(`${PARSER_ORIGIN}${LOOKUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: items.map((item) => ({ category: MEDIA_TYPE, name: item.filename })),
      }),
    });

    const byName = new Map(body.results.map((entry) => [entry.name, entry]));
    for (const item of items) {
      const entry = byName.get(item.filename);
      if (entry === undefined) {
        throw new Error(`double: the parser service answered nothing for "${item.filename}"`);
      }
      // eslint-disable-next-line no-await-in-loop -- entries are applied in the order they were asked for, because that order decides which of two items claiming one provider ref wins
      await applyEntry(entry, item.id, ctx, db);
    }
  };

  const poll: JobHandler = async (job, ctx) => {
    const { db } = ownTables(ctx);
    // The rss item comes from the payload, never from `job.id`. Both are
    // numbers, so the wrong one compiles and quietly resolves a stranger.
    const { lookupId, rssItemId } = readPollPayload(job.payload);
    const body = await ctx.fetch.json<LookupPollResponse>(
      `${PARSER_ORIGIN}${LOOKUP_PATH}/${lookupId}`,
    );
    // The same four branches as the batch, so a poll that is still partial
    // enqueues the next one through the very code that enqueued this one.
    await applyEntry(body.result, rssItemId, ctx, db);
  };

  /**
   * Fetches every image `applyResolved` scheduled and attaches it to its
   * slot. `images.map` kicks every fetch off in the same synchronous pass,
   * not a loop of awaits: `ctx.fetch.bytes` is queued per hostname by the
   * host, so two images on different hosts genuinely run at once here, and
   * two on the same host serialise inside that queue regardless of how this
   * loop is written. Awaiting each image in turn would still be idempotent,
   * but it would leave the fetch queue emptied by a plugin that never asked
   * it to serialise its own requests across hosts.
   *
   * `Promise.allSettled`, not `Promise.all`: `all` resolves the moment the
   * first member rejects and abandons the rest mid-flight, so a test -- or a
   * real crash -- reading the database right after would catch the good
   * images half-written. `allSettled` waits for every image to finish, good
   * or bad, before this handler decides anything, so an image this handler
   * cannot fetch or measure never costs its neighbours: they are already
   * attached by the time the throw below runs. The throw still fails the job
   * as a whole, which is right -- a partially-attached run is not "done",
   * and the runner's own retry/backoff is what gives the failed image
   * another attempt. `attachPoster`/`attachBackground`/`attachLogo` are
   * keyed on `(mediaItemId, url)`, so a retry that re-attaches an image
   * already written is a no-op rather than a duplicate.
   */
  const artwork: JobHandler = async (job, ctx) => {
    const { mediaItemId, images } = readArtworkPayload(job.payload);
    const settled = await Promise.allSettled(images.map(async (image) => {
      const bytes = await ctx.fetch.bytes(image.url);
      const init: ImageInit = { url: image.url, title: image.title, language: image.language, bytes };
      if (image.role === 'poster') {
        await ctx.media.attachPoster(mediaItemId, init);
      } else if (image.role === 'background') {
        await ctx.media.attachBackground(mediaItemId, init);
      } else {
        await ctx.media.attachLogo(mediaItemId, init);
      }
    }));
    const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed !== undefined) {
      // `PromiseRejectedResult.reason` is typed `any` by the language's own
      // lib types; narrowed here the same way every other caught error in
      // this file is, rather than let that `any` leak into what this
      // handler throws.
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    }
  };

  return {
    id: DOUBLE_ID,
    mediaType: MEDIA_TYPE,
    migrations: MIGRATIONS,
    jobs: { lookup, poll, artwork },
    synced: [],
    tokens: TOKENS,

    async onNewRssItems(ids, ctx) {
      if (ids.length === 0) return;
      const { db } = ownTables(ctx);
      const at = deps.now();

      await db.insert(doubleMedia).values(ids.map((rssItemId) => ({
        rssItemId,
        mediaItemId: null,
        lookupJobId: null,
        providerRef: null,
        createdAt: at,
        updatedAt: at,
      })));

      // One job for the whole batch, not one per item. The parser service
      // takes up to 100 names per request; nothing here sends more than a
      // handful, so this double never has a second batch to split off.
      const jobId = await ctx.jobs.enqueue({ kind: 'lookup', payload: { rssItemIds: [...ids] } });

      // `enqueue`'s return recorded rather than discarded: a job id nothing
      // keeps is a job nobody can trace back to the rows it is identifying.
      await db.update(doubleMedia)
        .set({ lookupJobId: jobId, updatedAt: at })
        .where(inArray(doubleMedia.rssItemId, [...ids]));
    },

    // The two entry points the flow tests never reach. Both are required —
    // a plugin that cannot answer all three is not a plugin — and neither is
    // a stub: this is what the double would really do if called.
    async onDownloadedFile(file, ctx) {
      // The same steps the engine takes: list, then place each entry,
      // resolving this plugin's declared tokens for it and handing them to
      // the host, which owns the destination and the copy. Modelled rather
      // than stubbed, because `flow.test.ts` drives this through a real
      // `Host` and a stub would prove nothing about `ctxFor` wiring
      // `library` at all.
      // A declaration rather than an arrow in a `const`: TypeScript narrows
      // past a `never` call only when the callee's type is declared, and
      // the narrowing is what lets the loop below read `listing` as entries.
      function refuse(refusal: string, errno: string | null): never {
        // The ids and the verdict, never a path -- importer design spec §7,
        // and the same line the engine logs.
        ctx.log('could not put a finished download in the library', {
          rssItemId: file.rssItemId, mediaItemId: file.mediaItemId, refusal, errno,
        });
        // Thrown so the row stays `completed` and the next tick retries --
        // design spec §5 and §7, and what the engine does.
        throw new Error(`${DOUBLE_ID}: this download was not imported (${refusal})`);
      }

      const listing = await ctx.library.list(file);
      if ('refusal' in listing) refuse(listing.refusal, listing.errno);

      let copied = 0;
      let placed: 'library' | 'unmatched' | null = null;
      for (const entry of listing) {
        const entryFile = { ...file, path: entry.path, sizeBytes: entry.sizeBytes };
        // eslint-disable-next-line no-await-in-loop -- one copy at a time, as the engine does
        const outcome = await ctx.library.place(file, entry, async () => {
          const entries = Object.entries(TOKENS);
          const values = await Promise.all(entries.map(async ([, resolve]) => resolve(entryFile, ctx)));
          return Object.fromEntries(entries.map(([name], index) => [name, values[index] ?? null]));
        });
        if ('refusal' in outcome) refuse(outcome.refusal, outcome.errno);
        copied += 1;
        placed = outcome.placed;
      }
      ctx.log('a download finished', {
        rssItemId: file.rssItemId, mediaItemId: file.mediaItemId, listed: listing.length, copied, placed,
      });
    },

    async onDownloadRequest(rssItemId, ctx) {
      // An rss item and nothing else, because that is all a
      // `DownloadSubmission` has room for. A constant `downloadClientId`
      // used to sit here standing in for a column this double had no
      // business reading; the field went, and with it the question.
      const reference = await ctx.downloads.submit({ rssItemId });
      ctx.log('submitted a download', { rssItemId, reference });
    },

    // The double writes no rows of its own beyond the shared tables, so a
    // dropped item leaves nothing for it to delete, and nothing asks it to
    // look anything up.
    async onMediaItemDropped() {},
    async onLookupRequest() {},
  };
}
