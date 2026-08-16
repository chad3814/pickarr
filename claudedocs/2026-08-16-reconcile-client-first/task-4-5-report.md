# Task 4 & 5 report: absence visible in the API and UI, retry as the escape hatch

Commits (worktree `reconcile-client-first`, not pushed):

- `af36497` Expose absence over the API and give retry an escape hatch for it (Task 4)
- `fdba758` Show a download the client has lost, and let its retry button actually work (Task 5)

## Task 4 — API

- `packages/core/src/http/views.ts`: `DownloadView` gains `absentSince: number | null`;
  `toDownloadView` populates it from `DownloadRow.absentSince`.
- `packages/core/src/http/server.ts`: the retry guard on `POST /api/downloads/:id/retry`
  widened from `existing.status !== 'failed'` to
  `existing.status !== 'failed' && existing.absentSince === null`. The 409 message now
  names both acceptable states ("Only a failed or absent download can be retried;
  this one is …"). Everything else about the route (404s, the reset itself, the reasons
  `queued`/`downloading`(seen)/`completed`/`importing`/`imported` must stay refused) is
  unchanged.
- Comment above the guard explains *why* accepting an absent row is safe: reconcile now
  never fails a download purely for missing-from-client (a snapshot gap must not read as
  "gone"), so without this widening an absent row would sit in `downloading` forever with
  no retry, and — since `inFlightForRelease` excludes only `failed` — no way for its
  release to be picked again either.

### Tests added (`packages/core/test/http/server.test.ts`)

- `downloads reports absentSince, null and populated` — `/api/downloads` reflects the
  column both ways.
- `retrying a healthy downloading download is refused` — a `downloading` row with no
  `absent_since` still 409s (renamed/added alongside the existing `imported`-row 409
  test, which already pinned the "not failed, not absent" case for a different status).
- `retrying a downloading download the client has lost is accepted` — a `downloading`
  row with `absent_since` set is accepted, resets to `queued`, and clears
  `absent_since` via `resetForRetry`.
- Existing `retrying a failed import resumes at completed` and `retry takes no body...`
  continue to pin the `failed` path.

### Mutation evidence (Task 4)

Reverted the guard to `if (existing.status !== 'failed') {` and reran
`packages/core/test/http/server.test.ts`: 1 failure, exactly
`retrying a downloading download the client has lost is accepted`. Restored the
widened guard and re-verified the file passes at 41/41.

## Task 5 — UI

- `packages/web/src/api/client.ts`: added `absentSince: number | null` to the
  hand-maintained `DownloadView` (does not derive from the server type, so this needed
  its own edit).
- `packages/web/src/api/format.ts`: added `formatElapsed(ms): string`, a coarse
  single-unit duration (`under a minute` / `Nm` / `Nh` / `Nd`), floored rather than
  rounded so "1h" never overstates. No `setInterval`/live clock — the value is computed
  at render time only, same as every other field on the row; it goes stale exactly as
  fast as the screen's own 3-second poll and no faster.
- `packages/web/src/components/DownloadRow.tsx`:
  - Renders `<span className="download-absent">missing from client for {…}</span>`
    when `absentSince !== null`, following the `download-status`/`download-error`
    naming convention.
  - Retry button condition changed from `download.status === 'failed'` to
    `download.status === 'failed' || download.absentSince !== null` — the exact
    formula the server's widened guard accepts, with a comment saying the two must
    agree or the button 409s.
- `packages/web/src/styles.css`: one line, `.download-absent { color: #b45309; }`
  (amber, not the `.download-error` red — absence is not yet a failure).

### Tests added/extended (`packages/web/test/Downloads.test.tsx`)

- `download()` factory extended with `absentSince: null` default.
- `an absent row warns and offers retry, a healthy row offers neither` — renders the
  "missing from client for 3h" text and a retry button for an absent row; neither for a
  healthy one. Uses the `gone()` helper (boolean compare, not
  `assert.equal(queryByText(...), null)`) per the stated rule.
- `a failed row keeps its error and retry button, and no absence warning` — confirms
  the failed path is untouched by the absence branch.
- `retry is offered for exactly the statuses the API guard accepts` — the agreement
  test: enumerates every status the SPA can see
  (`queued`/`downloading`/`completed`/`importing`/`imported`/`failed`) crossed with
  `absentSince` null/set, and asserts the button's presence matches
  `status === 'failed' || absentSince !== null` in every one of the 12 cases. This is
  the test that pins the two-halves-agree requirement directly, rather than by
  inspection.
- Existing test `a tracked row shows status and offers retry only when failed` is
  unchanged and still passes (it never sets `absentSince`).

Two unrelated test files construct `DownloadView` literals and needed the new required
field added with no behavioural change: `packages/web/test/Browse.test.tsx` (a `pick`
response's `download`) and `packages/web/test/Picks.test.tsx` (a `failed` tracked row).

### Mutation evidence (Task 5)

- Reverted `retryable` to `download.status === 'failed'` (dropping the absent clause):
  `retry is offered for exactly the statuses the API guard accepts` failed at the first
  `queued` + absent case (`false !== true`), as expected. Restored.
- Neutralized the warning's render guard (`{download.absentSince !== null && (...)}` →
  `{false && (...)}`): `an absent row warns and offers retry...` failed (could not find
  the "missing from client for 3h" text). Restored.

## How the two halves were kept in agreement

1. Both guards are the literal formula `status === 'failed' || absentSince !== null`
   (API: negated as the 409 condition; UI: as the `retryable` boolean) — no derived or
   independently-reasoned condition on either side.
2. The web enumeration test above evaluates the UI's own condition against 12
   status/absence combinations and pins it as a value, not just as a smoke test on one
   row — so a change to either half's condition without updating the comment referring
   to the other would still be caught by drift in this test only if someone also edits
   the API's condition to something the comment describes differently; the tests can't
   physically import each other's source across packages, so agreement is enforced by
   (a) both being one-line boolean formulas transcribed identically, (b) the paired
   commit messages and in-code comments cross-referencing each other explicitly, and
   (c) `npm run check` running both suites together every time either half changes.

## Verification

- `npm run check` from worktree root: lint (0 errors, pre-existing warnings only,
  confirmed via `npx oxlint` on just the touched files — no new warnings introduced),
  typecheck (clean across all workspaces), `npm run test:server` (862 tests, 859 pass,
  3 fail — the pre-existing `AbortSignal.timeout` mock-timer failures in
  `clients/theporndb.test.ts` (x2) and `media/artwork.test.ts` (x1), unchanged from
  baseline; baseline 859/856+3 plus 3 new server tests = 859 passing, no new failure),
  `npm run test:web` (168 tests, 168 pass — baseline 165 plus 3 new web tests, all
  green). `npm run check` itself stops after `test:server` because the script chains
  `test:server && test:web` and `test:server` exits non-zero due to the 3 known
  failures; ran `test:web` separately to get its count — this appears to be pre-existing
  behaviour of the `check` script, not something introduced here.

## Deliberately not done

- Did not touch `missing_polls` (already gone, per the brief; grepped to confirm it
  does not reappear).
- Did not add a repair script for the 35 stranded rows — the plan says none is wanted;
  they recover through Task 3's matching rule on the next tick.
- Did not fix pre-existing oxlint warnings (`no-shadow`, `no-await-in-loop`,
  `no-map-spread`, etc.) encountered in touched files — out of scope, none are new.
- Did not add a "time since absent" tooltip with exact timestamp, or any UI beyond the
  one warning line and the retry button — brief asked for a coarse duration and a
  retry affordance, nothing more.

## Concerns

- None outstanding. The `npm run check` script's `&&`-chaining between `test:server`
  and `test:web` means a pre-existing (non-regression) server test failure silently
  skips the entire web suite when using the top-level `check` command; this is
  pre-existing repo behavior, not introduced by this change, but worth flagging since
  it means `npm run check`'s reported "3 failures" understates that web tests didn't
  run at all in that invocation — I ran `test:web` directly to confirm its 168/168.
