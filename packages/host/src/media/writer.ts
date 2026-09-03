import type {
  BackgroundInit,
  MediaItemInit,
  MediaWriter,
  PersonInit,
  PosterInit,
  ProviderClaim,
  Resolution,
  RoleInit,
} from '@pickarr/contract';
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
 *
 * Built on `db.$client`, the same raw `node:sqlite` handle `HostDb` wraps,
 * rather than Drizzle's query builder: `claimProviderRef` needs the driver's
 * own error, unwrapped, to tell a UNIQUE violation from anything else.
 */
export function createMediaWriter(db: HostDb, now: () => number): MediaWriter {
  const raw = db.$client;

  return {
    async createMediaItem(init: MediaItemInit): Promise<number> {
      const at = now();
      const result = raw.prepare(`
        INSERT INTO media_item (plugin_id, title, release_date, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(init.pluginId, init.title, init.releaseDate, init.description, at, at);
      return Number(result.lastInsertRowid);
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

    async relinkRssItem(rssItemId: number, mediaItemId: number): Promise<void> {
      const at = now();
      raw.prepare('UPDATE rss_item SET media_item_id = ?, updated_at = ? WHERE id = ?')
        .run(mediaItemId, at, rssItemId);
    },

    async dropMediaItem(mediaItemId: number): Promise<void> {
      raw.prepare('DELETE FROM media_item WHERE id = ?').run(mediaItemId);
    },

    async attachPoster(mediaItemId: number, poster: PosterInit): Promise<void> {
      const at = now();
      // Upsert on `(media_item_id, url)`, not a bare INSERT: every handler
      // has to be safe to run twice, because crash recovery re-runs a job
      // that was already claimed. `created_at` is left as the first write
      // set it -- the row is the same row, seen again.
      raw.prepare(`
        INSERT INTO poster (media_item_id, title, language, url, width, height, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (media_item_id, url) DO UPDATE
          SET title = excluded.title, language = excluded.language,
              width = excluded.width, height = excluded.height
      `).run(mediaItemId, poster.title, poster.language, poster.url, poster.width, poster.height, at);
    },

    async attachBackground(mediaItemId: number, background: BackgroundInit): Promise<void> {
      const at = now();
      // Idempotent for the same reason as `attachPoster`.
      raw.prepare(`
        INSERT INTO background (media_item_id, title, description, language, url, width, height, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (media_item_id, url) DO UPDATE
          SET title = excluded.title, description = excluded.description,
              language = excluded.language, width = excluded.width, height = excluded.height
      `).run(
        mediaItemId,
        background.title,
        background.description,
        background.language,
        background.url,
        background.width,
        background.height,
        at,
      );
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
