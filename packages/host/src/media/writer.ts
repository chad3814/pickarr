import type {
  ImageInit,
  LookupState,
  MediaItemInit,
  MediaItemUpdate,
  MediaWriter,
  PersonInit,
  ProviderClaim,
  RoleInit,
} from '@pickarr/contract';
import { normalizeVideoResolution } from '@pickarr/contract';
import type { ArtworkStore } from '../artwork/store.ts';
import type { HostDb } from '../db/open.ts';
import { reassignRelease, type ReassignDeps } from './reassign.ts';

/** SQLite's own code for a UNIQUE constraint failure -- verified against `node:sqlite`. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * `node:sqlite` throws a plain `Error` carrying `code: 'ERR_SQLITE_ERROR'`
 * and SQLite's own numeric `errcode` -- verified by probe, and neither is
 * part of `@types/node`'s declared `Error` shape, so this is a runtime check
 * rather than something the compiler already knows. Checking `code` alone
 * would not do: a generic logic error (a typo'd column, a dropped table)
 * surfaces with the same `code` but `errcode: 1`, and treating that as a lost
 * race would turn a real bug into a silent no-op.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  const errcode = (err as { errcode?: unknown }).errcode;
  return code === 'ERR_SQLITE_ERROR' && errcode === SQLITE_CONSTRAINT_UNIQUE;
}

/**
 * The only implementation of `MediaWriter`. `PluginContext` also hands every
 * plugin `ctx.db`, the same raw `node:sqlite` connection this is built on, so
 * nothing stops a plugin from writing to a shared table directly and
 * bypassing both invariants below. They hold only for writes that go through
 * `ctx.media` instead of `ctx.db` — convention, not enforcement:
 *
 * - `claimProviderRef`'s dedup on `(provider, provider_ref)` is resolved
 *   here, once, rather than something every plugin has to get right.
 * - every method that mutates a row with an `updated_at` column sets it from
 *   `now`, so the client's "what changed since" flow never misses a write.
 * - a mutation that targets a row by id throws if no row matched, rather
 *   than succeeding silently: a caller that got the id wrong finds out here,
 *   not later when the write it expected turns out never to have happened.
 *
 * Built on `db.$client`, the same raw `node:sqlite` handle `HostDb` wraps,
 * rather than Drizzle's query builder: `claimProviderRef` needs the driver's
 * own error, unwrapped, to tell a UNIQUE violation from anything else.
 *
 * Takes an `ArtworkStore` because `attachPoster`/`attachBackground`/
 * `attachLogo`/`attachPersonImage` now measure and cache the bytes they are
 * handed, not just write a row: one writer for the row and the file is what
 * keeps the two from disagreeing the way 1.x's row and cached file could.
 * That makes this writer perform filesystem I/O it did not before -- the
 * cost of that one writer.
 */
export function createMediaWriter(
  db: HostDb,
  now: () => number,
  artwork: ArtworkStore,
  hooks: { dropRows: ReassignDeps['dropRows'] },
): MediaWriter {
  const raw = db.$client;

  /**
   * Every cached file path this media item's artwork rows still point at.
   * Read before any row is deleted -- `dropMediaItem` needs this list
   * intact to unlink the files afterward.
   */
  function artworkPaths(mediaItemId: number): string[] {
    const rows = raw.prepare(`
      SELECT path FROM poster     WHERE media_item_id = ? AND path IS NOT NULL
      UNION ALL
      SELECT path FROM background WHERE media_item_id = ? AND path IS NOT NULL
      UNION ALL
      SELECT path FROM logo       WHERE media_item_id = ? AND path IS NOT NULL
    `).all(mediaItemId, mediaItemId, mediaItemId);
    return rows.map((row) => String((row as { path: unknown }).path));
  }

  /**
   * The rows to drop, and the files to unlink, once a slot's new image is
   * in: every other row this owner has in that table.
   *
   * **A slot holds one image, and until this existed it accumulated them.**
   * Each `attach*` upserts on `(owner, url)`, which makes a re-run of the
   * *same* url idempotent -- the reason that key was chosen -- but makes a
   * *better* url a second row rather than a correction. Every
   * `ARTWORK_QUERY` in `api/artwork-route.ts` then serves
   * `ORDER BY id ASC LIMIT 1`, the oldest row, so the new picture was
   * written to disk and never served. Re-running the artwork job to
   * improve artwork could not work, which is how a batch of square
   * performer crops survived a deliberate re-fetch.
   *
   * Two SQL statements per table, spelled literally rather than built from
   * a table name in a variable: `scripts/check-test-hygiene.ts` reads this
   * file for reads of named tables, and an interpolated name is not one.
   * The same reason `sync/tables.ts` spells its own.
   *
   * Widening a slot to hold several images is issue #79. When that lands
   * this is what has to change, and the route's `LIMIT 1` with it -- the
   * two are one policy stated in two places.
   */
  const OTHER_ARTWORK_SQL: Readonly<Record<string, { readonly paths: string; readonly drop: string }>> = {
    poster: {
      paths: 'SELECT path FROM poster WHERE media_item_id = ? AND url <> ? AND path IS NOT NULL',
      drop: 'DELETE FROM poster WHERE media_item_id = ? AND url <> ?',
    },
    background: {
      paths: 'SELECT path FROM background WHERE media_item_id = ? AND url <> ? AND path IS NOT NULL',
      drop: 'DELETE FROM background WHERE media_item_id = ? AND url <> ?',
    },
    logo: {
      paths: 'SELECT path FROM logo WHERE media_item_id = ? AND url <> ? AND path IS NOT NULL',
      drop: 'DELETE FROM logo WHERE media_item_id = ? AND url <> ?',
    },
    person_image: {
      paths: 'SELECT path FROM person_image WHERE person_id = ? AND url <> ? AND path IS NOT NULL',
      drop: 'DELETE FROM person_image WHERE person_id = ? AND url <> ?',
    },
  };

  /**
   * Leaves `keptUrl` as the owner's only image in `table`.
   *
   * Rows first, then files, the same order and for the same reason
   * `dropMediaItem` gives: a failed unlink after the row is gone leaks a
   * file, where a failed delete after the unlink leaves a row pointing at
   * nothing that something will try to serve. The unlink is best-effort
   * for that reason -- `artwork.remove` swallowing a missing file is what
   * makes a re-run of this safe.
   */
  async function keepOnly(table: string, ownerId: number, keptUrl: string): Promise<void> {
    const sql = OTHER_ARTWORK_SQL[table];
    if (sql === undefined) return;
    const stale = raw.prepare(sql.paths).all(ownerId, keptUrl);
    if (stale.length === 0) return;
    raw.prepare(sql.drop).run(ownerId, keptUrl);
    await Promise.all(
      stale.map((row) => artwork.remove(String((row as { path: unknown }).path))),
    );
  }

  const writer: MediaWriter = {
    async createMediaItem(init: MediaItemInit): Promise<number> {
      const at = now();
      const result = raw.prepare(`
        INSERT INTO media_item (plugin_id, title, release_date, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(init.pluginId, init.title, init.releaseDate, init.description, at, at);
      return Number(result.lastInsertRowid);
    },

    async updateMediaItem(mediaItemId: number, update: MediaItemUpdate): Promise<void> {
      const at = now();
      // Replaces exactly title, release_date and description -- not
      // plugin_id, and not provider/provider_ref, which are claimProviderRef's
      // to write. A full replacement, not a partial patch: see MediaItemUpdate.
      const result = raw.prepare(
        'UPDATE media_item SET title = ?, release_date = ?, description = ?, updated_at = ? WHERE id = ?',
      ).run(update.title, update.releaseDate, update.description, at, mediaItemId);
      if (result.changes === 0) {
        throw new Error(`updateMediaItem: no media item ${mediaItemId}`);
      }
    },

    async claimProviderRef(mediaItemId: number, provider: string, ref: string): Promise<ProviderClaim> {
      const at = now();
      try {
        // One statement, so the unique index on (provider, provider_ref) is
        // what decides a race between two concurrent claims for the same
        // ref -- not a check this method does itself and could get wrong.
        raw.prepare('UPDATE media_item SET provider = ?, provider_ref = ?, updated_at = ? WHERE id = ?')
          .run(provider, ref, at, mediaItemId);
        return { kept: mediaItemId, dropped: null };
      } catch (err) {
        if (!isUniqueConstraintViolation(err)) throw err;
        // Lost the race: some other row already holds this ref. Our own
        // UPDATE was rolled back whole by the failed constraint, so this
        // caller's row is still unclaimed -- read back who actually won.
        const holderRow = raw.prepare('SELECT id FROM media_item WHERE provider = ? AND provider_ref = ?')
          .get(provider, ref);
        if (!holderRow) {
          throw new Error(
            `claimProviderRef: lost the race for ${provider}:${ref}, but no row holds it now`,
            { cause: err },
          );
        }
        const kept = Number((holderRow as { id: unknown }).id);
        return { kept, dropped: mediaItemId };
      }
    },

    async relinkRssItem(rssItemId: number, mediaItemId: number | null): Promise<void> {
      const at = now();
      // **Linking clears `lookup_json` in the same statement, and that is
      // not tidiness -- it is where the invariant lives.** A stored lookup
      // answer exists only while a release is unmatched: `/unmatched` is
      // the only screen that reads it, and that screen selects on
      // `media_item_id IS NULL`. So the moment this row gains a media item
      // the answer is unreachable, and anything that leaves it behind is
      // storage no UI can show and no code will revisit.
      //
      // It used to be cleared two statements later, by `setLookupState` at
      // the end of `openmetadata/src/engine.ts`'s resolved branch -- with
      // the plugin's own `apply` and `attachPeople` in between. A throw in
      // either left the row linked and the answer retained; the lookup job
      // retries and then **dead-letters**, so a persistently failing
      // `apply` stranded up to `LOOKUP_JSON_CAP_BYTES` per release,
      // permanently. One statement has no window to lose.
      //
      // **Unlinking deliberately does not clear.** `relinkRssItem(id,
      // null)` is the refusal path: the media item created before the
      // answer arrived is being dropped and the release goes back to being
      // unmatched, which is exactly the state an answer belongs to.
      // `applyEnvelope` writes a fresh one straight afterwards, so clearing
      // here would be a write the next statement undoes -- but the reason
      // it would be wrong is the invariant, not the redundancy.
      const result = mediaItemId === null
        ? raw.prepare('UPDATE rss_item SET media_item_id = NULL, updated_at = ? WHERE id = ?')
          .run(at, rssItemId)
        : raw.prepare('UPDATE rss_item SET media_item_id = ?, lookup_json = NULL, updated_at = ? WHERE id = ?')
          .run(mediaItemId, at, rssItemId);
      if (result.changes === 0) {
        throw new Error(`relinkRssItem: no rss item ${rssItemId}`);
      }
    },

    reassignRelease(rssItemId: number, mediaItemId: number): Promise<void> {
      return reassignRelease(
        { raw, relink: writer.relinkRssItem, drop: writer.dropMediaItem, now, dropRows: hooks.dropRows },
        rssItemId,
        mediaItemId,
      );
    },

    async dropMediaItem(mediaItemId: number): Promise<void> {
      // Read the paths, delete the rows, then unlink the files best-effort --
      // in that order. A failed unlink after the row is gone leaks a file; a
      // failed row delete after the unlink leaves a row pointing at nothing,
      // which is worse, because something will try to serve it.
      const paths = artworkPaths(mediaItemId);
      const at = now();
      // One savepoint for the three artwork tables, the media item row and
      // the tombstone that records its deletion: a crash between them must
      // not leave, say, the poster rows gone but the media item row (and thus
      // its background/logo rows) still there -- and must not leave a
      // tombstone standing over a row that is still present, which would
      // tell every syncing client an item was deleted that is not.
      raw.exec('SAVEPOINT drop_media_item');
      try {
        // The tombstone first, and reading `plugin_id` off the live row is
        // the reason: after the DELETE below there is nothing left to read it
        // from, and nothing to join a tombstone to either -- which is why
        // `deleted_media_item` carries its own copy of the owner.
        //
        // `ON CONFLICT` rather than a plain INSERT because a media item id is
        // reusable: SQLite hands the highest rowid back once its row is gone
        // (measured, not assumed), and the dedup path drops exactly the newest
        // row, so the very next `createMediaItem` takes the dropped id. The
        // second drop of that id must move the tombstone forward -- both its
        // owner and its time -- rather than abort on the primary key and take
        // the whole deletion down with it.
        //
        // Moving the *owner* forward is a real loss when the two drops
        // belong to two different plugins: the first plugin's tombstone
        // becomes the second's, so a client of the first that had not polled
        // in between never learns its item was deleted, and nothing can tell
        // it later because the live row is gone. Measured through this method
        // and `deletionsSince`; the owner half is pinned by the reused-id
        // test in `test/media/writer.test.ts`. Every alternative with one
        // row per id is worse: keeping the older tombstone loses the *second*
        // plugin's deletion instead, and the plain INSERT aborts on the
        // primary key (errcode 1555), rolling this savepoint back so that no
        // deletion is recorded and the duplicate row stays alive -- which is
        // the bug the upsert was added to fix. So this stands; the read API
        // spec's §8 records it as a known gap rather than a decision to be
        // re-derived here.
        raw.prepare(`
          INSERT INTO deleted_media_item (media_item_id, plugin_id, deleted_at)
          SELECT id, plugin_id, ? FROM media_item WHERE id = ?
          ON CONFLICT (media_item_id) DO UPDATE
            SET plugin_id = excluded.plugin_id, deleted_at = excluded.deleted_at
        `).run(at, mediaItemId);
        raw.prepare('DELETE FROM poster WHERE media_item_id = ?').run(mediaItemId);
        raw.prepare('DELETE FROM background WHERE media_item_id = ?').run(mediaItemId);
        raw.prepare('DELETE FROM logo WHERE media_item_id = ?').run(mediaItemId);
        raw.prepare('DELETE FROM media_item WHERE id = ?').run(mediaItemId);
      } catch (err) {
        raw.exec('ROLLBACK TO drop_media_item');
        raw.exec('RELEASE drop_media_item');
        throw err;
      }
      raw.exec('RELEASE drop_media_item');
      await Promise.all(paths.map((path) => artwork.remove(path)));
    },

    async attachPoster(mediaItemId: number, poster: ImageInit): Promise<void> {
      const at = now();
      const { path, width, height } = await artwork.put(mediaItemId, poster.url, poster.bytes);
      // Upsert on `(media_item_id, url)`, not a bare INSERT: every handler
      // has to be safe to run twice, because crash recovery re-runs a job
      // that was already claimed. `created_at` is left as the first write
      // set it -- the row is the same row, seen again. The path is derived
      // from `(mediaItemId, url)` (see `createArtworkStore`), matching this
      // very index, so a re-attach resolves to the same file and this
      // `path` update is a no-op in practice.
      raw.prepare(`
        INSERT INTO poster (media_item_id, title, language, url, width, height, path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (media_item_id, url) DO UPDATE
          SET title = excluded.title, language = excluded.language,
              width = excluded.width, height = excluded.height, path = excluded.path
      `).run(mediaItemId, poster.title, poster.language, poster.url, width, height, path, at);
      await keepOnly('poster', mediaItemId, poster.url);
    },

    async attachBackground(mediaItemId: number, background: ImageInit): Promise<void> {
      const at = now();
      const { path, width, height } = await artwork.put(mediaItemId, background.url, background.bytes);
      // Idempotent for the same reason as `attachPoster`. `description` has
      // no home in `ImageInit` (see the contract's doc comment) and is never
      // set here, on either the insert or the conflict update -- it stays
      // whatever it already was, which for every row this method has ever
      // written is null.
      raw.prepare(`
        INSERT INTO background (media_item_id, title, language, url, width, height, path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (media_item_id, url) DO UPDATE
          SET title = excluded.title, language = excluded.language,
              width = excluded.width, height = excluded.height, path = excluded.path
      `).run(mediaItemId, background.title, background.language, background.url, width, height, path, at);
      await keepOnly('background', mediaItemId, background.url);
    },

    async attachLogo(mediaItemId: number, logo: ImageInit): Promise<void> {
      const at = now();
      const { path, width, height } = await artwork.put(mediaItemId, logo.url, logo.bytes);
      // Idempotent for the same reason as `attachPoster` -- but not for free:
      // `logo` is the one artwork table slice A left with neither a writer
      // nor a unique index (see `schema.ts`'s own note on it), so this slice
      // added both. The index is `logo_media_item_url` in
      // `migrate.ts`; without it this `ON CONFLICT` clause has nothing to
      // conflict on and a re-run would duplicate rows instead of updating.
      raw.prepare(`
        INSERT INTO logo (media_item_id, title, language, url, width, height, path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (media_item_id, url) DO UPDATE
          SET title = excluded.title, language = excluded.language,
              width = excluded.width, height = excluded.height, path = excluded.path
      `).run(mediaItemId, logo.title, logo.language, logo.url, width, height, path, at);
      await keepOnly('logo', mediaItemId, logo.url);
    },

    async attachPersonImage(personId: number, image: ImageInit): Promise<void> {
      const at = now();
      // `artwork.putPerson`, not `artwork.put` -- see that method's own
      // docblock. A person and a media item are different tables' rows, and
      // `put` is keyed on `(mediaItemId, url)`; calling it with `personId`
      // in that slot would collide person 7's picture with media item 7's
      // poster the moment the two also shared a url. `putPerson` hashes in
      // a namespace `put` can never produce, so the two can never resolve
      // to the same path regardless of what either id or url turns out to
      // be.
      const { path, width, height } = await artwork.putPerson(personId, image.url, image.bytes);
      // Idempotent for the same reason as `attachPoster`: upsert on
      // `(person_id, url)`, matching `person_image_person_url` exactly, so a
      // handler re-run by crash recovery is the same row and the same file,
      // not a second of either.
      raw.prepare(`
        INSERT INTO person_image (person_id, title, language, url, width, height, path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (person_id, url) DO UPDATE
          SET title = excluded.title, language = excluded.language,
              width = excluded.width, height = excluded.height, path = excluded.path
      `).run(personId, image.title, image.language, image.url, width, height, path, at);
      await keepOnly('person_image', personId, image.url);
    },

    async upsertPerson(person: PersonInit): Promise<number> {
      const at = now();
      // `person_provider_ref` is unique, so this is the same dedup shape as
      // `claimProviderRef`'s -- but nothing here ever awaits between the
      // read and the write, so there is no gap for two calls to interleave
      // in: node:sqlite's calls are synchronous all the way down.
      const existingRow = raw.prepare('SELECT id FROM person WHERE provider_ref = ?').get(person.providerRef);
      if (existingRow) {
        const id = Number((existingRow as { id: unknown }).id);
        raw.prepare('UPDATE person SET name = ?, updated_at = ? WHERE id = ?').run(person.name, at, id);
        return id;
      }
      const result = raw.prepare(`
        INSERT INTO person (name, provider_ref, created_at, updated_at) VALUES (?, ?, ?, ?)
      `).run(person.name, person.providerRef, at, at);
      return Number(result.lastInsertRowid);
    },

    async attachRole(mediaItemId: number, role: RoleInit): Promise<void> {
      const at = now();
      // Upsert on `(media_item_id, person_id, role)`. One person plays one
      // part in one item once, so re-attaching the same part is the same row
      // rather than a second one -- which is what lets a `lookup` handler run
      // twice without doubling an item's cast, and what makes the dedup's
      // re-attach of the loser's people onto the winner a no-op where the two
      // casts overlap.
      raw.prepare(`
        INSERT INTO role (media_item_id, person_id, role, name, billing_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (media_item_id, person_id, role) DO UPDATE
          SET name = excluded.name, billing_order = excluded.billing_order
      `).run(mediaItemId, role.personId, role.role, role.name, role.billingOrder, at);
    },

    async setLookupState(
      rssItemId: number,
      state: LookupState,
      detail: string | null,
      lookupJson: string | null,
    ): Promise<void> {
      const at = now();
      // `lookup_json` is written on every call, including with `null`,
      // which is what clears an answer left by an earlier failure.
      raw.prepare('UPDATE rss_item SET lookup_state = ?, lookup_state_detail = ?, lookup_json = ?, updated_at = ? WHERE id = ?')
        .run(state, detail, lookupJson, at, rssItemId);
    },

    async setVideoResolution(rssItemId: number, value: string | null): Promise<void> {
      if (value !== null && normalizeVideoResolution(value) !== value) {
        throw new TypeError('media writer: not a video resolution Pickarr stores');
      }
      // `IS NOT`, not `!=`, so `null` compares as a value: an unchanged
      // resolution writes nothing, which keeps `updated_at` -- the Retry
      // button's "landed" signal and the sync log's cursor -- still.
      raw.prepare('UPDATE rss_item SET video_resolution = ?, updated_at = ? WHERE id = ? AND video_resolution IS NOT ?')
        .run(value, now(), rssItemId, value);
    },
  };
  return writer;
}
