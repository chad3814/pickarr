# Finding a group whose download failed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a download fails, make the group it belongs to easy to find and its alternatives easy to pick.

## Why

Reported from a live instance and confirmed against its database. A 2160p was picked on 08-09; the download failed five minutes later with `Repair failed, not enough repair blocks (92 short)`. The group has sat `picked` ever since — off Browse, because Browse shows `state = 'new' OR upgrade_release_id IS NOT NULL` and a group whose pick is the best release it has qualifies for neither. It now holds three untried alternatives: a second 2160p re-post, a 1080p and a 720p.

Nothing pointed at any of that. The Downloads tab said a download failed and named a title; the Picks tab held the group somewhere in a long list; the two screens did not connect, and the failed release still read `Current` — a word that is exactly wrong for a file you do not have.

## What this adds

1. **Anchors on the Picks tab.** Each card gets a stable id so it can be linked to directly.
2. **Downloads titles become links** to that anchor.
3. **A group whose current pick failed sorts to the top of Picks**, so the thing needing attention is where you land.
4. **That release reads `Failed`, in red, instead of `Current`.**

## Global Constraints

- **Do not commit.** Leave work in the working tree; the repo owner approves every commit.
- Node 24 is not the shell default: `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.
- **Verify with `npm run check`** (lint + typecheck + test). `npm run build` runs no typechecker.
- Baseline: 549 server / 62 web, all green.
- Never use `any`. tsconfig sets `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`.
- In web tests **never** write `assert.equal(screen.queryByText(x), null)` — it deep-inspects a live DOM node to format the failure, burns ~75s and kills the run with no test named, inside `waitFor` or not. Compare booleans; see `gone()` in `packages/web/test/Browse.test.tsx`.
- Comments explain *why*.
- When a test claims to pin a property, mutate the source to break it and confirm the test fails. Report the evidence.

---

### Task 1: The server says which picks have failed

**Files:**
- Modify: `packages/core/src/db/groups.ts`
- Modify: `packages/core/src/http/views.ts`
- Test: `packages/core/test/db/picks-order.test.ts` (create)
- Test: extend `packages/core/test/http/server.test.ts`

**Interfaces produced,** consumed by Task 2: `GroupView.pickFailed?: boolean`, and `pickedGroups` ordering failed picks first.

**What "failed" means here, precisely.** The group's `picked_release_id` names a release; that release's **most recent** download has `status = 'failed'`. Most recent matters: picking a release whose earlier attempt failed inserts a *second* `downloads` row (`inFlightForRelease` excludes only `failed`, so it does not block), and a group that failed once and is now downloading again is not a group needing attention. Order by `id DESC` within a release and take the first.

A release with no download at all is not failed. A group with no pick is not failed.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/db/picks-order.test.ts`, one `test()` each:

1. A group whose picked release's only download failed sorts before a group whose pick imported, **even when its `list_rank_at` is older** — that is the whole point, and ordering by `list_rank_at` alone would hide it.
2. Two failed groups keep the existing relative order among themselves (`list_rank_at DESC, id ASC`).
3. A group whose picked release failed and was then re-picked — a newer `downloads` row that is `queued` — does **not** sort to the top.
4. A group whose *non-picked* release has a failed download does not sort to the top. Someone tried an alternative, gave up, and picked something else; that is not the same thing.
5. A picked group with no downloads at all is unaffected.

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/db/picks-order.test.ts
```

- [ ] **Step 3: Implement**

Extend `pickedGroups`' query with a computed "pick failed" flag and order by it first, then by the existing `list_rank_at DESC, id ASC`. Keep the existing tiebreak exactly — read the comment on `browseGroups` explaining why the id tiebreak is ascending, and do not disturb it.

Do the whole thing in SQL rather than sorting in JavaScript afterwards: `pickedGroups` returns rows straight to a view and a second sort pass in the caller would be a second place the order is decided.

- [ ] **Step 4: Surface it on the view**

`GroupView` gains `pickFailed?: boolean`, set **only when true** — `exactOptionalPropertyTypes` is on, so build it with a conditional spread, never `pickFailed: undefined`. Absent means "not failed", which keeps every existing response byte-identical and means the SPA needs no change where it does not care.

`toGroupView` already receives the `GroupRow`; it needs the same "most recent download for the picked release" fact. Compute it once per group, not per release.

Add a server test asserting the field is present and `true` for a failed pick, and **absent entirely** — not `false` — otherwise.

- [ ] **Step 5: Verify**

```
npm run check
```

---

### Task 2: The two screens connect

**Files:**
- Modify: `packages/web/src/components/MediaCard.tsx`
- Modify: `packages/web/src/components/ReleaseRow.tsx`
- Modify: `packages/web/src/components/DownloadRow.tsx`
- Modify: `packages/web/src/routes/Picks.tsx`
- Modify: `packages/web/src/api/client.ts` (mirror `pickFailed`)
- Modify: `packages/web/src/styles.css`
- Test: extend `packages/web/test/MediaCard.test.tsx`, `Downloads.test.tsx`

**Interfaces consumed:** `GroupView.pickFailed` from Task 1.

- [ ] **Step 1: Write the failing tests**

- A card renders an anchor id derived from the group id, stable across renders.
- The picked release reads `Current` normally.
- With `pickFailed`, the picked release reads **`Failed`** and carries a class the stylesheet colours red. Assert the accessible text, not the colour — a test that asserts CSS pins the stylesheet, not the behaviour.
- A `DownloadRow`'s title is a link to `/picks#<anchor>` for its group.
- A download that is *not* failed still links — the link is navigation, not an error affordance.
- `MediaCard` with no `pickFailed` behaves exactly as before, so `Picks.tsx` and `Browse.tsx` both keep working.

- [ ] **Step 2: Run and watch them fail**

```
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/MediaCard.test.tsx
```

- [ ] **Step 3: Implement**

The anchor id has to agree in two places — the card that defines it and the row that links to it. **Put it in one exported function** (`groupAnchor(groupId)`), imported by both. Two string templates that must match is exactly the kind of duplication this codebase has been bitten by before.

`DownloadView` already carries `groupId`, so the link needs no new server field.

Red comes from a class in `styles.css`, following whatever the existing `.error` and `.badge` rules do; do not inline a colour.

- [ ] **Step 4: Verify**

```
npm run check
```

Then read the two flows end to end and confirm: a failed download on the Downloads tab links to the Picks tab, lands on the right card, and that card is at the top with its failed release marked `Failed` and its alternatives showing `Pick`.

---

---

### Task 3: Going with a different version actually finishes

**Files:**
- Modify: `packages/core/src/pipeline/pick.ts`
- Modify: `packages/core/src/db/groups.ts`
- Test: extend `packages/core/test/pipeline/pick.test.ts` and `packages/core/test/db/groups.test.ts`

The owner settled the semantics: *"a failed download should not release the pick, the user still wants the content, it's still picked, just need to go with a different version."* Tasks 1 and 2 make the group findable. This makes the act of choosing the alternative behave.

Traced against the real case before writing this — own nothing, pick the 2160p, it fails, pick the 1080p instead:

```
picking the 1080p records kind = "upgrade"
after it imports:  picked = 1080p,  upgrade = 2160p   ← the one that failed with 92 blocks short
```

Two defects, one each.

#### 3a. `kind` is decided by group state, not by whether anything is on disk

`pick.ts` reads `group.state === 'picked' ? 'upgrade' : 'initial'`. An upgrade means *replace the file you have*: it defers moving the pick until import, and on import it trashes the superseded file. With a failed download there is no file, so neither behaviour is wanted — the pick should move immediately, as an ordinary acquisition.

Decide it by what is actually on disk: `liveFilesForGroup(db, groupId).length > 0`. Real upgrades — files present, better release — are unaffected, and deliberately choosing a *lower* release while holding a file stays an upgrade, because it does replace that file.

Note one behaviour this changes beyond the failed case: picking a second release while the first is still downloading is now `initial` rather than `upgrade`, so the pick moves at once instead of at import. Both orderings are odd states; the new one at least matches what the user just asked for. Say so in the comment.

#### 3b. A release whose download failed is offered as an upgrade forever

`deriveUpgradeReleaseId` (`groups.ts:105`) picks the highest-scoring release beating the pick, with no regard for whether that release has already failed. So after 3a the group returns to Browse advertising an upgrade to the release that just failed; taking it fails again; it never stops.

Exclude releases whose **most recent** download failed — the same predicate Task 1 built for the picked release, generalised to any release. Most recent, so a retry that succeeds makes the release eligible again on its own.

Task 1 put that predicate in a module-private SQL constant. **Do not write a third copy.** Make it a function of the release-id expression and use it in both places; a rule spelled out twice is how this codebase produced its last Critical.

What this deliberately does *not* do: hide the failed release. It stays on the card with a Pick button, so retrying is one click. It merely stops being *advertised*. And the group does not vanish — it is `picked`, so it lives on the Picks tab, which is where a scene you own belongs.

- [ ] **Step 1: Write the failing tests**

For 3a, one `test()` each: a group with no live files records `initial` even when `state = 'picked'`, and `markPicked` moves the pick immediately; a group with live files records `upgrade` and leaves the pick until import; a brand-new group is unchanged.

For 3b: a better release whose latest download failed is not flagged; the same release after a retry that succeeded *is* flagged again; a better release with no downloads is flagged as before; a failed release that is not better than the pick changes nothing.

Then the end-to-end one that motivated the task: own nothing, pick the best, fail it, pick the lesser, import it — and assert the group ends with the lesser as its pick and **no** upgrade flag.

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/pipeline/pick.test.ts
```

- [ ] **Step 3: Implement, then verify**

```
npm run check
```

---

## Notes for the controller

- Tasks 1 and 2 do **not** change what a pick means: the group stays `picked` and stays off Browse, it is merely findable. Task 3 changes what *choosing an alternative* does, which the owner asked for explicitly.
- Nothing commits. Snapshot each task with `git stash create`.
