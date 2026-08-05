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

export const feedSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  plugin: z.string().min(1),
  intervalSeconds: z.number().int().positive().default(900),
});

export const configSchema = z.object({
  server: z.object({ port: z.number().int().positive().default(8080) }).default({ port: 8080 }),
  database: z.object({ path: z.string().min(1) }),
  trashDir: z.string().min(1),
  plugins: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))),
  downloadClients: z.array(downloadClientSchema).min(1),
  feeds: z.array(feedSchema).min(1),
});

export type PickarrConfig = z.infer<typeof configSchema>;
export type DownloadClientConfig = z.infer<typeof downloadClientSchema>;
export type FeedConfig = z.infer<typeof feedSchema>;
export type PathMapping = z.infer<typeof pathMappingSchema>;
