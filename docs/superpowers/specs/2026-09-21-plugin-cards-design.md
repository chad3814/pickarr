# Plugin-owned browse cards

## 1. What is wrong today

A TV row in the browse list reads `Dio's World(3)`. It should read
`Jo Jo's Bizarre Adventure S02E47 Dio's World(3)`.

The data is already in the browser. `tv_release` replicates with
`seriesTitle`, `seasonNumber`, `episodeNumber` and `kind`
(`contract/src/sync.ts`'s `TvRead`), and the replica indexes
`value.mediaItemId` as `by_media_item` (`web/src/store/db.ts:96`). Nothing
renders any of it, because `MediaItemCard` renders `item.title` and nothing
else.

That is a ten-line fix, and it is not the thing being built here. The reason
it cannot simply be written into `MediaItemCard` is that
`web/src/store/gather.ts` already states the rule this repo intends:

> **Plugin-blind by construction.** This module names exactly six tables
> [...] and no others. [...] A plugin's own `compose.ts` reads the rows this
> one ignores. That split is what makes a new plugin a new directory rather
> than an edit here.

No `compose.ts` exists. The split is described and was never built, so every
plugin-shaped question in the browser has nowhere to go. All three plugins
have one: `tv` wants series and episode numbering, `xxx` has `siteName`
(`XxxRead`), `movie` has `runtimeMinutes` and `tagline` (`MovieRead`).

This spec builds the seam, and the TV headline is its first consumer.

## 2. Scope

**A plugin owns its card body** — everything below the poster: the title
line, the expander, the release list, the pick button, and their markup,
behaviour and accessibility.

**Web owns that body's styling**, along with the poster, routing, paging,
the replica, and the shell. A plugin ships markup and behaviour, not CSS.

This is the widest of the three options considered, chosen deliberately. §9
records what it costs and what contains the cost.

### 2.1 Why styling stayed in web (amended after the whole-branch review)

The first version of this section gave the plugin "their accessibility and
styling". The implementation delivered the accessibility half and not the
styling half, and nothing recorded the divergence: every rule that reaches a
plugin's card markup lives in `packages/web/src/styles/library.css` —
`article h2`, `article h2 button`, and seven rules selecting under
`ul[aria-label='releases']`, counted on the tree — no plugin package ships
a stylesheet, and no mechanism exists for one to. The Global Constraint "no raw values outside `tokens.css`" points
the same way.

The boundary is therefore drawn where the code drew it, rather than left as
a promise the seam does not keep. **Web keeps the styling for now.**

What that costs, stated so it is not discovered later:

- A plugin whose card needs a rule of its own needs a second edit, in
  another package's stylesheet, and nothing detects the omission. The card
  renders unstyled while every `getByRole` still passes — which is
  `CLAUDE.md`'s longest testing hazard (`IdentityChangeConfirm`: correct
  roles, ten passing tests, no stylesheet rule, reported broken by its first
  user) reproduced at this seam.
- A plugin author outside this repo — the audience §11 puts out of scope
  anyway — cannot style a card at all.
- Web's stylesheet is now the likely shape of a per-plugin rule, which is
  why acceptance 7's scan was widened to read `.css` files under
  `packages/web/src`: a `.category-<id>` rule is the same "second place
  naming a plugin" that acceptance 7 exists to forbid.

A mechanism for plugin-shipped CSS — a scoped stylesheet per plugin, or a
documented class contract web guarantees — is deliberately **not** built
here, and is the change to make when a plugin first needs one. Until then
`@pickarr/plugin-ui`'s `BrowserPlugin` docblock is where a card author is
told that web's stylesheet is what styles their markup.

## 3. Packages and their boundaries

```
@pickarr/contract      data shapes only. No React. Unchanged by this work
                       except where noted.

@pickarr/plugin-ui     NEW. The UI seam: the BrowserPlugin and CardProps
                       interfaces, the view types a card is handed, and the
                       shared presentational component a card composes --
                       ReleaseList, which carries the pick button inside it.
                       react is a peerDependency.

@pickarr/plugin-tv     gains src/browser.tsx, exporting one BrowserPlugin.
@pickarr/plugin-movie  same.
@pickarr/plugin-xxx    same.

@pickarr/web           gains src/plugins/registry.ts -- the one list.
                       Loses MediaItemCard's body and ReleaseList.
```

**Why `@pickarr/plugin-ui` and not `@pickarr/contract`.** Contract is the
data protocol and is imported by the host, every plugin, and the browser. A
React component type in it would put `@types/react` on all of them to
describe something only the browser uses.

**Why a shared UI package at all, rather than each plugin writing its own
card outright.** Three plugins owning a card body means three release lists,
three pick buttons and three sets of accessibility decisions.
`CLAUDE.md`'s "getByRole and getByText cannot see whether a component is
legible" entry describes a component that shipped with correct roles, ten
passing tests, and no stylesheet rule, and was reported as broken by its
first user. That hazard is paid once per component, so the components are
shared and each plugin composes them.

**How far that got, amended after the whole-branch review.** The release
list and the pick button are shared exactly once, in `ReleaseList.tsx`. The
**expander is not**: each of the three cards writes its own
`<h2><button aria-expanded={expanded}>`, one site per plugin
(`plugin-tv/src/browser.tsx`, `plugin-movie/src/browser.tsx`,
`plugin-xxx/src/browser.tsx`), along with its own `useState` and its own
`onExpandedChange` call. So one set of accessibility decisions — the
disclosure pattern — is written three times rather than once, and a fourth
card would write it a fourth time.

That is deliberate as far as `aria-expanded` goes (Ruling 13: the card owns
its own disclosure semantics, because the attribute belongs to the element
the plugin renders), and it is a real cost the paragraph above does not
charge: the duplicated part includes the `onExpandedChange`-on-every-
transition obligation that §4.1 explains, which is the one a plugin can get
wrong alone. A shared expander taking `expanded`, `onExpandedChange` and
children would pay it once; it was not built, and is the change to make if a
fourth card repeats it again.

## 4. The `BrowserPlugin` contract

Declared in `@pickarr/plugin-ui`.

```ts
export interface BrowserPlugin {
  /** Matches MediaItemSyncRead.pluginId and the host plugin's id. */
  readonly id: string;
  /** What the nav and headings call this category. */
  readonly label: string;
  /**
   * Replica tables this plugin's card reads. Web fetches these rows and
   * hands them to Card; the plugin never touches the store.
   */
  readonly tables: readonly string[];
  readonly Card: ComponentType<CardProps>;
}

export interface CardProps {
  /** The media item, already held by the list. Always present. */
  readonly item: MediaItemSyncRead;
  /**
   * Rows from this plugin's declared tables for this media item, keyed by
   * table name. Empty arrays, never absent keys, for a table with no rows.
   * Values are `unknown`: the plugin narrows them, because the store does
   * not know what shape any table holds.
   */
  readonly rows: PluginRows;
  /**
   * Releases and their downloads, or undefined until gathered. A card
   * renders its collapsed state without this.
   */
  readonly gathered: GatheredItemView | undefined;
  /**
   * Tells web this card's expanded state changed, with the state the card
   * is moving *to*. Called on every transition, closing included.
   */
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly submit: PickSubmit;
}
```

`rows` values are `unknown` for the reason `store/rows.ts` already returns
`unknown`: the row-level surface does not know what any table holds, and
that knowledge belongs to the plugin. Each plugin narrows with the same
`in`-guard style the codebase already uses, never a cast — the "no cast to
silence a type error" rule applies here as everywhere. `PluginRows` is the
name that alias ended up with, and it is exactly
`Readonly<Record<string, readonly unknown[]>>`.

### 4.1 Two members changed during implementation (amended after the whole-branch review)

The block above is the shipped interface,
`packages/plugin-ui/src/plugin.ts:21-63`. Two members are not what the first
version of this section declared, and the first version is what this document
carried until now — a spec describing an interface the code did not have,
while every test passed. What it said, and why the code says otherwise:

**`onExpand: () => void` became
`onExpandedChange: (expanded: boolean) => void`** (`plugin.ts:61`), under
Ruling 12.

`onExpand` gave web no way to learn that a card had *closed*, so web's only
possible state was a latch — "has this card ever been opened" — which kept
`useGatheredItem` enabled for the life of the list and moved the subscription
fan-out from "cards currently open" to "cards ever opened", which is unbounded
in a paging list. Measured on 24 cards opened and then closed again: **72 live
subscriptions, and 24 IndexedDB transactions for a single `torrent_download`
insert with nothing expanded on screen.** The same scenario now holds 0 and
costs 0.

**One callback carrying the new value, not an `onExpand`/`onCollapse` pair.**
A pair would have fixed the fan-out and left a worse hazard: a plugin may call
one and forget the other, which silently reinstates the latch for that plugin
alone and is invisible to every test of the other two cards. One callback
taking the new value cannot be half-implemented — there is one call site per
card and the value is the whole message. This is recorded here, and not only
in the code, because it is exactly the kind of thing a later reader
"simplifies" back into a pair.

What it costs: the card owns its `expanded` state and web mirrors it, so the
same fact lives in two places (Ruling 13 parked that deliberately — the
duplication is what lets the card own its own `aria-expanded` while web owns
the fetch gate), and a card that never calls the callback renders an expander
that reveals nothing. That is a loud failure rather than a quiet one, which is
the trade taken.

**`gathered: GatheredItem | undefined` became
`GatheredItemView | undefined`** (`plugin.ts:31`,
`packages/plugin-ui/src/types.ts:50`).

`GatheredItem` is web's own type (`web/src/store/gather.ts:166`) and
`@pickarr/plugin-ui` must not import web — §3's dependency direction. So the
seam declares the narrower view it actually needs, and web proves its own type
satisfies it through `gatherSatisfiesView` (`gather.ts:275`), cast-free per
Ruling 3. Renaming a field on `GatheredRelease` produces
`error TS2322: Type 'GatheredItem' is not assignable to type
'GatheredItemView'` at that function, so the two cannot drift silently.

The same rename runs through `GatheredRelease`/`GatheredReleaseView` and
`GatheredDownload`/`GatheredDownloadView`.

## 5. How a card gets its data

Web keeps owning the store, and no plugin touches it.

**A page's plugin rows are read once, for every card on the page, before any
of them expand.** `store/rows.ts`'s `pluginRowsByMediaItems(db, mediaItemIds,
tables)` (`rows.ts:304`) opens **one** transaction and issues one
`by_media_item` `getAll` per id on it, answering a map from media item id to
`PluginRows`. Every table in `tables` is a key for every id, always, with an
empty array where that id has no rows — an absent key would read as "not
fetched", which a caller cannot tell from "fetched, and empty".
`library/usePluginRows.ts`'s `usePluginRows` (`usePluginRows.ts:232`) is the
hook, and `Category` hands each card its own entry.

`usePluginRows` also **subscribes to inserts on each declared table**,
because `/api/sync` is a `sync_log` walk applied in batches and does not
promise to deliver a plugin row in the same batch as its `media_item`
(`@pickarr/contract`'s `TvSeasonRead` doc states the non-ordering outright).
Without that subscription the late-arrival case was permanent: the effect is
keyed on `[source, mediaItemIds, tables]`, a plugin row arriving for an id
already on screen changes none of the three, and this screen does not poll —
so the card rendered `item.title` and nothing ever woke it until a remount.
Mid-backfill is 2.0's *normal first-run condition*, so the likeliest time to
meet a plugin's card was the one time it silently did not work. The
subscription is filtered to the ids on the page, so one insert elsewhere does
not refetch every mounted browse screen.

Consequences, which are the point:

- No plugin imports IndexedDB, `store/rows.ts`, or anything async.
- A card is a pure function of its props and is testable by rendering it
  with literals.
- The collapsed row is served. It costs one transaction for the whole page,
  paid once alongside the list read it already does.

### 5.1 This replaced a gather-level partition (amended after the whole-branch review)

The first version of this section said the `byMediaItem` read inside
`useGatheredItem` "discards what it does not recognise" and that "that
discard becomes a partition: rows whose table appears in the rendering
plugin's `tables` go to `rows`". **That was built, and reverted under
Ruling 7**, and this document described the reverted design until now — which
matters because the plan argues from this document.

Why it cannot work: `useGatheredItem` returns `undefined` unless the card is
expanded, and `gatherMediaItem` under it only runs then. So routing `rows`
through the gather means a **collapsed** card has no plugin rows — and the
collapsed headline is the entire point of the branch (§4, acceptance 1). The
contradiction was inside this section: its own third bullet claimed "the
collapsed row costs nothing new … one `by_media_item` read", which the
opening paragraph's design could not deliver. Ruling 7 resolved it in favour
of §4, and `store/gather.ts:13-22` carries the same note on the code side.

**The open question is closed.** It asked whether the collapsed card's `rows`
is fetched per page or per card, and said "measure before choosing".
Measured: `packages/web/test/store/rows.test.ts:133-167` counts real
`db.transaction` calls for a page of 50 ids and asserts **1**, where a
per-card fetch opens **50** — `rowsStore` opens a transaction per call. And
per-card cannot serve a collapsed card at all, for the reason above, so the
measurement decided a question that had already been settled by correctness.
Per page it is.

What it costs, so it is not discovered later: "load more" refetches the whole
accumulated id list per page, so the `getAll` count is quadratic in pages
(50, then 100, then 150 …) while staying one transaction. Filed rather than
fixed.

## 6. The registry, and what derives from it

`packages/web/src/plugins/registry.ts` is the one place naming plugins:

```ts
export const BROWSER_PLUGINS: readonly BrowserPlugin[] =
  [tvBrowser, movieBrowser, xxxBrowser];
```

Four existing hardcoded lists derive from it and stop being written by hand:

| today | after |
|---|---|
| `useCounts.ts`'s `type Category = 'tv' \| 'movie' \| 'xxx'` | **deleted**; the ids are plain `string` |
| `useCounts.ts`'s `CATEGORIES` | `BROWSER_PLUGINS.map(p => p.id)` (`useCounts.ts:41`) |
| `Shell.tsx`'s three literal `<Route>`s | one `.map` over the registry (`Shell.tsx:222-230`) |
| `web/src/pluginLabels.ts` | `p.label`; the file is deleted |

`pluginLabels.ts` was added days ago with a documented `Object.hasOwn` guard
against prototype keys, because an unmapped id reached a heading. A registry
of objects has no prototype-key hazard, so that guard and its tests retire
with the file — deliberately, not by oversight.

### 6.1 What adding a plugin actually takes (amended after the whole-branch review)

This section said "adding a plugin becomes: a new directory, plus one import
line here." That undercounts, and it missed two lists outside
`packages/web/src` that the registry does not and cannot drive. Enumerated on
the tree:

| edit | why the registry cannot cover it |
|---|---|
| `registry.ts`: one import, one array entry | the seam itself |
| `@pickarr/contract`'s `TOKEN_NAMES_BY_PLUGIN` (`contract/src/tokens.ts:152-156`) | another package's list, which `Settings.tsx` maps over to build the Library-destinations rows. A plugin absent from it gets a row headed by its raw id and offering no path tokens (`Destinations.tsx:261`). |
| `packages/e2e/src/harness-2.ts`'s `Category` union (`:145`) and `PLUGIN_SCHEMA` (`:168`) | `packages/e2e` cannot import web — its dependencies are `contract`, `host` and `plugin-tv` — so this literal is necessary and nothing cross-checks it against `CATEGORIES`. |
| a `library.css` rule, **if** the card needs one | web owns the styling (§2.1) |

Today the two id lists agree — `Object.keys(TOKEN_NAMES_BY_PLUGIN)` is `tv,
movie, xxx` — so nothing is broken, and none of these is a defect. The
original sentence was, because a plan arguing "one import line" from this
document would have budgeted one edit for four.

**What stays hardcoded and why.** Route *paths* still equal plugin ids, and
`/unmatched` and `/settings` are not categories. The registry drives which
category routes exist, not the shell's shape.

## 7. What each plugin's card renders

### 7.1 TV — the headline

One rule, no branching on `kind`:

1. Start with `seriesTitle`.
2. Append `S{season}` when `seasonNumber` is non-null, and `E{episode}`
   when `episodeNumber` is non-null, as one token: `S02E47`, `S02`, `E47`,
   or nothing. Each number is zero-padded to two digits and not truncated
   above that (`S02E147`).
3. Append `item.title` **unless it equals `seriesTitle`**.

Joined with single spaces.

| case | renders |
|---|---|
| episode, season known | `Jo Jo's Bizarre Adventure S02E47 Dio's World(3)` |
| episode, no season | `Jo Jo's Bizarre Adventure E47 Dio's World(3)` |
| season pack | `Jo Jo's Bizarre Adventure S02 Season 2` |
| series pack | `Jo Jo's Bizarre Adventure` |

**Why step 3 exists, verified in code rather than assumed.**
`media_item.title` is the lookup document's `media.title`
(`openmetadata/src/engine.ts:141`). For a series pack that is the series
name, so without the equality check the row would read `Jo Jo's Bizarre
Adventure Jo Jo's Bizarre Adventure`. The check also costs nothing in the
episode case, where the two never match.

The season-pack row is mildly redundant (`S02 Season 2`) and that is
accepted rather than special-cased: `kind` remains on `TvRead`, so an
explicit `(season pack)` treatment is a later change with no contract
consequence.

A media item with no `tv_release` row renders `item.title` alone, which is
today's behaviour.

### 7.2 Movie and XXX

Their cards render `item.title` and reuse the shared release list — the same
output as today, through the new seam. `MovieRead.runtimeMinutes`/`tagline`
and `XxxRead.siteName` are available to them and **are not used in this
work**. Porting them unchanged is what proves the seam is not TV-shaped.

## 8. Build, types and tests

**Measured, not assumed** (spiked on `2a2fde4`, then reverted):

- A `./browser` subpath export resolves and bundles. Web's production
  bundle gained the plugin component with **zero** `node:` imports and no
  `drizzle`/`DatabaseSync`. The plugin's node-only problem is `index.ts`'s
  import graph, not the package.
- The production build does **not** use the `development` condition, so each
  plugin must emit `dist/browser.js`: a second esbuild entry with
  `--platform=browser`. The root `build` script already orders plugins
  before web.
- `react` becomes a `peerDependency` of each plugin package and of
  `@pickarr/plugin-ui`.
- `@pickarr/plugin-*` move from web's `devDependencies` to `dependencies`,
  since production code now imports them. **Only the `/browser` subpath may
  be imported by web's `src/`**; importing the root would reach
  `node:sqlite` and fail the build. This is a real footgun and needs a test
  that fails on it, not a comment.

**Tests.** `test:web` widens from `packages/web/test/**/*.test.tsx` to
`packages/*/test/**/*.test.tsx`, so plugin card tests run under the same
happy-dom setup and the same `check-test-hygiene` enforcement. The hazards
in `CLAUDE.md` apply unchanged: `afterEach(cleanup)`, never a live DOM
element in a `node:assert` equality helper.

## 9. Acceptance

1. A TV episode row reads `Jo Jo's Bizarre Adventure S02E47 Dio's
   World(3)`, in the browser, proven by an e2e assertion on rendered text.
2. Each of the four cases in §7.1's table renders as stated, driven by unit
   tests over literal `TvRead` values.
3. A media item with no plugin row renders `item.title` alone.
4. Movie and XXX rows render exactly what they render today.
5. The web production bundle contains no `node:` import and no `drizzle` or
   `DatabaseSync`, asserted by a test over the built bundle — not by
   inspection.
6. A test fails if web's `src/` imports a plugin package's root entry
   instead of its `/browser` subpath.
7. `packages/web/src` names no plugin id outside `plugins/registry.ts`,
   asserted by a test.
8. Deleting a plugin from the registry removes its route, its nav entry and
   its count, with no other edit.
9. The card is legible, not merely queryable: a two-sided computed-style
   pin, per issue #90 and the `CLAUDE.md` legibility entry.
10. Full gate green: lint, typecheck, test-hygiene, server and web suites,
    build, e2e.

## 10. Risks, and what contains them

**This is a refactor of the browse screen, not an additive change.**
`MediaItemCard`'s body and `ReleaseList` move out of web. The headline that
prompted the work is ten lines inside it. The containment is that movie and
xxx port *unchanged* (§7.2), so any behavioural difference in those two is a
seam defect rather than an intended change, and acceptance 4 is what catches
it.

**Three cards can drift apart.** Contained by `@pickarr/plugin-ui` owning
every shared piece, and by acceptance 4.

**The root-import footgun** (§8) is the one that silently breaks the
production build while every test passes. Acceptance 6 exists because a
comment would not survive.

## 11. Out of scope

- Runtime-loaded or third-party plugin UI. The registry is build-time and
  typed; a dynamic seam is a different design with versioning and CSP
  questions.
- Surfacing `runtimeMinutes`, `tagline` or `siteName` (§7.2).
- An explicit season-pack or series-pack label (§7.1).
- Artwork; still not replicated (design spec §1.2, #79).
- Any host, schema, migration or sync change. This work is browser-only,
  which is why no migration appears in it.
