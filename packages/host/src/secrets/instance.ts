import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chain, fromEnv, fromFile, memoize, ProviderError } from '@chad3814/secret-provider';
import type { Provider } from '@chad3814/secret-provider';
import { assertSecretName, envNameFor, SecretNotFound, SecretsFileUnreadable } from './names.ts';
import { readSecretValue, writeSecretValue } from './store.ts';

/**
 * The file link's "present but broken" failure, on its way out of `chain`.
 *
 * Module-private, and it never escapes `get`: it exists only because `chain`
 * halts on a `ProviderError` whose `tryNextLink` is `false` and on nothing
 * else, so the signal has to be one -- while `fromFile`'s own instance of
 * that class carries the path in its message and must not travel. `get`
 * converts this into the public {@link SecretsFileUnreadable}, which is a
 * plain `Error` with a truthful `name`; this one's `name` is stuck at
 * `'ProviderError'`, because the base class declares that property as a
 * readonly literal and a subclass cannot redeclare it. That is exactly why
 * the error an operator sees is the other class and not this one.
 */
class UnreadableFileLink extends ProviderError {
  constructor() {
    super('the secrets file is present and could not be read', false);
  }
}

export interface Secrets {
  /** The credential for `name`, from the environment, the secrets directory or the `secret` table, in that order. */
  get(name: string): Promise<string>;
  /** Stores a credential and drops any memoized value for that name. */
  saveSecret(name: string, value: string): void;
}

/**
 * One way to fetch a credential, for every caller.
 *
 * The chain's order is its whole contract: the environment beats a file,
 * which beats the database. That is what lets a container deployment override
 * a credential the settings UI stored, without the settings UI knowing.
 * Nothing logs which link answered -- the order *is* the answer, so a
 * misconfiguration is diagnosed by knowing it rather than by reading a log
 * line (design spec §8).
 *
 * **"Beats" means a link that answers, not a link that fails.** A missing
 * variable and a missing file fall through; a secrets *directory* that is
 * present and unreadable does not -- it halts the chain, and the database is
 * never consulted. That is `fromFile`'s deliberate policy and it is kept; see
 * {@link SecretsFileUnreadable}, which is what `get` raises for it so the
 * case is distinguishable from "this credential was never configured".
 *
 * A provider is built once per name and held, so `memoize` can do its job:
 * measured, three concurrent `get` calls for one name produce one underlying
 * read, and a rejection is not cached, so a secret that appears later
 * resolves without a restart.
 *
 * `saveSecret` drops the held provider in the same call that writes. Without
 * that, editing a credential would leave every resolved caller on the old
 * value until the process restarted -- a silent authentication failure
 * against a service whose password had just been fixed. There is deliberately
 * no public `invalidate`: the only way to change a secret is the call that
 * already invalidates it, so it cannot be forgotten.
 */
export function createSecrets(deps: {
  raw: DatabaseSync;
  baseDir: string;
  now?: () => number;
}): Secrets {
  const now = deps.now ?? Date.now;
  const held = new Map<string, Provider<string>>();

  const fromDatabase = (name: string): Provider<string> => async () => {
    const value = readSecretValue(deps.raw, name);
    if (value === null) {
      throw new ProviderError(`no secret row for ${JSON.stringify(name)}`);
    }
    return value;
  };

  /**
   * `fromFile`, with its own "present but broken" failure replaced by one
   * that carries no path. The replacement is still a chain-halting
   * `ProviderError`, so the database stays unconsulted exactly as before --
   * only the error an operator ends up reading changes.
   */
  const fromSecretsFile = (name: string): Provider<string> => {
    const read = fromFile(join(deps.baseDir, name));
    return async () => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof ProviderError && !error.tryNextLink) throw new UnreadableFileLink();
        // An absent or empty file: `fromFile` marks those `tryNextLink:
        // true`, and the chain's own fall-through is what should handle
        // them. Their messages name the path and never leave `get`.
        throw error;
      }
    };
  };

  const providerFor = (name: string): Provider<string> => {
    const existing = held.get(name);
    if (existing !== undefined) return existing;
    const built = memoize(chain(
      fromEnv(envNameFor(name)),
      fromSecretsFile(name),
      fromDatabase(name),
    ));
    held.set(name, built);
    return built;
  };

  return {
    async get(name: string): Promise<string> {
      // Before the path is built, never after: `join` with a name containing
      // `..` would read outside `baseDir`.
      assertSecretName(name);
      try {
        return await providerFor(name)();
      } catch (error) {
        // Every failure becomes an error of this subsystem's own, because
        // the chain's error names `fromFile`'s path (design spec §2.4) and
        // no log line here may carry a path. A non-`ProviderError` is a bug
        // rather than a missing secret, so it propagates untouched.
        //
        // **The unreadable-file case is checked first, and has to be:**
        // `UnreadableFileLink` is a `ProviderError` (nothing else halts the
        // chain), so the broader branch below would otherwise swallow it and
        // report a permissions failure as a credential nobody configured.
        if (error instanceof UnreadableFileLink) throw new SecretsFileUnreadable(name);
        if (error instanceof ProviderError) throw new SecretNotFound(name);
        throw error;
      }
    },

    saveSecret(name: string, value: string): void {
      assertSecretName(name);
      writeSecretValue(deps.raw, name, value, now());
      held.delete(name);
    },
  };
}
