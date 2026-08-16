# Client-first reconcile — Design

Date: 2026-08-16
Status: approved for planning
Branch: `reconcile-client-first`

## 1. What this fixes

On 2026-08-15, between 22:50:05 and 23:07:25 UTC, Pickarr marked 35 downloads
`failed` with the error `disappeared-from-client`. Every one of them was healthy. All 35
finished downloading, post-processed normally, and are sitting in SABnzbd's history as
`Completed` right now, under the same `nzo_id` Pickarr recorded for them. None was ever
imported: all 35 have `storage_path IS NULL`, none of their releases was satisfied by any
other download, and 33 completed directories are still occupying disk under
`/downloads/pickarr`.

The damage is silent in both directions. The rows are `failed`, so `activeDownloads`
(which excludes `imported` and `failed`) never looks at them again. Their refs are still
in `knownRefs` — that query has no status filter — so they are not reported as untracked
either. They are invisible to Pickarr and invalid nowhere: SABnzbd has them, the files
exist, and nothing will ever pick them back up.

This design removes the cause, removes the class of fault behind it, and makes the
surviving failure mode self-healing rather than terminal.

## 2. Root cause

`reconcileClient` fails a download when its ref appears in neither the queue snapshot nor
the history snapshot for `MAX_MISSING_POLLS` (3) consecutive ticks at
`RECONCILE_INTERVAL_MS` (10 s) — a 30-second budget. The rule is sound only if the two
snapshots are a complete picture of what the client holds. They are not.

`snapshot()` in `clients/sabnzbd.ts` asks SABnzbd to filter on our behalf:

```js
call('queue',   { category: config.category }),
call('history', { category: config.category }),
```

Three separate server-side behaviours can hide a job that is plainly visible in
SABnzbd's own web UI, which applies none of them.

**The history limit.** `_api_history_default` does `if not limit: limit =
cfg.history_limit()`. Omitting `limit` does not mean "everything"; it means "whatever the
user's `history_limit` is set to", which was **10** at the time of the incident.
`_api_queue_default` does the opposite — `int_conv(kwargs.get("limit"))` yields `0`, and
`queue_info` treats `if not limit` as unlimited. So **the queue was never truncated and
history always was.** That asymmetry is exactly the observed behaviour: every one of the
35 was healthy for the entire time it was downloading and died only after crossing to the
history side.

**Post-processing consumes the same window.** `build_history` fills its slots from the
post-processing queue *first* and gives only the remainder to database history. Measured
from SABnzbd's own log across the incident, against a 10-slot window:

```
  time      in postproc   slots left for db history
  22:45:02            2   8
  22:50:02            9   1
  22:55:02           13   0
  23:00:02           19   0
  23:05:02           19   0     (peak 21)
```

From roughly 22:52 onward, 9–11 post-processing jobs were invisible at any moment *and*
every completed-but-unimported job in database history got zero slots. This is why the
failures arrived staggered over 17 minutes rather than all at once — jobs rotated in and
out of a window too small to hold them.

**Post-processing takes far longer than the budget.** Measured across the same 35 jobs,
the gap between `Ending job` (queue exit) and `Added job … to history`:

```
min=31s   median=505s (8.4 min)   max=1023s (17 min)
gaps exceeding the 30s budget: 35 of 35
```

So a job must stay visible for minutes, and only ten things could be visible.

**Two further blind spots, unfixed by raising the limit.** `PostProcessor.get_queue`
skips a job on either of:

```python
if not nzo.work_name:                          continue
if categories and nzo.cat not in categories:   continue
```

The first drops post-processing jobs regardless of category and could not be reproduced
live (nothing was post-processing during the investigation); it is recorded as a known
hazard rather than a proven cause. The second is our own `category` parameter being
honoured on a path where a job's category is not guaranteed to be what we set.

Raising `history_limit` masks all of this without fixing any of it. It is 50 now; 21
concurrent post-processing jobs plus accumulated history will cross 50 as the library
grows.

**The conclusion that shapes this design:** Pickarr is drawing a negative inference —
"absent, therefore gone" — from a view whose completeness it never established, and which
was in fact bounded by a server-side setting it never sets. A negative inference from an
unbounded-but-unverified view is not a rule; it is a guess that happens to be right when
the library is small.

## 3. Scope

In scope:

- `clients/sabnzbd.ts` — `snapshot()` fetches a provably complete view.
- `clients/types.ts` — the snapshot contract gains completeness and category.
- `pipeline/reconcile.ts` — restructured client-first.
- `db/downloads.ts` — absence recorded as an observation; lookup by ref.
- `db/migrations.ts` — one migration for the new column and the stranded rows.
- `http/server.ts` — the retry route accepts an absent download.
- Recovery of the 35 stranded downloads.

Out of scope:

- Changing `RECONCILE_INTERVAL_MS`, the import pipeline, or `importDownload`.
- The metadata worker, the poster repair, anything on the Browse/Picks path.
- Persisting untracked entries (see §9).
- Any change to SABnzbd's own configuration. This must work correctly against
  `history_limit = 10`.

## 4. The snapshot must be complete, or say that it is not

This is the load-bearing change. Everything else is a consequence.

`ClientSnapshot` gains one field:

```ts
export interface ClientSnapshot {
  queue: ClientQueueEntry[];
  history: ClientHistoryEntry[];
  /**
   * Whether this snapshot is the client's whole picture. False when a page
   * could not be retrieved or the client reported more entries than it
   * returned. A false snapshot may still be used to advance rows it *does*
   * contain; it may never be used to conclude something is absent.
   */
  complete: boolean;
}
```

(Mutable arrays, matching the existing declarations in `clients/types.ts`; this design
introduces no readonly conversion.)

`snapshot()` changes in three ways.

**No category filter.** Both calls drop `category`. We do not need SABnzbd to filter for
us — we match on `nzo_id` with the `[pickarr-N]` label as a fallback — and asking it to
costs us the guarantee that what we are looking at is everything. Filtering moves to our
side, where the rules are ours (§9).

Dropping it is not merely preferable, it is *required* for the completeness check below
to work at all. `queue_info` ends with:

```python
if not search and not nzo_ids:
    nzos_matched = len(self.__nzo_list)
```

so `noofslots` on the queue is the size of the **whole** queue, not of the filtered
result. Ask for one category and the reported total legitimately exceeds the returned
count, and a completeness check comparing the two would declare every snapshot
incomplete forever. Comparing returned against `noofslots` is only meaningful on an
unfiltered request.

**Explicit, verified paging.** History is requested with an explicit `limit` rather than
inheriting `history_limit`. The response carries `noofslots`, the true total, so
completeness is checkable rather than assumed:

- Request `start=0, limit=HISTORY_PAGE_SIZE` (500).
- Read `noofslots`. While fewer entries have been collected than `noofslots`, request the
  next page.
- Stop at `MAX_HISTORY_PAGES` (20 — 10,000 entries, far past any real installation) or at
  a page that returns nothing. Either of those stops sets `complete = false`.
- If the collected count is short of `noofslots` for any reason, `complete = false`.

The queue is requested with an explicit `limit=0`, which `queue_info` already treats as
unlimited, and is checked against its own `noofslots` the same way. Passing it explicitly
rather than omitting it is deliberate: the two endpoints read a missing `limit`
differently, and relying on that difference is what caused this incident.

**Category carried, not filtered.** `ClientQueueEntry` and `ClientHistoryEntry` each gain
`category: string | null`. The two endpoints spell it differently and this is easy to get
wrong: a **queue** slot carries `cat`, a **history** slot carries `category`. A queue slot
with no category is the literal string `"None"`, not an absent field and not an empty
string, so the reader must map `"None"` to `null` — otherwise §9's local filter would
compare against a category nobody configured. This is what lets §9 filter locally.

A failure of any single request still throws, as today — an unreachable client is not an
empty client, and `Promise.all` rejecting is the correct behaviour. `complete = false` is
for the narrower case where the client answered but the answer is partial.

## 5. Matching a client entry to a download

Two keys, tried in order:

1. **`nzo_id` against `downloads.client_ref`.** The primary key, and correct in every
   observed case: all 35 stranded refs still match SABnzbd exactly.
2. **The `[pickarr-N]` label** parsed out of the entry's name via the existing
   `extractLabel`. Every one of the 35 history entries carries its label — that is how
   the incident timings were correlated — so this is a proven fallback, not a
   speculative one.

The label match exists because a ref can be lost (a crash between `addUrl` returning and
the write landing) or, in principle, change. Today the label is consulted at exactly one
place, `if (clientRef === null)`, purely as a double-submit guard. Widening it to a
general matching key is the change that makes a mismatched or missing ref recoverable
instead of fatal.

When both keys resolve and disagree, the `nzo_id` match wins and the disagreement is
logged once. When only the label matches, the row's `client_ref` is corrected to the
entry's `nzo_id`.

Eligibility for matching is deliberately wider than `activeDownloads`:

- `imported` rows are matched, so the cleanup pass can still remove their jobs (§8).
- `failed` rows are matched **only** when the failure was `disappeared-from-client`.
  That is the self-retiring recovery path for the 35 (§10). A row that failed for any
  other reason — a repair failure, an import failure, an exhausted `addurl` — stays
  failed; resurrecting those is a different decision with different risks, and the user
  already has an explicit retry.

## 6. The tick, restructured client-first

Today the loop iterates the database and looks each row up in the client. That ordering
is why a failed row is unreachable forever: it is not in `activeDownloads`, so nothing
ever asks the client about it again. Iterating the client first inverts that — a job
SABnzbd is holding gets reconciled with whatever Pickarr believes about it, including
"nothing" and including "failed".

```
1. snapshot the client (queue + history, unfiltered, paged, completeness known)

2. submit anything unsubmitted
     for each active row with client_ref IS NULL:
       if the snapshot already holds its [pickarr-N] label -> adopt that ref
       else -> addUrl, record the ref

3. for each entry in the snapshot:
     resolve the entry to a download (§5)
     no match                     -> untracked (§9)
     match is 'imported'          -> leave to the cleanup pass (§8)
     entry is completed
        -> set storage path, mark completed, import
     entry is failed              -> fail with the client's message
     otherwise (queued, downloading, post-processing)
        -> mark downloading, clear any absence mark

4. for each row that should be active and was not seen in step 3:
     completed with a storage path -> import it (client may have pruned it)
     snapshot incomplete           -> do nothing at all
     otherwise                     -> record absence (§7); never fail
```

Step 2 must run after the snapshot, not before it. The double-submit guard works by
checking the *already-fetched* snapshot for our label before calling `addUrl` again; a
queueing pass that ran first would have nothing to check against and would resubmit any
download whose ref write was lost.

Step 3 handles "unknown" before it branches on status. A completed entry with no matching
download must not take the completed branch and attempt to import a row that does not
exist — unknown is a property of the match, not of the status.

Step 4's first case is the existing early branch for `completed` rows that already carry
a `storage_path`, and it must survive: SABnzbd prunes history on its own schedule, so a
row that is ready to import may legitimately never appear in the snapshot again.

Step 4's second case is the invariant this whole design exists to establish. **An
incomplete snapshot may never drive an absence conclusion.** With `complete = false` the
sweep is skipped entirely and logged once; rows keep whatever absence state they already
had.

## 7. Absence is an observation, never a verdict

`MAX_MISSING_POLLS` and `missing_polls` are removed. A poll *count* was the wrong clock
twice over: three polls is thirty seconds only if ticks fire on schedule, and they do not
— reconcile runs under `tryRun`, so ticks are dropped for the entire duration of a long
import.

In its place, `downloads` gains `absent_since INTEGER` (epoch ms, nullable):

- Seen in a snapshot → `absent_since = NULL`.
- Not seen, snapshot complete → `absent_since = now` if it is currently null; otherwise
  left at its original value, so it records when absence *began*.
- Nothing ever transitions a row to `failed` on account of absence.

The row keeps its real status (`downloading`), stays in the active set, and is retried on
every subsequent tick forever. If the job reappears — post-processing finishes, the user
un-pauses it, the client comes back — step 3 finds it and clears the mark with no
intervention. This is what makes the surviving failure mode self-healing.

The cost of never failing is that a job genuinely deleted at the client sits as
`downloading` indefinitely, and `inFlightForRelease` (which excludes only `failed`) will
keep that release from being picked again. That is accepted deliberately, on the
instruction that absence must never fail a download, and it is mitigated two ways:

- `absent_since` is surfaced through `/api/downloads` so the UI can show *how long* a
  download has been missing from the client. An invisible stuck row is the thing that
  made this incident expensive; a visible one is a work item.
- The retry escape hatch is widened (§11).

## 8. Cleanup is unchanged in behaviour

The existing cleanup pass — remove an imported download's job from the client to reclaim
its directory — keeps its current semantics and its current position at the end of the
tick. It already keys off the history snapshot and is already self-healing. The only
change is that it now reads from a snapshot known to be complete; a partial snapshot must
not be read as "the job is gone, nothing to clean up", which is harmless today only
because cleanup does nothing when it finds nothing.

## 9. Untracked entries stay in memory

Dropping the server-side category filter means the snapshot now contains every job on the
SABnzbd instance, including other applications' work. Untracked reporting must not
suddenly list all of it.

`result.untracked` is therefore filtered locally to entries whose `category` equals
`config.category`. Matching our own downloads (§5) is *not* category-filtered, so a job
of ours that was re-categorised at the client is still found and reconciled — which is
precisely one of the blind spots being removed.

Untracked entries remain in-memory and are still never persisted. That is an existing
deliberate decision with a documented reason — SABnzbd prunes history on its own
schedule, so orphan rows would accumulate forever — and nothing here changes the argument.
Persisting them would need a table and a retention rule and is out of scope.

## 10. Recovering the 35

No bespoke repair script and no data migration of download state. The recovery falls out
of §5: a row whose failure was `disappeared-from-client` is eligible for matching, so on
the first tick after deploy each of the 35 is found in history as `Completed`, has its
storage path set, is marked `completed`, and is imported by the ordinary path. Rows whose
directory no longer exists (2 of the 35) fail the import and are recorded with the real
import error, which is the correct outcome and an honest one.

One migration is still required, for the schema. The highest existing version is 7, so
this is **version 8**:

```sql
ALTER TABLE downloads ADD COLUMN absent_since INTEGER;
```

`missing_polls` is left in place rather than dropped. SQLite's `DROP COLUMN` is available
but rewriting a live table buys nothing here, the column is small, and leaving it makes
the migration trivially reversible. It stops being read or written; that is stated in a
comment on the column's only remaining mention.

This recovery path is self-retiring: once §7 lands, nothing produces
`disappeared-from-client` again, so the clause matches only rows created before this
change.

## 11. HTTP and UI

`POST /api/downloads/:id/retry` currently rejects anything that is not `failed`:

```js
if (existing.status !== 'failed') return reply.code(409)...
```

Under a never-fail policy that would leave a permanently-absent download with no escape
hatch at all — it stays `downloading`, so retry refuses it. The guard widens to accept a
download that is `failed` **or** currently marked absent (`absent_since IS NOT NULL`).
Everything else about the route is unchanged.

`DownloadView` and `toDownloadView` — both in `http/views.ts`, not `server.ts` — gain
`absentSince: number | null`, so `/api/downloads` can render "missing from client for 3h"
against the row. No new endpoint.

## 12. Testing

Unit tests, against the existing `node:test` suites.

`clients/sabnzbd.ts`:

- History paging: a client reporting `noofslots` larger than one page is fully collected.
- `complete = false` when the collected count is short of `noofslots`.
- `complete = false` when `MAX_HISTORY_PAGES` is hit.
- Neither request carries a `category` parameter; history carries an explicit `limit`.
- Category is read off each entry and preserved.
- A regression test written directly from the incident: a history endpoint that honours
  `limit` the way SABnzbd does — capping at 10 unless asked otherwise — yields a complete
  snapshot of 35 entries rather than 10.

`pipeline/reconcile.ts`:

- A completed entry whose download row is `failed` with `disappeared-from-client` is
  re-attached and imported. This is the incident, as a test.
- A completed entry whose row failed for any *other* reason is left alone.
- An entry matched only by `[pickarr-N]` label repairs a null `client_ref`.
- A row absent from a **complete** snapshot gets `absent_since` set once, and a second
  absent tick does not move it.
- A row absent from an **incomplete** snapshot is untouched — no absence recorded. The
  single most important test here.
- A previously-absent row seen again has `absent_since` cleared.
- No path anywhere fails a download for absence.
- A completed row with a storage path still imports when missing from the snapshot.
- Untracked is filtered to our category; a re-categorised job of ours is still matched.
- Unknown is decided before status: a completed entry with no matching row is untracked,
  not an import attempt.

`http`:

- Retry accepts an absent `downloading` download and still rejects a healthy one.

## 13. Risks and non-goals

**Paging cost.** History is now up to 20 requests per tick in the worst case instead of
one. In practice it is one: a page is 500 entries and installations hold tens. The page
size is deliberately far above realistic history sizes so the common case stays a single
request.

**A genuinely deleted job blocks its release.** Stated and accepted in §7.

**`work_name`.** The `if not nzo.work_name: continue` skip in SABnzbd's post-processing
queue is not fixed by anything here, because it cannot be — it is server-side and
unconditional. It is *survivable* here in a way it was not before: a job it hides is
simply absent, absence no longer fails anything, and the job reconciles the moment it
reappears. This is the strongest argument for §7 over merely widening the timeout.

**Not attempted:** persisting untracked entries, changing the reconcile interval,
reworking `tryRun` tick-dropping, or touching SABnzbd's configuration. Each is a separate
decision and none is required to fix this.
