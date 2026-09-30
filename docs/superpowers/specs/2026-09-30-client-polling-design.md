# Download-client polling, health and stuck rows (Phase 2: #93, #95, #101)

## Problem

Pickarr polls each SAB and qBittorrent client every 60 seconds
(`RECONCILE_INTERVAL_S`, `packages/host/src/clients/reconcile-job.ts:63`), so a
download's progress moves once a minute. Making that faster exposes four problems:

1. **A client that is briefly unreachable is never polled again.** A failed tick
   throws; the dispatcher retries it on `backoffMs` (1s, 2s, 4s, 8s) and dead-letters
   it after five attempts — about 15 seconds. Reconcile jobs are scheduled only at boot
   (`main.ts:238`) and when a client is added (`host.ts:894`), so that client's
   downloads stop advancing and stop importing until the host restarts, with nothing
   visible.
2. **#101 — a refused import retries every tick, forever.** `deliverOne` leaves the row
   `completed` and redoes the whole attempt (map path, stat, owner lookup, list, place)
   on every pass. `DeliverResult` counts nothing for it. At a 10-second tick that cost
   is six times today's.
3. **#95 — a `submitting` row wedges its release.** Nothing settles a row left
   `submitting` (process killed mid-submit, an unhandled path). Migration 18's partial
   unique index then refuses every re-pick.
4. **#93 — client selection is health-blind.** When a feed names no client and several
   match, `selectClientForFeed` picks at random, so a dead client receives its share
   of picks.

## Goal

Progress updates every 10 seconds. Polling survives any outage and resumes on its own.
A stuck import costs little and says so. A stuck pick clears itself. Picks prefer a
reachable client, and the settings screen shows which clients are reachable.

## Decisions already made

| Question | Decision |
|---|---|
| Poll interval | 10 seconds, fixed |
| Stuck imports | Count them and back off per row (10s doubling, capped at 1 hour); the row stays `completed` |
| Stuck `submitting` | Settled inside the reconcile tick, after ref recovery, once 10 minutes old |
| Health | Consecutive-failure count; 3 or more means unreachable; selection prefers reachable clients and falls back to all |

## 1. Data: host migration 25

One migration, `ADD COLUMN` only. `docs/database-migrations.md` measures that as
keeping every sync trigger, so none are reinstalled.

**`download_client`** (synced):

- `consecutive_failures INTEGER NOT NULL DEFAULT 0`
- `unreachable_since INTEGER`: when the current streak of failures began, or `NULL`
  when the last check succeeded or no check has failed yet.

Both are added to the `download_client` case of `sync/tables.ts`'s projection. They
are also added to `DownloadClientSyncRead` in `@pickarr/contract` as
`consecutiveFailures: number` and `unreachableSince: number | null`. No error text is
stored or replicated: a client's error can carry its address or a credential. It goes
to the log only, redacted as today.

**`torrent_download` and `nzb_download`** (synced tables, but these columns are
host-only):

- `import_failures INTEGER NOT NULL DEFAULT 0`
- `import_retry_at INTEGER`: the earliest time delivery may try this row again, or
  `NULL` for "now".

Neither column is added to the sync projection or the contract. A write to them still
fires the row's update trigger, and that is accepted. Such writes happen only at the
backed-off pace described below.

**Nothing for #95.** A `submitting` row's `created_at` is the moment the pick was
written (`downloads.ts:94,105`). `updated_at` is not used, because `setRef` moves it
while the row stays `submitting`.

## 2. The reconcile tick

**Interval.** `RECONCILE_INTERVAL_S` becomes `10`.

**A tick never dead-letters.** The handler catches every failure and returns normally,
so the dispatcher's `max_attempts` is never reached. It then schedules the next tick
itself, by the same `scheduleReconcile` guard that allows one pending job per client:

- **Contact failure.** Building the adapter or taking the snapshot failed. The client
  is marked as failed (see Health below). The next tick is due after
  `min(10s × 2^(n−1), 5 min)`, where `n` is the new `consecutive_failures`.
- **Local fault after a good snapshot.** For example, a database error in the walk or
  in delivery. This does not count against the client's health. The next tick is due
  after the normal 10 seconds, and the fault is logged.

The module doc says a reschedule on a throw path would stack with the dispatcher's own
retry. That rule is kept: nothing throws any more, so the dispatcher never retries a
reconcile job. The doc is rewritten to say so.

**Health writes happen only when health changes.** A successful snapshot writes
`consecutive_failures = 0, unreachable_since = NULL`, and only when
`consecutive_failures > 0`. A failed snapshot writes
`consecutive_failures = consecutive_failures + 1`, and sets `unreachable_since` to now
if it was `NULL`. A healthy client costs no writes, so no sync churn, however often it
is polled. A failing one costs one write per failed check, at the backed-off pace.

**Settling unconfirmed submissions (#95).** `walkSnapshot` gains a last step after its
existing ref recovery (`recoverRefs`). Every one of this client's `torrent_download` or
`nzb_download` rows that is still `submitting` and has `created_at` more than 10 minutes
ago moves to `failed`, with `last_error` set to "the client never confirmed this
submission". The update carries a `WHERE status = 'submitting'` guard, so it cannot
overwrite a row something else settled first. `ReconcileResult` gains an `unconfirmed`
counter.

- **Why here.** Recovery has already had its chance at the row in this same tick, from
  the client's own current list, so the two cannot race.
- **Why 10 minutes.** A submission is bounded by the 30-second fetch timeout, so
  anything still `submitting` long after that was not going to finish.

Only a successful snapshot reaches this step. A client that is down never settles its
rows: without its list there is no way to tell "never arrived" from "arrived, not yet
seen".

## 3. Delivery backoff (#101)

In `deliverCompleted`:

- **Rows not yet due are skipped.** A `completed` row whose `import_retry_at` is after
  now is not attempted this tick.
- **A refused import is recorded, not only logged.** The import is refused or throws,
  and the row stays `completed`. Its `import_failures` increases by 1. Its
  `import_retry_at` becomes now + `min(10s × 2^(n−1), 1 hour)`, where `n` is the new
  `import_failures`. `DeliverResult` gains `refused`, the number of attempts refused in
  this pass, and the tick summary logs it when it is not zero.
- **A delivered row needs no reset.** It leaves `completed`.

**Saving a destination clears the wait.** A successful
`PUT /api/destinations/:pluginId` sets `import_retry_at = NULL` on that plugin's
`completed` rows in both download tables, found through
`rss_item → rss_feed.plugin_id`. `import_failures` is left alone, so a row refused
again resumes its backoff where it was. The effect: an operator who fixes a path shape
sees the import on the next tick, not up to an hour later.

Every refusal code backs off alike. Some fix themselves: a root mounted later, a
destination saved later. Others need an operator: `destination-exists`, a bad resolved
value. Either way the row keeps being retried, now at a bounded cost, and none becomes
terminal. So the rule that `delivered` means "a plugin was told" is untouched.

## 4. Selection (#93)

A client is **unreachable** when `consecutive_failures >= 3`. In `selectClientForFeed`:

- **The feed names a client.** That client is used, reachable or not.
- **The feed names none, and several match its download type.**
  - The draw is among the reachable candidates.
  - If none is reachable, the draw is among all of them, as today.

So wrong health data can never stop a pick from being sent somewhere. The injected
`chooseIndex` still does the drawing, so tests stay deterministic.

## 5. Settings display

In `packages/web/src/settings/DownloadClients.tsx`, each client shows one visible,
styled line:

- `Reachable` when `consecutiveFailures < 3`.
- `Unreachable since <local time> (<n> failed checks)` otherwise.

The line is real text in an element a stylesheet rule reaches, never an `aria-label`
(the `IdentityChangeConfirm` hazard in `CLAUDE.md`). A client with fewer than 3
failures reads `Reachable`, matching the selection threshold, so the screen and the
picks never disagree.

## 6. Testing

Each test is written to fail first.

- **Migration 25**
  - Adds the four columns with their defaults.
  - The `download_client` and download-table sync triggers still log an update.
- **Tick**
  - A client whose snapshot fails six times in a row is rescheduled every time, with
    delays of 10, 20, 40, 80, 160 and 300 seconds (capped). No job ever reaches
    `dead`.
  - A local fault after a good snapshot reschedules at 10s and leaves health untouched.
  - A healthy client's repeated successful ticks write nothing to `download_client`.
  - The first success after failures resets the streak.
- **Settle**
  - A `submitting` row 11 minutes old, with no match in the snapshot, becomes `failed`.
  - A row 9 minutes old is left alone.
  - A row the recovery step matches in the same tick advances instead of failing.
  - Another client's row is untouched.
- **Delivery**
  - A refused import sets `import_failures`/`import_retry_at` on the ladder and counts
    `refused`.
  - A row not yet due is not attempted.
  - Saving that plugin's destination clears `import_retry_at` and not
    `import_failures`.
  - Another plugin's rows are untouched.
- **Selection**
  - Reachable candidates are preferred.
  - With every candidate unreachable, the draw is from all of them.
  - An explicitly named, unreachable client is still used.
- **Settings**
  - Both lines render as visible text, at the threshold's boundary (2 and 3 failures).
- **Mutations.** Remove or break each guard and confirm a test goes red:
  - the no-throw catch
  - the health-change-only write
  - the 10-minute bound
  - the `WHERE status = 'submitting'` guard
  - the not-yet-due skip
  - the destination-save reset
  - the reachable filter and its fallback
- **Gate.** `npm run check` and the full e2e suite.

## Out of scope

- A retry or cancel button for a failed or stuck download (the Activities page, Phase 4).
- A per-client or adaptive poll interval.
- Showing an import refusal's reason in the UI.
- Replacing polling with push (Phase 3).
