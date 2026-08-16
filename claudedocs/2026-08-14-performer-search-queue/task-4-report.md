# Task 4 Report: The match rule, on its own

## What was implemented

- `packages/core/src/pipeline/pick-performer.ts` — the pure `pickPerformer(query, results): MetadataPerformer | null` function, tiered name-then-alias matching, exactly as specified in the brief, with one necessary fix to `normalise` (see "Deviation from the brief" below).
- `packages/core/test/pipeline/pick-performer.test.ts` — the 9 tests given verbatim in Step 1 of the brief.

No database, no client, no clock. Only imports are `MetadataPerformer` from `@pickarr/plugin-api` and `PerformerSearchResult` from `../clients/theporndb.ts`.

## Deviation from the brief: `normalise` had to change

The brief's Step 3 code for `normalise` was:

```ts
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
```

This does not pass the brief's own test (`'comparison ignores case, punctuation and whitespace runs'`, specifically the `"Katie ONeil"` vs `"Katie O'Neil"` case). Tracing it:

- `normalise("Katie ONeil")` → `"katie oneil"` (no punctuation to touch)
- `normalise("Katie O'Neil")` → apostrophe replaced with a space → `"katie o neil"`

These are different strings, so the exact-match test fails. The doc comment's own stated intent — "`ONeil` ... `O'Neil` ... Both are the same claim about the same person" — requires the apostrophe to be *removed*, not turned into a word-separating space, while hyphens and existing spaces still need to fold to one separator (for the `Anne Marie`/`Anne-Marie` case).

I implemented this by stripping apostrophes before the general punctuation-to-space fold:

```ts
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
```

I kept the doc comment text exactly as given — it states the conceptual bar ("spelled the same, punctuated differently"), not a literal regex, so it did not need to change. I did not touch anything else the brief specified.

## TDD evidence

### RED

Command:
```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts
```

Output (before `pick-performer.ts` existed):
```
node:internal/modules/esm/resolve:271
    throw new ERR_MODULE_NOT_FOUND(
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/core/src/pipeline/pick-performer.ts' imported from '.../packages/core/test/pipeline/pick-performer.test.ts'
...
✖ packages/core/test/pipeline/pick-performer.test.ts (334.541268ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Expected: the test file imports `pickPerformer` from a file that doesn't exist yet, so the whole suite fails to even load. This confirms the tests were written before the implementation (Step 1 → Step 2 order followed).

### GREEN

After creating `pick-performer.ts` per Step 3 (with the `normalise` fix described above):

Command:
```
node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts
```

Output:
```
✔ one exact name match is linked (2.649699ms)
✔ an alias-only match is linked, because that is what filenames carry (0.378052ms)
✔ a name match beats another candidate alias match (0.284004ms)
✔ two exact name matches link nothing and do not fall through to aliases (0.299941ms)
✔ two alias matches link nothing (0.304084ms)
✔ no match links nothing (0.259977ms)
✔ one candidate matching by both name and alias is a single tier-one hit (0.247553ms)
✔ comparison ignores case, punctuation and whitespace runs (0.303147ms)  [after the normalise fix]
✔ normalisation does not collapse two genuinely different people into a tie (0.339964ms)
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

(Note: on the first GREEN attempt, before fixing `normalise`, 8/9 passed and `'comparison ignores case, punctuation and whitespace runs'` failed with `actual: undefined, expected: "Katie O'Neil"` — this is the bug documented above. The output shown here is after the fix.)

### Full suite (`npm run check`)

Command:
```
npm run check
```
Result: exit code 0. `oxlint` clean for the new files (all warnings present are pre-existing `preserve-caught-error` warnings in unrelated files: `theporndb.ts`, `import.ts`, `upgrade.ts`, `registry.ts`, `config/load.ts`). Typecheck clean across all workspaces. Tests:
```
ℹ tests 861
ℹ pass 861
ℹ fail 0
```
(core) and
```
ℹ tests 165
ℹ pass 165
ℹ fail 0
```
(web). 861 = 852 baseline + 9 new, matching the expected count exactly.

## Step 5: mutation evidence

All three mutations were applied to `packages/core/src/pipeline/pick-performer.ts`, run individually, and reverted before moving to the next. Working tree was confirmed clean (`git status`) with only the two new files staged for commit, at the end.

### Mutation 1: let `byName.length > 1` fall through to the alias tier

Change: removed `if (byName.length > 1) return null;` entirely (so a tie at the name tier falls into the alias filter below instead of returning immediately).

Command: `node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts`

Result: 8/9 pass, 1 fail.
```
✖ two exact name matches link nothing and do not fall through to aliases (5.378617ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + { ... name: 'Someone Else', ... }
  - null
```
This is exactly the named test the mutation targets: with the two "Jessica Jaymes" name-ties no longer short-circuiting, the alias tier found the third candidate ("Someone Else") whose alias matches, and wrongly returned it instead of `null`. Reverted, re-ran: 9/9 pass.

### Mutation 2: change `byAlias.length === 1` to `byAlias.length >= 1`

Command: `node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts`

Result: 8/9 pass, 1 fail.
```
✖ two alias matches link nothing (4.89507ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + { ... name: 'Jessica Jaymes', ... }
  - null
```
Exactly the named test: with two alias matches now accepted (`>= 1`), the first candidate ("Jessica Jaymes") was wrongly returned instead of `null`. Reverted, re-ran: 9/9 pass.

### Mutation 3: add `.replace(/\s+/g, '')` to `normalise`

Command: `node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts`

Result: **9/9 pass — the mutation did NOT reproduce the brief's claimed failure.**

Root cause, verified directly:
```
normalise('Anna Bell')  → "annabell"   (8 chars)
normalise('Annabelle')  → "annabelle"  (9 chars)
```
Stripping all whitespace after the punctuation fold does not make these two strings equal, because the two names differ in spelling beyond the space — `Bell` (double-l) vs `belle` (double-l plus a trailing `e`) — not merely in how the words are separated. So `'normalisation does not collapse two genuinely different people into a tie'` still passes under this mutation, contradicting the brief's Step 5 claim that it "must fail."

This is a real discrepancy in the brief, verified empirically (see the raw `node -e` check in my work), not a mistake in my mutation — I applied `.replace(/\s+/g, '')` exactly as specified, in the position specified (end of the chain). I'm reporting it rather than silently substituting a different mutation to make the brief's claim true, since inventing a "better" mutation would misrepresent what Step 5 actually asked me to prove.

The mutation was reverted regardless (back to the fixed `normalise` without the extra `.replace`), and the full suite re-confirmed green: 9/9 in the focused file.

### Confirmation of final state

After all three mutations were reverted:
```
node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts
→ 9/9 pass
```
```
npm run check
→ exit 0, 861/861 core, 165/165 web
```
```
git status → nothing to commit, working tree clean
git diff HEAD -- packages/core/src/pipeline/pick-performer.ts → (empty, matches committed state)
```

## Files changed

- `/home/chad/Projects/pickarr/worktrees/performer-search-queue/packages/core/src/pipeline/pick-performer.ts` (new)
- `/home/chad/Projects/pickarr/worktrees/performer-search-queue/packages/core/test/pipeline/pick-performer.test.ts` (new)

Commit: `84acf52` — "Decide a performer match by name first, alias second, nothing on doubt"

## Self-review findings

- Completeness: all 6 brief steps followed in order (tests written first, watched fail, implemented, re-run, three mutations proven and reverted, committed).
- Quality: pure function, no I/O, two-space indent, semicolons throughout, `.ts` extensions on relative imports, no `any` or `unknown`, doc comments kept verbatim as the brief instructed (they argue the "why", not the "what"). Optional-property discipline (`exactOptionalPropertyTypes`) not implicated here — `pickPerformer` returns `MetadataPerformer | null`, no optional fields constructed.
- Discipline: did not add a reason code, result object, thrown error, or log for unreadable input, per the explicit scope boundary in the task instructions — `pickPerformer`'s signature and behavior match exactly what tasks 5/6 expect.
- Testing: the 9 tests are the brief's own, verifying behavior (tiering, ties, normalisation bounds) rather than restating the implementation. Test output is pristine — no warnings, no stray console output, in both the focused run and the full `npm run check`.

## Concerns

1. **`normalise` bug in the brief's own Step 3 code**: the literal code given does not pass the literal test given (`"Katie ONeil"` vs `"Katie O'Neil"`). I fixed it by stripping apostrophes rather than converting them to a separator, which is the minimal change consistent with the doc comment's own stated intent. Confirmed by the coordinator — deviation stands, no further action.
2. **Step 5's original mutation 3 did not reproduce the claimed failure** (see the fix report below for the corrected mutation and its result). Resolved.

## Fix report: corrected Step 5 mutation 3

The coordinator confirmed both concerns above and supplied a corrected mutation 3 — one that is aggressive in exactly the way `normalise`'s doc comment warns against (stripping whitespace *and* dropping a trailing `e`), which does collapse `Anna Bell` and `Annabelle` into the same string. This is evidence only: no commit was made or amended; `pick-performer.ts` is back to its committed state and the working tree is clean.

### Corrected mutation

Applied to `packages/core/src/pipeline/pick-performer.ts`:

```ts
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '')
    .replace(/e$/, '');
}
```

### Command and actual output

```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts
```

```
✔ one exact name match is linked (2.303831ms)
✔ an alias-only match is linked, because that is what filenames carry (0.379759ms)
✔ a name match beats another candidate alias match (0.30527ms)
✔ two exact name matches link nothing and do not fall through to aliases (0.281823ms)
✔ two alias matches link nothing (0.286759ms)
✔ no match links nothing (0.253258ms)
✔ one candidate matching by both name and alias is a single tier-one hit (0.244833ms)
✔ comparison ignores case, punctuation and whitespace runs (0.280413ms)
✖ normalisation does not collapse two genuinely different people into a tie (4.26154ms)
ℹ tests 9
ℹ pass 8
ℹ fail 1

✖ failing tests:

test at packages/core/test/pipeline/pick-performer.test.ts:1:2267
✖ normalisation does not collapse two genuinely different people into a tie (4.26154ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + undefined
  - 'Anna Bell'
```

### Which test failed, and confirmation it's isolated

Only `'normalisation does not collapse two genuinely different people into a tie'` failed (8/9 pass, 1 fail — visible directly in the output above). No other named test was affected. This matches expectation: `normalise('Anna Bell')` → `"annabell"` and `normalise('Annabelle')` → `"annabell"` are now identical strings under this mutation (`annabelle` loses its trailing `e` to become `annabell`, matching `Anna Bell` with its spaces stripped), so `pickPerformer` sees two name-tier candidates instead of one and correctly-for-the-mutation returns `null` — which the test (expecting `'Anna Bell'`) reports as `undefined`/`picked?.name`.

### Revert and clean-tree confirmation

Reverted `normalise` to the committed version (dropped the two added `.replace` calls). Re-ran:

```
node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts
```
```
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

```
git status
```
```
nothing to commit, working tree clean
```

```
git diff HEAD -- packages/core/src/pipeline/pick-performer.ts
```
(empty output — file matches the committed `84acf52` state exactly)

No commit was created or amended for this fix report; it is evidence only, as instructed.
3. Per the task's explicit scope boundary, I did not address Task 3's silently-dropped-result observation (missing slug/uuid on a search result) — noting only that it is still an open item for whoever owns that follow-up, as instructed.

## Fix report: doc comment for `normalise` — explain the apostrophe/hyphen asymmetry

The Task 4 review came back Spec ✅ / Approved with one Important finding: the doc comment for `normalise` lumped apostrophe-handling in with hyphen-handling ("punctuation that separates words ... `ONeil` where it writes `O'Neil`"), but the code treats them differently — hyphens fold to a separating space via the general regex, while apostrophes are elided outright by a line added specifically to fix the brief's bug (see the first fix report above). The comment didn't explain the asymmetry, so a future reader could "simplify" by deleting the apostrophe-strip line as apparently redundant and silently reintroduce the `Katie O'Neil`/`Katie ONeil` bug.

### What changed

Rewrote the `normalise` doc comment in `packages/core/src/pipeline/pick-performer.ts` to give the apostrophe rule its own paragraph, distinct from the hyphen-folding paragraph, arguing:
- A hyphen sits *between* two words (`Anne-Marie` renders `Anne Marie`), so folding it to a space is what makes the two compare equal.
- An apostrophe sits *inside* one word (`O'Neil` is one word; a title routinely drops the mark to write `ONeil`), so folding it to a space instead would split the word into two tokens (`o neil`) that would never match a spelling with none.
- The elision has to run *before* the general punctuation fold, or the hyphen rule would already have turned the apostrophe into a space by the time the elision ran.
- Explicitly states the regression that removing this line would cause (`Katie O'Neil` stops matching `Katie ONeil`), so the line doesn't read as redundant beside the fold that follows it.

Kept the existing "deliberately not aggressive beyond that" paragraph about over-normalising verbatim — the review said it's still load-bearing and correct, and I made no change to it. No code lines changed — this is comment-only, confirmed by `git diff` (see below).

### Explicitly not touched

Per the coordinator's instruction, I did not act on either Minor finding from the review: the ASCII-only apostrophe match (`/'/g`, no U+2019 handling) and the unreachable-but-harmless `?? null` fallbacks. Both are deferred to the whole-branch review.

### Covering tests and commands run

Focused test file, to confirm the comment-only change moved no test behaviour:
```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts
```
```
✔ one exact name match is linked
✔ an alias-only match is linked, because that is what filenames carry
✔ a name match beats another candidate alias match
✔ two exact name matches link nothing and do not fall through to aliases
✔ two alias matches link nothing
✔ no match links nothing
✔ one candidate matching by both name and alias is a single tier-one hit
✔ comparison ignores case, punctuation and whitespace runs
✔ normalisation does not collapse two genuinely different people into a tie
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

Full check, to confirm the baseline counts and no new lint warning on the touched lines:
```
npm run check
```
Result: exit code 0.
```
ℹ tests 861
ℹ pass 861
ℹ fail 0
```
(core), and
```
ℹ tests 165
ℹ pass 165
ℹ fail 0
```
(web). `grep -n "pick-performer" /tmp/check-commentfix.log` against the full `npm run check` output returned no matches — no oxlint warning was raised anywhere in `pick-performer.ts`, including the touched comment lines.

### Diff confirmation (comment-only)

```
git diff packages/core/src/pipeline/pick-performer.ts
```
showed only the JSDoc block for `normalise` changed (4 lines removed, 19 added, all comment text); the `function normalise(...)` body and every line of `pickPerformer` are byte-for-byte unchanged.

### Commit

```
git add packages/core/src/pipeline/pick-performer.ts
git commit -m "Explain why an apostrophe is elided and a hyphen is folded, not both alike"
```
Commit: `658d9a2` — "Explain why an apostrophe is elided and a hyphen is folded, not both alike". `git status` after commit: `nothing to commit, working tree clean`.
