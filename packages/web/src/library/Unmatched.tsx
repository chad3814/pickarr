/**
 * `/unmatched`: releases a feed delivered that no lookup has attached to a
 * media item yet -- `rss_item` rows whose `mediaItemId` is `null` (design
 * spec §4, acceptance item 3). A category screen's own `pluginId`-keyed
 * index (`by_table_plugin_updated`) cannot show these, because `rss_item`
 * projects `feedId` and no `pluginId` at all and therefore never enters that
 * index -- task 1's own note on why it is self-filtering. This screen reads
 * `rss_item` in modification order through `Store['listByTable']` instead
 * (`by_table_updated`), and does the "`mediaItemId` is null" filtering
 * itself, in memory, over each raw page that index hands back. It is the
 * only production reader in `packages/web/src` that *pages* `listByTable`,
 * and so the only one that pages `by_table_updated`: `useCounts.ts` moved
 * to `by_table_plugin_updated` when counts stopped reading rows, and the
 * category screens page against that index too. **This paragraph used to
 * say "the only production reader of `listByTable`" full stop, and that
 * has not been true for some time** -- `./useFeedNames.ts` and the four
 * settings hooks (`useFeeds`, `useDownloadClients`, `useDestinations`,
 * `useClientMappings`) all call it. Every one of them takes a single
 * bounded page and passes no `from`, which is the distinction that
 * actually matters here and is the one now written down: this screen is
 * the only place a cursor is resumed, and so the only place the walk below
 * costs more than one read.
 *
 * **There is no index on "`mediaItemId` is null", and that is a deliberate
 * choice, not an oversight** (design spec §3.1 weighs the same three options
 * for the category screens; this is the fourth case the same reasoning
 * applies to). Adding one would be a third schema bump -- another full
 * client resync, `SCHEMA_VERSION`'s own cost -- and it is not bought here.
 *
 * **What the scan actually costs, measured rather than argued.** An earlier
 * version of this paragraph claimed the walk "costs an occasional page read
 * that turns up nothing", and its own premise refutes it: if the unmatched
 * set really is the short tail, the walk never reaches its 24-row break and
 * therefore **always runs the table to exhaustion**. Measured against
 * `fake-indexeddb` (whole-branch review §1): 500 `rss_item` rows with one
 * unmatched cost 21 page reads per refresh, every time, and a single further
 * insert cost 21 more. That is the normal case, not the bad one. The cost is
 * accepted here -- one cursor walk of a table one client's feeds filled, in
 * exchange for not bumping the schema a third time -- but it is linear in
 * the whole table and it is paid on *every* wake, which is why the number of
 * wakes is what this screen controls instead (see {@link makeRefresh}).
 *
 * **Two wake-up channels, for two different shapes of change.**
 * `subscribeInserts('rss_item', ...)` fires only when a row becomes newly
 * visible at a key that held nothing before -- a fresh release arriving, or
 * a tombstone revived (`store/apply.ts`: "a revive is still new data
 * appearing at that key") -- and it does **not** fire for a plain field
 * update to a row this screen already holds a value for. That is exactly
 * the shape a live lookup match takes on the wire: `sync/tail.ts`'s
 * `tailSince` never emits `create`, only `upsert` for a row's *current*
 * state, and `store/apply.ts` counts an `upsert` over a row that already
 * carried a value as "touched", never "inserted" -- the same distinction
 * `Changed`'s own doc draws. **This was a real gap in an earlier version of
 * this screen**, found and proven (both by tracing `apply.ts`/`notify.ts`
 * and by an empirical repro) during task 7's review: a matched release
 * could sit on this screen indefinitely with nothing to wake a re-read.
 *
 * The fix is `source.subscribe(table, id, cb)` -- `store/notify.ts`'s
 * per-row channel, which fires on *any* change to `['table', id]`, touched
 * or inserted alike -- subscribed to every id currently on screen, the same
 * mechanism `useGatheredItem.ts` uses for a single media item's own row,
 * applied here to a whole visible list rather than one item. Each time the
 * filtered result changes, the previous page's row subscriptions are torn
 * down and a fresh set is put up for the new page, so a row that drops off
 * (matched) or a row that was never watched (page not yet read) is never
 * silently missed or double-subscribed.
 *
 * **That fix bought a fan-out, which is why both channels share one
 * coalescing refresher.** `store/notify.ts`'s `emit` calls `fireRow` once
 * per touched row, so a batch that matches every listed release wakes this
 * screen once per listed row -- and an uncoalesced refresher answered each
 * wake with its own full-table walk. Measured before the coalescing below
 * existed: 400 `rss_item` rows with 24 listed cost **408** page reads (24
 * independent walks of 17 pages each) for one batch, plus 24 renders each
 * tearing down and rebuilding 24 subscriptions. {@link makeRefresh} turns
 * that into at most two. It matters whenever batches arrive into
 * `rss_item` back to back: a feed poll landing a run of releases, the
 * lookups that follow it resolving in a stream, or a client bootstrapping
 * a replica it does not yet hold.
 *
 * **This paragraph used to name "exactly the event this branch creates:
 * `SCHEMA_VERSION`'s 1->2 bump", and that was wrong twice over.** The bump
 * is on `main` -- `store/db.ts` is untouched by this branch -- so it is
 * not this branch's event; and if a resync really were forced here,
 * {@link textOf} further down would have nothing to be tolerant *of*,
 * since its whole premise is that a replica row written before
 * `lookupJson` existed is never refreshed. Two comments in one file
 * disagreeing about whether the replica had just been rebuilt is what
 * gave it away.
 *
 * **Each release renders as a card, not as a line of a list.** A release
 * here has no `media_item` and so no plugin card of its own, but it should
 * not look like a different application: the `<article>` and the
 * {@link CardHeading} below are the same two pieces a browse card
 * composes, so `styles/library.css`'s `article`, `article h2 button` and
 * `article h2 button small` rules reach this screen with nothing added for
 * it. The trailing label is the feed's name, resolved through
 * {@link useFeedNames}; the body -- behind the same disclosure a browse
 * card uses -- is why the lookup did not match and what the service
 * actually answered, both of which the host has been sending and nothing
 * has been showing.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { LOOKUP_JSON_TOO_LARGE, type RssItemSyncRead } from '@pickarr/contract';
import { CardHeading, useExpansion } from '@pickarr/plugin-ui';
import type { Store } from '../store/index.ts';
import { PAGE_SIZE } from './useMediaItems.ts';
import { useFeedNames } from './useFeedNames.ts';

/**
 * The four `Store` members this screen needs, and nothing else -- so a
 * test can hand it a bare database's `listByTable`, `subscribeInserts`,
 * `subscribe` and `subscribeTable` directly, the way `useCounts.test.tsx`'s
 * `sourceFor` does. A real `Store` satisfies this by structural assignment.
 *
 * `subscribeTable` is here for {@link useFeedNames}'s sake rather than this
 * screen's own reads, and this interface is deliberately a superset of that
 * hook's `FeedNamesSource` rather than a second prop: one `source` means
 * one object identity, and both hooks key their effects on `[source]`, so
 * splitting them would give the caller two things to keep stable instead of
 * one.
 */
export interface UnmatchedSource {
  listByTable: Store['listByTable'];
  subscribeInserts: Store['subscribeInserts'];
  subscribe: Store['subscribe'];
  subscribeTable: Store['subscribeTable'];
}

export interface UnmatchedProps {
  source: UnmatchedSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether `value` is shaped enough like `RssItemSyncRead` for this screen to
 * read `filename` and `mediaItemId` off it. Checks exactly those two fields
 * -- the ones this module dereferences -- and no more (`store/gather.ts`'s
 * own predicates set this precedent: "each predicate checks the fields this
 * module itself dereferences, and no more"). `mediaItemId` is checked
 * against its own nullable type rather than narrowed to `number`, since
 * `null` is the value this whole screen exists to find.
 */
function isRssItem(value: unknown): value is RssItemSyncRead {
  return (
    isRecord(value) &&
    typeof value.filename === 'string' &&
    (value.mediaItemId === null || typeof value.mediaItemId === 'number')
  );
}

/**
 * A string field of a stored row, or `undefined` when there is nothing to
 * show for it.
 *
 * **Read off the record rather than off the narrowed type, and that is the
 * point of this function existing.** {@link isRssItem} above answers
 * `value is RssItemSyncRead`, and that interface declares `resolution:
 * string` and `lookupJson: string | null` -- but it checks neither, so
 * after the narrowing those two fields are *typed* present and may be
 * absent at run time. That is not hypothetical here: `store/gather.ts`'s
 * own doc states the rule ("a replica *persists across client builds* ...
 * `SCHEMA_VERSION` rebuilds it when the store's own schema changes and the
 * generation token rebuilds it when the server's database changes, but
 * neither fires when a **wire shape** changes"), and `lookupJson` is a
 * field this very branch added. A client that was running before it
 * existed holds `rss_item` rows without it, and the host only rewrites a
 * row when something about it changes, so those rows are not refreshed by
 * the upgrade either.
 *
 * Widening {@link isRssItem} to demand the new fields was the alternative
 * and is worse: a row missing one would stop being an unmatched release at
 * all and vanish from the screen, and a release disappearing is the exact
 * failure this screen exists to prevent. Declining to render one *line of
 * a card* is the proportionate loss.
 *
 * The empty string answers `undefined` too. It is not a value worth a
 * label, and rendering it would leave a `<dt>` standing over an empty
 * `<dd>`.
 *
 * **That exclusion has to happen here, because the shared components do
 * not make it.** `CardHeading`'s gate is `trailing !== undefined`, so a
 * `trailing` of `''` renders an empty `<small>` -- and the one card in
 * this repo that passes a trailing label filters the empty string out
 * itself, before passing it, for exactly that reason. An earlier version
 * of this comment credited `CardHeading` with the call; it makes none.
 * The rule is that a shared component renders what it is given, and
 * "there is nothing here" is the caller's fact to establish.
 */
function textOf(value: Record<string, unknown>, field: string): string | undefined {
  const held = value[field];
  return typeof held === 'string' && held !== '' ? held : undefined;
}

/**
 * The `updatedAt` `by_table_updated` sorted `row` by. Every row `listByTable`
 * can return necessarily has a numeric `value.updatedAt` -- that index's own
 * key path is `['table', 'value.updatedAt', 'id']`, and IndexedDB omits any
 * record whose key path does not resolve, so a row missing it could never
 * have been returned in the first place (`store/db.ts`'s doc on
 * `by_table_updated`). Thrown rather than defaulted if that invariant is
 * ever violated: a bad cursor would silently corrupt this screen's paging,
 * which is worse than failing loudly.
 */
function updatedAtOf(row: { value?: unknown }): number {
  if (isRecord(row.value) && typeof row.value.updatedAt === 'number') return row.value.updatedAt;
  throw new Error('a row from by_table_updated has no numeric value.updatedAt, which the index should not allow');
}

/** Whether `err` is IndexedDB's own complaint that the connection underneath a request is already closed -- the same `InvalidStateError` shape `shell/useCounts.ts`'s and `useGatheredItem.ts`'s own `isStoreClosed` check, and for the same reason: this screen can still be mounted and subscribed when the store it reads from stops (sign-out, a 401). Anything else is rethrown. */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/**
 * One unmatched release, as this screen's card renders it.
 *
 * Every field but `id` and `filename` is `string | number | undefined`
 * where the wire's is nullable or newer than some replica: `undefined`
 * means "nothing to show here", and the wire's `null`, an absent field and
 * an empty string all collapse into it because the body renders all three
 * as the same nothing. {@link textOf} has why that tolerance is needed at
 * all.
 */
interface UnmatchedRow {
  readonly id: number;
  readonly filename: string;
  /** Which feed delivered it, for {@link useFeedNames} to name. */
  readonly feedId: number | undefined;
  /** `@pickarr/contract`'s `Resolution` vocabulary: what became of this release's identification. */
  readonly resolution: string | undefined;
  /** The host's own sentence about that outcome. */
  readonly resolutionDetail: string | undefined;
  /** The lookup service's answer, as stored -- or the `LOOKUP_JSON_TOO_LARGE` marker in place of one too big to keep. */
  readonly lookupJson: string | undefined;
}

/**
 * Walks `rss_item` newest-first through `source.listByTable`, keeping only
 * the rows whose `mediaItemId` is `null`, until either enough have been
 * collected for one screen or the table is exhausted. See this file's
 * docblock for why the filter lives here instead of in an index.
 */
async function readUnmatched(source: UnmatchedSource): Promise<readonly UnmatchedRow[]> {
  const collected: UnmatchedRow[] = [];
  let from: { updatedAt: number; id: number } | undefined;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous page's last row, so the walk is inherently sequential
    const page = await source.listByTable('rss_item', {
      ...(from !== undefined ? { from } : {}),
      direction: 'prev',
      limit: PAGE_SIZE,
    });

    for (const row of page) {
      // `isRecord` before `isRssItem`, so the narrowed value keeps its
      // index signature and {@link textOf} can reach fields that guard
      // does not check. `isRssItem` alone narrows to an interface, which
      // has none.
      const value: unknown = row.value;
      if (!isRecord(value) || !isRssItem(value) || value.mediaItemId !== null) continue;
      collected.push({
        id: row.id,
        filename: value.filename,
        feedId: typeof value.feedId === 'number' ? value.feedId : undefined,
        resolution: textOf(value, 'resolution'),
        resolutionDetail: textOf(value, 'resolutionDetail'),
        lookupJson: textOf(value, 'lookupJson'),
      });
    }

    if (page.length < PAGE_SIZE) break; // the table's earliest row was reached
    if (collected.length >= PAGE_SIZE) break; // enough for one screen

    const last = page[page.length - 1];
    // `page.length === PAGE_SIZE` here (neither break fired), so `page` is
    // non-empty and `last` is defined.
    if (last === undefined) break;
    from = { updatedAt: updatedAtOf(last), id: last.id };
  }

  return collected;
}

/**
 * Builds the one refresher both of this screen's wake-up channels call:
 * re-read `source`, apply the result through `apply`, unless the component
 * has since unmounted. A store-closed rejection is swallowed (the same race
 * `useCounts.ts`'s and `useGatheredItem.ts`'s own `isStoreClosed` guards --
 * `Unmatched` can still be mounted and subscribed when the store it reads
 * from stops, sign-out or a 401); anything else is rethrown.
 *
 * **Wakes coalesce; they do not queue.** A wake arriving while a walk is
 * already in flight sets a "read again when this one finishes" flag rather
 * than starting a second walk, and the flag is one bit rather than a count
 * because {@link readUnmatched} is idempotent -- ten wakes and one wake want
 * the same single re-read of the same table. So one batch costs at most two
 * walks whatever it touched: the one already running, which may have started
 * before the batch committed and so cannot be trusted to have seen it, and
 * one more after it, which necessarily has. See this file's docblock for the
 * 408-page-read measurement that made this necessary.
 *
 * Shared by both effects rather than written out twice, so the two channels
 * cannot drift into reading the replica two different ways -- and, now that
 * they share it, cannot walk the table concurrently and apply their two
 * answers in whichever order finished last.
 */
function makeRefresh(
  source: UnmatchedSource,
  apply: (rows: readonly UnmatchedRow[]) => void,
  isCancelled: () => boolean,
): () => void {
  let walking = false;
  let wakeArrivedWhileWalking = false;

  function walk(): void {
    walking = true;
    readUnmatched(source)
      .then((next) => {
        if (!isCancelled()) apply(next);
      })
      .catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      })
      .finally(() => {
        walking = false;
        if (!wakeArrivedWhileWalking) return;
        wakeArrivedWhileWalking = false;
        if (!isCancelled()) walk();
      });
  }

  return () => {
    if (walking) {
      wakeArrivedWhileWalking = true;
      return;
    }
    walk();
  };
}

/**
 * What every card on this screen hands {@link useExpansion}, hoisted to
 * module scope rather than written inline.
 *
 * **Why this screen reports nothing.** That callback exists so web can
 * start and stop *gathering* for a browse card -- `MediaItemCard` turns a
 * `useGatheredItem` subscription on when a card opens and off when it
 * closes, which is what keeps a page of 24 collapsed cards from holding
 * subscriptions nobody asked for (`plugin-ui/src/expansion.tsx`'s own
 * measurement: 72 live subscriptions for 24 closed cards). This screen
 * gathers nothing. Everything {@link UnmatchedDetail} renders is already
 * in the {@link UnmatchedRow} the card was handed, so opening one costs no
 * read and closing one has nothing to release.
 *
 * **Hoisted, and that is not style.** `useExpansion` memoises `toggle` on
 * this callback (`useCallback(..., [onExpandedChange])`), so an inline
 * `() => {}` would be a fresh identity per render and hand every card on
 * the page a new `onClick` prop every time the list re-rendered -- which
 * on this screen is once per wake, and this screen is woken by every row
 * it lists. One shared constant makes `toggle` stable for a card's whole
 * life.
 */
const REPORTS_NOTHING = (): void => {};

/**
 * The body behind a card's disclosure: why the lookup did not match this
 * release, and what the service said.
 *
 * A `<dl>` because that is what this is -- three labelled values, not
 * prose and not a table. `styles/library.css` styles it structurally;
 * these four element types appear nowhere else in the rendered app, so no
 * class is needed and none is added (web's stylesheets set none anywhere).
 *
 * **`resolution` is rendered as the word the host recorded, not mapped to
 * a sentence.** The column is unconstrained TEXT and nothing narrows it on
 * the way here (`RssItemSyncRead.resolution`'s own doc), so any mapping
 * would need a fallback for a word this build does not know -- and the
 * vocabulary is already plain English: `pending`, `refused`, `unresolved`.
 * The sentence an operator actually wants is `resolutionDetail`, which the
 * host writes for exactly that purpose. The `<dt>` reads `State` rather
 * than `Resolution` because `ReleaseList` shows a *video* resolution under
 * that word, and the two are unrelated columns.
 *
 * **A pair whose value is absent renders neither half.** There is no
 * empty `<pre>` for a release whose lookup never ran, and no `Lookup
 * answer` label standing over nothing: a bordered box containing nothing
 * reads as a bug, and the state line above it already says `pending`.
 */
function UnmatchedDetail({ row }: { row: UnmatchedRow }): ReactElement {
  return (
    <dl>
      {/*
        `not recorded` rather than omitting the pair, because unlike the
        other two this one is never legitimately absent: the host has
        written `resolution` for every release since the column existed.
        Absent here means a replica row older than this build understands
        ({@link textOf}), and saying so is more use than a card that
        quietly opens onto less than the next one.
      */}
      <dt>State</dt>
      <dd>{row.resolution ?? 'not recorded'}</dd>
      {row.resolutionDetail !== undefined && (
        <>
          <dt>Detail</dt>
          <dd>{row.resolutionDetail}</dd>
        </>
      )}
      {row.lookupJson !== undefined && (
        <>
          <dt>Lookup answer</dt>
          {row.lookupJson === LOOKUP_JSON_TOO_LARGE ? (
            /*
              The marker is an implementation detail of the column -- what
              the host stores *instead of* an answer over
              `LOOKUP_JSON_CAP_BYTES` -- and it is valid JSON precisely so
              that a client can recognise it rather than render wreckage
              (its own doc in `@pickarr/contract`). Recognising it and then
              printing it would waste that: `{"pickarr":"lookup-answer-too-
              large"}` in a code block reads as the service's answer, which
              is the one thing it is not.
            */
            <dd>The service answered, but the answer was too large to keep.</dd>
          ) : (
            <dd>
              {/*
                Verbatim, and not re-serialised for looks. This is the
                string the replica holds; a `JSON.parse` / `stringify`
                round trip to pretty-print it would throw on anything this
                build cannot parse -- and "what the service actually said"
                stops being true the moment something reformats it.
              */}
              <pre>{row.lookupJson}</pre>
            </dd>
          )}
        </>
      )}
    </dl>
  );
}

/**
 * One unmatched release.
 *
 * The same two pieces a browse card composes, so this screen's title line
 * *is* the browse card's title line -- `article h2 button` and `article h2
 * button small` already style it and no rule of its own is added. An
 * unmatched release has no `media_item` and so no plugin card, but it
 * should not look like a different application.
 *
 * `trailing` is spread in conditionally rather than passed as
 * `trailing={feedName}`: `exactOptionalPropertyTypes` distinguishes an
 * absent key from an explicit `undefined`, and `CardHeading` renders no
 * `<small>` at all only for the absent one.
 */
function UnmatchedCard({ row, feedName }: { row: UnmatchedRow; feedName: string | undefined }): ReactElement {
  const { expanded, toggle } = useExpansion(REPORTS_NOTHING);

  return (
    <article>
      <CardHeading
        headline={row.filename}
        {...(feedName === undefined ? {} : { trailing: feedName })}
        expanded={expanded}
        onToggle={toggle}
      />
      {expanded && <UnmatchedDetail row={row} />}
    </article>
  );
}

export function Unmatched({ source }: UnmatchedProps): ReactElement {
  // `undefined` means "still loading" -- distinct from an empty array, which
  // means "loaded, and there is nothing" (Global Constraint: zero is an
  // answer, and the two must not render the same way).
  const [rows, setRows] = useState<readonly UnmatchedRow[] | undefined>(undefined);

  // `feedId -> name`, for the trailing label on each card's title line.
  // Kept current by its own `subscribeTable` subscription, so a feed
  // renamed on the settings screen relabels these cards without a reload;
  // an id no feed claims is simply absent from the map, which is exactly
  // the `undefined` `CardHeading`'s optional `trailing` wants
  // (`useFeedNames.ts`'s own doc).
  const feedNames = useFeedNames(source);

  // The one refresher, held across the row-subscription effect's many
  // re-runs -- coalescing is worthless if each re-run builds its own, since
  // the fan-out being coalesced arrives through those very subscriptions.
  // `undefined` between unmount and the effect below re-establishing it, so
  // a wake that somehow outlives its own unsubscribe does nothing rather
  // than reading from a store this screen no longer owns.
  const refreshRef = useRef<(() => void) | undefined>(undefined);

  // Wakes on a fresh or revived `rss_item` row -- see this file's docblock
  // for exactly which changes this channel does and does not see. Runs for
  // the whole life of this component; `source` is fixed for that lifetime,
  // matching every other screen's own `[store]`-only effect. This is also
  // where the shared refresher is created and torn down, so its "cancelled"
  // means unmounted rather than "the listed set changed", which is what
  // lets a walk started under one page of rows still apply under the next.
  useEffect(() => {
    let cancelled = false;
    const refresh = makeRefresh(source, setRows, () => cancelled);
    refreshRef.current = refresh;

    refresh();
    const unsubscribe = source.subscribeInserts('rss_item', refresh);
    return () => {
      cancelled = true;
      refreshRef.current = undefined;
      unsubscribe();
    };
  }, [source]);

  // Wakes on a plain update to any release *currently listed here* -- the
  // one shape `subscribeInserts` cannot see (this file's docblock). Torn
  // down and rebuilt whenever `rows` changes, so the subscribed set always
  // matches what is actually on screen: a row that just dropped off is not
  // still watched, and a row that just appeared is watched from the moment
  // it does. Every one of these subscriptions calls the *shared* refresher,
  // which is what turns a batch touching all of them into one re-read.
  useEffect(() => {
    if (rows === undefined) return undefined;

    const unsubscribes = rows.map((row) => source.subscribe('rss_item', row.id, () => {
      refreshRef.current?.();
    }));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [source, rows]);

  return (
    <section aria-labelledby="unmatched-heading" data-testid="unmatched">
      <h1 id="unmatched-heading">Unmatched</h1>
      {rows !== undefined &&
        (rows.length === 0 ? (
          <p>Everything has been matched.</p>
        ) : (
          rows.map((row) => (
            <UnmatchedCard
              key={row.id}
              row={row}
              feedName={row.feedId === undefined ? undefined : feedNames.get(row.feedId)}
            />
          ))
        ))}
    </section>
  );
}
