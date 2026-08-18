import { z } from 'zod';

/**
 * Marks a config value as an indirection to a file holding the real value, so
 * secrets can arrive as Docker Compose secrets. Resolved by loadConfig after
 * this schema has run, which is why the length rule below has to let these
 * through and be re-applied to the resolved value.
 */
export const SECRET_REFERENCE_PREFIX = 'file:';

/**
 * The shortest download-client api key the config will accept. SABnzbd issues
 * 32 hex characters, so nothing legitimate is anywhere near this short.
 *
 * The reason for a floor is legibility, not safety. The client substring-matches
 * its key against text it did not write; a two- or three-character key matches
 * inside ordinary English and would turn every diagnostic the client emits into
 * an unreadable smear. Refusing that configuration at boot is better than
 * shipping a client whose error messages are useless. Confidentiality does not
 * rest on this number — see the fail-closed check in clients/sabnzbd.ts, which
 * holds for a key of any length.
 */
export const MIN_API_KEY_LENGTH = 16;

export const pathMappingSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export const downloadClientSchema = z.object({
  id: z.string().min(1),
  type: z.literal('sabnzbd'),
  url: z.string().url(),
  // A `file:` reference is exempt here because the schema is looking at the
  // path, not the key; loadConfig re-checks the length once it has resolved.
  apiKey: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.startsWith(SECRET_REFERENCE_PREFIX) || value.length >= MIN_API_KEY_LENGTH,
      `apiKey must be at least ${MIN_API_KEY_LENGTH} characters, or a "${SECRET_REFERENCE_PREFIX}" reference to a file containing such a key`,
    ),
  // Must be unique to this Pickarr installation if multiple instances share
  // one SABnzbd server: reconcile recovers an orphaned download by a label
  // derived only from the download's own row id (see downloadLabel in
  // db/downloads.ts), with no per-installation salt, so two instances
  // polling the same category could each recover the other's job.
  category: z.string().min(1),
  importMode: z.enum(['move', 'copy']),
  pathMappings: z.array(pathMappingSchema).default([]),
});

/**
 * How to walk a feed backwards through its own pagination, and absent by default
 * — a feed without this block is polled for its current page exactly as before.
 *
 * `style` is stated rather than detected. The failure of a wrong guess is silent
 * (an indexer ignoring the parameter serves page one forever, and every item on it
 * is already known, so the walk reports itself finished having read nothing), and
 * there is nothing in a generic RSS document to detect from — Newznab's
 * `<newznab:response offset= total=>` is exactly what the non-Newznab feeds this
 * also serves do not carry.
 *
 * `pageSize` has to match what the indexer really returns per page, because
 * `newznab` offsets are computed from it: too large silently skips items, too
 * small merely re-reads them, and re-reading is free. It is the one field here a
 * user can get quietly wrong.
 */
export const feedBackfillSchema = z.object({
  style: z.enum(['newznab', 'page']),
  pageSize: z.number().int().positive().default(100),
  /**
   * Pages per pass, which is also the rate limit. Backfilled titles go through
   * the same site resolution the live poll uses — skipping it would key old
   * groups differently from new ones and split one scene in two — so this bounds
   * a burst against a provider the metadata passes also budget for.
   *
   * At least two, and that floor is load-bearing rather than taste. The only
   * defence against an indexer that ignores the pagination parameter is noticing
   * that consecutive pages carry the same items, and comparing them requires
   * fetching two of them in one pass. At one page per pass there is nothing to
   * compare against and the walk would report itself `done` having read page one
   * repeatedly. Someone wanting a gentler walk should raise the interval, which
   * costs nothing, rather than lower this, which costs the guard.
   */
  pagesPerPass: z.number().int().min(2).default(2),
  /** Total pages ever walked for this feed, after which it stops as `exhausted`. */
  maxPages: z.number().int().positive().default(100),
});

export const feedSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  plugin: z.string().min(1),
  intervalSeconds: z.number().int().positive().default(900),
  backfill: feedBackfillSchema.optional(),
});

/**
 * Optional metadata service used to settle the site of a release whose name
 * cannot settle it alone. Absent means the feature is off and such names fall
 * back to treating the first word as the site.
 */
export const siteLookupSchema = z.object({
  type: z.literal('theporndb'),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().default('https://api.theporndb.net'),
});

export type SiteLookupConfig = z.infer<typeof siteLookupSchema>;

/**
 * The asynchronous scene-metadata worker.
 *
 * Credentials come from `siteLookup`, which already carries the key and base
 * URL for the same service; no `siteLookup` means no metadata, exactly as it
 * already means no site lookup. Renaming that block for accuracy would break
 * every documented config for a cosmetic gain.
 */
export const metadataSchema = z.object({
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().positive().default(5),
  /**
   * Groups looked up per pass. With the default interval that is a ceiling of
   * one request per second, before backoff or a rate-limit cooldown.
   */
  perTick: z.number().int().positive().default(5),
  // Left unresolved here deliberately: the default (an `artwork/` directory
  // beside the database) needs `config.database.path`, which this schema
  // cannot see in isolation — resolved once in main.ts instead.
  artworkDir: z.string().min(1).optional(),
});

export type MetadataConfig = z.infer<typeof metadataSchema>;

export const configSchema = z.object({
  server: z.object({ port: z.number().int().positive().default(8080) }).default({ port: 8080 }),
  database: z.object({ path: z.string().min(1) }),
  trashDir: z.string().min(1),
  // Mirrors PluginConfig in @pickarr/plugin-api; the array member is what lets
  // a plugin take a list (the scenes plugin's known site names) without
  // inventing a delimiter that a value could contain.
  plugins: z.record(
    z.string(),
    z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
    ),
  ),
  downloadClients: z.array(downloadClientSchema).min(1),
  feeds: z.array(feedSchema).min(1),
  siteLookup: siteLookupSchema.optional(),
  metadata: metadataSchema.default({}),
});

export type PickarrConfig = z.infer<typeof configSchema>;
export type DownloadClientConfig = z.infer<typeof downloadClientSchema>;
export type FeedConfig = z.infer<typeof feedSchema>;
export type FeedBackfillConfig = z.infer<typeof feedBackfillSchema>;
export type PathMapping = z.infer<typeof pathMappingSchema>;
