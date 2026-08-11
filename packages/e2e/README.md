# @pickarr/e2e

Browser tests across the client/server seam: a real Chromium driving the real
built SPA against a real Fastify server over real HTTP.

## First run needs a browser download

Playwright's Chromium is **not** installed by `npm install`. It is a few
hundred megabytes, and `npm run check` deliberately does not depend on it.
Before the first `npm run e2e` on a fresh clone:

```
npx playwright install chromium
```

Without it, `npm run e2e` fails with `Executable doesn't exist at …` and the
same instruction.

## Running

```
npm run e2e            # from the repo root
```

`npm run e2e` is **not** part of `npm run check`, and should not become part of
it. `check` runs constantly, on every task; making it pull a browser binary
would tax every future piece of work. This suite is run deliberately, and in
CI.

The run builds the SPA once (`npm run build -w @pickarr/web`) in
`src/global-setup.ts`, then each test starts its own server.

## In CI

`.github/workflows/ci.yml` runs this suite as its own `e2e` job on every push
to `main` and every pull request, in parallel with the `check` job. The job does
the browser download for you — `npx playwright install --with-deps chromium`,
Chromium only, cached on the Playwright version resolved from
`package-lock.json` — so a green local run and a green CI run are running the
same browser against the same built bundle.

Two things differ from a local run, both because `CI` is set:

- `forbidOnly` is on, so a stray `test.only` fails the job instead of quietly
  skipping every other spec. Take `.only` off before you push.
- the reporters are `line` plus `html`, rather than `list`.

When the job fails it uploads a `playwright-failure-<run id>` artefact holding
`test-results/` and `playwright-report/`, kept for 7 days. Download it, unzip
it, and:

```
npx playwright show-trace <the unzipped>/test-results/<spec>/trace.zip
```

That trace is the whole point of `trace: 'retain-on-failure'` in
`playwright.config.ts` — it is the only way to see what the browser was looking
at on a runner you cannot log into. The setting has to stay paired with
`retries: 0`: the old `on-first-retry` produced no trace at all, because with
retries off there is never a first retry.

## What a test gets

`src/harness.ts` exports a `test` whose `harness` fixture gives each test:

- a **fresh database** in its own temp directory, removed when the test ends —
  `openDatabase` runs every migration, so it starts at the current schema with
  no rows;
- a server on an **ephemeral port** (bind 0, read back what the OS assigned),
  with `baseURL` overridden so `page.goto('/')` reaches it;
- the **built** SPA as `webRoot`, so the bundle under test is the one that
  ships;
- a **fake `DownloadClient`** that records `addUrl` calls and returns whatever
  snapshot the test set, so a spec can drive a download to `failed` without
  usenet;
- `harness.ingest(titles)`, which seeds through the **real** ingest path and
  the real scenes parser — a spec's fixtures cannot drift from what the parser
  actually produces;
- `harness.reconcile()`, the real reconcile pipeline over the fake client;
- `harness.db`, for the few states ingest cannot reach.

## Why this suite exists

Every web unit test stubs `globalThis.fetch`, so the suite proves components
render what a hand-written fixture claims the server returns, and never that
the server returns it. `api.retry` set `content-type: application/json` on a
POST with no body; Fastify answered `400 FST_ERR_CTP_EMPTY_JSON_BODY` before
the route ran, and the retry button never worked for the whole life of the
feature. The route's test sent no content-type header. The client's test used a
mock. Neither could see it.
