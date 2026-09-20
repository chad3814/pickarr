/**
 * The three `filepath_mapping` write paths: add, edit and remove.
 *
 * **`filepath_mapping`'s first production writer.** `clients/paths.ts`'s
 * `mapClientPath` has read this table since the deliver slice and the only
 * `INSERT`s in the repository were in two test files -- design spec §1. The
 * rules below are therefore the whole of what a row is ever checked
 * against, since nothing else has ever put one there.
 *
 * **Every refusal is a value, never a throw**, the shape `feeds/add.ts`,
 * `clients/add.ts` and `clients/pick.ts` already answer in, and for the
 * reason each of their docs states: a thrown error is indistinguishable
 * from a bug at the call site, and the routes in front of these need to map
 * each refusal to its own status code. That is narrower than "never
 * throws": a SQLite error that is neither of the two constraint violations
 * named below is rethrown untouched, reaches `api/server.ts`'s outermost
 * handler and becomes a 500, which is where an infrastructure fault
 * belongs.
 *
 * **Both "already exists" refusals are caught, not pre-checked.** A
 * check-then-write leaves a window for two concurrent calls to both pass
 * the check and race the constraint anyway -- the same reasoning
 * `clients/add.ts` and `clients/pick.ts` each record. `duplicate-from-path`
 * comes from migration 19's unique index on
 * `(download_client_id, from_path)`; `unknown-client` comes from the
 * `download_client_id` foreign key, which `db/open.ts` turns on with
 * `PRAGMA foreign_keys = ON`.
 *
 * **Nothing here validates the *shape* of a path**, and design spec §7 is
 * explicit that nothing may. These are foreign paths from a machine that is
 * not this one: `paths.ts` refuses `node:path` because
 * `resolve`/`normalize` would rewrite them by this host's platform rules,
 * and a `from_path` of `D:\Downloads` is a mapping that works. A writer
 * stricter than its consumer refuses configurations the consumer would have
 * handled, so there is no leading-slash check, no backslash rejection and
 * no normalisation. `empty-path` is the single exception and covers `''`
 * alone.
 *
 * **What an empty path actually does, since the reason given here was
 * wrong and the paragraph above is what disproved it.** An empty `to_path`
 * maps every file under its prefix to a relative path. An empty
 * `from_path` was described as matching "every path `matchesBoundary` is
 * asked about", which cannot be true of a module that exists to accept
 * `D:\Downloads`: `matchesBoundary` requires the remainder after the
 * prefix to be `''` or to start with `/`, and with an empty prefix the
 * remainder is the whole path. So it is a catch-all for **absolute POSIX
 * paths only**. Measured on this tree against `mapClientPath`, with an
 * empty-`from_path` row to `/media` inserted by hand:
 * `/downloads/complete/x` -> `/media/downloads/complete/x` and `''` ->
 * `/media` are matched, while `D:\Downloads\x`, `C:/Downloads/x` and
 * `relative/path` all come back unchanged. It is also the shortest
 * possible prefix, so `mapClientPath`'s longest-match rule makes it lose
 * to every other mapping that matches -- a fallback, not an override.
 * The refusal is still right, and for a reason the false one obscured: an
 * empty `from_path` silently rewrites the paths a host that shares a
 * filesystem with its client relies on passing through untouched, while
 * missing exactly the foreign, Windows-shaped ones this table exists to
 * translate. It is a rule that fires where it is not wanted and not where
 * it looks like it would.
 *
 * **No refusal carries anything from the input.** Not a path, not an id:
 * a refusal says which rule was broken and nothing about the value that
 * broke it -- the rule `clients/add.ts`'s `AddDownloadClientRefusal` states.
 * Paths are in this table by design (design spec §5) and the *route*
 * answers `{ id }` or `{ refusal }`, so nothing a caller submitted is ever
 * echoed back to them by this path.
 *
 * Synchronous, like `addFeed` and `addDownloadClient`: `node:sqlite` is
 * synchronous -- this repo's documented exception to preferring an async
 * API -- and each of these is one prepared statement. The `Host` methods
 * wrapping them are `async` only because the interface they satisfy is.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MappingRefusalCode } from '@pickarr/contract';

/**
 * What `Host.addMapping` needs to create a mapping.
 *
 * **Every field is a primitive and none is optional**, for the reason
 * `AddDownloadClientInput` gives at length: these values arrive unchecked
 * out of a JSON request body and this module is the validator that narrows
 * them, not a caller that has already done so. `downloadClientId` is a
 * plain `number` for the same reason `requestPick`'s `rssItemId` is -- the
 * route's shape guard establishes it is a number, and whether that number
 * names a row is the `unknown-client` refusal's business rather than a
 * type's.
 */
export interface AddMappingInput {
  downloadClientId: number;
  fromPath: string;
  toPath: string;
}

/**
 * What `Host.editMapping` replaces a mapping's two mutable columns with.
 *
 * **Both fields, always, rather than a patch of whichever the caller cares
 * about.** The route is a `PATCH` because it addresses one existing row,
 * not because the body is sparse: a two-field body with one field optional
 * gives "leave it alone" and "set it to the same value" two spellings that
 * this module would have to tell apart, and `exactOptionalPropertyTypes`
 * makes the absent case a third thing again. Sending both is also what the
 * edit case design spec §9's acceptance 4 describes actually does -- fixing
 * a typo in `to_path` and resubmitting the `from_path` unchanged -- which
 * is why a no-op `from_path` has a test of its own.
 *
 * **`downloadClientId` is absent, and cannot be sent.** A mapping belongs
 * to exactly one client by foreign key and is meaningless away from it
 * (design spec §8), so moving one between clients is not an edit; it is a
 * remove and an add, and the `unknown-client` refusal exists on the add
 * alone because of it.
 */
export interface EditMappingInput {
  fromPath: string;
  toPath: string;
}

/**
 * Why a mapping write declined, returned as a value rather than thrown --
 * the one-field shape `AddFeedRefusal`, `AddDownloadClientRefusal` and
 * `PickRefusal` already have, so `api/server.ts` narrows all of them with
 * `'refusal' in result`.
 *
 * The codes are `@pickarr/contract`'s `MAPPING_REFUSALS`, not this file's,
 * because the browser client has to agree with them exactly to pick the
 * right sentence; that module's own doc has the measurement from the feeds
 * slice, where the two spellings were hand-copied.
 *
 * **One type across all three capabilities**, rather than one per
 * capability. Which codes each can actually answer is a property of the
 * function -- `unknown-client` only from {@link addMapping},
 * `unknown-mapping` only from {@link editMapping} and
 * {@link removeMapping} -- and it is pinned by their tests, not by three
 * narrower types whose union a client would have to reassemble anyway.
 */
export interface MappingRefusal {
  refusal: MappingRefusalCode;
}

/**
 * SQLite's own code for a UNIQUE constraint failure -- verified against
 * `node:sqlite` on this tree.
 *
 * The same constant `feeds/add.ts`, `clients/add.ts`, `media/writer.ts` and
 * `clients/downloads.ts` each already declare. `clients/add.ts` records the
 * reason none of them imports another's -- pulling one of those modules in
 * for a two-line SQLite check is the wrong dependency for this one to take
 * on -- and adds that at four copies the honest fix is one exported helper
 * the four share. **This file makes it five**, and does not do that
 * refactor: it would be a change to four existing modules rather than part
 * of this slice. The count is written here rather than left implicit so the
 * next writer inherits the tally and not just the copy.
 */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * SQLite's own code for a FOREIGN KEY constraint failure -- measured on this
 * tree, by inserting a `filepath_mapping` naming a `download_client` id that
 * does not exist and reading `errcode` off what was thrown.
 *
 * **Not the first mention of 787 in the repository**, which is what this
 * said until a review checked it: `db/migrate.ts`'s migration-12 docblock
 * already records the same code, measured the same way, for the two
 * `auth_user` foreign keys that declare no `ON DELETE`. It is the first
 * *constant* -- that one is prose in a comment, since nothing there
 * catches the error -- and the four `2067` declarations named above have
 * no `787` beside them, because no other write path in this package has a
 * foreign key it lets a caller choose the value of.
 */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

/**
 * Whether `err` is SQLite reporting the specific constraint `errcode` names.
 *
 * `node:sqlite` throws a plain `Error` carrying `code: 'ERR_SQLITE_ERROR'`
 * and SQLite's own numeric `errcode`, neither part of `@types/node`'s
 * declared `Error` shape, so this is a runtime check rather than something
 * the compiler already knows. Checking `code` alone would not do: a generic
 * logic error surfaces with the same `code` and a different `errcode`, and
 * treating that as a constraint violation would misreport a real bug as a
 * refusal. The two `errcode`s this file passes in are also each other's
 * near neighbours -- an insert naming an absent client and an insert
 * repeating a `from_path` are two different answers -- so the number is a
 * parameter rather than folded into the function.
 *
 * `'code' in err` / `'errcode' in err`, not a cast: narrowing `unknown` this
 * way tells the compiler no more than the check itself proves. The twins in
 * `feeds/add.ts` and `clients/add.ts` have the longer version of this note.
 */
function isConstraintViolation(err: unknown, errcode: number): boolean {
  return typeof err === 'object' && err !== null
    && 'code' in err && err.code === 'ERR_SQLITE_ERROR'
    && 'errcode' in err && err.errcode === errcode;
}

/**
 * `empty-path` for a `''` in either field, or `undefined` for a pair this
 * module has nothing to say about.
 *
 * `=== ''` and nothing else. Not `.trim()`, and this is the decision rather
 * than an oversight: a path of `' '` is a directory named with a space,
 * which every filesystem this host might be handed a path from permits, and
 * trimming would silently write a *different* prefix than the one the
 * operator typed -- which `mapClientPath` would then fail to match against
 * the client's own reported path. Refusing a blank-but-not-empty string
 * would be the stricter-than-the-consumer rule design spec §7 forbids.
 */
function emptyPathRefusal(fromPath: string, toPath: string): MappingRefusal | undefined {
  if (fromPath === '' || toPath === '') return { refusal: 'empty-path' };
  return undefined;
}

/**
 * Writes one `filepath_mapping` row, answering `{ id }` or a refusal.
 *
 * **`updated_at` is bound explicitly, and the column is `NOT NULL` with no
 * default, so omitting it now fails loudly rather than quietly.** That was
 * not free: `ALTER TABLE ... ADD COLUMN` would only have added a `NOT NULL`
 * column to a populated table with a constant default, and SQLite has no
 * `ALTER COLUMN` to take one away again, so migration 19 rebuilds the
 * table instead. Before that rebuild the column carried `DEFAULT 0` and an
 * `INSERT` that left it out stored epoch 0 -- which sorts to the front of
 * `listByTable`'s modification order and renders as 1970 in a client, with
 * nothing failing. `test/clients/mappings.test.ts` still pins the stored
 * value, and it is now the second guard rather than the only one: the
 * schema refuses the omission and the test pins that this writer does not
 * make it.
 *
 * `created_at` and `updated_at` take the same `now()` on an insert, the
 * shape `clients/add.ts` and `feeds/add.ts` both use: a row that has never
 * been edited was last modified when it was created.
 */
export function addMapping(
  deps: { raw: DatabaseSync; now: () => number },
  input: AddMappingInput,
): { id: number } | MappingRefusal {
  const empty = emptyPathRefusal(input.fromPath, input.toPath);
  if (empty !== undefined) return empty;

  const at = deps.now();
  try {
    const result = deps.raw.prepare(`
      INSERT INTO filepath_mapping
        (download_client_id, from_path, to_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.downloadClientId, input.fromPath, input.toPath, at, at);
    return { id: Number(result.lastInsertRowid) };
  } catch (err) {
    // The foreign key first, because it is the condition that makes the
    // other unreachable: a client that does not exist can hold no mapping,
    // so an insert naming one cannot also be a duplicate. Both are checked
    // rather than one, because which constraint SQLite reports when two are
    // violated is not something this module should depend on -- and here it
    // never has to.
    if (isConstraintViolation(err, SQLITE_CONSTRAINT_FOREIGNKEY)) {
      return { refusal: 'unknown-client' };
    }
    if (isConstraintViolation(err, SQLITE_CONSTRAINT_UNIQUE)) {
      return { refusal: 'duplicate-from-path' };
    }
    throw err;
  }
}

/**
 * Replaces mapping `id`'s two paths, answering `{ id }` or a refusal.
 *
 * **`changes === 0` is `unknown-mapping`**, not a silent success: an
 * `UPDATE` whose `WHERE` matches nothing is how SQLite reports an id naming
 * no row, and answering `{ id }` for it would tell a browser its edit
 * landed when nothing was written. There is no `SELECT` ahead of the
 * statement to establish the row exists -- it would be a second copy of the
 * same question with a race between the two answers.
 *
 * **Editing a mapping to its own current `from_path` is accepted**, and
 * that is a property of the statement rather than of a check. The unique
 * index sees the row's new key against every *other* row's, so a row keeping
 * its own key collides with nothing; SQLite still reports `changes: 1` for
 * an `UPDATE` that writes the values already there, so the no-op is an
 * accept rather than an `unknown-mapping`. Both halves are measured, and
 * both have a test -- a pre-check implementation ("is this `from_path`
 * taken?") would refuse exactly this edit, which is the one someone makes
 * when fixing a typo in the `to_path` alone.
 *
 * `updated_at` is bound here too, and the `NOT NULL` column that protects
 * {@link addMapping} does **not** protect this statement: an `UPDATE` that
 * omitted the column from its `SET` list violates nothing -- it simply
 * leaves the insert's value, so a row edited hours later still claims it
 * was last modified when it was created, and the replica orders it wrongly.
 * Binding it here is the whole of the guard, and
 * `test/clients/mappings.test.ts` moves its clock between the insert and
 * the edit so that a writer which forgot could not pass.
 */
export function editMapping(
  deps: { raw: DatabaseSync; now: () => number },
  id: number,
  input: EditMappingInput,
): { id: number } | MappingRefusal {
  const empty = emptyPathRefusal(input.fromPath, input.toPath);
  if (empty !== undefined) return empty;

  try {
    const result = deps.raw.prepare(`
      UPDATE filepath_mapping
         SET from_path = ?, to_path = ?, updated_at = ?
       WHERE id = ?
    `).run(input.fromPath, input.toPath, deps.now(), id);
    if (result.changes === 0) return { refusal: 'unknown-mapping' };
    return { id };
  } catch (err) {
    // No foreign-key branch: `download_client_id` is not in the `SET` list
    // and {@link EditMappingInput} carries no client, so the only
    // constraint this statement can reach is the one on
    // `(download_client_id, from_path)` -- another mapping on the same
    // client already holding the `from_path` this edit moves to.
    if (isConstraintViolation(err, SQLITE_CONSTRAINT_UNIQUE)) {
      return { refusal: 'duplicate-from-path' };
    }
    throw err;
  }
}

/**
 * Deletes mapping `id`, answering `{ id }` or `unknown-mapping`.
 *
 * `changes === 0` is the refusal, for the reason {@link editMapping} gives:
 * a delete that matched nothing is a caller working from a stale list, and
 * reporting success for it would leave a browser believing a row it can
 * still see is gone.
 *
 * No `now()`, because nothing is written: `installSyncTriggers`' existing
 * `AFTER DELETE` trigger logs `OLD.id, 'delete'` and the tombstone reaches
 * the replica with no column of its own (design spec §5).
 */
export function removeMapping(
  deps: { raw: DatabaseSync },
  id: number,
): { id: number } | MappingRefusal {
  const result = deps.raw.prepare('DELETE FROM filepath_mapping WHERE id = ?').run(id);
  if (result.changes === 0) return { refusal: 'unknown-mapping' };
  return { id };
}
