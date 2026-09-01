# Picks ⊕ Downloads — Design

The Downloads tab is deleted. Every tracked download's state appears on the card
for the group it belongs to, on the row for the release it is a download *of*,
and the download client's untracked queue moves to the foot of Picks.

## 1. What this delivers

A reader who has picked something currently watches it in two places. Picks says
which release is `Current`; Downloads says whether the file is `queued`,
`downloading` or `failed`, and is the only screen with a Retry control. Neither
screen answers the other's question, and `ReleaseRow`'s own comment sends the
reader across:

> a retry of this one belongs to the Downloads tab, which has a Retry control
> for it

After this change the card answers both. `release-current` reads the download's
status while one is in flight, the release that failed carries its error and a
Retry button on a line of its own, and nav drops from five tabs to four.

### 1.1 What this is not

- **No pagination of Picks.** `/api/picks` still answers every picked group in
  one response with no cursor, and the search box still filters what has
  arrived. Paginating it changes what that box means, and the untracked list's
  placement is entangled with both — that is its own session's work.
- **No server-side search.** Unchanged from today, and unchanged by this.
- **No new download states.** `DownloadStatus` keeps exactly the six members it
  has in `packages/core/src/db/downloads.ts:6-12`.
- **`kind` is dropped, not moved.** `DownloadRow` showed `initial` vs `upgrade`;
  a card that already distinguishes the current release from its alternatives
  says the same thing positionally.

## 2. Status belongs to a release, not to the pick

The obvious reading — show the download's status where the card currently says
`Current` — loses a whole class of download, and the reason is recorded in
`packages/core/src/pipeline/pick.ts` beside the branch that causes it:

> an upgrade deliberately leaves `picked_release_id` on the old release until
> the replacement imports

`pick.ts:142` is `if (kind === 'initial') markPicked(...) else refreshUpgradeFlag(...)`,
and `kind` is `'upgrade'` whenever the group already has files (`pick.ts:116`).
So an upgrade the reader clicked five seconds ago is downloading against a
release that is *not* `pickedReleaseId` — it is an alternative further down the
card. Rendering status only on the current row would leave that download with
nowhere to appear at all once Downloads is gone, which is the orphaning
`DownloadRow`'s own comment describes:

> a failure here left the group holding the untried alternatives somewhere in
> the Picks list with nothing pointing at it

So state is keyed by release id and rendered on whichever row owns it. The
current pick is the common case, not a special one. This is also how the field
being generalised already works — `ReleaseView.downloadFailed` is per-release
because, in `client.ts:240`'s words, "the failed release is frequently not the
pick".

## 3. The data path

Two halves, exactly as metadata already works on this screen: a static value the
list response carries, and a live value a poll overrides it with.

**Static.** `ReleaseView.downloadFailed?: boolean` becomes
`ReleaseView.download?: ReleaseDownloadView` — the release's most recent
download, absent when it has none:

```ts
export interface ReleaseDownloadView {
  downloadId: number;
  status: DownloadStatus;
  error: string | null;
  /** When the client first stopped reporting it, or null while it is seen. */
  absentSince: number | null;
}
```

This subsumes the boolean it replaces (`downloadFailed` was
`download?.status === 'failed'`) and is produced where that boolean is produced,
`packages/core/src/http/views.ts:472`. It covers first paint and every terminal
state, so a card shows `imported` or `failed` with no poll running at all.

**Live.** `GET /api/downloads/for-groups?ids=1,2,3` returns
`Record<number, Record<number, ReleaseDownloadView>>` — group id, then release
id. It mirrors `GET /api/metadata` exactly: the same comma-separated `ids`
string, the same `parseIds` validation capped at `MAX_PAGE_LIMIT` (100,
`server.ts:168`), a 400 on a malformed or over-long list, and a fixed number of
queries regardless of how many ids arrive rather than a query per id.

It returns the most recent download per release **whatever its status**, not
only the ones in flight. Returning in-flight rows only would mean a download
that imports while the tab is open drops out of the live map and falls back to a
static value captured at page load, so the row would sit reading `downloading`
forever — the live half has to be able to say "this is finished", not merely go
quiet.

**The hook.** `useGroupDownloads`, beside `useGroupMetadata`, chunking at the
same 100-id cap. Two deliberate differences from its neighbour:

- **A flat 3s interval, not a backoff ladder.** `POLL_MS = 3000` is what
  `Downloads.tsx:8` used, and status advances on the scheduler's reconcile tick
  rather than on a per-row backoff a server can predict. There is no `next_at`
  to honour and so nothing for a ladder to be built out of.
- **A bounded watch list.** It asks only about groups the static payload says
  hold a download in a non-terminal state — `TERMINAL_STATUSES` is
  `['imported', 'failed']` (`downloads.ts:16`). Unbounded, this would be one
  request per 100 picked groups every three seconds for a library where almost
  nothing is downloading; bounded, it is normally one request per tick, which is
  what the screen it replaces cost.

`MediaCard` merges live over static per release, the same shape Picks already
uses for metadata (`Picks.tsx:210`).

### 3.1 What the bounded watch list gives up

A download created in *another* tab, or by another client of the API, is not
noticed until this screen reloads — the static payload is what seeds the watch
list, and a group with nothing in flight is not asked about. This is narrower
than it sounds: `pickRelease` has exactly one caller (`server.ts:1174`), so a
download is only ever created by a human clicking Pick somewhere, and a click
*here* runs `reload()` already. The old screen's poll would have caught the
other-tab case, because it polled page one of a global list; this is the price
of not polling every picked group. A reload is the remedy and nothing is lost
permanently.

## 4. The release row

`release-current` reads, in this order of precedence:

| Condition | Text |
|---|---|
| download failed | `Failed`, in red — today's behaviour |
| download in `queued`/`downloading`/`completed`/`importing` | the status word |
| any release with a download in any other status, **except `imported` on a release that is not the pick** | the status word |
| a release that is not the pick whose download `imported` | nothing — the `Pick` button stands alone |
| picked release with no download row at all | `Current` |
| other release, no download | nothing (the `Pick` button stands alone) |

**Amended after the fact, against a real library.** This section first said
`imported` reads `Current` rather than `imported`, because the reader has the
file, which is what that word has always meant here; a release cannot be
`imported` and *not* the pick, since `completeUpgrade` (`groups.ts:374`) moves
`picked_release_id` onto it at import.

That reasoning was sound about the word and wrong about the screen. Measured on
a real database: **1137 of 1164 picked groups sit at `imported`**, 26 at
`failed`, one `downloading`, and none with no download at all. So the carve-out
applied to essentially every row, every card kept saying `Current`, and the
feature this whole design exists to deliver was invisible — which is the
opposite of the brief, whose words were "expand what can be shown in the
`release-current` span to be the contents of the `download-status`".

`imported` now shows itself. `Current` is reserved for the one state no status
word covers: picked, with no download row at all. That state does not occur in
the measured library, but it is reachable — a group picked before downloads
existed, or one whose download rows were purged — so the branch stays and has
its own test.

**Amended a second time, for the same reason in the opposite direction.** The
first amendment was wrong by *kind* where the original was wrong by *scale*.
`completeUpgrade` (`db/groups.ts`) moves `picked_release_id` onto the
replacement when an upgrade imports, and the superseded release keeps its own
`imported` download in history — so after any completed upgrade **both** rows
read `imported`, nothing said which file the reader actually holds, and the
superseded row said it beside a `Pick` button offering to fetch what it appeared
to claim was already there. Measured at 14 such releases.

The rule that survives both mistakes: **a terminal success on a release you no
longer hold is history, not state.** Only `imported` is qualified by the pick,
and only when it is not the pick. Every non-terminal status stays keyed to
whichever release owns it, because an in-flight upgrade is by definition not the
pick (§2) and qualifying those on the pick would hide them entirely — the
orphaning this design exists to prevent. Both halves have a test, and each dies
to a mutation in its own direction.

**A detail line under the release**, rendered only when there is something to
put on it: the download's `error`, the `missing from client for X` warning, and
the Retry button. It sits under the row rather than inside it because
`.release-row` is one flex line (`rows.css:33-40`) whose cells set `min-width` as
a floor rather than a fixed column — its own comment says so — and an error
message is arbitrary-length prose that would stretch that line without bound.

The `missing from client` warning keeps its wording, its `formatElapsed` call —
whose only caller is the line being moved — and the reason
`DownloadRow.tsx:33-40` gives for it — it is that state's only window onto the
screen, and an invisible stuck row is what once let 35 healthy downloads sit
unnoticed for a day.

**`Pick` is suppressed only while a download is in flight** — status present and
not in `TERMINAL_STATUSES`. A row reading `downloading` beside a `Pick` button
invites a duplicate download of what is already coming. `failed` rows are
deliberately left exactly as they are today: a failed *alternative* keeps its
`Pick`, because `ReleaseRow`'s comment is right that this is a way out of the
failure, and it now sits beside a `Retry` that re-submits the same download
rather than committing the group to a different release. A failed *current* row
offers no `Pick` today and gains `Retry`, which is precisely the control its
comment sent readers to another tab for.

## 5. Retry

The offer is `status === 'failed' || absentSince !== null`, copied unchanged from
`DownloadRow.tsx:14` and for the reason stated there: it must accept exactly what
the API accepts, since a wider or narrower offer becomes a 409 on click.

`api.retry` returns the updated `DownloadView`, so the hook exposes a patch that
writes that row into its live map instead of refetching — the same choice
`Downloads.tsx:109-119` made, and for one of the same reasons: `reload()` here
re-fetches every picked group's releases and metadata, which is a large response
to spend on one row that the retry's own response already described. The next
poll confirms it.

A retry that is accepted and then fails again on the next reconcile tick still
looks like nothing happened, and the row's error message is where it says so.
That is unchanged.

## 6. Untracked

`Not managed by Pickarr` — its `<h2>`, its `ul.downloads.untracked`, and its
rows — moves to the foot of Picks below the cards, which is where it already
sits relative to the tracked list. `UntrackedEntry` is unchanged. It keeps:

- the composite `${clientId}:${ref}` key, because a `ref` is unique only within
  one client and two clients (#34) can present the same one
- the heading hiding when a term has excluded every entry, because the heading
  is the whole of what says these downloads are not Pickarr's

It arrives from the same place it does now, `/api/downloads`, which Picks calls
once on mount for this purpose only — the response's `untracked` is the client's
whole live queue rather than a slice, so one call gets all of it. Its `tracked`
half is discarded here; the endpoint keeps serving both because nothing else
about it changes.

Untracked entries are not refreshed by the download poll. They are not keyed by
group, so they do not fit the group-keyed endpoint, and a second interval for
them is not worth its request; they refresh when the screen does. Their
placement is revisited when Picks is paginated.

## 7. Routes, nav, and inbound links

- `packages/web/src/routes/Downloads.tsx` and
  `packages/web/src/components/DownloadRow.tsx` are deleted.
- `App.tsx:15` (`NavLink to="/downloads"`) and `App.tsx:44` (its `Route`) go.
  Nav is Browse, Picks, Failed, Settings.
- `/picks` keeps its path and its `#group-N` landing effect, which still works;
  nothing links to it any more, because `DownloadRow` was the only linker
  (`groupAnchorHref`). The effect stays rather than being deleted with its
  caller: it is the answer to "a link from Downloads would land at the top of a
  list its group may be far down", and Browse's failed-card work is the next
  thing likely to want it.
- `mergeNewestPage` and `usePagedList`'s use on this screen go with
  `Downloads.tsx`. `usePagedList` itself stays — Browse and Failed both use it.
- **`groupAnchorHref` is deleted**; `DownloadRow` was its only caller, and
  `Downloads.test.tsx` names it only in comments explaining why it is
  deliberately not imported. `groupAnchor` stays — `MediaCard` carries the id it
  builds, and two tests import it. `api/anchors.ts`'s doc comment says the two
  places that must agree are "the card that carries the id and the Downloads row
  that links to it"; with the second gone that sentence is false about its own
  file and is rewritten, not left standing.

## 8. Testing

- **`packages/web/test/Picks.test.tsx`** — the four `release-current` branches;
  the detail line appearing only with something to put on it; `Pick` suppressed
  in flight and present on a failed alternative; untracked rendered at the foot
  and its heading hidden when filtered out. `Picks.test.tsx:70` already builds a
  `downloadFailed` fixture and moves to the new field.
- **`packages/web/test/MediaCard.test.tsx`** — `MediaCard.test.tsx:187-190`'s
  `downloadFailed` helper becomes a `download` helper.
- **A new test for `useGroupDownloads`** — that the watch list excludes groups
  whose downloads are all terminal, and that a retry's patch survives until the
  next poll.
- **`packages/e2e/tests/retry.spec.ts`** — moves to Picks. Its
  `.download-status` assertions (`:78`, `:87`) become assertions on the release
  row's span.
- **`packages/e2e/tests/theme.spec.ts:181`** — `/downloads` leaves the route
  sweep.
- **`packages/e2e/tests/identity-change.spec.ts`** should keep passing
  untouched, and for reasons worth stating rather than assuming. Its surviving
  row asserts `.release-current` reads `Current` (`:168`) — that row's release
  *does* have a download, imported at `:66` (`reconciled.imported === 1`). Under
  the amended §4 that row reads `imported` in `.release-status`, and the spec
  was updated along with the rule rather than left describing the first version.
  Its upgrade row asserts `Pick` is visible (`:171`); that release is never
  picked — `:35` is the spec's only `Pick` click, on the dateless release — so it
  has no download and the in-flight suppression never applies to it. If either
  assertion breaks, the precedence table in §4 is wrong.
- **`packages/web/test/Downloads.test.tsx` is deleted, but most of it is
  re-homed rather than dropped.** Only two of its tests are about the deleted
  screen as such — `:134` and `:162`, which assert a download row links to its
  group, and the link goes with `DownloadRow`. Everything else asserts behaviour
  this change *keeps* and must keep working somewhere:
  - `:67`, `:83`, `:96`, `:110` — status shown, absence warned, error kept, and
    retry offered for exactly the statuses the API guard accepts — become
    `ReleaseRow` tests. `:110` is the one that matters most: it pins the
    `status === 'failed' || absentSince !== null` rule against the server's, and
    that rule is being moved verbatim.
  - `:171`, `:188`, `:223` — a bodyless retry request carries no JSON
    content-type, a refused retry surfaces instead of vanishing, and a retry
    refreshes its row without waiting on the poll — become `Picks` tests.
  - `:277`, `:328`, `:555` — untracked entries render inert and labelled, a term
    filters them and takes their heading with it, and two entries from different
    clients sharing a `ref` are keyed apart — become `Picks` tests. `:555` is the
    test for the composite key §6 promises to carry across, so losing it would
    leave that promise unguarded.
  - `:364` — a poll landing does not clear the search term or unfilter the list —
    becomes a `Picks` test about the *download* poll, which is the first poll
    that screen has ever had and so the first thing that could do this to it.
  - `:488`, `:522` — a poll landing keeps page two on screen while patching page
    one, and a term filters rows from every page loaded — die with their subject.
    Both are about `usePagedList` and `mergeNewestPage` driving the *tracked*
    list, and Picks is unpaginated; there is no page two to keep on screen. The
    equivalent guarantees for Browse and Failed are tested on those screens.
  - `:310` — a term leaves only the matching tracked rows — is the one to think
    about rather than mechanically move. Tracked rows no longer exist; Picks
    already filters cards by term, and that is already tested. Dropped, and named
    here so the drop is a decision rather than an omission.

  Sixteen tests, of which **eleven must have a home**, four die with the thing
  they test, and one is dropped on purpose. Task 8 of the plan checks this off
  before the file is deleted.

Every test above states a rule with more than one branch, so each is
mutation-checked individually: break the branch, prove that test and no other
fails. A test that passes for all four span states is worth nothing.

## 9. Consequences

- **Picks starts polling.** It never did. The watch list bounds the cost to what
  is downloading, but the ids being watched are drawn from every picked group, so
  the *filtering* work grows with the library even when the request count does
  not.
- **Download history stops being browsable.** Downloads listed every row
  `created_at DESC` with a pager; a card shows one download per release. History
  for a release that has been downloaded more than once is no longer reachable
  from the UI, and history for a group that has left Picks entirely — a merge
  where the survivor holds no pick — is reachable from nowhere. Nothing is
  deleted; `/api/downloads` still answers it.
- **`attempts` and `updatedAt` are unaffected.** Neither has a reader in the web
  package today — `DownloadRow` never showed them — so the merge neither exposes
  nor hides them. Noted only because `DownloadView` carries them and their
  absence from the card is not a regression.
- **Two screens' error surfaces become one.** Picks already has an `error`
  paragraph for pick/edit failures, and retry failures now report through it.
