import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The config file as JSON, before any schema has seen it. Its keys are
 * namespaces; what is under each is that namespace's business.
 */
export type ConfigDocument = Readonly<Record<string, unknown>>;

/**
 * Reads the document, or `{}` when the file does not exist.
 *
 * Absent and empty are the same thing on a first boot, so an absent file is
 * not an error. **Unparseable is** -- reading a hand-edit with a trailing
 * comma as "no configuration" would silently run the host on defaults, and
 * the next write would overwrite the edit. See `writeConfigDocument`'s
 * counterpart guarantee.
 */
export async function readConfigDocument(path: string): Promise<ConfigDocument> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return {};
    throw error;
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
 */
export async function writeConfigDocument(path: string, document: ConfigDocument): Promise<void> {
  const temp = join(dirname(path), `.${Date.now()}.${process.pid}.config.tmp`);
  await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}
