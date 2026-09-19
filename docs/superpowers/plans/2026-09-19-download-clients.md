# Adding download clients — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan
> task-by-task.

**Goal:** Give `download_client` its first production writer — a settings
UI that creates one, storing its credential in the secret store and never
in a row, a log, or a response.

**Architecture:** `POST /api/download-clients` → `Host.addDownloadClient`
→ a `download_client` row plus a `secret` row → `scheduleReconcile`. The
table joins the synced set so the list reads from the replica. Mirrors the
feed-settings slice throughout; §8 of the spec records where it departs.

**Tech Stack:** node:sqlite, node:test, React 19 + react-router, Testing
Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-19-download-clients-design.md`

## Global Constraints

- **Never the `any` type.** Not in source, not in tests, not behind a cast.
- **No cast to silence a type error.** If a cast seems needed the types are
  wrong — say so in your report instead.
- **No credential in any message, log, response body, or database column.**
  The value crosses the wire once, in the request body, and goes to
  `Secrets.saveSecret`. Nothing else may see it.
- **No url, path or credential in any log line.**
- **A refusal is distinguishable without parsing prose.** Codes in
  `@pickarr/contract`, one definition, both sides deriving from it. The
  client owns every sentence a human reads.
- **Lists come from the replica only.** No remote fallback.
- **The client never reads, stores or forwards a session token** —
  `credentials: 'same-origin'`.
- Prefer the async form of an API over its synchronous twin; inside an
  `async` function, `await` it.
- **Commits in this slice are unsigned.** Use
  `git -c commit.gpgsign=false commit`. The repo owner is away; they will
  rebase to sign on return. Do not attempt to sign and do not stop on a
  signing error.

### A warning particular to this repo

**A comment that states a *reason* is where this codebase's bugs live.**
Six false justification comments were found in the previous slice, each
explaining why something was safe or sufficient, each accepted by a reader
because a stated reason invites agreement rather than checking. Plan text
gets no presumption of truth either — including this plan's. When you
write or edit a comment justifying a design choice, construct the case it
claims is impossible before you commit it.

**Every test you write must be verified by mutation**, not by inspection.
Break the thing it covers, watch it red, restore by checksum-verified
copy-aside (`cp` aside, `cp` back, `shasum -a 256 -c`) — never
`git checkout`/`restore`/`stash`/`clean`. A mutant that makes code *crash*
proves nothing; it must be wrong but runnable. In the previous slice a test
named "the error is a visible heading" passed against a heading with no
visible text, because `getByRole`'s `name` reads the accessibility tree.

### The gate

Run each step **separately and branch on its exit code**. Never pipe a gate
command into a grep for a count — a grep for a number cannot fail.

```bash
for s in lint typecheck test-hygiene build; do
  if npm run "$s" > /tmp/g-$s.txt 2>&1; then echo "PASS $s"; else echo "FAIL $s"; fi
done
```

Then `npm run test:server`, `npm run test:web`, `npm run e2e` separately.

**Baseline, measured on this worktree at `3237f2a`:** lint **110 warnings /
0 errors**, 0 in `packages/{contract,host,web,e2e}`; typecheck,
test-hygiene, build PASS; `test:server` **2375**; `test:web` **103**; e2e
**11**.

Lint must stay 110/0. Suites grow only by the tests you add. Report
measured numbers with the arithmetic.

Suite membership is decided by extension: `test:web` takes
`packages/web/test/**/*.test.tsx` — **`.tsx` only**. A `.test.ts` under
`packages/web/test/` runs in `test:server`.

---

## File structure

- `packages/contract/src/download-clients.ts` — refusal codes, one
  definition. Exported from `index.ts` beside `AddFeedRefusalCode`.
- `packages/host/src/clients/add.ts` — `Host.addDownloadClient`.
- `packages/host/src/host.ts` — the capability on the interface.
- `packages/host/src/api/server.ts` — the route.
- `packages/host/src/sync/tables.ts`, `db/migrate.ts` — the projection and
  migration 17.
- `packages/web/src/settings/DownloadClients.tsx`, `AddDownloadClient.tsx`,
  `useDownloadClients.ts` — the screen.
- `packages/web/src/settings/Feeds.tsx` — gains the second section.
- `packages/web/src/styles/settings.css`, `packages/e2e/tests/shell.spec.ts`.

---

## Task 1: The write path, end to end

**Files:**
- Create: `packages/contract/src/download-clients.ts`,
  `packages/host/src/clients/add.ts`
- Modify: `packages/contract/src/index.ts`, `packages/host/src/host.ts`,
  `packages/host/src/api/server.ts`, `packages/host/src/main.ts`
- Test: `packages/host/test/clients/add.test.ts`, and additions to
  `packages/host/test/api/server.test.ts`

**Interfaces:**
- Produces: `Host.addDownloadClient(input: AddDownloadClientInput):
  Promise<{ id: number } | AddDownloadClientRefusal>` and
  `POST /api/download-clients`.
- `AddDownloadClientInput` fields arrive **unvalidated from a JSON body**,
  so every one is a primitive type, never a union — this function is the
  validator. Follow `feeds/add.ts`'s `AddFeedInput`, which types
  `downloadType` as `string` for exactly this reason.

**Read first:** `packages/host/src/feeds/add.ts` in full. This task is its
sibling and should read like it. Also `packages/host/src/clients/config.ts`
lines 60–130 for the row contract, and `packages/host/src/secrets/instance.ts`
for `saveSecret`.

- [ ] **Step 1: The refusal codes**

`packages/contract/src/download-clients.ts`, modelled on
`packages/contract/src/feeds.ts` (read it and match its shape):

```ts
export const ADD_DOWNLOAD_CLIENT_REFUSALS = [
  'unknown-implementation',
  'bad-auth-shape',
  'duplicate-name',
  'bad-url',
] as const;

export type AddDownloadClientRefusalCode = (typeof ADD_DOWNLOAD_CLIENT_REFUSALS)[number];
```

Export the type from `packages/contract/src/index.ts` beside
`AddFeedRefusalCode`.

- [ ] **Step 2: Write the failing tests for `addDownloadClient`**

The cases, each its own test. Derive the expected value yourself before
looking at what the implementation returns:

1. A SABnzbd client with an api key is created; the row's
   `api_key_secret_name` is a name, **not** the key; `saveSecret` was
   called once with that name and the real value.
2. A qBittorrent client with username and password is created; the row's
   `password_secret_name` is a name, `username` is stored plaintext,
   `password` never appears in any column.
3. A qBittorrent client with an api key is created (the bearer strategy).
4. `type` is derived: `sabnzbd` → `nzb`, `qbittorrent` → `torrent`. The
   caller never sends it.
5. An unknown implementation is refused `unknown-implementation`.
6. SABnzbd with username/password instead of an api key is refused
   `bad-auth-shape`. So is qBittorrent with neither, and qBittorrent with
   both.
7. A duplicate name is refused `duplicate-name`, **caught from the real
   constraint violation** on `download_client_name` rather than
   pre-checked. Follow `feeds/add.ts`'s duplicate handling exactly,
   including its cast-free narrowing of the sqlite error.
8. A url that does not parse is refused `bad-url`.
9. **The credential appears in no log line.** Capture the logs, assert the
   secret value is absent from `JSON.stringify(logs)`.
10. `scheduleReconcile` is called with the new id.

- [ ] **Step 3: Run them, watch them fail, implement, run them again**

`saveSecret` is called **before** the row insert (spec §3): an orphaned
secret is harmless, a row referencing a secret that was never stored is
not. Say so in the docblock, and say which ordering was rejected.

The secret name is `randomUUID()`, matching what migration 14 generated
for the credentials it moved.

`import_mode` is a constant — a named one, with a comment recording that
nothing in 2.0 reads the column and that the constant exists only because
it is `NOT NULL`.

- [ ] **Step 4: The route**

`POST /api/download-clients` in `packages/host/src/api/server.ts`, beside
`POST /api/feeds` and shaped exactly like it: `methods: ['POST']`,
`open: false`, a shape-only `isDownloadClientBody` guard, and
`deps.addDownloadClient` as a *function*, not the `Host`.

Status mapping: `duplicate-name` → 409, everything else → 422, matching
`statusForFeedRefusal`'s reasoning. Pin **all four** codes with tests —
the feeds slice shipped two of four unpinned and a review caught it.

Wire it in `main.ts` the way `addFeed` is wired.

- [ ] **Step 5: Mutation-test, then commit**

At minimum: make `addDownloadClient` store the credential in the row
instead of its name, and confirm the "no credential in a column" test
reds. Report the observed failure.

```bash
git -c commit.gpgsign=false commit -m "Add Host.addDownloadClient and POST /api/download-clients"
```

---

## Task 2: `download_client` joins the synced tables

**Files:**
- Modify: `packages/host/src/sync/tables.ts`,
  `packages/host/src/db/migrate.ts`
- Test: `packages/host/test/sync/tables.test.ts`,
  `packages/host/test/db/migrate.test.ts`

**Read first:** how `rss_feed` did this. `sync/tables.ts`'s top docblock
(lines 14–60), its `case 'rss_feed'` (~line 226), and `readHostRows`'s
extra step. Migration 16 is the model for migration 17.

- [ ] **Step 1: Amend the exclusion rule, do not delete it**

`sync/tables.ts`'s docblock currently says, in its "Out, and why" list:

> `download_client` holds a service's address and the names of its secrets.

That sentence becomes false in this task. **Amend it the way the
`rss_feed` paragraph below it was amended** — state what the rule was, what
changed, and what the new guarantee is. Do not simply strike the clause.

The new guarantee is *stronger* than `rss_feed`'s and the docblock should
say so: the secret names are **not projected at all**, and the url is
normalised to `origin + pathname`, which drops userinfo, query and
fragment **structurally**. That is a closed door, not a pattern match —
unlike `redactUrl`, which knows one query parameter and is why issue #78
is open for feeds. Note explicitly that `http://user:pw@host:8080` is the
case `redactUrl` would have let through.

- [ ] **Step 2: Write the failing tests**

1. The projection contains `id, name, type, implementation, url, username,
   category, createdAt, updatedAt` and **not** `api_key_secret_name` or
   `password_secret_name`.
2. A url of `http://user:hunter2@qbit.local:8080/base?token=abc#frag`
   projects as `http://qbit.local:8080/base`. Assert the absence of
   `hunter2`, `token` and `frag` individually, so a partial normalisation
   cannot pass.
3. A url that does not parse does not throw the whole sync — decide the
   behaviour, state it in the docblock, and pin it. (Rows are written by
   `addDownloadClient`, which refuses `bad-url`, so this is defence
   against rows from elsewhere.)
4. Migration 17 installs the sync triggers and seeds existing rows, the
   way migration 16 did for `rss_feed`.
5. `HOST_SYNCED_TABLES` has eight entries.

- [ ] **Step 3: Implement, and sweep for statements this falsifies**

`MIGRATION_15_TABLES` is **frozen** and must not change — it is an
already-applied migration, and re-coupling it to a growing list is pinned
against by a test. Read its docblock before touching anything nearby.

Then sweep: `grep -rn "seven" packages/host/src packages/host/test docs/`
and check every hit that refers to the synced table count. The previous
slice left nine such statements false and needed a fix round for them.
Leave alone the ones describing `migration15`'s frozen six.

- [ ] **Step 4: Mutation-test, then commit**

Drop `download_client` from `HOST_SYNCED_TABLES` and confirm the new
bootstrap assertion reds. Then restore the url to a raw pass-through and
confirm test 2 reds.

---

## Task 3: The settings screen

**Files:**
- Create: `packages/web/src/settings/DownloadClients.tsx`,
  `AddDownloadClient.tsx`, `useDownloadClients.ts`
- Modify: `packages/web/src/settings/Feeds.tsx` (or the `/settings` route
  element — see below)
- Test: one `.test.tsx` per new file

**Read first:** `packages/web/src/settings/Feeds.tsx`, `AddFeed.tsx` and
`useFeeds.ts` in full. This is their sibling. Note especially how
`postFeed` handles a response it does not recognise — it returns an
`unrecognised` outcome and never throws, because the form wedges
permanently otherwise. Match that.

**The `/settings` route renders both sections.** Decide whether that means
a new parent component or `Feeds.tsx` gaining a sibling, and say why in
your report. Keep each section's data hook independent — a failure listing
clients must not blank the feeds list.

- [ ] **Step 1: Write the failing tests**

1. The list shows a client by name, implementation and address, from the
   replica.
2. Adding one puts it in the list without a refetch (the row arrives
   through the replica's subscription).
3. The form offers the api-key fields for SABnzbd and, for qBittorrent, a
   choice between api key and username+password. Selecting one hides the
   other's fields.
4. Each refusal reads as its own sentence; an unrecognised code and an
   offline submit each read differently again.
5. **The error is legible.** Assert the *rendered text*
   (`screen.getByText(...)`), not the accessible name — `getByRole`'s
   `name` option is satisfied by an `aria-label` on an empty element, and
   a test asserting it passes against a component a human would see
   nothing in. This exact defect shipped in the previous slice.
6. The credential input is `type="password"` and its value is never
   rendered back into the DOM after submit.
7. The submit button re-enables after every outcome, including a rejected
   `submit`. A `finally` is the only way this holds.

- [ ] **Step 2: Implement**

`submit` is a required prop, injected. Do **not** give it a default that
posts — a default performing network I/O is invisible at the call site and
a test that forgets the prop gets a real `fetch` under jsdom.

- [ ] **Step 3: Mutation-test, then commit**

Collapse every refusal to one sentence and confirm test 4 reds. Replace
the visible error text with an `aria-label` on an empty element and
confirm test 5 reds **on its own**, run in isolation with
`--test-name-pattern`, with no neighbour available to catch it.

---

## Task 4: Styling and the browser proof

**Files:**
- Modify: `packages/web/src/styles/settings.css`,
  `packages/e2e/tests/shell.spec.ts`

- [ ] **Step 1: Style the section against the tokens**

No raw values outside `tokens.css`. Read that file's docblock before
adding to it.

- [ ] **Step 2: The browser proof**

One spec: sign in, go to `/settings`, add a download client, see it
listed. Plus one computed-style assertion for the new section.

Note what this spec does and does not cover, accurately, in its comment.
The e2e harness builds a real `Host` and never calls `host.start()`, so
the scheduled reconcile does **not** dispatch — the row reaches the
replica through the table's own `AFTER INSERT` trigger. Say that. The
previous slice's equivalent comment claimed "the whole slice" and was
wrong.

- [ ] **Step 3: Prove the pin, two-sided**

Both, and report both:
1. Remove the settings styles' import → the new assertion must red.
2. Keep the stylesheet but **gut its meaningful rules** → the new
   assertion must still red.

The second is the one that matters. In the previous slice the first
passed while the second did not. Assert a computed value only a real rule
produces — a token-derived colour or border.

> **Correction (final fix wave).** The reason originally given here —
> "because `list-style-type: none` is satisfied by a UA reset" — is
> false, and is left visible rather than deleted. No UA resets a `ul` to
> `none`; `base.css`'s only `list-style` reset is scoped to `nav ul`.
> Removing the import *does* red that assertion, with `disc` — Task 4's
> own half 1 measured exactly that. The weakness is real but narrower:
> `list-style: none` is a single declaration near the top of
> `settings.css`, so the **gutted** half satisfies it while every
> meaningful rule is gone. It pins the file's existence, not its rules.
> The guidance is unchanged; only its justification was wrong.

- [ ] **Step 4: Gate and commit**

---

## Self-review

- **Spec coverage:** §3 → Task 1. §4 → Task 1. §5 → Task 2. §6 → Task 3.
  §7.6 → Task 4. Acceptance items 1–5 are pinned by Tasks 1–3; item 6 by
  Task 4.
- **Type consistency:** `AddDownloadClientInput` is produced by Task 1 and
  consumed by Task 3; `AddDownloadClientRefusalCode` by Task 1 and
  consumed by Tasks 1 and 3. Both live in `@pickarr/contract` so a rename
  is a compile error on both sides — the fix the previous slice's final
  review required after finding the codes hand-copied.
- **Known departure from writing-plans:** this plan points at precedent
  files to copy shapes from rather than transcribing large code blocks.
  That is deliberate. Plan-authored code and comments were the single
  largest defect source in the previous slice — three separate defects,
  two of which cleared a reviewer. Requirements, names, types and
  invariants are stated exactly; shapes that must match existing code are
  cited by file and line so the implementer reads the real thing rather
  than my copy of it.
