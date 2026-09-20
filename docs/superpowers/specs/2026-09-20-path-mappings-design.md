# Path mappings — design

**Predecessors:** the feed-settings, download-clients and picks slices —
the first three write paths this API had. This is the fourth, and the
first with an **edit** and a **delete**.

---

## 1. The gap

`filepath_mapping` translates a path a download client reports into one
the host can open. `clients/paths.ts`'s `mapClientPath` reads it,
`clients/deliver.ts` applies it on every delivery tick, and both are
well built and tested.

**Nothing writes a row.** The only `INSERT`s in the repository are in
two test files. So the translation exists and cannot be configured —
the same shape `rss_feed` and `download_client` were in before their
slices, and the third instance of it.

`sync/tables.ts` still lists `filepath_mapping` among tables that "have
no consumer". That was true when written and has been false since
`deliver.ts` landed; it is corrected here.

## 2. Why it matters now

A pick reaches `completed`, and `deliverCompleted` maps the client's
path before handing the file to its plugin. On a single machine, where
host and client share a filesystem, no mapping is needed and none is
missed — `mapClientPath` returns an unmatched path unchanged, and §2 of
its docblock is explicit that this is correct rather than a
misconfiguration.

On any split setup — a seedbox, a NAS, a container with different
mounts — the client's path is meaningless to the host, and there is
currently no way to say so.

## 3. What a wrong mapping costs, and why that shapes the slice

`deliverCompleted` **never dead-letters**. Its docblock:

> A throw at any of 1-4 leaves the row `completed`, and logs. The next
> tick tries again -- forever, deliberately: a plugin that cannot
> accept a file is a bug to fix, not a row to abandon.

So a typo'd mapping produces a path that will never exist and a
delivery that retries forever. That is the argument for shipping
**delete and edit in this slice**, where the two previous settings
slices deliberately shipped add-only: a mapping is the first thing this
UI writes whose *mistake* has no in-app exit.

## 4. Edit is safe, and the reason predates this slice

The obvious worry — what an in-flight delivery sees when its mapping
changes underneath it — is already answered. `deliver.ts`:

> `mapClientPath` the stored path -- the stored value is the *client's
> own* path, and the mapping is applied on demand, **never stored**,
> because a stored mapped path goes stale the moment a
> `filepath_mapping` row changes.

Mappings are re-read every tick. An edit takes effect on the next one,
and a delivery stuck against a typo recovers by itself once corrected —
which `deliver.ts` already cites as its reason for not failing such
rows. Edit is therefore preferable to delete-plus-add: it keeps the
row's identity and its `created_at`.

## 5. The replica, and a rule amended rather than broken

`filepath_mapping` joins `HOST_SYNCED_TABLES`, so the list reads from
the replica like every other settings list.

**This needs care, because paths are deliberately kept out of the
replica.** `contract/src/sync.ts` says of the download tables:

> Neither `storagePath` nor `lastError` is here, and neither ever will
> be.

That rule stands, and this slice does not weaken it. The distinction
being drawn, stated so it can be argued with:

- **`storage_path` is discovered.** The client reports where it happened
  to put a file, revealing a filesystem layout nobody chose to disclose.
- **A mapping is dictated.** Both paths are strings the operator typed
  into this very screen. Reading them back is showing someone their own
  input.

A settings UI that cannot display the setting is not a settings UI. The
rule's purpose — that this host does not leak filesystem structure to a
client that never asked for it — is untouched.

**Migration 19 adds `updated_at` to `filepath_mapping`**, backfilled
from `created_at`. Every synced table projects one; `listByTable`
refuses a table without it. Then triggers, and a seed of existing rows,
following migration 17's shape.

Delete needs no new machinery: `installSyncTriggers` already emits
`AFTER DELETE … OLD.id, 'delete'`, so a removal tombstones to the
browser for free.

## 6. The routes

Three, each a thin adapter over a host capability, shaped like the three
write paths before them — body shape-checked at the route, every
value-level invariant in the host, refusals returned as values.

| route | answers |
|---|---|
| `POST /api/mappings` | `201 { id }` |
| `PATCH /api/mappings/:id` | `200 { id }` |
| `DELETE /api/mappings/:id` | `204` |

`PATCH` and `DELETE` are **new methods for this API**, which until now
answered `GET` and `POST` only. The per-route `methods` table added in
the feed-settings slice is what makes that a one-line addition per
route rather than a change to the guard — and the guard's ordering
(session before method) must stay as it is, since that ordering was a
fix round of its own.

### Refusals

`unknown-client`, `duplicate-from-path`, `unknown-mapping`,
`empty-path`. Codes in `@pickarr/contract`, one definition both sides
derive from.

`duplicate-from-path` is caught from a **unique index on
`(download_client_id, from_path)`**, not pre-checked, so two concurrent
writes cannot both pass a check and collide. That index is also a
correctness fix in its own right: `mapClientPath` resolves ties between
equal-length `from_path` values to "whichever `.reduce` visits first",
and says plainly that **nothing should rely on it**. Two identical
`from_path`s for one client make resolution unpredictable; the index
makes them impossible.

## 7. What is deliberately not validated

**Path shape.** `paths.ts` refuses to use `node:path` and says why:

> These are *foreign* paths -- possibly Windows-shaped, always from a
> machine that is not this one -- and `path.resolve`/`path.normalize`
> would rewrite them according to the host's own platform rules.

A `from_path` may be `D:\Downloads`. The UI must not be stricter than
the consumer, so nothing here checks for a leading `/`, rejects
backslashes, or normalises. `empty-path` refuses only the empty string,
because an empty `from_path` matches every path and an empty `to_path`
maps everything to a relative path.

**`to_path` existence.** The host may legitimately not have the volume
mounted yet. A mapping that does not resolve today can resolve tomorrow,
which is the same reason `deliver.ts` retries instead of failing.

## 8. The screen

Each download client row on `/settings` expands to its mappings, with
add, edit and remove. A mapping belongs to exactly one client by foreign
key and is meaningless away from it; `MediaItemCard` expanding to its
releases is the existing precedent for the shape.

## 9. Acceptance

1. A mapping can be added, edited and removed, and each change reaches
   the replica.
2. A second mapping with the same `from_path` for one client is refused
   `duplicate-from-path`, caught from the index.
3. A `from_path` of `D:\Downloads` is accepted unchanged.
4. Editing a mapping changes what the **next** delivery tick resolves —
   pinned against `mapClientPath`, not asserted.
5. Deleting a mapping removes it from the replica, via the existing
   delete trigger.
6. Each refusal reads as its own sentence; an unrecognised code and an
   offline submit read differently again; no outcome leaves a control
   pending.
7. `PATCH` and `DELETE` are refused without a session, exactly as `POST`
   is — the guard ordering unchanged.

## 10. Out of scope

- **Importing** (#96). A mapping makes the host able to *open* the file;
  nothing yet puts it anywhere.
- **`import_mode`** — still `NOT NULL` with no reader. It belongs to the
  importer, not here.
- **Validating that a mapped path exists.** §7.
- **Reordering mappings.** Longest-prefix wins, so order is not a thing
  an operator controls or should.
