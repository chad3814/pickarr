import type {
  ImageInit,
  MediaItemInit,
  MediaItemUpdate,
  MediaWriter,
  PersonInit,
  ProviderClaim,
  Resolution,
  RoleInit,
} from '@pickarr/contract';
import type { ArtworkStore } from '../artwork/store.ts';
import type { HostDb } from '../db/open.ts';

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
 * `attachLogo` now measure and cache the bytes they are handed, not just
 * write a row: one writer for the row and the file is what keeps the two
 * from disagreeing the way 1.x's row and cached file could. That makes this
 * writer perform filesystem I/O it did not before -- the cost of that one
 * writer.
 */
export function createMediaWriter(db: HostDb, now: () => number, artwork: ArtworkStore): MediaWriter {
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

  return {
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
      const result = raw.prepare('UPDATE rss_item SET media_item_id = ?, updated_at = ? WHERE id = ?')
        .run(mediaItemId, at, rssItemId);
      if (result.changes === 0) {
        throw new Error(`relinkRssItem: no rss item ${rssItemId}`);
      }
    },

    async dropMediaItem(mediaItemId: number): Promise<void> {
      // Read the paths, delete the rows, then unlink the files best-effort --
      // in that order. A failed unlink after the row is gone leaks a file; a
      // failed row delete after the unlink leaves a row pointing at nothing,
      // which is worse, because something will try to serve it.
      const paths = artworkPaths(mediaItemId);
      // One savepoint for the three artwork tables and the media item row:
      // a crash between them must not leave, say, the poster rows gone but
      // the media item row (and thus its background/logo rows) still there.
      raw.exec('SAVEPOINT drop_media_item');
      try {
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

    async setResolution(rssItemId: number, resolution: Resolution, detail: string | null): Promise<void> {
      const at = now();
      raw.prepare('UPDATE rss_item SET resolution = ?, resolution_detail = ?, updated_at = ? WHERE id = ?')
        .run(resolution, detail, at, rssItemId);
    },
  };
}
