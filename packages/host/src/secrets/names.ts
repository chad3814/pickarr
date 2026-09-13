/**
 * The shape of a secret name, and the two things derived from one.
 *
 * A name is addressed three ways: as an environment variable, as a file under
 * the secrets directory, and as a row in `secret`. The file case is why the
 * shape is enforced rather than trusted -- the path is built by joining this
 * string, so a name containing `..` or a separator would read outside the
 * directory. Refusing `.` and `/` outright is what makes that impossible,
 * and it is checked before any path is built.
 *
 * A name is not a secret, so an error may name it. Its *value* never appears
 * in any message here.
 */
export const SECRET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Throws unless `name` matches {@link SECRET_NAME}. */
export function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new Error(
      `secret name ${JSON.stringify(name)} is not lowercase alphanumerics, ` +
      `underscores and hyphens, 1 to 64 characters, starting alphanumeric`,
    );
  }
}

/**
 * Every secret's variable lives under this prefix, and nothing else does.
 *
 * **Without it a secret's name lands in the ambient environment.** Measured
 * on the unprefixed form: `envNameFor('path')` was `PATH`, and `get('path')`
 * for a secret saved to the database returned the container's `PATH` --
 * `fromEnv` wins the chain, so the stored value was never read, and that
 * string would have gone to a third-party client as its api key. Every name
 * that uppercases onto a variable the process already has does this:
 * `path`, `home`, `user`, `shell`, `lang`, `term`, `pwd`, `hostname`, `tz`,
 * `node_env`. `assertSecretName` accepts all of them, and it should -- they
 * are ordinary names, and namespacing the variable is the fix, not
 * forbidding the name.
 *
 * Latent rather than live when it was found: the only production writer of a
 * name is `randomUUID()` (migration 14 and `scripts/seed-client.ts`), and no
 * uuid collides with anything. It goes live the first time a settings UI
 * lets a human type one, which is why this is here now -- no consumer sets a
 * secret by environment yet, so the prefix costs nothing today and would be
 * a breaking change later.
 */
export const SECRET_ENV_PREFIX = 'PICKARR_SECRET_';

/**
 * The environment variable that overrides a secret.
 *
 * Hyphens become underscores because a `randomUUID()` carries them and an
 * environment variable may not: without this, the env link could never
 * resolve for a credential the settings UI stored, and the rule would differ
 * between a generated name and a chosen one.
 *
 * **One rule for every name, the uuid form included** -- a name-shaped
 * special case is how a resolver ends up with two behaviours nobody can
 * predict from the outside.
 *
 * **`a-b` and `a_b` still map to one variable**, and the prefix does not
 * change that: both are `PICKARR_SECRET_A_B`, so two distinct `secret` rows
 * share one override and the env link cannot tell them apart. Setting that
 * variable overrides whichever of the two is asked for. Nothing generates
 * both forms today (a uuid has hyphens and no underscores), and the fix
 * would be to refuse one of the two characters in `SECRET_NAME`, which is a
 * change to what names are legal rather than to this function.
 *
 * **The prefix also makes the variable one a shell can assign**, which the
 * bare form was not. Measured: 200 of 200 uuids begin with a hex digit --
 * they are hex -- and 114 of 200 begin with a *decimal* digit, which is the
 * property that matters and is 10/16 = 62.5% by construction. `sh`, `zsh`
 * and `bash` all refuse `550E8400_X=v` as a command rather than an
 * assignment (`$550E8400_X` expands as `$5` followed by literal text), and
 * all three accept `PICKARR_SECRET_550E8400_X=v`, measured the same way. So
 * the env link now serves a generated name from a shell as well as from
 * `env(1)`, a Docker `environment:` entry or a systemd `Environment=` --
 * though a uuid's home is still the `secret` table.
 */
export function envNameFor(name: string): string {
  return `${SECRET_ENV_PREFIX}${name.toUpperCase().replaceAll('-', '_')}`;
}

/**
 * No link in a secret's chain produced a value.
 *
 * This replaces the `ProviderError` the chain throws, which is not safe to
 * propagate: design spec §2.4 measured that its message joins every link's
 * failure, `fromFile`'s **full path** included, and no log line in this repo
 * may carry a path. The name alone is what survives.
 *
 * The property is `secretName`, not `name`: `Error.name` already means the
 * error's class, and shadowing it would report a secret's name everywhere a
 * tool expects `'SecretNotFound'`.
 */
export class SecretNotFound extends Error {
  readonly secretName: string;

  constructor(secretName: string) {
    super(`no value for secret ${JSON.stringify(secretName)}`);
    this.name = 'SecretNotFound';
    this.secretName = secretName;
  }
}

/**
 * The secrets directory answered and could not be read, so nothing after it
 * was consulted.
 *
 * **This is not {@link SecretNotFound}, and the distinction is the whole
 * point.** `fromFile` separates "there is nothing at this path" (`ENOENT`, or
 * a file empty after trimming) from "there is something here and reading it
 * failed" -- no permission, a path component that is not a directory, a
 * symlink loop -- and marks the second so that the chain **halts** instead of
 * falling through to the database. Measured, with a row in `secret`: a
 * `baseDir` that does not exist resolves from the database, and a `baseDir` at
 * mode `000` or one that is a plain file resolves nothing at all. In Docker
 * `/run/secrets` is routinely root-owned, so that is a live failure and it
 * makes **every** database-stored credential unresolvable at once.
 *
 * Reported as its own error because `SecretNotFound` for that case reads as
 * "you never configured this credential", which sends the operator to the
 * settings UI for a permissions problem. The chain's own halt is kept rather
 * than reversed: a directory that is present but unreadable is a
 * misconfiguration, and quietly answering from the database instead would
 * hand out a stale credential while the file the operator actually mounted
 * sat unread.
 *
 * **No path and no errno.** A name is not a secret, so the message may name
 * the secret, and nothing else: the errno lives only inside `fromFile`'s own
 * message, which carries the path beside it (design spec §2.4), and this
 * repo's rule against a path in a message is not worth a substring match
 * against a third-party string to recover one code. The message names the
 * two things an operator can check instead.
 */
export class SecretsFileUnreadable extends Error {
  readonly secretName: string;

  constructor(secretName: string) {
    super(
      `secret ${JSON.stringify(secretName)} could not be read from the secrets directory, `
      + 'so no later source was tried: check that the directory and the file in it are '
      + 'readable by this process',
    );
    this.name = 'SecretsFileUnreadable';
    this.secretName = secretName;
  }
}
