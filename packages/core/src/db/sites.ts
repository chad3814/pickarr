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
  foundAt: number;
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

export function getDiscoveredSite(db: DatabaseSync, prefix: string): DiscoveredSite | undefined {
  const row = db
    .prepare('SELECT prefix, site, source, found_at FROM discovered_sites WHERE prefix = ?')
    .get(sitePrefixKey(prefix));
  if (row === undefined) return undefined;

  const site = row['site'];
  return {
    prefix: String(row['prefix']),
    site: site === null || site === undefined ? null : String(site),
    source: String(row['source']),
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
  site: string | null,
  source: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO discovered_sites (prefix, site, source, found_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (prefix) DO UPDATE SET site = excluded.site, source = excluded.source,
                                        found_at = excluded.found_at`,
  ).run(sitePrefixKey(prefix), site, source, now);
}

/** Every confirmed site name, for seeding a plugin at boot. */
export function knownSiteNames(db: DatabaseSync): string[] {
  return db
    .prepare('SELECT site FROM discovered_sites WHERE site IS NOT NULL ORDER BY prefix')
    .all()
    .map((row) => String(row['site']));
}
