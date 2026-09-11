import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chain, fromEnv, fromFile, memoize, ProviderError } from '@chad3814/secret-provider';
import type { Provider } from '@chad3814/secret-provider';
import { assertSecretName, envNameFor, SecretNotFound } from './names.ts';
import { readSecretValue, writeSecretValue } from './store.ts';

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

  const providerFor = (name: string): Provider<string> => {
    const existing = held.get(name);
    if (existing !== undefined) return existing;
    const built = memoize(chain(
      fromEnv(envNameFor(name)),
      fromFile(join(deps.baseDir, name)),
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
        // Every failure becomes `SecretNotFound`, because the chain's own
        // error names `fromFile`'s path (design spec §2.4) and no log line
        // here may carry a path. A non-`ProviderError` is a bug rather than
        // a missing secret, so it propagates untouched.
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
