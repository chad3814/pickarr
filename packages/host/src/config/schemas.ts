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
/**
 * The proxy hops `advanced.ipAddress.trustedProxies` believes by default.
 *
 * **Loopback and the RFC1918/ULA blocks, so a reverse proxy on the LAN or in
 * a Docker network works with no configuration.** Better Auth walks
 * `x-forwarded-for` from the right, skipping addresses that match one of
 * these, and takes the first that does not -- so a proxy inside these ranges
 * yields the real client. With an empty list it refuses any header carrying
 * more than one hop, which is the "could not determine a client IP" warning.
 *
 * **What this costs, stated because it is a security default and not a
 * convenience one.** Any host inside these ranges can set `x-forwarded-for`
 * and be believed, and the resolved address is what rate limiting buckets
 * on -- so a LAN host can spend, or evade, another client's budget. The
 * alternative was an empty default that every proxied deployment has to
 * discover through a warning, and this repo's owner chose working-by-default
 * with the forgery understood. Narrow it to your proxy's own address to
 * remove that: `server.trustedProxies` replaces this list, never extends it.
 */
export const DEFAULT_TRUSTED_PROXIES = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
] as const;

export const serverConfigSchema = z.object({
  // 0.0.0.0, not loopback: from the auth slice on, a session is what protects
  // this socket rather than the interface it listens on.
  host: z.string().min(1).default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(7676),
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
  // Optional with no default, on the same reasoning as `publicUrl`: absent
  // means "derive it", and `web` beside the host's own `dist` (design spec
  // §3) is not a value this schema can compute -- `main.ts`'s
  // `defaultWebRoot` does, from where the running process's own code lives,
  // which this file has no way to see.
  webRoot: z.string().min(1).optional(),
  /**
   * Origins a browser may reach this host at, beyond `publicUrl`.
   *
   * **A host is reachable at more than one origin and only one can be
   * `publicUrl`.** That field is also Better Auth's `baseURL`, so it is the
   * *canonical* address; this is the list of others that are still allowed
   * to sign in. The case that made it necessary: a deployment behind a
   * reverse proxy at `https://pickarr.example` that the operator also
   * reaches directly at `http://box:7676`. Before this, the second was
   * refused `Invalid origin` and the install could not be claimed from it.
   *
   * **Hostnames are not inferred, and that is deliberate.** A request whose
   * origin is a private-range IP literal is trusted without configuration
   * (`auth/instance.ts`'s `isPlaceableOrigin`), because the address itself
   * proves where it came from. Nothing distinguishes `http://box:7676` from
   * an attacker-controlled DNS name that resolves anywhere, so a hostname
   * has to be named here.
   */
  trustedOrigins: z.array(
    z.string().superRefine((value, ctx) => {
      try {
        assertOriginOnly(value, 'server.trustedOrigins');
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : 'server.trustedOrigins holds a value that is not an origin',
        });
      }
    }),
  ).default([]),
  /** CIDR blocks whose addresses are proxies rather than clients. See {@link DEFAULT_TRUSTED_PROXIES}. */
  trustedProxies: z.array(z.string().min(1)).default([...DEFAULT_TRUSTED_PROXIES]),
  /**
   * Headers to read the client address from, in order. Absent leaves Better
   * Auth's own default, `x-forwarded-for`, rather than restating it here --
   * a second copy of a library default is a thing to keep in step for no
   * gain.
   */
  ipAddressHeaders: z.array(z.string().min(1)).optional(),
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
