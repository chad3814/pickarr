# Browser tests across the client/server seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch the class of bug that has repeatedly shipped here — one where the client is right, the server is right, and the contract between them is wrong.

## Why, precisely

**Every web test stubs `globalThis.fetch`.** All four of them. So the suite verifies that components render what a *hand-written fixture* says the server returns, and never that the server returns it.

The bug that proves the point: `api.retry` set `content-type: application/json` on a POST with no body, and Fastify answered `400 FST_ERR_CTP_EMPTY_JSON_BODY` before the route ran. **The retry button never worked, for the whole life of the feature.** The route had a passing test — it sent no content-type header, so it tested a request no browser makes. The client had a passing test — its mock returned whatever the fixture said. Neither could see it.

Three more of the same family, all found by review rather than by tests:

- `PATCH /api/releases/:id` returned a non-nullable group, so a downgraded release left a stale card whose Pick button queued an *upgrade* — trashing the better file.
- Picking after "Load more" refetched page one and discarded every later page.
- A merge's response shape (`group` + `mergedInto`) had to be read correctly by the list to avoid duplicate React keys.

What these share is that no single unit can be wrong on its own. Only running the real client against the real server finds them.

## What this is not

Not a replacement for the component tests. Those are fast, they pin rendering, and they run on every `check`. This is a second, slower net for the seam, covering flows that have actually broken.

Not cross-browser testing. Chromium only. The bugs here are contract bugs, not rendering bugs, and a browser matrix would triple the runtime for no coverage of the thing being tested.

## Decisions taken, all reversible

- **A new workspace, `packages/e2e`**, private, holding `@playwright/test`, the harness and the specs.
- **A separate `npm run e2e`, NOT part of `npm run check`.** Playwright needs browser binaries (`npx playwright install chromium`, a few hundred MB) and takes seconds per spec rather than milliseconds. `check` is run constantly, by agents, on every task; making it depend on a browser download would be a tax on every future piece of work. `e2e` is run deliberately, and in CI.
- **The real server, a real database, a fake download client.** `buildServer` already takes its client as a dependency, so the fake is small. Nothing talks to SABnzbd or to an indexer.
- **The built SPA**, via `vite build` and `fastifyStatic`, not the dev server — the point is to test what ships.

## Global Constraints

- **Do not commit.** Leave work in the working tree; the repo owner approves every commit.
- Node 24 is not the shell default: `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.
- `npm run check` must stay green and must **not** grow slower. If you find yourself adding e2e to it, stop.
- Never use `any`. tsconfig sets `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`.
- Comments explain *why*.

---

### Task 1: The harness

**Files:**
- Create: `packages/e2e/package.json`, `tsconfig.json`, `playwright.config.ts`
- Create: `packages/e2e/src/harness.ts`
- Modify: root `package.json` (an `e2e` script; the workspace glob already covers `packages/*`)
- Test: `packages/e2e/tests/smoke.spec.ts` (create)

**Produces,** consumed by Task 2: a fixture that starts a server on an ephemeral port against a fresh database and yields its base URL plus a handle for seeding.

The harness must:

- Open a **fresh database per test** — a temp file, deleted after. `openDatabase` runs every migration, so each test starts at the current schema with no rows. Tests that share a database share failures.
- Bind port **0** and read back the assigned port. A fixed port makes two tests, or two developers, collide.
- Serve the **built** SPA. Build once for the whole run, not per test.
- Supply a **fake `DownloadClient`** whose `addUrl` records calls and returns a ref, and whose `snapshot` returns whatever the test set. That is what lets a spec drive a download to `failed` without usenet.
- Expose seeding that goes through the **real** ingest path where possible — `ingestEntries` with the real scenes plugin — so a spec's fixtures cannot drift from what the parser actually produces. Direct SQL only for states ingest cannot reach, like a failed download.

- [ ] **Step 1: Scaffold and prove the harness boots**

`packages/e2e/tests/smoke.spec.ts` asserts the app loads, the nav has its four tabs, and `/api/health` answers. That is the whole of Task 1's test: if this passes, the wiring is real.

- [ ] **Step 2: Run it**

```
npx playwright install chromium
npm run e2e
```

- [ ] **Step 3: Verify `check` is untouched**

```
npm run check
```

Same test counts as before, same duration. Report both.

---

### Task 2: The specs, one per bug that shipped

**Files:**
- Create: `packages/e2e/tests/retry.spec.ts`, `pagination.spec.ts`, `manual.spec.ts`

Each spec exists because a real bug got past the existing suite. Write the comment saying which.

- [ ] **Step 1: `retry.spec.ts` — the flagship**

Seed a group, pick a release, drive its download to `failed` through the fake client, open Downloads, click Retry, and assert the row leaves `failed`.

**Before implementing it, prove it would have caught the original bug.** Revert `packages/web/src/api/client.ts`'s `request` to set `content-type: application/json` unconditionally, run the spec, and confirm it fails with the 400. Then restore. A regression test for a fixed bug is worth exactly as much as its ability to fail on the old code — and this one is easy to check, because the old code is in git.

- [ ] **Step 2: `pagination.spec.ts`**

Seed enough groups to need two pages. Load more, pick something from the **first** page, assert the second page's cards are still there. Then the same for the Failed tab's resolve and dismiss.

Prove it too: the pre-fix `Browse.tsx` is in git history.

- [ ] **Step 3: `manual.spec.ts`**

Seed a feed item the parser refuses. Open Failed, fill the form, save, and assert the item leaves Failed and the scene appears on Browse under the right group. Then edit a group's identity so it merges into another, and assert the source card goes and the target is patched — with no duplicate cards, which is the failure a wrong `mergedInto` reading produces.

- [ ] **Step 4: Verify**

```
npm run e2e && npm run check
```

---

## Notes for the controller

- Two branches in flight (`site-identity-key`, `failed-pick-navigation`) change the UI this tests. This plan is based on `main` and covers only flows that exist there. Specs for the failed-pick anchors and the `Failed` badge come after those merge.
- The browser install is a real cost for anyone cloning the repo. Task 1 should say so in the workspace README rather than letting the first `npm run e2e` fail confusingly.
