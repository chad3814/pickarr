# Pickarr 2.0 — The Shell: Served, Signed Into, Replicating

The first build of 2.0 you can open in a browser. It serves the app from the host, signs
you in, boots the storage provider with real browser adapters, and ships an image that
runs all of it.

It renders no card and composes no plugin data. That is the next slice.

**Read `2026-09-15-client-storage-design.md` first.** This slice supplies the three
adapters its §1.2 deferred and finally exercises its code in an engine that is not Node.

## 1. What this delivers

- A tenth host route serving the built bundle, with an `index.html` fallback so
  client-side routing survives a deep link and a refresh.
- `packages/web` rewritten as 2.0's app: one sign-in form with a claim affordance, and a
  shell that shows replication happening.
- The three browser-facing adapters: a real `fetch` that honours the store's abort
  signal, an idle scheduler, and the Web Locks lease that `leader.ts` has always had and
  nothing has ever called.
- A Playwright suite against a **2.0** harness, proving in a real browser what no unit
  test can.
- A Dockerfile that builds and runs 2.0, and a healthcheck that resolves the port the
  way boot does.

### 1.1 Decisions taken before this spec

- **`packages/web` is rewritten, not forked.** 1.x's four routes, its API client and its
  1.x-shaped components go. `pickarr-2` never reaches `main` and 1.x is greenfield
  replaced, so nothing anyone runs is affected. *Rejected:* a second `packages/client`
  (two workspaces to keep in step for a version being deleted), and two vite entries in
  one package (the seam ends up inside a package rather than between two).
- **One form, sign-in with a claim affordance.** Nothing tells an unauthenticated client
  whether the install is claimed, and nothing should: "this install is unclaimed" is the
  same class of fact as the generation token we deliberately kept off `/api/health`, and
  it is the one state where a claim token is all that stands between a scanner and the
  account. *Rejected:* an open `{claimed}` endpoint, and branching on a failed sign-up.
- **The slice boots the store.** Signing in and stopping would ship `store/` without ever
  running it in a browser, which is the largest blind spot the storage slice's
  whole-branch review named.
- **The shell shows a count, not a list.** The smallest thing that proves replication to
  a human eye. A list is a card is the compose layer, and that is slice B.

### 1.2 What this slice is not

- **No card, no per-plugin `compose.ts`.** The gatherer exists; what a card shows does
  not.
- **No picks, no settings, no artwork rendering.** The host is still GET-only, so
  anything that writes is a backend slice first.
- **No 1.x in the image.** `packages/core` and `packages/plugin-scenes` stay in the repo
  and stay buildable from source; nothing containerises them any more.

### 1.3 What this slice deletes, and why it has to

`packages/web`'s rewrite takes its tests with it, and that reaches further than the
package:

- **The 12 Playwright specs in `packages/e2e/tests`** drive 1.x's routes and components.
  They cannot be kept passing against a UI that no longer exists, and keeping them
  skipped would be 12 files asserting nothing.
- **`packages/e2e/src/harness.ts`** boots a *1.x* server: it imports
  `@pickarr/plugin-api`, registers `@pickarr/plugin-scenes`, and seeds 1.x's config
  shape. A 2.0 harness is new code, not an edit.
- **`packages/web/test`'s 24 `.test.tsx` files**, which are the whole of `test:web`:
  **377 tests**, every one of them against a 1.x component. Plus five of the six
  `.test.ts` files there — `groupImages`, `groupTitle`, `search`, `requeryMetadata` and
  `format` all address 1.x shapes (19, 10, 13, 6 and 1 references to groups, identity
  keys or scenes respectively). `fetchStub.test.ts` has none and stays: it guards the
  typed fetch helper that closed issue #58, and a 2.0 test suite wants that as much as a
  1.x one did.

**So the honest number is roughly 380 tests deleted**, against §7's fourteen new
properties. That is not a like-for-like trade and it should not be presented as one:
what those 380 covered was 1.x's browser UI, which this branch does not ship and cannot
run. The replacement for most of it is slice B, when there are 2.0 components to test.
The replacement for the part that mattered most — that any of this works in a real
browser — is §7's items 10 to 14, which is coverage the deleted suite never had for 2.0
at all.

## 2. Facts, measured rather than assumed

**2.1 The host serves nothing but JSON and images today.** Plain `node:http`, nine
routes, and a fixed `404 {error: 'unknown route'}` for every other path. There is no
static handler and no dependency that provides one.

**2.2 `artwork-route.ts` is already a file server.** Injected `readFile` and `stat`, a
content type chosen per request, a **weak** ETag, and a 304 on `If-None-Match`. Its
docblock argues why weak is forced rather than chosen: nothing stored survives a
re-fetch that changes the bytes at a path. Static serving reuses that shape instead of
inventing a second one.

**2.3 `createReadServer` is exported from `@pickarr/host`.** So a 2.0 Playwright harness
can boot a real host in-process on port 0, exactly as the 1.x harness boots 1.x's.

**2.4 The vite dev proxy points at the wrong host.** `packages/web/vite.config.ts`
proxies `/api` to `localhost:8080`, which is 1.x's port. 2.0 defaults to 8787.

**2.5 The Dockerfile is 1.x throughout.** It installs `plugin-api`, `plugin-scenes` and
`core`; sets `PICKARR_CONFIG=/config/config.json` where 2.0's default is
`/config/pickarr.config.json`; exposes 8080 where 2.0 uses 8787; copies
`packages/web/dist` into `packages/core/dist/web`; and runs `core/dist/main.js`.

**2.6 The root `build` script cannot build a 2.0-only image.** It names `plugin-api`,
`plugin-scenes` and `core` among its ten workspaces, none of which a 2.0 image
copies — so a build stage that installed only the 2.0 manifests would fail on a
missing workspace. The image builds a targeted list.

**2.7 The claim token exists only on the host's stdout.** `main` prints it once per boot
while the install is unclaimed and writes it nowhere a request can reach. So a test that
signs up has to read it from the process it started, which the 2.0 harness can do because
it boots the host itself.

## 3. Serving the app

A tenth route, and the second open one:

| Request | Answer |
|---|---|
| `GET /assets/<file>` | the file, content type by extension, weak ETag, 304 on a match |
| `GET /` or any unmatched non-`/api` path | `index.html`, 200 |
| `GET /api/<anything unmatched>` | unchanged: `404 {error: 'unknown route'}` |

**`/api` must never fall through to `index.html`.** A typo'd endpoint answering HTML is a
client that parses markup as JSON and reports a nonsense error, which is worse than a
404 by exactly the time it takes to find.

**Path traversal is refused after normalisation, not before.** The candidate path is
resolved against the web root and served only if the resolved path is still inside it.
`%2e%2e%2f` is a `..` by the time `new URL` has decoded it, so a check on the raw string
is a check on the wrong string.

**A missing or unreadable web root is not fatal.** The host logs once and serves the API
alone. An operator running headless should not be blocked by an absent bundle, and a host
that refuses to boot over a UI it was never asked to serve is a host that is harder to
diagnose.

The root is `server.webRoot`, a new key on the server config namespace, defaulting to
`web` beside the host's own `dist`. That is where §6.5's image puts it.

## 4. Signing in

One form: email, password, submit. A "first time here? claim this install" link reveals a
claim-token field and posts to sign-up instead of sign-in.

The client discovers it is unauthenticated the ordinary way: a read answers 401, and the
app renders the form. No probe, no new endpoint.

`better-auth` owns the cookie. The client never reads, stores or forwards a token — every
request is `credentials: 'same-origin'` and the browser does the rest. The auth routes
are already mounted under `/api/auth`, so this is a form against a surface that exists.

Sign-out ends the session **and** calls `store.stop()`. A store left running against a
dead session retries a 401 on the backoff ladder forever, which is the shape the previous
slice just finished bounding.

## 5. The three adapters

```ts
realFetch(url, signal)   // window.fetch, credentials: 'same-origin' -> SyncResponse
idleScheduler            // requestIdleCallback where present, setTimeout where not
webLocksLease(name)      // leader.ts's, now with a caller
```

**`realFetch` must pass the signal through.** The one-minute deadline the storage slice
added does nothing if the adapter drops it, and an adapter that drops it looks correct in
every test that stubs `fetch`. This is the property §7 pins first.

`idleScheduler` falls back because `requestIdleCallback` is absent in Safari before 16.4
and in every jsdom-like environment. The fallback is a plain `setTimeout`, which is
worse at yielding and correct at running.

## 6. The shell

A header, three category tabs (`tv`, `movie`, `xxx`), and per category a count read
through `listByTable` and refreshed on `subscribeInserts`. A number that climbs while
the backfill runs.

This is also **`by_table_updated`'s first reader**: the storage review flagged that index
as having none, and this is the answer rather than a coincidence.

Counts come from the replica only. There is no remote fallback — the storage spec's §9
keeps that decision, and a count that silently fell back to the network would make the
one screen that proves offline capability the screen that hides its absence.

## 6.5 The image

Rebuilt for 2.0, not patched.

**Build stage.** Manifests first, as now, for `contract`, `openmetadata`, `plugin-tv`,
`plugin-movie`, `plugin-xxx`, `host` and `web`. Then a **targeted** build rather than
`npm run build`, per §2.6. The existing comment about keeping lint and typecheck out of
the image carries over unchanged — its reasoning still holds, and it was written because
a dev-only workspace once broke the production image.

**Runtime stage.** `npm ci --omit=dev --include-workspace-root` over the 2.0 runtime
workspaces, then each `dist`, plus `packages/web/dist` → `packages/host/dist/web`, which
is §3's `server.webRoot` default. `@pickarr/web` stays out of the runtime install for the
reason already written down: it ships as prebuilt assets, so react and vite have no
business there.

**Three declarations change, and all three are wrong for 2.0 today:**

```
PICKARR_CONFIG=/config/pickarr.config.json   (was /config/config.json)
EXPOSE 8787                                   (was 8080)
CMD node packages/host/dist/bin.js            (was core/dist/main.js)
```

**The healthcheck is written, not ported.** 1.x's exists because a `node -e` one-liner
cannot import anything, so it fell back to 8080 and called every config-set port
unhealthy. 2.0 has the same problem: `packages/host/src/healthcheck.ts` resolves the port
exactly as boot does — `PICKARR_READ_API_PORT`, else the config file, else 8787 — and
requests `/api/health`. That route is open precisely so a health check has something to
ask without a credential.

**`docker-compose.example.yml` comes with it.** It currently mounts 1.x paths and a
`sabnzbd_api_key` file. An example that does not match the image is a false document:
`/config` for the database and config, `/run/secrets` for `secrets.baseDir`, and
`openmetadata-api-key` as the one secret a working install needs.

**Two documents become false when this lands**, and both assert the opposite today: the
README's "There is no 2.0 container", and `CLAUDE.md`'s "1.x … still the only thing
`Dockerfile` builds". Both are corrected in this slice.

**The image is verified by building it once, by hand, and recording the result in the
ledger.** `docker build` in the gate would add minutes to every run for a file that
changes rarely; a build nobody ever ran is a Dockerfile that only looks right. Whether it
belongs in CI is a separate conversation about what CI runs.

## 7. What the tests must prove

Unit, in `packages/web/test` and `packages/host/test`:

1. `realFetch` passes the caller's `AbortSignal` to `window.fetch`, and an aborted signal
   rejects rather than resolving.
2. `idleScheduler` uses `requestIdleCallback` when it exists and `setTimeout` when it
   does not, and its cancel works in both.
3. The static route serves a known asset with its content type, and answers 304 on a
   matching `If-None-Match`.
4. An unmatched non-`/api` path answers `index.html`; an unmatched `/api` path still
   answers `404 {error: 'unknown route'}`.
5. `..` and `%2e%2e%2f` outside the web root are refused after normalisation.
6. An absent web root logs once and leaves the API answering.
7. `healthcheck` resolves the port from the environment, then the config file, then the
   default — and reports unhealthy on a non-200.
8. The sign-in form posts sign-in by default and sign-up with a token once the claim
   affordance is used.
9. Sign-out calls `store.stop()`.

Playwright, against a **2.0** harness:

10. The app loads from the host — bundle, assets, and a deep link that is not `/`.
11. Sign-up with the claim token creates the account; a second sign-up is refused.
12. After sign-in the counts climb above zero: IndexedDB, Web Locks and both cursors
    working in a real engine.
13. Two tabs: exactly one fetches, and the follower's counts still climb. Node's Web
    Locks is per-process where a browser's is per-origin, so the existing tests *model*
    this and do not verify it.
14. Reload: counts are immediately non-zero, because the replica persisted.

Item 13 is the one this slice exists to reach.

## 8. Consequences

- **The bundle finally ships, so `store/` is finally exercised in a browser.** Two of
  its dependencies — Web Locks and IndexedDB — have only ever run under Node and
  `fake-indexeddb`.
- **Coverage drops hard before it rises.** §1.3 deletes 12 e2e specs and about 380
  tests; §7 adds fourteen properties. `npm test`'s total will fall by roughly a sixth
  and `test:web` will briefly be almost empty. Anyone reading the numbers without §1.3
  will read that as a regression, so the merge commit says it outright.
- **A headless operator gets a working host with no UI and one log line.** That is
  deliberate (§3) and it is the only way an absent bundle stays diagnosable.
- **Sign-out is the only way to stop the store from the UI.** There is no pause, and a
  backgrounded tab keeps its lease until it is closed — which is what the lease is for,
  but it means the "leader" is whichever tab was opened first rather than whichever is
  visible.
- **The image stops building 1.x.** Anyone wanting a 1.x container builds it from `main`,
  which is where 1.x lives.
