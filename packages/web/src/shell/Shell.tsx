/**
 * The first screen that proves replication (design spec §6): a header, three
 * category tabs, and per category a count read from the replica. It owns the
 * store's whole lifetime -- creates one with the real browser adapters on
 * mount, stops it on unmount -- because signing in and never running the
 * store would ship `store/` without ever exercising it in a browser, which is
 * the largest blind spot the storage slice's whole-branch review named.
 *
 * **Sign-out stops the store and ends the session**, in that order, and both
 * unconditionally (design spec §4). The store stops first so no in-flight
 * sync request can race the session teardown; a store left running against a
 * dead session retries a 401 on the backoff ladder forever -- the previous
 * slice bounded how long, not whether. Stopping does not wait on the network
 * call: the local half of sign-out (no more polling) has no reason to depend
 * on the remote half succeeding, and a caller who is offline still gets a
 * store that stops.
 *
 * **A 401 on any read means the same thing sign-out does.** `session.ts`'s
 * `isUnauthenticated` doc calls this "the ordinary way" a client discovers it
 * needs to show `SignIn` again -- any read can answer it, not just the three
 * auth calls. `withUnauthenticatedCheck` below is what lets *this* store's
 * reads be "any read": it wraps whatever `fetch` `createStore` is given so a
 * 401 anywhere in the sync loops reaches `onUnauthenticated`, without this
 * component or `sync.ts` ever inspecting a response body.
 *
 * **Routing (task 4, task 5 adds `/settings`).** `Shell` is also where the
 * app's five routes live -- `/tv`, `/movie`, `/xxx`, `/unmatched`,
 * `/settings`, with `/` redirecting to `/tv` -- via
 * a pathless layout `Route` (`ShellChrome`, below) that renders the header
 * and nav once and an `<Outlet />` for whichever category matched. A
 * trailing `path="*"` route keeps that chrome on screen for any path this
 * router does not otherwise recognise, rather than rendering nothing: the
 * host falls back to `index.html` for every non-`/api` path (`App.tsx`'s own
 * doc, `packages/e2e/tests/shell.spec.ts`'s deep-link spec), so a stale or
 * hand-typed deep link reaches the router as an unmatched path, not a 404,
 * and this is what keeps that case looking like the app rather than a blank
 * page. `MediaItemCard` (task 6) already exists and is what task 5's
 * `Category` (`../library/Category.tsx`, imported below as `CategoryScreen`)
 * renders one per media item, and `Unmatched` (`../library/Unmatched.tsx`)
 * is what `/unmatched` renders. Every route now reaches a real screen; the
 * placeholders this file carried while those screens were being built are
 * gone.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router';
import { createStore, type CreateStoreDeps, type Store } from '../store/index.ts';
import { realFetch, idleScheduler } from '../store/adapters.ts';
import { webLocksLease, type SyncFetch } from '../store/sync.ts';
import { signOut, isUnauthenticated } from '../auth/session.ts';
import { Unmatched } from '../library/Unmatched.tsx';
import { useCounts, CATEGORIES, type Counts } from './useCounts.ts';
import { Category as CategoryScreen } from '../library/Category.tsx';
import { Settings } from '../settings/Settings.tsx';
import { pluginLabel } from '../pluginLabels.ts';
import { postFeed } from '../settings/AddFeed.tsx';
import { postDownloadClient } from '../settings/AddDownloadClient.tsx';
import { mappingSubmit } from '../settings/postMapping.ts';
import { destinationSubmit } from '../settings/postDestination.ts';
import { postPick } from '../library/postPick.ts';

/** The one replica this shell ever opens. One tab, one database (design spec §5). */
const DB_NAME = 'pickarr';

/**
 * A category's plugin table list, until the plugin registry
 * (`packages/web/src/plugins/registry.ts`, Task 6) exists to supply the
 * real one. A stable module-level constant rather than a `[]` literal at
 * each `<CategoryScreen>` below: `Category.tsx`'s own doc says a fresh
 * array there refetches `usePluginRows` on every render for reasons
 * unrelated to `tables` changing.
 */
const NO_TABLES: readonly string[] = [];

/** The real browser adapters (task 4, task 6's brief): `webLocksLease()`'s own default lease name, `Date.now`, `realFetch` and `idleScheduler`. */
function defaultDeps(): CreateStoreDeps {
  return {
    dbName: DB_NAME,
    fetch: realFetch,
    schedule: idleScheduler,
    now: (): number => Date.now(),
    locks: webLocksLease(),
  };
}

/**
 * Wraps `fetch` so a 401 anywhere calls `onUnauthenticated`, and otherwise
 * changes nothing about the response `sync.ts` sees -- it still decides for
 * itself whether `res.ok`. Never reads the body (Global Constraints): the
 * status is the whole of what this needs to know.
 */
function withUnauthenticatedCheck(fetch: SyncFetch, onUnauthenticated: () => void): SyncFetch {
  return async (url, signal) => {
    const res = await fetch(url, signal);
    if (isUnauthenticated(res)) onUnauthenticated();
    return res;
  };
}

export interface ShellProps {
  /** Called once sign-out completes, or once any sync read discovers the session is already dead. Either way, `App`'s job is the same: show `SignIn` again. */
  onUnauthenticated: () => void;
  /**
   * Overridable for tests, which need to drive fetch, the scheduler, the
   * clock and the lease by hand rather than touch a real browser API --
   * `store/index.ts`'s own end-to-end test takes the same approach. Defaults
   * to the real browser adapters.
   */
  deps?: CreateStoreDeps;
}

export function Shell({ onUnauthenticated, deps }: ShellProps): ReactElement {
  const [store, setStore] = useState<Store | undefined>(undefined);
  /**
   * Whether `createStore` rejected -- the one state that is neither "still
   * opening" nor "open", and which every screen below would otherwise
   * render identically to both (whole-branch review §3: `/tv`'s section had
   * an innerHTML of `""`, the counts read `0/0/0`, and no alert appeared,
   * indefinitely). A boolean, not the error: a `VersionError`'s or an
   * `OpenBlockedError`'s message names the database, and nothing this
   * component renders may carry one (Global Constraints). The error itself
   * still reaches `console.error` below, where a developer can read it.
   */
  const [storeFailed, setStoreFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let created: Store | undefined;
    const base = deps ?? defaultDeps();
    const wired: CreateStoreDeps = { ...base, fetch: withUnauthenticatedCheck(base.fetch, onUnauthenticated) };

    createStore(wired)
      .then((opened) => {
        if (cancelled) {
          opened.stop();
          return;
        }
        created = opened;
        setStore(opened);
      })
      .catch((err: unknown) => {
        // Reported to the console *and* to the person looking at the tab.
        // `openStore` can genuinely reject (`OpenBlockedError`, or
        // IndexedDB refusing outright), and a console line is not a report
        // to anyone who is not already watching one.
        console.error('pickarr: failed to open the replica', err);
        if (!cancelled) setStoreFailed(true);
      });

    return () => {
      cancelled = true;
      created?.stop();
    };
    // Deliberately `[]`: `deps` and `onUnauthenticated` are fixed for the life
    // of one `Shell`, matching `store/index.ts`'s own "a factory, not a
    // singleton" stance -- a store's identity is fixed at creation, and a test
    // that must vary `deps` renders a fresh `Shell` rather than reusing one.
  }, []);

  const counts = useCounts(store);

  function handleSignOut(): void {
    store?.stop();
    signOut().catch(() => {
      // `session.ts`'s `signOut` is a bare `fetch`, which rejects for
      // transport reasons -- offline, DNS, a reset connection -- and `void`
      // does not contain a rejection; task 5's review found the identical
      // shape in `SignIn.handleSubmit` and `4283bb6` fixed it there with
      // `REQUEST_FAILED`. The rejection is deliberately not inspected here
      // either: its own message can name a host or a port (Global
      // Constraint). Unlike `SignIn`, there is no error banner to show a
      // human -- the local half of sign-out (stopping the store, already
      // done above) is what this tab actually needed, and the remote call is
      // best-effort from here on.
      console.error('pickarr: could not reach the sign-out endpoint');
    });
    onUnauthenticated();
  }

  return (
    <Routes>
      <Route element={<ShellChrome counts={counts} onSignOut={handleSignOut} storeFailed={storeFailed} />}>
        <Route index element={<Navigate to="/tv" replace />} />
        {/*
          `postPick` is the third real `submit` this file wires, on the same
          rule as the two below: a form or a button that performs network I/O
          takes it as a required prop, because a default that posts is
          invisible at the call site and a test that forgets the prop gets a
          real `fetch`. It reaches `ReleaseList`'s per-release Pick button
          through `Category` and `MediaItemCard`, neither of which calls it
          (picks design §2).

          **Where these three lines are driven**, since no unit test in
          `Shell.test.tsx` reaches them and the repo's hazard list warns
          that pinning a pure function does not pin that anyone calls it:
          `packages/e2e/tests/shell.spec.ts`'s "an operator can pick a
          release and watch its status take the button's place" clicks the
          real button in Chromium against a real host and watches
          `Status: submitted` arrive through sync, which is a stronger pin than a jsdom render
          could be -- it fails if any hop between this line and
          `POST /api/picks` is wrong, including ones a stubbed `fetch`
          would not exercise. Deliberately not duplicated here: a jsdom
          copy would need a seeded replica and a stubbed global `fetch`,
          and would be a second, weaker statement of the same fact to keep
          in step.
        */}
        <Route path="tv" element={<CategoryScreen store={store} pluginId="tv" tables={NO_TABLES} submit={postPick} />} />
        <Route
          path="movie"
          element={<CategoryScreen store={store} pluginId="movie" tables={NO_TABLES} submit={postPick} />}
        />
        <Route path="xxx" element={<CategoryScreen store={store} pluginId="xxx" tables={NO_TABLES} submit={postPick} />} />
        {/*
          `store` is `undefined` until `createStore` resolves (this component's
          own effect, above); `Unmatched`'s `source` prop is not optional, so
          this route renders nothing for that brief window rather than handing
          it a store that is not there yet. No marker pinned `/unmatched` while
          it was a placeholder, unlike the three category routes -- task 7's
          fix round closed that, and `Shell.test.tsx`'s "the /unmatched route
          renders Unmatched, not a category" now asserts this route's rendered
          content through `Unmatched`'s own `data-testid`.
        */}
        <Route path="unmatched" element={store === undefined ? null : <Unmatched source={store} />} />
        {/*
          `postFeed`, `postDownloadClient`, `mappingSubmit` and
          `destinationSubmit` are the real `submit`s this screen needs
          (`../settings/AddFeed.tsx`'s own doc on why each is injected
          rather than defaulted): wired here, explicitly, rather than given
          a default inside either form that would perform network I/O
          invisibly at every call site. The third is one value carrying
          three verbs -- the add, the edit and the remove a path mapping
          needs -- because all three are the same seam and threading them
          separately would put five submit props on this one element.
          `Settings` is the whole screen -- both sections -- and its own
          docblock says why it is a parent component rather than a second
          section inside `Feeds`.
        */}
        <Route
          path="settings"
          element={
            store === undefined ? null : (
              <Settings
                source={store}
                submitFeed={postFeed}
                submitDownloadClient={postDownloadClient}
                submitMapping={mappingSubmit}
                submitDestination={destinationSubmit}
              />
            )
          }
        />
        {/* Keeps the chrome on screen for any other path -- see this file's doc. */}
        <Route path="*" element={null} />
      </Route>
    </Routes>
  );
}

interface ShellChromeProps {
  counts: Counts;
  onSignOut: () => void;
  /** See `Shell`'s own `storeFailed` state: when true, {@link StoreFailed} takes the `<Outlet />`'s place. */
  storeFailed: boolean;
}

/**
 * The one thing a tab with no replica can honestly show.
 *
 * **A real heading, not a `role="alert"` with an `aria-label`**
 * (`CLAUDE.md`'s longest testing hazard: `IdentityChangeConfirm` shipped a
 * named `role="dialog"` that ten tests asserted on and nobody could read).
 * The `<section>` takes its accessible name from the heading through
 * `aria-labelledby`, so the announced string and the visible one are the
 * same string and cannot drift.
 *
 * **It names no database, url or error.** A `VersionError`'s or an
 * `OpenBlockedError`'s own message carries the replica's name (Global
 * Constraints); the console line in `Shell`'s `catch` is where a developer
 * reads the detail. What a user needs instead is the one action that
 * actually resolves the overwhelmingly likely cause -- another tab holding
 * an older version of the app open, which is what blocks a version bump.
 */
function StoreFailed(): ReactElement {
  return (
    <section aria-labelledby="store-failed-heading">
      <h2 id="store-failed-heading">Pickarr cannot open its local database</h2>
      <p>
        Nothing can be shown until it can. Another tab may still have an older version of Pickarr
        open — close it, then reload this page.
      </p>
    </section>
  );
}

/**
 * The nav and header, rendered once regardless of which category route
 * matched, plus the `<Outlet />` that renders whichever one did -- or
 * {@link StoreFailed} in its place when there is no replica to render from.
 * The chrome itself stays either way, so "Sign out" is still reachable from
 * a tab whose replica never opened. Hoisted out of `Shell` (rather than
 * defined inline in its render) so this component's identity stays stable
 * across `Shell` renders -- an inline layout component would remount on
 * every render, which is wasteful even though nothing here currently has
 * state.
 */
function ShellChrome({ counts, onSignOut, storeFailed }: ShellChromeProps): ReactElement {
  return (
    <div>
      <header>
        <h1>Pickarr</h1>
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      {/*
        `aria-label="Primary"`, not `"Categories"` (fix round 1,
        review-found): the three category links used to be everything this
        nav held, but `/unmatched` and `/settings` below are not categories,
        and a label naming only a third of what it announces is exactly the
        kind of drift `CLAUDE.md`'s stale-doc lesson warns against in prose
        -- an `aria-label` is read aloud the same way.
      */}
      <nav aria-label="Primary">
        <ul>
          {CATEGORIES.map((category) => (
            <li key={category}>
              <NavLink to={`/${category}`}>
                {pluginLabel(category)} <span data-testid={`count-${category}`}>{counts[category]}</span>
              </NavLink>
            </li>
          ))}
          {/*
            Design spec §4: "a nav link beside the three categories and
            `/unmatched`" -- which presumes `/unmatched` already has one.
            It did not (a pre-existing gap from the browse slice); task 5's
            fix round closes it here rather than treating the gap as licence
            to add `/settings` without one too (task 5's review, Finding B).
          */}
          <li>
            <NavLink to="/unmatched">Unmatched</NavLink>
          </li>
          <li>
            <NavLink to="/settings">Settings</NavLink>
          </li>
        </ul>
      </nav>
      {storeFailed ? <StoreFailed /> : <Outlet />}
    </div>
  );
}

