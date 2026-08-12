import type { DatabaseSync } from 'node:sqlite';
import { maybeNum, type SqlRow } from './row.ts';

/**
 * A prefix's cached lookup answer. `site: null` is a recorded negative — the
 * prefix was asked about and is not a site — which is distinct from having no
 * row at all, meaning it has never been asked.
 */
export interface DiscoveredSite {
  prefix: string;
  site: string | null;
  source: string;
  /**
   * The answering service's identifier for the site, kept so a later feature
   * can address it directly instead of searching by name again. Null on a
   * negative answer, and null for a service that publishes none.
   */
  sourceUuid: string | null;
  /**
   * The service's *integer* id for the site. Distinct from `sourceUuid`
   * because the scene-search endpoint filters by this form only. Null on a
   * negative answer, and null when discovery predates this column or the
   * service publishes none.
   */
  sourceId: number | null;
  foundAt: number;
}

/** What a lookup learned about a prefix. `null` records a negative answer. */
export interface DiscoveredSiteInput {
  readonly site: string | null;
  readonly sourceUuid?: string | null;
  readonly sourceId?: number | null;
}

/**
 * Normalises queried text to the table's key. Matches the slug alphabet the
 * scenes parser uses, so `Anal Only`, `anal.only` and `ANAL_ONLY` are one
 * prefix and get one lookup between them.
 */
export function sitePrefixKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function getDiscoveredSite(db: DatabaseSync, prefix: string): DiscoveredSite | undefined {
  const row = db
    .prepare(
      `SELECT prefix, site, source, source_uuid, source_id, found_at
       FROM discovered_sites WHERE prefix = ?`,
    )
    .get(sitePrefixKey(prefix));
  if (row === undefined) return undefined;

  return {
    prefix: String(row['prefix']),
    site: text(row['site']),
    source: String(row['source']),
    sourceUuid: text(row['source_uuid']),
    sourceId: maybeNum(row as SqlRow, 'source_id'),
    foundAt: Number(row['found_at']),
  };
}

/**
 * Records an answer. `ON CONFLICT DO UPDATE` rather than `DO NOTHING` because
 * a later lookup is better information than an earlier one — a site added to
 * the metadata service after we cached a negative should be able to correct it
 * once something re-asks.
 */
export function recordDiscoveredSite(
  db: DatabaseSync,
  prefix: string,
  found: DiscoveredSiteInput,
  source: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO discovered_sites (prefix, site, source, source_uuid, source_id, found_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (prefix) DO UPDATE SET site = excluded.site, source = excluded.source,
                                        source_uuid = excluded.source_uuid,
                                        source_id = excluded.source_id,
                                        found_at = excluded.found_at`,
  ).run(
    sitePrefixKey(prefix),
    found.site,
    source,
    found.sourceUuid ?? null,
    found.sourceId ?? null,
    now,
  );
}

/** Every confirmed site name, for seeding a plugin at boot. */
export function knownSiteNames(db: DatabaseSync): string[] {
  return db
    .prepare('SELECT site FROM discovered_sites WHERE site IS NOT NULL ORDER BY prefix')
    .all()
    .map((row) => String(row['site']));
}

/**
 * The integer id for a site, by its canonical name.
 *
 * Keyed on `site` rather than `prefix` because several prefixes can confirm
 * one site — `bangbros ass` and `bangbros` both land on `Bang Bros` — and any
 * of their rows carries the same id. A site that came from configuration
 * rather than discovery has no row at all, and answers null: that group
 * searches with `q=` alone and is filtered on the result's own site object.
 */
export function siteIdForName(db: DatabaseSync, siteName: string): number | null {
  const row = db
    .prepare('SELECT source_id FROM discovered_sites WHERE site = ? AND source_id IS NOT NULL LIMIT 1')
    .get(siteName);
  return row === undefined ? null : Number(row['source_id']);
}

/**
 * Backfills the integer id from a scene response, which embeds the whole site
 * object. Deliberately does not insert: a site nobody has discovered has no
 * confirmed name to key on, and inventing a row here would record a discovery
 * that never happened.
 */
export function rememberSiteId(db: DatabaseSync, siteName: string, sourceId: number): void {
  db.prepare('UPDATE discovered_sites SET source_id = ? WHERE site = ? AND source_id IS NULL').run(
    sourceId,
    siteName,
  );
}
