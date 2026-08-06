import type { DatabaseSync } from 'node:sqlite';

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
  foundAt: number;
}

/** What a lookup learned about a prefix. `null` records a negative answer. */
export interface DiscoveredSiteInput {
  readonly site: string | null;
  readonly sourceUuid?: string | null;
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
      `SELECT prefix, site, source, source_uuid, found_at
       FROM discovered_sites WHERE prefix = ?`,
    )
    .get(sitePrefixKey(prefix));
  if (row === undefined) return undefined;

  return {
    prefix: String(row['prefix']),
    site: text(row['site']),
    source: String(row['source']),
    sourceUuid: text(row['source_uuid']),
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
    `INSERT INTO discovered_sites (prefix, site, source, source_uuid, found_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (prefix) DO UPDATE SET site = excluded.site, source = excluded.source,
                                        source_uuid = excluded.source_uuid,
                                        found_at = excluded.found_at`,
  ).run(sitePrefixKey(prefix), found.site, source, found.sourceUuid ?? null, now);
}

/** Every confirmed site name, for seeding a plugin at boot. */
export function knownSiteNames(db: DatabaseSync): string[] {
  return db
    .prepare('SELECT site FROM discovered_sites WHERE site IS NOT NULL ORDER BY prefix')
    .all()
    .map((row) => String(row['site']));
}
