# Task 11 report: end-to-end, the reported scenario in a browser

## Files changed

- `packages/e2e/tests/identity-change.spec.ts` (new) — the scenario spec.
- `packages/e2e/tests/manual.spec.ts` (modified) — added the confirm-dialog
  click the merge test now needs.
- `packages/e2e/src/harness.ts` (modified) — seeded a known site name so the
  dateless parse shape the bug depends on can actually occur in this harness.
  See "What the brief got wrong / had to be resolved" below for why this was
  necessary.

## What the harness needed, and why

`SomeSite.TitleOfScene.1080p.MP4-WRB` (no date) only parses at all through
`parseDatelessForm` in `packages/plugin-scenes/src/parse.ts`, which **refuses
outright unless the leading run is a site the plugin already knows** — there
is deliberately no first-token fallback for the dateless shape, because
without a date there is no other evidence the release is a scene at all. In
production a site becomes "known" via the site-lookup pipeline
(`learnSites`/`resolve-sites.ts`), which needs a `SiteLookupClient` the e2e
harness has never modeled (it only fakes `SceneLookupClient` for the metadata
worker). Every existing e2e spec sidesteps this because they all use *dated*
titles, which fall back to the release's own first token when the site is
unrecognized.

So the exact bug scenario the brief describes — a dateless release parsing
successfully — could not occur in the harness as it stood. I added a small,
documented constant to `harness.ts`:

```ts
const KNOWN_SITES = ['SomeSite'];
```

and passed it as `sites: KNOWN_SITES` in the scenes plugin's config
(`plugins: { [SCENES_PACKAGE]: { libraryRoot, sites: KNOWN_SITES } }`). This
mirrors exactly how `packages/plugin-scenes/test/parse-date-at-end.test.ts`
unit-tests the dateless shape (`parseSceneRelease(name, { sites: [...] })`),
and it's the config schema's own documented use case for the array member of
`PluginConfig` ("the scenes plugin's known site names", per
`configSchema`'s comment in `packages/core/src/config/schema.ts`). I verified
it doesn't affect any other e2e spec: none of them use a site named
`SomeSite`, and dated/episode-anchored parses don't require a known site in
the first place.

I confirmed the exact parse output for both release names against the real
parser (`node --import tsx`, ad hoc probe, not committed) before writing the
spec, rather than guessing at identity keys, display strings, or rendered
library paths.

## The new spec: `identity-change.spec.ts`

One test, `'adding a date to a picked group merges it into the dated one'`,
against two literal release names:

- `DATELESS = 'SomeSite.Title.Of.Scene.1080p.MP4-WRB'`
- `DATED = 'SomeSite.26.08.14.Title.Of.Scene.2160p.MP4-WRB'`

Steps and what each proves:

1. **Ingest the dateless release, pick it through the UI, complete and import
   its download.** Uses the harness's real `ingestEntries`/`reconcileClient`/
   `importDownload` pipeline exactly as `retry.spec.ts` does for the pick →
   client → reconcile leg, with a genuine `.mp4` file written to a temp
   "download directory" so the import pipeline's real `stat()` calls have
   something to find (no fabricated DB rows). Asserts `reconciled.imported`
   is 1, and — as a filesystem-level check, not just a DB one — that the
   dateless library path
   (`somesite/somesite.title.of.scene.1080p-WRB.mp4`) exists.

2. **Ingest the dated 2160p release.** Asserts, across two separate real
   page loads, that the bug's actual shape holds: Browse (`/`) shows exactly
   one card (the new dated group — `BROWSABLE` in `db/groups.ts` excludes a
   picked group with no upgrade flag), and Picks (`/picks`) shows exactly one
   card (the picked dateless group). I documented in the spec why "two
   separate cards" can't be proven on one screen here — the moment a release
   is picked its group leaves Browse's `state = 'new'` filter, well before
   its download finishes — and that the split across two pages *is* the bug
   this feature exists to fix, not an artifact of how I wrote the test.

3. **On Picks, open the picked group's edit form and set the anchor to a
   date.** Confirmed against `packages/plugin-scenes/src/manual.ts`'s real
   field list (`Site`, `Anchor` select with options `date`/`episode`/`none`,
   `Date`, `Episode`, `Scene`, `Title order`) rather than guessing. Only
   `Anchor` → `date` and `Date` → `2026-08-14` are touched, matching what a
   real user correcting this bug would do.

4. **Assert the confirmation dialog.** `role="dialog"`, `aria-label="Confirm
   identity change"` per `IdentityChangeConfirm.tsx`. Asserts the merge-target
   text ("This will merge into … Title Of Scene … moving 1 release(s) and 1
   download(s)"), the "Files renamed" heading, exactly one rename row
   (`from → to`), and that the `from`/`to` paths are the exact absolute paths
   I derived from `renderPath`/`templateValues` for the dateless and dated
   identities respectively (computed via `harness.libraryRoot`, not
   hardcoded strings that could drift from a real temp dir). Also asserts no
   `p.error` blocker is shown.

5. **Confirm.** Clicks the dialog's `Confirm` button; asserts the dialog
   closes.

6. **Assert the merge landed.** One card remains, `p.date` reads
   `2026-08-14`, `span.badge` reads `Upgrade available` (the 2160p arriving
   through a human correction earns the same "arrival" bump a normal ingest
   would — verified by reading `operations.ts`'s `earnsListBump`/
   `flagUpgrade` logic rather than assuming). Two release rows: the dateless
   one is `.release-current` ("Current" — still the pick), the dated one
   offers a `Pick` button (the upgrade path, not auto-promoted). Re-checked
   Browse also now shows exactly one card (the same survivor, now reachable
   via the upgrade flag) — no leftover/duplicate group. Finally, filesystem
   proof: the dated path exists and contains the original bytes
   (`readFile(...) === '1080p bytes'`), and the old dateless path is gone
   (`stat(...).rejects`), which is the real-move guarantee `importMode:
   'move'` promises, not merely a database row update.

## `manual.spec.ts` repair

Task 10 flagged that the second test, `'editing a group into another merges
it and leaves no card behind'`, would go RED because a merge now always
requires confirmation (`needsConfirmation` gates on `plan.kind === 'merge'`
alone, per `useIdentityChange.ts`, regardless of whether either side is
picked). I made the minimal fix — no rewrite of the file, no touching the
first test (which goes through `resolveFeedItem`, a different code path with
no confirmation step):

```ts
await form.getByRole('button', { name: 'Save' }).click();

// A merge always needs confirming now (2026-08-16's identity-change work),
// regardless of whether either side is picked — `needsConfirmation` gates on
// `plan.kind === 'merge'` alone. Nothing here moves a file (neither release
// is downloaded), so the dialog names only the merge target, not a rename.
await expect(page.getByRole('dialog', { name: 'Confirm identity change' })).toBeVisible();
await page.getByRole('button', { name: 'Confirm' }).click();

// The source card is gone — this is the assertion the `mergedInto` bug fails.
```

Everything after that (the "source card is gone", release-count, and notice
assertions) is unchanged.

## Gate results

- `npm run lint` — exit 0. Only pre-existing warnings (no-await-in-loop,
  no-shadow, preserve-caught-error, etc.) in files I did not touch; nothing
  new from my changes.
- `npm run typecheck` — exit 0, all five workspaces.
- `npm run test` — exit 0. `test:server`: 876 passed, 0 failed.
  `test:web`: 182 passed, 0 failed. (No `any`/`unknown` introduced; nothing
  in this task touched core/web source beyond the e2e package.)
- `npm run build` — exit 0, all four buildable packages including the SPA
  the e2e harness serves.
- `npm run e2e` — exit 0. **15/15 passed**, including:
  - `identity-change.spec.ts` — 1/1 passed (~0.8s)
  - `manual.spec.ts` — both tests passed, including the repaired merge test
  - all pre-existing specs (`card-layout`, `metadata-modal` ×3, `retry`,
    `pagination` ×2, `settings` ×3, `smoke`, `metadata`) unaffected by the
    harness's `sites` seed.

(Playwright's Chromium browser had to be installed locally via `npx
playwright install chromium` before the suite could run at all — a one-time
environment setup, not a code change.)

## `git status --porcelain` check

```
A  packages/core/src/manual/identity-plan.ts
M  packages/core/src/manual/operations.ts
A  packages/core/src/manual/values.ts
...
M  packages/e2e/src/harness.ts
A  packages/e2e/tests/identity-change.spec.ts
M  packages/e2e/tests/manual.spec.ts
...
```

Every line's first column is `A` or `M` — confirmed programmatically with
`git status --porcelain | awk '{print substr($0,1,1)}' | sort -u` → `A`, `M`
only, no space (unstaged) or `?` (untracked) entries. All three of my files
(`identity-change.spec.ts`, `manual.spec.ts`, `harness.ts`) are staged.

## Concerns

- The harness's `KNOWN_SITES` addition is a real, if small, expansion of
  shared test fixture state. It's scoped to a site name no other spec uses
  and is documented in place, but it's worth a reviewer's eye since it's the
  one piece of this task that isn't purely additive to the e2e package.
- I did not attempt to exercise the site-lookup/`learnSites` pipeline itself
  (out of scope for this task and not part of the identity-change feature) —
  the harness seed is a deliberate substitute for it, not a claim that the
  real learning pipeline was tested.
