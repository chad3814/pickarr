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
 * The environment variable that overrides a secret.
 *
 * Hyphens become underscores because a `randomUUID()` carries them and an
 * environment variable may not: without this, the env link could never
 * resolve for a credential the settings UI stored, and the rule would differ
 * between a generated name and a chosen one.
 *
 * **A uuid's variable name is not one a shell can export.** Measured: 116 of
 * 200 uuids begin with a hex digit, and `sh`, `zsh` and `bash` all refuse
 * `550E8400_...=v` as a command rather than an assignment (`$550E8400_X`
 * expands as `$5` followed by literal text). `env(1)`, a Docker `environment:`
 * entry and a systemd `Environment=` all set it, and Node reads it. So the env
 * link genuinely serves the names an operator types, like `tvdb_key`, and is a
 * theoretical override for a generated one -- which is fine, because a uuid's
 * home is the `secret` table.
 */
export function envNameFor(name: string): string {
  return name.toUpperCase().replaceAll('-', '_');
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
