# Continuous integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the checks automatically on every push and pull request, and make a failure diagnosable without reproducing it locally.

## Why now

**There is no CI. No `.github/workflows` at all.** Every check this repo has — lint, typecheck, 571 unit tests, 6 browser tests — runs only when somebody remembers to run it. That has held so far because the work has been done in long sessions with a full `npm run check` between tasks, but it is not a property of the repo, it is a property of who happened to be driving.

The browser suite makes this sharper. It exists to catch bugs at the client/server seam that unit tests structurally cannot see, and it costs a few hundred megabytes of browser binaries — so it is the check most likely to be skipped locally and the one whose absence is least obvious.

## Shape

Two jobs, not one. `check` is fast and gates everything; `e2e` is slower and needs a browser.

Splitting them means a lint error tells you it is a lint error in twenty seconds, rather than after Chromium has downloaded.

## Global Constraints

- **Do not commit.** Leave work in the working tree; the repo owner approves every commit.
- Node **24** — `.nvmrc` says `24` and `engines.node` is `>=24`. Read the version from `.nvmrc` rather than hardcoding it in the workflow, so the two cannot drift.
- `npm ci`, not `npm install` — the lockfile is v3 and CI must install exactly what it pins.
- Never use `any`. Comments explain *why*.
- Nothing in this plan may make `npm run check` slower or add e2e to it.

---

### Task 1: The check workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

One job, `check`. Triggers: `push` to `main`, and `pull_request`. Steps: checkout, `actions/setup-node` with `node-version-file: .nvmrc` and `cache: npm`, `npm ci`, `npm run check`.

`npm run check` is already `lint && typecheck && test`, so the workflow does not enumerate them — the definition of "checked" lives in `package.json` where a developer running it locally sees the same thing. A workflow that lists its own steps is a second definition that drifts.

- [ ] **Step 2: Prove it runs**

You cannot run GitHub Actions locally without extra tooling, so verify what can be verified: the YAML parses (`node -e` with a YAML parser, or `gh workflow view` after it exists on a branch), the script names it invokes exist in `package.json`, and `.nvmrc` is where you say it is. State plainly in your report which parts you proved and which the first real run will decide — do not claim a workflow passes because it looks right.

---

### Task 2: The browser job, and making its failures readable

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `packages/e2e/playwright.config.ts`
- Modify: `packages/e2e/README.md`

- [ ] **Step 1: Fix the trace configuration first**

`playwright.config.ts` sets `trace: 'on-first-retry'` with `retries: 0`. **Those two together capture no trace, ever** — verified by forcing a failure: `test-results/` held only an ARIA snapshot, no trace, no screenshot, no video. Shipping CI on top of that means every red build gives you a stack trace and nothing else.

`retries: 0` is deliberate and stays — retries hide flakes, and this suite was measured stable across 104 executions including deliberate CPU contention. So fix the other side: `trace: 'retain-on-failure'`, plus `screenshot: 'only-on-failure'`. Force a failure and confirm a trace zip actually appears before moving on.

- [ ] **Step 2: Add the job**

A second job, `e2e`, running in parallel with `check` rather than after it — they test different things and a lint error should not delay a seam failure.

Steps: checkout, setup-node as above, `npm ci`, install **only Chromium** (`npx playwright install --with-deps chromium`; the config runs Chromium alone and installing all three browsers triples the download), then `npm run e2e`.

Cache the browser binaries keyed on the resolved Playwright version — take it from `package-lock.json` rather than hardcoding, so a dependency bump invalidates the cache instead of silently reusing a mismatched binary. Playwright refuses to run against a binary it did not install, so a stale cache fails loudly rather than subtly; the cache is a speed optimisation, not a correctness risk.

- [ ] **Step 3: Upload artefacts on failure**

`actions/upload-artifact` with `if: failure()`, carrying `packages/e2e/test-results/` and `packages/e2e/playwright-report/`. Set a retention shorter than the default — these are debugging aids for a specific red build, not history.

Without this the trace fix from Step 1 is pointless: the trace would be written inside the runner and thrown away with it.

- [ ] **Step 4: Say what the developer has to do**

`packages/e2e/README.md` already warns about the browser download. Add what CI does, so the difference between "green locally" and "green in CI" is written down rather than discovered.

- [ ] **Step 5: Verify**

```
npm run check && npm run e2e
```

Both must still pass locally and `check` must not have grown. Report its duration.

---

### Task 3: Close the two gaps CI would otherwise institutionalise

**Files:**
- Modify: `packages/e2e/src/harness.ts`
- Modify: `packages/e2e/tests/retry.spec.ts`
- Modify: `packages/web/test/Downloads.test.tsx`

Running a suite automatically makes its blind spots permanent, so these are worth closing in the same change rather than after.

- [ ] **Step 1: Fail a spec on an uncaught page error**

No spec listens for `pageerror` or console errors. `manual.spec`'s stated failure mode is *duplicate React keys* — it catches the visible symptom but a React key warning, or any uncaught SPA exception that does not move the DOM, passes silently across all four specs. Add the listener in the harness fixture so every spec inherits it. Prove it: throw in a component, confirm a spec goes red.

- [ ] **Step 2: Pin the immediate refresh after retry**

Removing `setData(await api.downloads())` from `Downloads.retry` — leaving only the 3-second poll to refresh the row — leaves the e2e spec **and all 62 web unit tests green**. Nothing in the repo pins it.

It is also where the suite's determinism lives: with the immediate refresh gone, the spec still passed but its runtime went from 1.6s to 5.3s, because it was waiting on the 3-second poll inside a 5-second assertion window. On a loaded CI runner that margin is the difference between green and a flake nobody can reproduce. Pin it with a unit test in `Downloads.test.tsx` asserting the second `/api/downloads` request happens without the timer advancing.

- [ ] **Step 3: Carry the retry spec through to re-submission**

`resetForRetry` sets `queued` and nulls `client_ref`; the actual re-submission happens on the next `reconcileClient`. The spec asserts the row reads `queued` and stops — so "retry marks it queued but never re-sends it to the client", exactly the UI-says-success/backend-does-nothing shape this branch exists to catch, would pass.

Clear the client snapshot first — the stale `failed` history entry carries the same label, so reconcile would recover the ref rather than re-add — then `await harness.reconcile()` and assert a second `addUrl`.

- [ ] **Step 4: Name the narrow pins in the spec's comment**

The retry spec needs *both* halves of its fix reverted to fail, because the client no longer sending the header and the server tolerating an empty body are independent. Both halves already have narrow unit pins — `server.test.ts`'s *retry takes no body, and is not refused for having none*, and `Downloads.test.tsx`'s *a bodyless request carries no json content-type*. Name them in the spec's header comment, so the next person who reverts one half, sees green, and concludes the spec is worthless has the answer in front of them.

- [ ] **Step 5: Verify**

```
npm run check && npm run e2e
```

---

## Notes for the controller

- Two follow-ups this plan deliberately leaves alone: an e2e spec for `PATCH /api/releases/:id` (the fourth motivating bug, and the highest-consequence one — no spec clicks "Edit quality"), and the `app.ts` composition-root split in core, already filed as #54. The second matters more than it looks: `main.ts` does five things the harness re-implements without — `recoverInterruptedWork`, `learnSites`, `resolveSitesForBatch`, per-client `untrackedFor`, and the scheduler — so a startup step added there leaves the harness passing against a server that no longer resembles production, silently.
- The branch is behind `main` (which has since taken the site-identity-key merge). Merge `main` in before landing.
