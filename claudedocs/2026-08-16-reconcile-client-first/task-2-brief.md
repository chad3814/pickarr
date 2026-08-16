### Task 2: Absence becomes an observation the database can hold

**Files:**
- Modify: `packages/core/src/db/migrations.ts`
- Modify: `packages/core/src/db/downloads.ts`
- Test: extend `packages/core/test/db/downloads.test.ts`, `packages/core/test/db/migrate.test.ts`

**Steps:**

- [ ] Add migration **version 8**: `ALTER TABLE downloads ADD COLUMN absent_since INTEGER;`. Comment it with why a poll counter was the wrong instrument: reconcile runs under `tryRun`, so ticks are dropped for the whole duration of a long import and "three polls" is not thirty seconds.
- [ ] Leave `missing_polls` in place. Do **not** drop the column — rewriting a live table buys nothing, and leaving it keeps the migration trivially reversible. Note on it that it is no longer read or written.
- [ ] `DownloadRow` gains `absentSince: number | null`; add `absent_since` to the `SELECT` list and map it with `maybeNum`.
- [ ] Add `markAbsent(db, id, now)` — sets `absent_since = ?` **only when it is currently NULL**, so the column records when absence *began* rather than when it was last noticed. A single statement with `WHERE id = ? AND absent_since IS NULL`; do not read-then-write.
- [ ] Add `clearAbsent(db, id)` — `UPDATE ... SET absent_since = NULL WHERE id = ? AND absent_since IS NOT NULL`, idempotent and a no-op when already clear, mirroring the existing `resetMissingPolls` shape.
- [ ] Add `downloadsByRef(db, clientId)` returning `Map<string, DownloadRow>` keyed on `client_ref`, for every row of this client with a non-null ref **except** `imported` — Task 3 needs `imported` handled separately by the cleanup pass, and including them here would invite a double import. Include `failed` rows; Task 3 decides which failures are eligible.
- [ ] Add `downloadsByLabel(db, clientId)` returning `Map<string, DownloadRow>` keyed on `downloadLabel(row.id)`, same row set. Building it in the db layer keeps Task 3's loop free of a second query.
- [ ] `resetForRetry` additionally clears `absent_since`. A retried download must not inherit a stale absence mark.
- [ ] Do **not** delete `bumpMissingPolls` / `resetMissingPolls` yet — Task 3 removes their last callers, and deleting them here breaks the build between commits.

**Tests:**

- [ ] `markAbsent` sets the timestamp, and a second call with a later `now` leaves the original value.
- [ ] `clearAbsent` clears it and is a no-op when already null.
- [ ] `absentSince` round-trips through `getDownload` as `null` and as a number.
- [ ] `downloadsByRef` includes `failed` and excludes `imported`; `downloadsByLabel` keys on `pickarr-<id>`.
- [ ] `resetForRetry` clears `absent_since`.
- [ ] Migration 8 on a database populated at version 7 adds the column with NULL for existing rows, following the existing style in `migrate.test.ts`.

**Verify:** `npm run check`. Commit.

---

