/**
 * The token resolvers every plugin built on this engine shares, and the
 * helpers a plugin's own resolvers are written with.
 *
 * Design spec §3 divides a plugin's token list in two: `resolution`,
 * `filename` and `ext` "come from `rss_item` and the source path, so every
 * plugin has them", and the rest are the plugin's own. `title` and
 * `releaseDate` join the first group here, because both come from the
 * shared `media_item` row rather than from any plugin's table.
 *
 * **Shared implementations, but never a shared list.** Each plugin still
 * writes out every key it declares -- `{ title: resolveTitle, … }`, not
 * `{ ...SHARED, … }` -- so `MediaPlugin.tokens`' own promise holds: one
 * object is the whole answer to "what may a shape of this kind say", with
 * nothing a reader has to know to add to it. What is shared is the function
 * behind the key, because three copies of "the extension, lowercased,
 * without its dot" is three chances for two libraries to be laid out
 * differently.
 *
 * **Why `{releaseDate}` means `media_item.release_date` for all three,
 * including xxx.** `xxx_scene.released_on` holds the same value -- `applyXxx`
 * writes `details.releasedOn ?? media.releaseDate`, and the shared row gets
 * `media.releaseDate` -- so reading the plugin table would differ only for a
 * scene whose service sent a `releasedOn` detail disagreeing with its own
 * release date. One token with two meanings across three plugins is the
 * drift this file exists to avoid, and the operator who wants the scene's
 * own date has no way to ask for it today either way.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import type { DownloadedFile, PluginContext, TokenResolver } from '@pickarr/contract';

/**
 * Design spec §8.2's two digits, applied where the signal exists.
 *
 * **Here and not in `host/src/media/shape.ts`.** The resolver used to pad
 * any all-digit value, because it is handed strings and nothing on them says
 * which is a number -- so the 2009 film *9* landed as `09`, permanently
 * (§10 puts re-importing out of scope). A plugin calling this knows it is
 * holding a season number, which is the signal the resolver never had.
 *
 * **A minimum width, not a field width.** Episode 100 keeps all three
 * digits: truncating would name a different episode, and no reading of §8.2
 * makes `E00` the right answer for it.
 */
const MIN_NUMERIC_WIDTH = 2;

/** A whole number as a path segment: `2` becomes `02`, `100` stays `100`, `null` stays `null`. */
export function paddedNumber(value: number | null): string | null {
  return value === null ? null : String(value).padStart(MIN_NUMERIC_WIDTH, '0');
}

/**
 * `PluginContext.db` narrowed to the connection it is.
 *
 * The same runtime check `engine.ts`'s `asDatabase` makes and for the same
 * reason -- `db` is `unknown` by contract, and there is no compile-time
 * route from that to a connection. Not imported from there: that one is
 * private to the engine's own flow, and exporting it to be shared would
 * make a narrowing helper part of this package's surface.
 */
function connection(ctx: PluginContext): DatabaseSync {
  if (!(ctx.db instanceof DatabaseSync)) {
    throw new TypeError('openmetadata: ctx.db is not a node:sqlite DatabaseSync');
  }
  return ctx.db;
}

/**
 * One column of one row, as text, or `null` for a row that is absent or a
 * column that is.
 *
 * **A missing row is `null`, not a throw.** A plugin's own tables are
 * written by `apply` when a lookup resolves, and a shape may be resolved for
 * a media item whose plugin row a migration has not yet backfilled -- an
 * absent season is a hole design spec §8.8 already says how to render.
 * Something genuinely broken -- a column that is not text -- does throw, and
 * a throw leaves the download row `completed` for the next tick.
 */
export function queryText(
  ctx: PluginContext,
  sql: string,
  ...parameters: readonly (string | number)[]
): string | null {
  const row = connection(ctx).prepare(sql).get(...parameters);
  if (row === undefined) return null;
  return readOptionalText(row, soleColumn(row));
}

/** The same, for a column the schema declares `INTEGER`. */
export function queryInteger(
  ctx: PluginContext,
  sql: string,
  ...parameters: readonly (string | number)[]
): number | null {
  const row = connection(ctx).prepare(sql).get(...parameters);
  if (row === undefined) return null;
  const value = row[soleColumn(row)];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') throw new TypeError('openmetadata: a token column is not an integer');
  return value;
}

/**
 * The one column the query selected.
 *
 * A token is one value, so every query here selects one column; a second
 * would make "the first key" an ordering a reader has to know about.
 * Refused rather than taken, so a caller who adds a column finds out here
 * instead of getting whichever one `node:sqlite` enumerated first.
 */
function soleColumn(row: Record<string, SQLOutputValue>): string {
  const columns = Object.keys(row);
  const [column] = columns;
  if (columns.length !== 1 || column === undefined) {
    throw new TypeError(`openmetadata: a token query must select one column, not ${columns.length}`);
  }
  return column;
}

function readOptionalText(row: Record<string, SQLOutputValue>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`openmetadata: column ${column} is not text`);
  // A blank is the same hole a null is -- `resolveShape` drops both -- so it
  // is reported as the hole rather than as an empty directory name.
  return value === '' ? null : value;
}

/**
 * {@link queryText} for a query whose one parameter is the media item this
 * download resolved to, answering `null` when there is no such item.
 *
 * **The `null` arm is why this exists rather than each plugin writing
 * `file.mediaItemId ?? 0`.** That spelling compiles, reads as a default, and
 * silently asks for the row with id 0 -- which is not a row any of these
 * schemas has, so it would have worked by accident until something took
 * rowid 0. Every caller is on the matched branch anyway (design spec §6
 * means no token is resolved for an unmatched release), so this arm should
 * never be taken; it is handled rather than asserted away because the
 * field's type says it can be.
 */
export function mediaItemText(ctx: PluginContext, file: DownloadedFile, sql: string): string | null {
  return file.mediaItemId === null ? null : queryText(ctx, sql, file.mediaItemId);
}

/** The same, for a column the schema declares `INTEGER`. */
export function mediaItemInteger(ctx: PluginContext, file: DownloadedFile, sql: string): number | null {
  return file.mediaItemId === null ? null : queryInteger(ctx, sql, file.mediaItemId);
}

/**
 * The media item this download resolved to.
 *
 * Every caller here is on the matched branch: `LibraryImporter.place` does
 * not resolve tokens at all for a release nothing matched (design spec §6),
 * so `mediaItemId` is non-null by the time any of this runs. The `null`
 * arm is still handled rather than asserted away, because the field's type
 * says it can be.
 */
async function mediaItem(file: DownloadedFile, ctx: PluginContext) {
  return file.mediaItemId === null ? null : ctx.read.mediaItem(file.mediaItemId);
}

/** `media_item.title`. */
export const resolveTitle: TokenResolver = async (file, ctx) => {
  const item = await mediaItem(file, ctx);
  return item === null || item.title === '' ? null : item.title;
};

/** `media_item.release_date`, the service's own ISO `yyyy-mm-dd`. */
export const resolveReleaseDate: TokenResolver = async (file, ctx) => {
  const item = await mediaItem(file, ctx);
  return item?.releaseDate ?? null;
};

/** The year of {@link resolveReleaseDate}, which is what a film library is named by. */
export const resolveYear: TokenResolver = async (file, ctx) => {
  const date = await resolveReleaseDate(file, ctx);
  // The first four characters, not a `Date`: the column is the service's own
  // `yyyy-mm-dd` string, and parsing it would introduce a timezone where
  // there is none -- `new Date('2009-01-01').getFullYear()` is 2008 west of
  // UTC. Anything not shaped like a year contributes no year at all.
  const year = date === null ? '' : date.slice(0, 4);
  return /^[0-9]{4}$/.test(year) ? year : null;
};

/**
 * `rss_item.resolution` for the item this download was started for.
 *
 * Hand-written SQL against a host table, like `engine.ts`'s own
 * `readRssItems` and for the same reason: `MediaReader` reaches rss items
 * only *through* a media item, and this one is reached through the download
 * instead. `rssItemsFor(mediaItemId)` would answer every item that ever
 * matched the same media item, which is a list of the releases this one beat
 * rather than this one.
 */
export const resolveResolution: TokenResolver = async (file, ctx) =>
  queryText(ctx, 'SELECT resolution FROM rss_item WHERE id = ?', file.rssItemId);

/**
 * The source file's name **without** its extension.
 *
 * Without, so that `{filename}.{ext}` reproduces the source name rather than
 * doubling the extension -- the same composability `{title}.{ext}` has. A
 * leading dot is not an extension: `.hidden` is the whole name.
 */
export const resolveFilename: TokenResolver = async (file) => {
  const name = baseName(file.path);
  const dot = name.lastIndexOf('.');
  const stem = dot <= 0 ? name : name.slice(0, dot);
  return stem === '' ? null : stem;
};

/**
 * The source file's extension, lowercased and without its dot.
 *
 * Lowercased unconditionally, the one rewrite here, and 1.x's
 * `plan-import.ts` records why: `scene.MP4` and `scene.mp4` must resolve to
 * one destination, or the same release imported twice under two spellings
 * lands as two files and neither is a duplicate of the other.
 */
export const resolveExtension: TokenResolver = async (file) => {
  const name = baseName(file.path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
};

/**
 * The last segment of a host path.
 *
 * Both separators, unlike `node:path`'s `basename`, which on POSIX splits on
 * `/` alone. The path is local -- `deliverCompleted` has already mapped it
 * through `filepath_mapping` -- so `/` is the separator that matters, and
 * splitting on `\` as well costs nothing and is right on a host where it
 * separates. `node:path` is not imported because this package runs beside a
 * host whose platform it does not get to assume.
 */
function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}
