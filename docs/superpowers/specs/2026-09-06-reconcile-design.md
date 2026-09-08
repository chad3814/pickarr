# Pickarr 2.0 Slice D — Reconcile

The fourth slice of the 2.0 backend. Slice C submits a download and writes a row
saying so. Nothing advances that row, so a finished download looks identical to
one still running, and `onDownloadedFile` — a required plugin entry point — has
no caller at all. This slice closes both.

**Designed and decided without review**, at the user's instruction ("implement
reconcile without my input, use your best judgement on any forks"). Every fork
is recorded in §2 with the reasoning, so a disagreement can be found and undone
rather than excavated.

## 1. What this slice delivers

- **`snapshot()` on both adapters** — one poll of everything a client holds,
  queue and history, unfiltered by category, carrying whether it is the whole
  picture.
- **A reconcile pass**, driven by a job on the existing dispatcher, one per
  download client, that walks the *client* and asks the database what it
  believes about each job.
- **A real state machine** on both download tables:
  `submitting → submitted → downloading → completed → delivered`, with `failed`
  reachable from any of them.
- **Delivery to the owning plugin**: a completed download's client path is
  translated through `filepath_mapping`, stat'd, and handed to that feed's
  plugin as `onDownloadedFile`.
- **Reclaim for nzb clients only**, after delivery is recorded.
- **Absence recorded as an observation**, never as a verdict.

### 1.1 Not in this slice, deliberately

- **No import, no library layout, no renaming.** The host maps a path, measures
  it, and tells the plugin. What happens to the file is the plugin's, because
  `onDownloadedFile` is already in the contract and the plugin already owns its
  own schema. 1.x's `import.ts` is 684 lines and exists because 1.x had no
  plugins; inheriting it here would move a library policy into the host that the
  contract has already given away.
- **No blind resubmission.** A row whose `client_ref` was never written is
  *recovered* when a complete snapshot proves the job is there (§5), and left
  alone otherwise. Re-sending a link we cannot prove was never accepted is how a
  download ends up submitted twice with one copy untracked forever. `attempts`
  therefore stays unincremented for one more slice — see §9.
- **No progress history and no rate.** `percentage` is read and stored; nothing
  derives a speed or an ETA from it.
- **No UI.** The read API is still slice E's.
- **No `ranking_score`, no `upgrade`, no `rekey`.** 1.x has all three; none is
  reachable from anything 2.0 has yet.

## 2. The forks, and how each was decided

Each of these had at least two defensible answers. The reasoning matters more
than the choice, because the reasoning is what a reviewer can disagree with.

**The host notifies; the plugin imports.** Decided above. The alternative —
porting 1.x's import — would have doubled the slice and put file layout in the
host permanently.

**Client-first iteration, not row-first.** The pass walks the snapshot and asks
the database about each entry, rather than walking active rows and looking each
one up. This is 1.x's most expensive lesson, recorded in its own comment: the
row-first ordering "is what made the 2026-08-15 incident unrecoverable rather
than merely wrong — a row this code had already failed was gone from
`activeDownloads`, so nothing ever asked the client about it again, even though
SABnzbd was still holding the finished job the whole time." Client-first means a
job the client holds is reconciled against whatever we believe about it,
**including `failed` and including nothing at all**, so a wrong verdict is
recoverable instead of terminal. We inherit the ordering and the reason.

**Absence is an observation, never a verdict.** A row the client does not have
gets `absent_since` stamped, and cleared the moment a snapshot contains it
again. Nothing in this slice fails a row for being absent. 1.x arrived here the
hard way — it once wrote a `disappeared-from-client` failure and had to build a
recovery path for rows its own verdict had stranded. Starting from the
observation costs one nullable column and avoids the recovery path entirely.

**An incomplete snapshot may advance rows it contains and may never establish
absence.** `ClientSnapshot.complete` is false when a page could not be fetched
or the client reported more entries than it returned. This is the one rule that
makes a partial poll safe to act on at all.

**Three-way history outcomes, not two.** `completed | failed | in-progress`.
SABnzbd's history carries transient post-processing labels — Extracting, Moving,
Repairing, Verifying, Fetching, Running, Queued, Paused — for a job that has
neither failed nor finished. 1.x's original two-way reading marked an ordinary
multi-part download `failed` while SABnzbd was still unpacking it. `failed` is
reserved for a status that means the job is never coming back.

**`remove()` is optional on the adapter, and absent on qBittorrent.** Not a
`reclaimsFinishedJobs` boolean. qBittorrent's `/torrents/delete` removes the job
whether or not `deleteFiles` is set, which stops the seed and abandons the
ratio; there is no "forget this but keep seeding" call, so the correct number of
calls is **zero**. A flag would leave a method on the interface that must never
be invoked, which is the shape of a future bug. Optionality makes the wrong call
impossible to write.

**`delivered` is a state distinct from `completed`.** `completed` is the
client's fact; `delivered` is ours — the plugin was told and returned. The gap
between them is exactly where a crash loses a notification, and collapsing them
would make a lost notification indistinguishable from a delivered one. It also
gives reclaim a precise trigger.

**Reconcile is a job, not a timer of its own.** The dispatcher already owns
timing, crash recovery, the five-minute per-job ceiling, and the
one-hung-thing-cannot-stall-everything property. A second scheduler would
duplicate all four.

**Untracked entries are reported and never persisted.** A job in our category
that matches no row of ours is counted and logged, not written. SABnzbd prunes
history on its own schedule, so persisted orphans would accumulate for the
lifetime of the installation.

**Matching is on `(category, name)`, never name alone, and never inside an
incomplete snapshot.** 2.0 dropped 1.x's per-installation label marker
deliberately (slice C §1.2), which removed the mechanism 1.x used to recover a
lost ref. Slice C's §10 already named the consequence and the remedy: "Reconcile
will have to match it on category and name, or leave it alone." That is what §5
implements.

## 3. Schema, migrations 7 and 8

```sql
ALTER TABLE torrent_download ADD COLUMN storage_path TEXT;
ALTER TABLE torrent_download ADD COLUMN percentage INTEGER;
ALTER TABLE torrent_download ADD COLUMN absent_since INTEGER;
ALTER TABLE torrent_download ADD COLUMN delivered_at INTEGER;

ALTER TABLE nzb_download ADD COLUMN storage_path TEXT;
ALTER TABLE nzb_download ADD COLUMN percentage INTEGER;
ALTER TABLE nzb_download ADD COLUMN absent_since INTEGER;
ALTER TABLE nzb_download ADD COLUMN delivered_at INTEGER;

CREATE INDEX torrent_download_status ON torrent_download (status);
CREATE INDEX nzb_download_status ON nzb_download (status);
```

Every added column is nullable, so no `DEFAULT` is needed and no existing row
has to be back-filled with a value that would be a guess.

`storage_path` holds the **client's own** path, exactly as reported. The mapped
path is derived on demand and never stored: a stored mapped path would go stale
the moment a `filepath_mapping` row changed, and would then be a lie that
outlived its cause.

`delivered_at` is on the download row, not on `rss_item` — `rss_item.delivered_at`
already exists and means something else entirely (slice A's re-offer of
undelivered *new items*). Two columns, one name, two meanings, on two tables;
the alternative was one column meaning different things depending on which
subsystem last wrote it.

The status indexes exist because reconcile's sweep and the future read API both
filter on `status`, and both tables are expected to grow without bound.

**Migration 8, added during implementation**, puts `reclaimed_at` on both tables:

```sql
ALTER TABLE torrent_download ADD COLUMN reclaimed_at INTEGER;
ALTER TABLE nzb_download ADD COLUMN reclaimed_at INTEGER;
```

Without it, §5's step 6 read "call it, once" as once *per pass* and nothing carried
the fact across passes, so every `delivered` row had `remove` called again every
tick, forever, on a set that only grows. The reclaim read narrows on this column
in SQL for the same reason the others narrow on `status`: a row stops moving at
`delivered` and stays there, so a query that ignores it grows with the
installation's whole history rather than with what is still live.

## 4. The client contract

```ts
export interface ClientQueueEntry {
  ref: string;
  name: string;
  percentage: number;
  /** `''` and `'None'` are mapped to null by the adapter, never by a caller. */
  category: string | null;
}

export interface ClientHistoryEntry {
  ref: string;
  name: string;
  category: string | null;
  outcome: 'completed' | 'failed' | 'in-progress';
  storagePath: string | null;
  failMessage: string | null;
}

export interface ClientSnapshot {
  queue: ClientQueueEntry[];
  history: ClientHistoryEntry[];
  /**
   * Whether this is the client's whole picture. A false snapshot may be used
   * to advance rows it contains; it may never be used to conclude something
   * is absent.
   */
  complete: boolean;
  /**
   * Every status or state value the adapter could not interpret, one entry per
   * distinct value, sorted, empty when it understood all of them. Added during
   * implementation: the two adapters guess differently about an unrecognised
   * value and SABnzbd's guess is `failed`, so without this a status SABnzbd
   * adds after this code was written becomes unexplained failed downloads. The
   * caller logs these; an adapter in this package owns no logger, and
   * process-wide "already warned" state inside a client is what forces 1.x to
   * export a test-only reset hatch.
   */
  unreadable: string[];
}
```

The adapter maps `''`/`'None'` to `null` **before** building an entry, so no
consumer needs to know a client's spelling of "no category". This is the read
half of the trap slice C fixed on the write half, and it lands in the adapter
for the same reason: the client's vocabulary should not escape the client.

`snapshot()` does **not** filter by category. Asking the server to filter costs
the ability to verify the result is whole — SABnzbd's `queue_info.noofslots` is
the size of the entire queue regardless of what was requested, so comparing a
filtered result's length against it would report every snapshot incomplete
forever. Filtering is the caller's job, on data that is provably everything.

`remove?(ref)` is present on the SABnzbd adapter and **absent** on qBittorrent.

## 5. The pass

One tick, per client, in this order:

1. **Snapshot.** One `snapshot()` call. Everything below reads it; nothing below
   fetches again.
2. **Recover refs.** For each row in `submitting` with a null `client_ref`: if
   the snapshot is complete, look for an entry whose `category` equals this
   client's category and whose `name` equals the `rss_item.filename` we
   submitted. One match recovers the ref and the row advances in this same tick.
   Two or more matches recover nothing and log — an ambiguous match resolved
   arbitrarily is worse than one left for a human. No match, and the row is
   left exactly as it is.
3. **Walk the snapshot.** For each queue entry: find the row by
   `(download_client_id, client_ref)`; advance it to `downloading` and store
   `percentage`. For each history entry, by outcome:
   - `completed` → `completed`, storing `storage_path`;
   - `failed` → `failed`, with `last_error` set to the client's `failMessage`,
     redacted;
   - `in-progress` → left alone. Not a failure, not a completion.
   An entry matching no row is **untracked**: counted, logged, never written.
4. **Sweep.** Rows in a non-terminal state that a **complete** snapshot did not
   account for get `absent_since` stamped if it is null. Rows the snapshot did
   account for get it cleared. An incomplete snapshot does neither.
5. **Deliver.** Every row in `completed` with a `storage_path` and no
   `delivered_at`: map the path, stat it, call the owning plugin's
   `onDownloadedFile`, and on return set `delivered_at` and status `delivered`.
   A throw leaves the row `completed` — so the next tick tries again — and logs.
6. **Reclaim.** Every `delivered` row on a client whose adapter has `remove`:
   call it, once **per download** — recorded by `reclaimed_at` (§3), not once per
   pass. qBittorrent has no `remove`, so a torrent is never dropped and
   never stops seeding.

Steps 5 and 6 are the two that touch the world outside the database, and both
are idempotent in the direction that matters: a delivery repeated is a plugin
told twice about a file that is still there; a reclaim repeated is a job already
gone.

**Every state write is conditional on the state it expects** —
`WHERE id = ? AND status = ?` — for the reason the job dispatcher slice found
the hard way: a guard that checks a row's identity but not its state lets a late
write decide a row a newer observation already owns.

## 6. Path mapping

`filepath_mapping` rows are `(download_client_id, from_path, to_path)`. Mapping
takes the **longest** matching `from_path` prefix, so a specific mapping beats a
general one regardless of insertion order. No match is not an error: the
client's path is used unchanged, which is correct for a host sharing a
filesystem with its client — the overwhelmingly common single-machine setup.

A mapped path that does not exist is a **delivery failure, not a completion
failure**: the row stays `completed`, so a mapping corrected later takes effect
on the next tick without anything having to be un-failed. This is the same
"absence is an observation" reasoning applied to the filesystem.

## 7. Failure modes worth naming

- **A client that hangs.** The dispatcher's per-job `AbortSignal.timeout` bounds
  the whole tick, and the per-hostname fetch queue bounds each request. Nothing
  in this slice adds a timeout of its own.
- **A plugin that throws on delivery.** Logged, row stays `completed`, retried
  next tick. Forever, deliberately: a plugin that cannot accept a file is a bug
  to fix, not a row to abandon.
- **A plugin that hangs on delivery.** Bounded only by the job ceiling, and it
  blocks the rest of *that tick's* deliveries. Accepted for now; the fix, if it
  is ever needed, is per-delivery timeouts, not a second dispatcher.
- **Two clients holding the same ref.** `ref` is unique only within a client,
  which is why every lookup is keyed on `(download_client_id, client_ref)` and
  never on `ref` alone. 1.x had to learn this when a second client became
  configurable.
- **A snapshot that is never complete.** Absence is never established, so
  nothing is ever swept. The pass still advances everything it can see. This is
  the intended degradation.

## 8. Testing

Fakes only. No test reaches a real client; no test outside `readClientConfig`
selects `api_key`, `username` or `password`.

The properties worth pinning, each chosen because it fails silently:

1. **An incomplete snapshot never stamps `absent_since`** — and still advances a
   row it contains. Two assertions, one fake.
2. **`in-progress` is not a failure.** A history entry mid-unpack leaves the row
   where it is. This is the bug that cost 1.x a fix round.
3. **Client-first survives a wrong verdict.** A row already `failed`, whose job
   the client still holds as `completed`, is advanced. Row-first iteration
   cannot do this, so the test fails against it.
4. **Delivery is at-least-once and recorded exactly once.** A plugin that throws
   is retried next tick; a plugin that returns is not called again.
5. **A torrent client is never asked to remove anything.** Assert the adapter has
   no `remove` and that reclaim skips it — not merely that it was not called
   with particular arguments.
6. **A ref is recovered from one match and never from two.** The ambiguous case
   asserts nothing was written.
7. **The longest mapping prefix wins**, independent of row insertion order.
8. **Every advance is state-conditional.** A stale write against a row that has
   moved on changes nothing.

## 9. Consequences

- **`attempts` is still dead.** Recovery reads the snapshot; nothing re-sends.
  A row whose link was never accepted, and whose absence a complete snapshot
  proves, stays `submitting` forever with no error. That is visible and
  recoverable by hand, which is more than slice C left, and less than a retry
  would give. Whoever adds resubmission owns the double-submit question.
- **Delivery has no ordering guarantee.** Two completed downloads for one media
  item are delivered in row order, and the plugin sees them as two calls. The
  contract has always said that.
- **Nothing reclaims a torrent, ever.** A qBittorrent history grows for the
  lifetime of the installation, by design. If that becomes a problem the answer
  is a seeding policy, not a `remove` call.
- **A completed download whose plugin is unregistered is never delivered.** It
  sits `completed` and is retried every tick. `notifyNewRssItems` has the same
  shape and the same `unowned` reporting; reconcile reports it the same way.
