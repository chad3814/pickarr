import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The config file as JSON, before any schema has seen it. Its keys are
 * namespaces; what is under each is that namespace's business.
 */
export type ConfigDocument = Readonly<Record<string, unknown>>;

/**
 * Node's fs errors carry the path in `.message` (and `rename` carries two).
 * No message in this repo may carry one, so every fs call site reads only
 * the errno code off the error -- never its message, and never as `cause`,
 * which would smuggle the same path back in via a cause chain.
 */
function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

function fsFailure(operation: string, error: unknown): Error {
  return new Error(`config file ${operation} failed: ${errnoCode(error) ?? 'unknown error'}`);
}

/**
 * Reads the document, or `{}` when the file does not exist.
 *
 * Absent and empty are the same thing on a first boot, so an absent file is
 * not an error. **Unparseable is** -- reading a hand-edit with a trailing
 * comma as "no configuration" would silently run the host on defaults, and
 * the next write would overwrite the edit. See `writeConfigDocument`'s
 * counterpart guarantee.
 *
 * Every other read failure (permission denied, a symlink loop, `/config`
 * unmounted, ...) is real and must not be swallowed, but Node's own error
 * for it carries the path in its message. It is rethrown as a fresh error
 * naming only the operation and the errno code -- an operator can act on
 * `EACCES`; a path is not this function's to disclose.
 */
export async function readConfigDocument(path: string): Promise<ConfigDocument> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return {};
    throw fsFailure('read', error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // The parser's own message carries an offset into the file, not a path,
    // but it is also not useful to an operator. The path is deliberately
    // absent: no message in this repo may carry one.
    throw new Error('the config file is not valid json');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the config file must be a json object whose keys are namespaces');
  }
  return parsed as ConfigDocument;
}

/**
 * Writes the document to a temp file in the same directory and renames it
 * over the target.
 *
 * `rename` within a directory is atomic, so a reader sees either the old file
 * or the new one and never a half-written one -- which matters because the
 * host reads this file at boot and a crash mid-write would otherwise leave an
 * unbootable install. The temp file is in the *same* directory because
 * `rename` across filesystems fails, and `/config` is a mounted volume.
 *
 * The temp name includes a random component precisely so two concurrent
 * calls for the same `path` cannot collide on it: without one, whichever
 * `writeFile` finished last would decide what both `rename`s acted on, and
 * the other caller's `rename` would then fail against a file that had
 * already moved. That still leaves interleaving at the `path` level to the
 * single-writer queue a caller is expected to go through (see Task 5); this
 * function only guarantees its own temp file is never shared.
 *
 * As in `readConfigDocument`, any failure here (`writeFile` or `rename`,
 * which names *two* paths in Node's own message) is rethrown as a fresh
 * error naming only the operation and the errno code.
 */
export async function writeConfigDocument(path: string, document: ConfigDocument): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.config.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw fsFailure('write', error);
  }
  try {
    await rename(temp, path);
  } catch (error) {
    throw fsFailure('rename', error);
  }
}
