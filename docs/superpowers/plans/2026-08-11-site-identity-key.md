# Site identity key — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the identity key moving when a site's spelling is learned, and merge the groups that have already been split by it.

**Tech Stack:** Node 24, TypeScript 7 (`tsgo`, typecheck only), `node:sqlite`, `node:test` + tsx, oxlint.

## The defect

Reported from a live instance. `TouchMyWife.25.02.07.Anna.Claire.Clouds...` arrived as a 2160p, was picked, and its 1080p and 720p never joined the group. Reproduced:

```
before the site is confirmed          → touchmywife:2025-02-07:anna-claire-…
after learnSites adds 'Touch My Wife' → touch-my-wife:2025-02-07:anna-claire-…
```

Site *matching* compares alphanumerics only (`siteComparisonKey`, `parse.ts:992`), so `TouchMyWife` and `Touch My Wife` are the same site. The identity key's site segment uses `slug` (`parse.ts:841`), which keeps separators as `-`. **The two spellings match as one site and key as two.** `learnSites` grows the site list at runtime from ThePornDB, so any site confirmed after its first release has already been ingested splits its scenes in half — silently, with no human involved.

This is the root cause behind #39, which recorded it as a manual-edit hazard. It is worse than that: it is a collation bug in the ingest path.

## The fix

**The key's site segment becomes the separator-free form** — exactly what matching already uses. Then no spelling of a site can key differently from any other, and learning a site later cannot move a key.

### Rendered paths must not change

`path-template.ts` derives `{site}`, `{Site}` and `{SiteName}` from the key's site segment by splitting on `-`. Strip the hyphens and those collapse to a run-together word: `Touch My Wife` becomes `Touchmywife`, and every library using a non-default template silently relocates.

So those three placeholders move to reading `display.subtitle`, which is the canonical site name and produces **exactly what they render today**. This is safe despite `path-template.ts`'s standing rule that values come from the key and never from display strings: `planImport` is handed a `ParsedRelease` whose `display` comes from the **group** (`pipeline/import.ts`), not from the release, so every release in a group renders one path. The rule exists to stop per-release variation reaching the path, and this does not reintroduce it.

`{sitename}` keeps reading the key. Its documented meaning is the run-together form, which is now exactly the key's segment.

### Migration

Every group whose site segment contains `-` is re-keyed. Where that collides with an existing group — which is the reported bug, already split — the two are merged.

## Global Constraints

- **Do not commit.** Leave work in the working tree; the repo owner approves every commit.
- Node 24 is not the shell default: `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.
- **Verify with `npm run check`** (lint + typecheck + test). `npm run build` runs no typechecker.
- Baseline: 549 server / 62 web, all green.
- Never use `any`. tsconfig sets `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`.
- Comments explain *why*.
- When a test claims to pin a property, mutate the source to break it and confirm the test fails. Report the evidence.

---

### Task 1: The key stops carrying separators

**Files:**
- Modify: `packages/plugin-scenes/src/parse.ts`
- Modify: `packages/plugin-scenes/src/path-template.ts`
- Modify: fixtures across `packages/plugin-scenes/test/` and `packages/core/test/` as needed
- Test: `packages/plugin-scenes/test/site-key.test.ts` (create)

A probe of the one-line change failed 20 plugin-scenes tests and 2 core tests. Most are fixtures asserting the old key. **Read each failure before changing it** — a fixture asserting `bang-bros:…` is expected to become `bangbros:…`, but a failure anywhere else is a finding.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-scenes/test/site-key.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneRelease } from '../src/parse.ts';

const NAME = 'TouchMyWife.25.02.07.Anna.Claire.Clouds.Wife.Makes.Dirty.Video.For.Hubby.XXX.2160p.MP4-VSEX';

test('learning a site later does not move the key', () => {
  // The reported bug: the 2160p arrived before ThePornDB confirmed the site and
  // the 1080p after, so they keyed differently and never collated.
  const before = parseSceneRelease(NAME, { sites: [] });
  const after = parseSceneRelease(NAME, { sites: ['Touch My Wife'] });
  assert.ok(before !== null && after !== null);
  assert.equal(after.identityKey, before.identityKey);
});

test('every spelling of one site produces one key', () => {
  // The same set `siteComparisonKey` already treats as one site.
  const keys = new Set(
    ['Touch My Wife', 'TouchMyWife', 'touchmywife', 'Touch.My.Wife', 'TOUCH-MY-WIFE'].map(
      (site) => parseSceneRelease(NAME, { sites: [site] })?.identityKey,
    ),
  );
  assert.equal(keys.size, 1, [...keys].join(' | '));
});

test('the canonical spelling still reaches the display', () => {
  // Only the key loses the separators. What the user sees, and what the path
  // template renders, is the site's real name.
  const parsed = parseSceneRelease(NAME, { sites: ['Touch My Wife'] });
  assert.equal(parsed?.display.subtitle, 'Touch My Wife');
  assert.ok(parsed?.identityKey.startsWith('touchmywife:'));
});
```

- [ ] **Step 2: Run it and watch it fail**

```
node --import tsx --conditions development --test packages/plugin-scenes/test/site-key.test.ts
```

- [ ] **Step 3: Change the key**

`parse.ts:841` builds the site segment with `slug(site)`. Use the separator-free form instead — export `siteComparisonKey` (currently private at `:992`) and call it, rather than writing a second expression that strips hyphens. Two spellings of the same rule is what caused this bug in the first place.

Update `buildRelease`'s doc comment to say why the site segment is spelled differently from the scene segment: the site's *name* is mutable — learned from a metadata service, or edited in config — while its identity must not be, so the key holds the form that every spelling collapses to.

- [ ] **Step 4: Keep rendered paths where they are**

In `path-template.ts`, `site`, `Site` and `SiteName` read `media.display.subtitle` (falling back to the key's segment when there is no subtitle — it is optional on `DisplayFields`). `sitename` continues to read the key.

Add a test asserting the default template's output for a multi-word site is **byte-identical before and after this change** — that is the property that keeps existing libraries in place, and it should be pinned rather than believed.

- [ ] **Step 5: Fix the fixtures, reading each one**

Then verify:

```
npm run check
```

---

### Task 2: Migration 4 — re-key existing groups, merging what collides

**Files:**
- Modify: `packages/core/src/db/migrations.ts`
- Test: `packages/core/test/db/migrate.test.ts` (extend)

**Spec:** this is the destructive half. It deletes `media_groups` rows. Everything below is about not losing anything while doing it.

The rule: for each group, `newKey` is its key with the separators removed **from the first segment only**. Group all old keys by their `newKey` and process each cluster.

- **A cluster of one** → `UPDATE media_groups SET identity_key = ?`.
- **A cluster of more than one** → merge into a survivor and delete the rest.

**Choosing the survivor**, in order: the group with `imported_files` rows (its name is on files that exist on disk); else the group with `downloads` rows; else the lowest id, which is the oldest. The survivor keeps its own `display` and `search_text` — the same rule `editGroup`'s merge follows, and for the same reason.

**Moving everything that references the losers:** `releases.group_id`, `downloads.group_id`, `imported_files.group_id`. All three, or the merge orphans rows against `PRAGMA foreign_keys = ON`. Move before deleting.

**Picks.** If the survivor has `picked_release_id` set, keep it. If it does not and a loser did, adopt the loser's — that release now belongs to the survivor, and dropping the pick would tell the user they no longer own a file they do. If two groups both have a pick, keep the survivor's and leave the other release as an ordinary member; note that in a `log` line if the migration has one, because it is the one case where information is discarded.

**The upgrade flag** must be re-derived after the move, not carried over: it names a release id, and which release is the best now depends on the merged set. `deriveUpgradeReleaseId` lives in `groups.ts`; importing application code into a migration risks a cycle and couples a historical migration to code that will keep changing. **Write the derivation as SQL in the migration.** A migration must keep doing what it did the day it was written even after the helpers move on.

- [ ] **Step 1: Write the failing tests**

Extend `packages/core/test/db/migrate.test.ts`, building each database with `migrations.slice(0, 3)` and then running `migrate` — the pattern already there for migrations 2 and 3:

1. A lone group with a hyphenated site is re-keyed, and its releases, downloads and imported files still point at it.
2. **The reported case**: `touch-my-wife:D:S` and `touchmywife:D:S` merge into one group holding all three releases.
3. The survivor is the group with imported files, even when it is the higher id.
4. The survivor is the group with a download when neither has imported files.
5. The survivor is the oldest when neither has either.
6. A loser's `downloads` and `imported_files` rows are repointed, not orphaned or deleted.
7. The survivor with no pick adopts the loser's.
8. The upgrade flag after a merge names the best release that beats the pick, out of the combined set.
9. A group whose site segment has no separators is untouched — same key, same row.
10. Three groups collapsing to one key all merge.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Write the migration**

- [ ] **Step 4: Verify against a copy of a real database**

Ask the controller for a copy of the reporting instance's database. Run the migration against it and report: rows before and after, how many groups were re-keyed, how many merged, and — the number that matters — that no `releases`, `downloads` or `imported_files` row was lost or left pointing at a deleted group.

- [ ] **Step 5: Verify**

```
npm run check
```

---

### Task 3: The manual-edit residual disappears

**Files:**
- Modify: `packages/plugin-scenes/src/manual.ts`
- Modify: `packages/plugin-scenes/test/manual.test.ts`
- Modify: `docs/known-issues.md`

`sceneToManualValues` carries `siteForKeySegment`, a two-probe check added because no value of the site field could reproduce a key whose site segment disagreed with `canonicalSiteName`'s answer. With the key holding the separator-free form, `siteComparisonKey(canonicalSiteName(anything in the class))` **is** the key's segment, so the disagreement it guards against can no longer arise.

- [ ] **Step 1: Prove it is unreachable before deleting it**

Do not simply remove the branch. First write a test that drives `sceneToManualValues` with the exact case that motivated it — a release parsed with `sites: []` whose group is later read back with `sites: ['Touch My Wife']` — and assert the round trip preserves the key. Then confirm the fallback branch is never taken, by instrumenting or by asserting the emitted `site` value is the display spelling rather than a key-derived one.

- [ ] **Step 2: Simplify**

Remove what is genuinely dead. Keep the *title* check — `titleForSceneSlug` guards a different lossiness and is unaffected.

- [ ] **Step 3: Update the record**

`docs/known-issues.md` has a "Manual metadata" section describing this residual as irreducible, and issue #39 says the same. Both are now wrong. Rewrite the entry to say what was actually done and why it worked, and leave a note that #39 should be closed by this branch.

- [ ] **Step 4: Verify**

```
npm run check
```

---

## Notes for the controller

- Task 1 changes every scene's key for multi-word sites. Task 2 is what makes that safe for an existing database. They must land together; neither is shippable alone.
- Task 2 Step 4 needs a copy of the reporting instance's database. Ask for it before dispatching.
- Nothing here commits. Snapshot each task with `git stash create` and diff consecutive snapshots.
