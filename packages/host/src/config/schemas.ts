import { z } from 'zod';
import { assertOriginOnly } from '../origin.ts';

/** Where the config file lives when `PICKARR_CONFIG` says nothing -- beside the database's own default. */
export const DEFAULT_CONFIG_PATH = '/config/pickarr.config.json';

/**
 * Every namespace is `.strict()` and `.prefault({})`.
 *
 * `.strict()` because a typo that parses to a default is a configuration
 * change that does nothing and reports nothing. `.prefault({})` because an
 * absent section reaches `parse` as `undefined`, and a schema without it
 * would make a first boot with no config file throw (design spec §2.6c).
 */
export const serverConfigSchema = z.object({
  // 0.0.0.0, not loopback: from the auth slice on, a session is what protects
  // this socket rather than the interface it listens on.
  host: z.string().min(1).default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(8787),
  // Optional with no default: absent means "derive it from the bind address",
  // which is not a value this schema can compute.
  publicUrl: z.string()
    .superRefine((value, ctx) => {
      try {
        assertOriginOnly(value, 'server.publicUrl');
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : 'server.publicUrl is not an origin',
        });
      }
    })
    .optional(),
}).strict().prefault({});

export const databaseConfigSchema = z.object({
  path: z.string().min(1).default('/config/pickarr.db'),
}).strict().prefault({});

export const secretsConfigSchema = z.object({
  baseDir: z.string().min(1).default('/run/secrets'),
}).strict().prefault({});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;
