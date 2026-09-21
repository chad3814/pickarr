/**
 * The fake lookup service, and a recording `MediaWriter`/`MediaReader`.
 *
 * Shipped from the package under `./testing` rather than kept in a test
 * directory, because all three plugin packages and the host's flow test need
 * them. The alternative is each of those encoding the wire shape itself, and
 * the wire shape is where this slice is most exposed: a batch answer carries
 * **no echoed name** and its entries are positional, which is exactly what the
 * host's older `test/double/plugin.ts` gets wrong for our purposes.
 *
 * Nothing here touches `globalThis.fetch`, so no test has to put it back.
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  DownloadClients,
  DownloadedFile,
  ImportOutcome,
  JobEnqueue,
  JobQueue,
  MediaItemInit,
  MediaItemRead,
  MediaItemUpdate,
  MediaReader,
  MediaWriter,
  PluginContext,
  ProviderClaim,
  Resolution,
  HostFetch,
  LibraryImporter,
  TokenValues,
} from '@pickarr/contract';
import type { LookupEnvelope, Media, MediaSuggestions } from './types.ts';

const BASE: Omit<LookupEnvelope, 'lookupId' | 'state'> = {
  partial: false,
  cached: false,
  confidence: null,
  refusal: null,
  parsed: null,
  media: null,
  suggestions: null,
};

export function resolvedEnvelope(
  fields: { lookupId: string; confidence?: number; media: Media },
): LookupEnvelope {
  return {
    ...BASE,
    lookupId: fields.lookupId,
    state: 'resolved',
    confidence: fields.confidence ?? 0.9,
    media: fields.media,
  };
}

/**
 * A non-media file, successfully identified as one. `state` is `resolved`,
 * because identifying a subtitle *is* a successful identification -- the
 * refusal is what makes it terminal.
 */
export function refusedEnvelope(fields: { lookupId: string; refusal: string }): LookupEnvelope {
  return { ...BASE, lookupId: fields.lookupId, state: 'resolved', refusal: fields.refusal };
}

export function unresolvedEnvelope(
  fields: { lookupId: string; suggestions?: MediaSuggestions },
): LookupEnvelope {
  return {
    ...BASE,
    lookupId: fields.lookupId,
    state: 'unresolved',
    suggestions: fields.suggestions ?? null,
  };
}

/** An answer that has not arrived: the state it *expects*, and nothing filled in. */
export function partialEnvelope(fields: { lookupId: string }): LookupEnvelope {
  return { ...BASE, lookupId: fields.lookupId, state: 'resolved', partial: true };
}

/** The other way the service says "not yet": a state rather than a flag. */
export function pendingEnvelope(fields: { lookupId: string }): LookupEnvelope {
  return { ...BASE, lookupId: fields.lookupId, state: 'pending' };
}

export interface FakeLookupScript {
  /** Keyed by filename. A name asked about but absent here is a test bug, not an answer. */
  batch: ReadonlyMap<string, LookupEnvelope>;
  /** Keyed by lookup id: successive poll answers, one consumed per GET. */
  polls: ReadonlyMap<string, readonly LookupEnvelope[]>;
}

export interface FakeLookupService {
  readonly fetch: HostFetch;
  /** Live view: the names each batch POST asked about, one array per request. */
  readonly batchRequests: readonly (readonly string[])[];
  /** Live view: the category each batch POST asked under, one per request. */
  readonly batchCategories: readonly string[];
  readonly pollRequests: readonly string[];
}

interface RequestedBatch {
  names: string[];
  category: string;
}

function requestedBatch(body: RequestInit['body']): RequestedBatch {
  if (typeof body !== 'string') {
    throw new TypeError('fake lookup service: a batch request must carry a JSON string body');
  }
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || !('items' in parsed)) {
    throw new TypeError('fake lookup service: a batch request body must carry items');
  }
  const items: unknown = parsed.items;
  if (!Array.isArray(items)) throw new TypeError('fake lookup service: items is not an array');
  let category: string | undefined;
  const names = items.map((item: unknown) => {
    if (
      typeof item !== 'object' || item === null
      || !('name' in item) || typeof item.name !== 'string'
      || !('category' in item) || typeof item.category !== 'string'
    ) {
      throw new TypeError('fake lookup service: an item carries no name or category');
    }
    if (category === undefined) {
      category = item.category;
    } else if (category !== item.category) {
      throw new TypeError(
        `fake lookup service: a batch request disagreed with itself about category: "${category}" and "${item.category}"`,
      );
    }
    return item.name;
  });
  // This guard is unreachable through the client's only caller: the batch client never
  // sends an empty chunk. It guards a caller mistake the current client cannot make, and
  // is untested on purpose.
  if (category === undefined) {
    throw new TypeError('fake lookup service: a batch request must carry at least one item');
  }
  return { names, category };
}

const LOOKUP_PATH = '/api/v1/lookup';

export function createFakeLookupService(script: FakeLookupScript): FakeLookupService {
  const batchRequests: string[][] = [];
  const batchCategories: string[] = [];
  const pollRequests: string[] = [];
  // Copied, so consuming an answer does not mutate the caller's script.
  const remaining = new Map<string, LookupEnvelope[]>(
    Array.from(script.polls, ([lookupId, answers]) => [lookupId, [...answers]]),
  );

  async function answer(url: string, init?: RequestInit): Promise<unknown> {
    const parsed = new URL(url);
    const method = init?.method ?? 'GET';

    if (method === 'POST' && parsed.pathname === LOOKUP_PATH) {
      const { names, category } = requestedBatch(init?.body);
      batchRequests.push(names);
      batchCategories.push(category);
      // In request order, and with `status` on each entry: the document's
      // batch shape. No `name` anywhere, which is the point of this fake.
      return {
        results: names.map((name) => {
          const envelope = script.batch.get(name);
          if (envelope === undefined) {
            throw new Error(`fake lookup service: nothing scripted for "${name}"`);
          }
          return Object.assign({}, envelope, { status: 200 });
        }),
      };
    }

    const prefix = `${LOOKUP_PATH}/`;
    if (method === 'GET' && parsed.pathname.startsWith(prefix)) {
      const lookupId = decodeURIComponent(parsed.pathname.slice(prefix.length));
      pollRequests.push(lookupId);
      const next = remaining.get(lookupId)?.shift();
      if (next === undefined) {
        throw new Error(`fake lookup service: no poll answer left for lookup ${lookupId}`);
      }
      // A bare envelope, as `GET /api/v1/lookup/{id}` specifies.
      return next;
    }

    throw new Error(`fake lookup service: unexpected ${method} ${parsed.pathname}`);
  }

  const fetch: HostFetch = {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      return await answer(url, init) as T;
    },
    async bytes(): Promise<Uint8Array> {
      throw new Error('fake lookup service: nothing here serves bytes');
    },
  };

  return { fetch, batchRequests, batchCategories, pollRequests };
}

export interface RecordedCall {
  method: string;
  args: readonly unknown[];
}

export interface RecordingMedia {
  readonly writer: MediaWriter;
  readonly reader: MediaReader;
  readonly calls: readonly RecordedCall[];
  readonly items: ReadonlyMap<number, MediaItemRead>;
  readonly resolutions: ReadonlyMap<number, { resolution: Resolution; detail: string | null }>;
  readonly roles: readonly { mediaItemId: number; personId: number; role: string; name: string | null; billingOrder: number | null }[];
  /** Makes the next `claimProviderRef` report `winner` as the keeper. */
  loseNextClaim(winner: number): void;
}

/**
 * A `MediaWriter`/`MediaReader` pair that records rather than writes, so the
 * engine's tests need no database and no host schema. Ids rise from 1, which
 * is enough for a test to tell two rows apart and cheap enough not to pretend
 * to be sqlite.
 */
export function createRecordingMedia(): RecordingMedia {
  const calls: RecordedCall[] = [];
  const items = new Map<number, MediaItemRead>();
  const people = new Map<string, number>();
  const resolutions = new Map<number, { resolution: Resolution; detail: string | null }>();
  const roles: { mediaItemId: number; personId: number; role: string; name: string | null; billingOrder: number | null }[] = [];
  const links = new Map<number, number | null>();
  let nextItem = 0;
  let nextPerson = 0;
  let claimLoser: number | null = null;

  function record(method: string, ...args: readonly unknown[]): void {
    calls.push({ method, args });
  }

  const writer: MediaWriter = {
    async createMediaItem(init: MediaItemInit): Promise<number> {
      record('createMediaItem', init);
      nextItem += 1;
      items.set(nextItem, {
        id: nextItem,
        title: init.title,
        releaseDate: init.releaseDate,
        description: init.description,
        provider: null,
        providerRef: null,
        createdAt: 0,
        updatedAt: 0,
      });
      return nextItem;
    },
    async updateMediaItem(mediaItemId: number, update: MediaItemUpdate): Promise<void> {
      record('updateMediaItem', mediaItemId, update);
      const existing = items.get(mediaItemId);
      if (existing === undefined) throw new Error(`updateMediaItem: no media item ${mediaItemId}`);
      items.set(mediaItemId, { ...existing, ...update });
    },
    async claimProviderRef(mediaItemId: number, provider: string, ref: string): Promise<ProviderClaim> {
      record('claimProviderRef', mediaItemId, provider, ref);
      const existing = items.get(mediaItemId);
      if (existing !== undefined) {
        items.set(mediaItemId, { ...existing, provider, providerRef: ref });
      }
      if (claimLoser !== null) {
        const kept = claimLoser;
        claimLoser = null;
        return { kept, dropped: mediaItemId };
      }
      return { kept: mediaItemId, dropped: null };
    },
    async relinkRssItem(rssItemId: number, mediaItemId: number | null): Promise<void> {
      record('relinkRssItem', rssItemId, mediaItemId);
      links.set(rssItemId, mediaItemId);
    },
    async dropMediaItem(mediaItemId: number): Promise<void> {
      record('dropMediaItem', mediaItemId);
      items.delete(mediaItemId);
    },
    async attachPoster(mediaItemId, poster): Promise<void> { record('attachPoster', mediaItemId, poster.url); },
    async attachBackground(mediaItemId, background): Promise<void> { record('attachBackground', mediaItemId, background.url); },
    async attachLogo(mediaItemId, logo): Promise<void> { record('attachLogo', mediaItemId, logo.url); },
    async upsertPerson(person): Promise<number> {
      record('upsertPerson', person);
      const existing = people.get(person.providerRef);
      if (existing !== undefined) return existing;
      nextPerson += 1;
      people.set(person.providerRef, nextPerson);
      return nextPerson;
    },
    async attachRole(mediaItemId, role): Promise<void> {
      record('attachRole', mediaItemId, role);
      roles.push({ mediaItemId, ...role });
    },
    async setResolution(rssItemId, resolution, detail): Promise<void> {
      record('setResolution', rssItemId, resolution, detail);
      resolutions.set(rssItemId, { resolution, detail });
    },
  };

  const reader: MediaReader = {
    async mediaItem(id: number): Promise<MediaItemRead | null> {
      record('mediaItem', id);
      return items.get(id) ?? null;
    },
    async mediaItemByProviderRef(provider: string, ref: string): Promise<MediaItemRead | null> {
      record('mediaItemByProviderRef', provider, ref);
      for (const item of items.values()) {
        if (item.provider === provider && item.providerRef === ref) return item;
      }
      return null;
    },
    async rssItemsFor(): Promise<[]> { return []; },
    async downloadsFor(): Promise<[]> { return []; },
  };

  return {
    writer,
    reader,
    calls,
    items,
    resolutions,
    roles,
    loseNextClaim(winner: number): void { claimLoser = winner; },
  };
}

/** One `library.place` call, and what the plugin resolved for it. */
export interface RecordedImport {
  readonly file: DownloadedFile;
  readonly values: TokenValues;
}

export interface TestHarness {
  readonly ctx: PluginContext;
  /**
   * Every import this plugin asked for, with the token values it resolved.
   *
   * The values are recorded because they are the plugin's whole
   * contribution to a destination: the host owns `plugin_destination`, the
   * shape and the copy, so what a test of a plugin can assert is exactly
   * this map. `resolveTokens` is always called here, unlike the real
   * importer, which skips it for an unmatched release (design spec §6) --
   * that branch is the host's and `host/test/media/import.test.ts` is what
   * pins it.
   */
  readonly imports: readonly RecordedImport[];
  /** Makes the next `place` answer `outcome` rather than a plain success. */
  answerImport(outcome: ImportOutcome): void;
  readonly raw: DatabaseSync;
  readonly media: RecordingMedia;
  /** Every job enqueued, with the id `enqueue` answered -- rising from 1. */
  readonly enqueued: readonly (JobEnqueue & { id: number })[];
  readonly logs: readonly { message: string; detail: Readonly<Record<string, unknown>> | undefined }[];
  /** Inserts an `rss_item` row and returns its id. */
  insertRssItem(filename: string, feedId?: number): number;
  /** Inserts an `rss_feed` row and returns its id. */
  insertFeed(downloadClientId: number | null): number;
}

/**
 * A `PluginContext` over an in-memory database holding *stubs* of the host
 * tables a plugin's own DDL references.
 *
 * Stubs rather than the real schema, because this package must not import from
 * `@pickarr/host`: what these tests prove is that a plugin written against the
 * contract behaves, and the real migrations, real foreign keys and real
 * dispatcher are proven by the host's own flow test. Foreign keys are turned
 * off below -- `node:sqlite` enables them by default, unlike `better-sqlite3` --
 * so a test may reference an rss item, feed or media item it never inserted
 * when the row itself is beside the point, and so `applyEnvelope`'s writes
 * against a `media_item_id` the recording `MediaWriter` invented, rather than
 * one that exists in this stub table, are not rejected by a constraint this
 * package's own tests have no way to satisfy.
 *
 * `rss_feed` and `rss_item.feed_id` are included even though nothing joins
 * them. They were added for an `onDownloadRequest` that did -- it read
 * `rss_feed.download_client_id` through `rss_item` to name a client in its
 * submission -- and that join is gone: `DownloadSubmission` has no client
 * field at all now, so the host resolves one from the feed and the plugin
 * never looks. They stay because that is exactly what `engine-jobs.test.ts`
 * drops in order to prove it, and a plugin cannot be shown not to read a
 * table that was never created.
 */
export function createTestHarness(deps: { fetch?: HostFetch; now?: () => number } = {}): TestHarness {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('CREATE TABLE rss_feed (id INTEGER PRIMARY KEY, download_client_id INTEGER)');
  raw.exec('CREATE TABLE rss_item (id INTEGER PRIMARY KEY, feed_id INTEGER, filename TEXT NOT NULL)');
  raw.exec('CREATE TABLE media_item (id INTEGER PRIMARY KEY)');

  const media = createRecordingMedia();
  const enqueued: (JobEnqueue & { id: number })[] = [];
  const logs: { message: string; detail: Readonly<Record<string, unknown>> | undefined }[] = [];
  const imports: RecordedImport[] = [];
  let nextOutcome: ImportOutcome | null = null;

  const library: LibraryImporter = {
    async place(file, resolveTokens): Promise<ImportOutcome> {
      const values = await resolveTokens();
      imports.push({ file, values });
      const scripted = nextOutcome;
      nextOutcome = null;
      return scripted ?? { placed: file.mediaItemId === null ? 'unmatched' : 'library' };
    },
  };

  const jobs: JobQueue = {
    async enqueue(job: JobEnqueue): Promise<number> {
      const id = enqueued.length + 1;
      enqueued.push({ ...job, id });
      return id;
    },
  };

  const downloads: DownloadClients = {
    async submit(): Promise<string | null> {
      throw new Error('downloads.submit: not used by a lookup test');
    },
  };

  const fetch: HostFetch = deps.fetch ?? {
    async json(): Promise<never> { throw new Error('fetch.json: this test scripted no service'); },
    async bytes(): Promise<never> { throw new Error('fetch.bytes: nothing here serves bytes'); },
  };

  return {
    ctx: {
      db: raw,
      media: media.writer,
      read: media.reader,
      jobs,
      fetch,
      downloads,
      library,
      log: (message, detail) => logs.push({ message, detail }),
    },
    raw,
    media,
    enqueued,
    logs,
    imports,
    answerImport(outcome: ImportOutcome): void { nextOutcome = outcome; },
    insertRssItem(filename: string, feedId?: number): number {
      const result = raw.prepare('INSERT INTO rss_item (filename, feed_id) VALUES (?, ?)')
        .run(filename, feedId ?? null);
      return Number(result.lastInsertRowid);
    },
    insertFeed(downloadClientId: number | null): number {
      const result = raw.prepare('INSERT INTO rss_feed (download_client_id) VALUES (?)').run(downloadClientId);
      return Number(result.lastInsertRowid);
    },
  };
}
