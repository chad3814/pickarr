/**
 * How the host answers a plugin's request for a credential.
 *
 * A stub, and deliberately shaped like the thing that replaces it: a secret
 * store is being built elsewhere, and this is the seam it drops into. What
 * makes the seam worth having now is what it already prevents -- no plugin
 * reads `process.env`, so no plugin decides where a credential lives, and the
 * one place that does is this file.
 *
 * Async because the real store will be: a resolver called per request can
 * serve a rotated credential, where a value read once at boot cannot.
 */
export type ResolveSecret = (key: string) => Promise<string>;

/** The logical key the openmetadata plugins ask for. */
export const OPENMETADATA_API_KEY = 'openmetadata-api-key';

/** The variable it is read from. */
export const OPENMETADATA_API_KEY_VARIABLE = 'PICKARR_OPENMETADATA_KEY';

/** Logical key to environment variable. One entry per credential a plugin may ask for. */
const VARIABLES: Readonly<Record<string, string>> = {
  [OPENMETADATA_API_KEY]: OPENMETADATA_API_KEY_VARIABLE,
};

/**
 * Takes the environment rather than reading `process.env` itself, so it is
 * testable without mutating the environment the whole process shares -- the
 * same rule `main.ts`'s resolvers follow.
 *
 * **Rejects rather than answering an empty string.** A resolver that answered
 * `''` would send `Authorization: Bearer ` and the first lookup would fail
 * with a 401, which says nothing about what to fix. Rejecting names the
 * variable to set, and the job's error carries that name.
 */
export function createEnvSecretResolver(
  env: Readonly<Record<string, string | undefined>>,
): ResolveSecret {
  return async (key: string): Promise<string> => {
    const variable = VARIABLES[key];
    if (variable === undefined) {
      throw new Error(`no secret is configured for "${key}"`);
    }
    const value = env[variable];
    // An empty variable is an unset one, exactly as it is for every
    // `PICKARR_*` value `main.ts` resolves: `KEY=` is what a compose file with
    // the key and no value passes.
    if (value === undefined || value === '') {
      throw new Error(`${variable} is not set, and a lookup cannot authenticate without it`);
    }
    return value;
  };
}
