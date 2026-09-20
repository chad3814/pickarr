# Path mappings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan
> task-by-task.

**Goal:** Give `filepath_mapping` its first production writer, so the
translation `deliverCompleted` already performs can be configured.

**Architecture:** `POST`/`PATCH`/`DELETE /api/mappings` → host
capabilities returning refusals as values → rows → replicated → a list
inside each download client's row on `/settings`, with add, edit and
remove.

**Tech Stack:** node:sqlite, node:test, React 19, Testing Library,
Playwright.

**Spec:** `docs/superpowers/specs/2026-09-20-path-mappings-design.md`

## Global Constraints

- **Never the `any` type.** Not in source, not in tests, not behind a
  cast. The last two slices shipped cast-free; keep it that way.
- **No cast to silence a type error** — if one seems needed the types
  are wrong; say so in your report.
- **No credential in any message, log, response body or column.**
- **Paths:** this slice deliberately puts operator-typed paths in the
  replica (spec §5) and nothing else. `storage_path` and `last_error`
  stay excluded, permanently. Do not widen anything else.
- **A refusal is distinguishable without parsing prose.** Codes in
  `@pickarr/contract`, one definition both sides derive from; the
  client owns every sentence a human reads.
- **Lists come from the replica only.** No refetch after a write.
- **The client never reads, stores or forwards a session token** —
  `credentials: 'same-origin'`.
- Prefer the async form of an API over its synchronous twin.
- `afterEach(cleanup)`, never a per-test `cleanup()`; never hand a live
  DOM element to `node:assert`.

### Four warnings this repo has earned

**A comment that states a *reason* is where this codebase's defects
live.** Nineteen false justification comments across three slices, six
in text the controller wrote. **This plan gets no presumption of
truth.** Construct the case a justifying comment calls impossible
before committing it.

**A sweep's rejections are unreviewed by construction.** It hid a
Critical last slice. The mechanism, measured: a sweep filters by
cost-to-verify, so the lines it skips are the ones whose premises live
in *another module*. Run `git log -L` on every hit you decide to leave.

**Two requirements can each be true and jointly impossible.** Last
slice an unconditional `finally` and "stay pending until the row
arrives" were both mandated; the contradiction lived in the gap and
survived four tasks and three reviews, because every seat checked its
own instruction and none checked the pair. If two things you were told
cannot both hold, say so.

**A change to a resolution rule invalidates every invariant keyed on
the resolved value.** That is how a random client draw silently broke
duplicate detection. This slice adds a unique index; ask what else
assumes `from_path` can repeat.

### Verification standard

**Every test verified by mutation, not inspection.** A mutant that
makes code *crash* proves nothing — wrong but runnable. Restore by
checksum-verified copy-aside (`cp` aside, `cp` back, `shasum -a 256
-c`), never `git checkout`/`restore`/`stash`/`clean`.

Test names are the least reliable evidence of what a test checks —
three times last slice a "the title overreaches" observation was
hiding a test that could not fail at all.

### The gate

Each step **separately, branching on its exit code**. Never pipe a gate
command into a grep for a count — a grep for a number cannot fail.

```bash
for s in lint typecheck test-hygiene build; do
  if npm run "$s" > /tmp/g-$s.txt 2>&1; then echo "PASS $s"; else echo "FAIL $s"; fi
done
```

Then `npm run test:server`, `npm run test:web`, `npm run e2e`
separately.

**Baseline, measured on this worktree at `9865d4b`:** lint **110
warnings / 0 errors**, 0 in `packages/{contract,host,web,e2e}`;
typecheck/test-hygiene/build PASS; `test:server` **2441**; `test:web`
**170**; e2e **14**.

Lint must stay 110/0. Suites grow only by the tests you add. Report
measured numbers with the arithmetic. `test:web` takes
`packages/web/test/**/*.test.tsx` — **`.tsx` only**.

**This plan cites precedent by file and line rather than transcribing
code.** Deliberate: plan-authored code and comments have been the
largest single defect source across three slices. Requirements, names,
types and invariants are exact; shapes that must match existing code
are cited so you read the real thing.

---

## File structure

- `packages/host/src/db/migrate.ts` — migration 19.
- `packages/host/src/sync/tables.ts` — the projection, and two stale
  claims.
- `packages/contract/src/mappings.ts` — refusal codes. New.
- `packages/host/src/clients/mappings.ts` — the three capabilities. New.
- `packages/host/src/host.ts`, `api/server.ts`, `main.ts`.
- `packages/web/src/settings/ClientMappings.tsx`,
  `useClientMappings.ts`, `postMapping.ts` — new.
- `packages/web/src/settings/DownloadClients.tsx` — the expander.
- `packages/web/src/styles/settings.css`,
  `packages/e2e/tests/shell.spec.ts`.

---

## Task 1: Migration 19, and the table joins the replica

**Files:** `db/migrate.ts`, `sync/tables.ts`, `contract/src/sync.ts`,
and their tests.

**Read first:** migration 17 (`rss_feed`'s sibling — `download_client`
joining the synced set) and `sync/tables.ts`'s top docblock. Migration
18 is the highest that exists.

- [ ] **Step 1: Write the failing tests**

1. `filepath_mapping` has `updated_at`, backfilled from `created_at` for
   rows that predate the migration.
2. A **unique index on `(download_client_id, from_path)`** exists, and
   a second row with the same pair is refused by SQLite.
3. The projection is `id, downloadClientId, fromPath, toPath, createdAt,
   updatedAt` — nothing else.
4. `HOST_SYNCED_TABLES` has nine entries.
5. Migration 19 installs the triggers and seeds existing rows.
6. A **delete** reaches the log as a `delete` op. The trigger already
   exists (`sync/log.ts` emits `AFTER DELETE … OLD.id, 'delete'`); this
   pins that it applies to this table too.

- [ ] **Step 2: Implement, then sweep**

`MIGRATION_15_TABLES` is frozen — read its docblock and leave it alone.

Two statements this falsifies, both cited in the spec:
- `sync/tables.ts` lists `filepath_mapping` among tables that "have no
  consumer". False since `deliver.ts` landed, not since this task.
- any count of the synced tables.

Sweep with `grep -rn "eight" packages/host/src packages/host/test docs/`
and **run `git log -L` on every hit you leave** — a stale count
survived two slices by being skipped twice.

- [ ] **Step 3: Mutation-test**

Drop `filepath_mapping` from `HOST_SYNCED_TABLES` → the bootstrap
assertion reds. Remove the unique index → test 2 reds.

- [ ] **Step 4: Gate and commit**

---

## Task 2: Three host capabilities, and three routes

**Files:** `contract/src/mappings.ts` (new), `contract/src/index.ts`,
`clients/mappings.ts` (new), `host.ts`, `api/server.ts`, `main.ts`,
tests.

**Read first:** `clients/add.ts` and `clients/pick.ts` — your two
siblings. And `paths.ts`'s `mapClientPath` in full: it is the consumer
whose behaviour these writes must not outlaw.

**Interfaces produced:**
`Host.addMapping`, `Host.editMapping`, `Host.removeMapping`, each
returning `{ id } | MappingRefusal` — never throwing.

- [ ] **Step 1: The refusal codes**

`unknown-client`, `duplicate-from-path`, `unknown-mapping`,
`empty-path`. Model the module on `contract/src/download-clients.ts`.

- [ ] **Step 2: Write the failing tests**

One per refusal per applicable route, plus the successes. Specifically:

- `duplicate-from-path` is **caught from the unique index**, never
  pre-checked. Follow `clients/add.ts`'s narrowing.
- **`D:\Downloads` is accepted unchanged** as a `from_path`. §7: these
  are foreign paths and the UI must not be stricter than
  `mapClientPath`, which refuses `node:path` for that reason.
- `empty-path` refuses `''` for either field, and **only** `''`.
- Editing a mapping to a `from_path` another mapping on the same client
  already holds is refused.
- Editing a mapping to its **own current** `from_path` is accepted —
  the index must not refuse a no-op edit.
- `removeMapping` on an id that does not exist refuses
  `unknown-mapping` rather than reporting success.

- [ ] **Step 3: The routes**

`POST /api/mappings` → `201 { id }`, `PATCH /api/mappings/:id` → `200
{ id }`, `DELETE /api/mappings/:id` → `204`.

**`PATCH` and `DELETE` are new methods for this API.** The per-route
`methods` array makes that a one-line addition each. **Do not touch
`refusalFor`'s ordering** — the session check runs before the method
check, and that ordering was its own fix round after an anonymous
caller could distinguish a real path from an invented one by comparing
405 against 401. Pin that `PATCH` and `DELETE` are refused without a
session exactly as `POST` is.

**`:id` is read by segment index, not bound.** `/api/artwork/:kind/
:mediaItemId` is the precedent — the template declares `:name` only for
segment-count matching, and the answer reads `segments[3]`, checks
`DIGITS`, then `Number.isSafeInteger`. Copy that shape; never `!`.

Status mapping: `duplicate-from-path` → 409, `unknown-mapping` and
`unknown-client` → 404, `empty-path` → 422. **Pin every code.**

- [ ] **Step 4: Mutation-test, then commit**

Make a capability throw instead of returning a refusal → a test reds
rather than the suite erroring. Remove the `Number.isSafeInteger` check
→ a test reds.

---

## Task 3: The mappings list inside each client

**Files:** `settings/ClientMappings.tsx`, `useClientMappings.ts`,
`postMapping.ts` (all new), `settings/DownloadClients.tsx`, tests.

**Read first:** `settings/AddDownloadClient.tsx`'s `postDownloadClient`
and `handleSubmit`, and `library/MediaItemCard.tsx` for the expander
shape. Two details in the first cost a fix round each — **inherit
both**:

1. **`postMapping` must never throw.** An unrecognised body returns an
   `unrecognised` outcome. When a sibling threw, the rejection was
   swallowed by `void handleSubmit(event)` and the form wedged.
2. **`finally { setPending(false) }`** on every path that can fail.

- [ ] **Step 1: Write the failing tests**

1. A client's row expands to its mappings, read from the replica.
2. Adding one puts it in the list without a refetch.
3. Editing one updates it in place.
4. Removing one takes it out of the list.
5. **`D:\Downloads` renders unchanged** — no normalisation in the UI.
6. Each refusal reads as its own sentence; an unrecognised code and an
   offline submit read differently again.
7. **The error is legible** — assert `screen.getByText(...)`, never the
   accessible name. `getByRole`'s `name` is satisfied by an
   `aria-label` on an empty element, and that defect shipped once here.
8. Every control re-enables after every outcome, including a rejecting
   `submit`.
9. **Acting on one mapping leaves the others alone** — a shared pending
   or editing flag would pass almost every other test.
10. A client with no mappings says so, rather than rendering an empty
    list with no explanation.

`submit` is a **required** injected prop with no network-performing
default.

- [ ] **Step 2: Implement, then mutation-test**

Collapse every refusal to one sentence → test 6 reds. Error text →
`aria-label` on an empty element → test 7 reds **alone**, in isolation
with `--test-name-pattern`. Share one pending flag → test 9 reds.

- [ ] **Step 3: Gate and commit**

---

## Task 4: Styling, and the browser proof

**Files:** `styles/settings.css`, `e2e/tests/shell.spec.ts`.

- [ ] **Step 1: Style against the tokens**

No raw values outside `tokens.css`; read its docblock first.

- [ ] **Step 2: The browser proof**

Sign in, open `/settings`, expand a client, add a mapping, edit it,
remove it. Plus one computed-style assertion.

**Say accurately what it covers.** The harness builds a real `Host` and
never calls `host.start()`. Work out what that means here and write
down what the spec does and does not exercise — an equivalent comment
two slices ago claimed "the whole slice" and was wrong.

- [ ] **Step 3: Prove the pin, two-sided**

1. Remove the stylesheet import → the assertion reds.
2. Keep the stylesheet, **gut its meaningful rules** → it still reds.

Assert a computed value with exactly **one** plausible producer. See
#90: `list-style-type: none` is produced by any reset, which is why the
equivalent pin survived a gutted stylesheet.

- [ ] **Step 4: Gate and commit**

---

## Self-review

- **Spec coverage:** §5 → Task 1. §6, §7 → Task 2. §8 → Task 3. §9.6 →
  Task 3; §9.7 → Task 2; the rest spread across 1–3. Acceptance 4
  (an edit changes what the next tick resolves) is **Task 2's**, pinned
  against `mapClientPath` rather than asserted.
- **Type consistency:** `MappingRefusalCode` is produced by Task 2 and
  consumed by Tasks 2 and 3, from `@pickarr/contract`, so a rename is a
  compile error on both sides.
- **Ordering:** 1 → 2 → 3 → 4. Task 3 needs both the replica rows and
  the codes; Task 4 needs Task 3's markup.
- **Known risk:** Task 1 adds a unique index to a table that has never
  had one. Per the fourth warning above, ask what assumed `from_path`
  could repeat — `mapClientPath`'s tie-break is the known case and the
  spec says it should become unreachable, not merely unlikely.
