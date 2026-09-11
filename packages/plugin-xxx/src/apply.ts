/**
 * One resolved answer, written as a scene.
 *
 * The site is upserted first and the scene points at it, so scenes from one
 * site share a row. Both writes are upserts keyed on a unique index, because a
 * retried job must re-write rather than duplicate.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { ApplyArgs, DetailValue } from '@pickarr/openmetadata';

function wholeNumber(details: Readonly<Record<string, DetailValue>>, key: string): number | null {
  const value = details[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function text(details: Readonly<Record<string, DetailValue>>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readInteger(row: Record<string, SQLOutputValue> | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value !== 'number') {
    throw new TypeError(`plugin-xxx: expected an integer ${column}, got ${String(value)}`);
  }
  return value;
}

function upsertSite(
  raw: DatabaseSync,
  site: { provider: string; providerRef: string; name: string },
  now: number,
): number {
  const row = raw.prepare(`
    INSERT INTO xxx_site (provider, provider_ref, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      name       = excluded.name,
      updated_at = excluded.updated_at
    RETURNING id
  `).get(site.provider, site.providerRef, site.name, now, now);
  return readInteger(row, 'id');
}

export async function applyXxx(args: ApplyArgs): Promise<void> {
  const { media, mediaItemId, raw, now } = args;
  if (media.kind !== 'scene') {
    throw new Error(`plugin-xxx: an xxx lookup answered with kind ${media.kind}`);
  }

  const siteName = text(media.details, 'siteName');
  const siteRef = text(media.details, 'siteRef');
  // Both, or neither. A name with no reference has nothing to key a row on,
  // and keying on the name would merge two sites that renamed into each
  // other's previous name -- so it is recorded in `details_json` and nowhere
  // else. A scene whose site is unknown is still a scene worth having.
  const siteId = siteName !== null && siteRef !== null
    ? upsertSite(raw, { provider: media.provider, providerRef: siteRef, name: siteName }, now)
    : null;

  raw.prepare(`
    INSERT INTO xxx_scene
      (media_item_id, site_id, duration_seconds, released_on, details_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (media_item_id) DO UPDATE SET
      site_id          = excluded.site_id,
      duration_seconds = excluded.duration_seconds,
      released_on      = excluded.released_on,
      details_json     = excluded.details_json,
      updated_at       = excluded.updated_at
  `).run(
    mediaItemId,
    siteId,
    wholeNumber(media.details, 'durationSeconds'),
    // The detail when the service sends one, else the answer's own release
    // date: one date for a reader rather than a null beside a date the media
    // item already has.
    text(media.details, 'releasedOn') ?? media.releaseDate,
    JSON.stringify(media.details),
    now,
    now,
  );
}
