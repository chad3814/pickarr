# Final fix wave — performer search queue

Branch `feature/performer-search-queue`, from `554837c`. Four commits, no push, no new
branch.

| SHA | Subject |
|---|---|
| `22f276c` | Link only a canonical performer, never a site-scoped namesake |
| `54f9ba5` | Share the backoff curve from a leaf module instead of across a cycle |
| `2e63a4a` | Pin the performer search url, and the fifth table a merge must clear |
| `2b0f90c` | Correct two spec statements the code on this branch contradicts |

Every command below was run with `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`
first, from the worktree root unless a `cd` is shown.

## Final state

```
$ npm run check
check exit=0
ℹ tests 895
ℹ pass 895
ℹ fail 0
ℹ tests 165
ℹ pass 165
ℹ fail 0

$ npm run build
build exit=0
```

890 → 895 core (five new tests; two of the seven fixes extended existing tests rather than
adding new ones), 165 → 165 web. Lint warning count is unchanged at 73 — verified by
stashing the whole wave, re-running `npm run check`, and counting `warning eslint` lines
before (73) and after (73). No new errors: `grep -c "error eslint"` is 0.

## Fix 1 — `pickPerformer` never filtered on `kind`

`packages/core/src/pipeline/pick-performer.ts`: one filter added before the tiering,

```ts
const linkable = results.filter((result) => result.performer.kind === 'performer');
```

and both tiers now read `linkable` instead of `results`. The doc comment explains why the
filter is here rather than in `readPerformerPage` (the client reports what the provider
said; which identity is *linkable* is matching policy), why it runs before the tiering
rather than inside each tier (so a `performer-site` entity cannot win tier 2 on an alias
after being excluded from tier 1), and quotes spec §7 for the justification:

> `site_performers` is deliberately not a match source ... names belonging to
> `performer-site` entities, which are a different identity than the one being linked

I opened `docs/superpowers/specs/2026-08-14-performer-search-queue-design.md` and confirmed
that sentence is present verbatim in §7 ("The match rule"). The comment also quotes
`readPerformerFields`' own comment — "every linked performer pointed at an alias page, and
nothing to notice it by" — and I re-read that comment in
`packages/core/src/clients/theporndb.ts` to confirm the wording before quoting it.

`packages/core/test/pipeline/pick-performer.test.ts`: the `result()` helper gained a third
parameter, `kind`, defaulting to `'performer'` so the nine existing tests are unchanged in
behaviour. Its `sourceUuid` is now `uuid-${name}-${kind}` so two same-named entries of
different kinds are distinguishable rows. Two tests added:

- *a canonical performer is linked past the site entries that share its name* — a
  `performer-site`, the canonical `performer`, and a second `performer-site`, all named
  `Alice Maze`. Asserts both `name` and `kind` of the pick. This is the case that returned
  `null` before.
- *a site entry is not linked on its own, by name or by alias* — a lone `performer-site`
  exact name match links nothing, and (second assertion) a lone `performer-site` whose
  *alias* matches also links nothing, which is what pins the filter's position ahead of the
  tiering.

### Mutation evidence

```
$ perl -0pi -e "s/const linkable = results\.filter\(\(result\) => result\.performer\.kind === 'performer'\);/const linkable = results;/" packages/core/src/pipeline/pick-performer.ts
$ cd packages/core && node --test --experimental-strip-types test/pipeline/pick-performer.test.ts
✔ one exact name match is linked (2.376397ms)
✔ an alias-only match is linked, because that is what filenames carry (0.400202ms)
✔ a name match beats another candidate alias match (0.361622ms)
✔ two exact name matches link nothing and do not fall through to aliases (0.365869ms)
✔ two alias matches link nothing (0.370073ms)
✔ no match links nothing (0.294516ms)
✔ one candidate matching by both name and alias is a single tier-one hit (0.279327ms)
✔ comparison ignores case, punctuation and whitespace runs (0.313618ms)
✖ a canonical performer is linked past the site entries that share its name (4.229922ms)
✖ a site entry is not linked on its own, by name or by alias (1.597581ms)
✔ normalisation does not collapse two genuinely different people into a tie (0.30226ms)
ℹ tests 11
ℹ pass 9
ℹ fail 2
```

Exactly the two new tests fail; all nine pre-existing ones — including the two alias-match
tests, which is the specific worry raised — still pass under the mutant and under the fix.
Filter restored from a copy taken before the edit and re-verified: 11/11 pass.

Covering command after restore:

```
$ cd packages/core && node --test --experimental-strip-types test/pipeline/pick-performer.test.ts
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

## Fix 2 — two false statements in the committed spec

Prose only; no section restructured, no other section touched.

**§5.** The sentence "`runMetadataPass` is the only place a metadata row settles, so every
settle path inherits the enqueue by construction" now reads "the only place *the pass*
settles a row, so every settle path within it inherits the enqueue by construction",
followed by two new paragraphs that (a) name `http/server.ts:713-719`'s `answerUnaskable`
as a second settle path that does not enqueue and record the asymmetry as unresolved rather
than argued for, and (b) state that it is currently latent and why.

Every link in the latency chain was opened and checked in this pass:

- `packages/core/src/http/server.ts:713-719` — `metadataAnswerability(plugin, group) ===
  'unaskable'` → `answerUnaskable(db, groupId, now)`, no enqueue. Confirmed.
- `packages/core/src/pipeline/metadata.ts:127-138` — `metadataAnswerability` returns
  `'unaskable'` on a missing plugin, a missing `metadataQuery`/`confirmMetadata`, a `null`
  query, or `queries.length === 0`. Confirmed.
- `packages/plugin-scenes/src/metadata.ts:17-22` — `sceneMetadataQuery` returns `null` only
  when `display.subtitle` is `undefined`/empty or the trimmed `display.title` is empty.
  Confirmed.
- `packages/plugin-scenes/src/parse.ts:848-856` — `buildRelease` does
  `if (siteSlug.length === 0) return refuse('site slug is empty')` and writes
  `subtitle: site`, so no scenes group carries an empty subtitle. Confirmed.
- `packages/plugin-scenes/src/performer-query.ts:30-34` — `scenePerformerQuery` splits the
  trimmed title and returns `null` below two words, so an empty title yields no performer
  query either. Confirmed.

The wording names the reachable case — a future plugin implementing `performerQuery`
without both metadata hooks, where `metadataAnswerability` answers `'unaskable'` on the
missing hooks alone — and does not claim reachability beyond that.

**§9.** "Running after means a row enqueued this tick is searched on the next one" is
replaced with the same-tick statement, checked against
`packages/core/src/db/performer-queue.ts` (`insertPerformerSearch` writes `next_at = now`
via `VALUES (?, ?, 0, ?)` with `now` twice; `duePerformerQueue` selects `next_at <= ?`) and
against `packages/core/src/main.ts:190-195`, whose call-site comment already said the same
thing. The replacement keeps §9's original point about ordering — producer before consumer
— which is the part that was true.

No test covers spec prose. Verified by re-reading the diff and by the sources above.

## Fix 3 — the `searchPerformers` request URL and two unchecked reader claims

`packages/core/test/clients/theporndb.test.ts`, three tests added, following the existing
`respondWith(...).urls` pattern that the `site_id=` tests use:

- *the performer search asks the documented endpoint for a full page, query encoded* —
  asserts the recorded URL starts with `https://api.theporndb.net/performers?`, and contains
  `per_page=100`, `page=1` and `q=Jessica%20Jaymes`. The encoded query is spelled literally
  rather than rebuilt with `encodeURIComponent`, since that is the helper under test. I
  checked the actual output of `encodeURIComponent` before writing the expectation (it does
  *not* escape an apostrophe, so I used a plain two-word name rather than `O'Neil`, which
  would have made the expectation subtly wrong).
- *a non-boolean is_parent is "not stated", not silently truthy* — `1`, `'true'` and `null`
  all read as `'performer-site'`.
- *an empty alias is dropped rather than carried as a matchable empty string* —
  `aliases: ['', 'x', 7, null]` yields `['x']`, which pins both halves of the filter's
  predicate.

```
$ cd packages/core && node --test --experimental-strip-types test/clients/theporndb.test.ts
ℹ tests 59
ℹ pass 59
ℹ fail 0
```

(56 → 59.)

## Fix 4 — the upsert source

`packages/core/src/pipeline/performers.ts`: `recordPerformerOutcome` gained a `source:
string` parameter, passed `client.source` from the already-narrowed `const client` at the
call site, and `upsertPerformers(deps.db, source, [performer], now)` replaces the literal
`'theporndb'`. Its doc comment records why — `source` is half of `performers`' `UNIQUE
(source, source_uuid)`, and `db/metadata.ts:315` writes the client's own `input.source` into
the same column, which I opened and confirmed.

Passing the value as a parameter rather than reading `deps.client.source` inside the helper
is deliberate: `PerformerPassDeps.client` is `PerformerLookupClient | undefined`, so the
helper would have had to re-narrow what the pass already narrowed.

Covered by the existing pass tests (whose double reports `source: 'theporndb'`, so the
assertions are unchanged):

```
$ cd packages/core && node --test --experimental-strip-types test/pipeline/performers-pass.test.ts
ℹ tests 15
ℹ pass 15
ℹ fail 0
```

## Fix 5 — the `performers.ts` ↔ `metadata.ts` cycle

New file `packages/core/src/pipeline/backoff.ts` holding `MAX_BACKOFF_MS` and `backoffFor`.
The existing doc comments are carried over, including the line saying both passes share the
curve, and a paragraph added explaining why it is a module of its own rather than left in
`metadata.ts` — the cycle worked only because both crossings were hoisted `function`
declarations referenced from inside function bodies.

- `packages/core/src/pipeline/metadata.ts` — the two declarations removed, `import
  { backoffFor } from './backoff.ts';` added.
- `packages/core/src/pipeline/performers.ts` — import switched from `./metadata.ts` to
  `./backoff.ts`.

**Importers updated, and the re-export decision.** `grep -rn "backoffFor\|MAX_BACKOFF"
packages/ --include="*.ts"` found exactly one other importer:
`packages/core/test/pipeline/metadata.test.ts`, which imported `MAX_BACKOFF_MS` from
`../../src/pipeline/metadata.ts`. It now imports it from `../../src/pipeline/backoff.ts`.
`backoffFor` had no importer besides the two pipeline modules.

**I did not re-export either symbol from `metadata.ts`.** Nothing outside the package can
reach them — `packages/core/src` has no barrel (`ls packages/core/src/*.ts` is `abort.ts`,
`json.ts`, `main.ts`) and no `index.ts` re-exports the pipeline — so the only consumer that
would have needed a compatibility alias was the one test, which I updated instead. A
re-export left behind would be a second name for the same thing and the next reader would
have to work out which is canonical.

```
$ cd packages/core && node --test --experimental-strip-types test/pipeline/metadata.test.ts
ℹ tests 22
ℹ pass 22
ℹ fail 0
```

## Fix 6 — the no-cascade lifecycle gap

`packages/core/test/manual/operations.test.ts`, both existing tests extended in place rather
than new ones added, since the review asked for these two `editGroup` paths specifically and
they already exist:

- *merging a group that has been browsed does not 500...* — a `performer_queue` row is now
  inserted alongside the `metadata_queue` one, and asserted gone after the merge. The setup
  comment's "all four rows a browse can leave behind" is now five and names both queue rows;
  the assertion comment's "in any of the four tables" is now "five".
- *an identity edit forgets metadata confirmed against the identity it replaced* — a
  `performer_queue` row inserted, and two assertions added: the `group_performers` link is
  gone (it was previously written by the fixture and never checked on this path) and the
  `performer_queue` row is gone. The comment distinguishes why the row matters on this path
  — it is a stale question built from the title being replaced, not a foreign-key hazard,
  since nothing is deleted.

### Mutation evidence

Removing `db.prepare('DELETE FROM performer_queue WHERE group_id = ?').run(groupId);` from
`clearGroupMetadata` in `packages/core/src/db/metadata.ts`:

```
✖ merging a group that has been browsed does not 500, and leaves the target metadata untouched (6.009565ms)
✖ an identity edit forgets metadata confirmed against the identity it replaced (6.697277ms)
ℹ tests 41
ℹ pass 39
ℹ fail 2
```

Exactly the two tests, and nothing else in the file. Restored and re-verified:

```
$ cd packages/core && node --test --experimental-strip-types test/manual/operations.test.ts
ℹ tests 41
ℹ pass 41
ℹ fail 0
```

## Fix 7 — two accuracy items

**`packages/core/src/pipeline/scheduler.ts`.** `metadata pass failed: …` → `metadata tick
failed: …`, with a comment saying why: `runMetadata` is main.ts's composed closure running
the scene pass and then the performer pass, so naming one pass sends an operator to the
wrong code, and the passes' own log lines already name themselves. I grepped for the old
string across `packages/` and `docs/` before changing it — no test and no document asserted
on it.

**`docs/known-issues.md`.** A new paragraph entry at the end of "Test-suite blind spots",
matching that section's bold-lead style (that section's stated purpose is hazards for
whoever writes or runs the next test, which is what this is). It names the two files, the
one-and-two split, the exact error text, the two Node versions, and that `engines.node` says
only `">=24"` so v24.15.0 is a version the repo currently claims to support.

I reproduced both halves before writing it rather than restating the brief:

```
$ node -v
v24.15.0
$ cd packages/core && node --test --experimental-strip-types test/clients/theporndb.test.ts
ℹ tests 56
ℹ pass 54
ℹ fail 2
  TypeError [ERR_INVALID_ARG_VALUE]: The property 'options.apis' option AbortSignal.timeout is not supported. Received 'AbortSignal.timeout'
  TypeError [ERR_INVALID_ARG_VALUE]: The property 'options.apis' option AbortSignal.timeout is not supported. Received 'AbortSignal.timeout'

$ cd packages/core && node --test --experimental-strip-types test/media/artwork.test.ts
ℹ tests 19
ℹ pass 18
ℹ fail 1

$ grep -n '"node"' package.json
6:    "node": ">=24"
```

Two in `theporndb.test.ts`, one in `artwork.test.ts`, three total — as briefed. The entry
notes that raising the floor would settle it and that doing so is a change to the published
contract which has not been made, rather than recommending it as done.

## Things I did not do, and why

- **Nothing from the out-of-scope list was touched.** No shared `requestJson`, no change to
  metadata's 429 attempts bump, no `enqueuePerformerSearch` at `http/server.ts:717`, no
  `main()` testability work, no warning-debt cleanup, no U+2019 widening, no `changes` from
  `removePerformerSearch`, no shared cooldown, no fixture de-duplication.
- **Fix 6 extended two existing tests instead of adding two new ones.** The review asked for
  a merge path and a plain-edit path through `editGroup`; both tests already existed and
  already drove those paths, so a third and fourth test would have duplicated their setup to
  assert one more row. The count is therefore 895 rather than the ~896-897 the brief
  estimated.
- **I did not disagree with any fix as specified.** All seven checked out against the code.

## One observation, deliberately not acted on

Spec §2's out-of-scope bullet for `site_performers` says "See §6", but the `site_performers`
reasoning is in §7 ("The match rule") — §6 is "The client method". That cross-reference is
off by one section and predates this wave. The brief said to change §5 and §9 prose only and
not to alter any other section, so I left it. It is a one-word fix (`§6` → `§7`) if wanted.
