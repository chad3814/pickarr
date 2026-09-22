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

@pickarr/plugin-ui     NEW. The UI seam: the BrowserPlugin interface, and
                       the shared presentational components a card composes
                       (ReleaseList, the expander, the pick button).
                       Depends on react.

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
  readonly rows: Readonly<Record<string, readonly unknown[]>>;
  /**
   * Releases and their downloads, or undefined until gathered. A card
   * renders its collapsed state without this.
   */
  readonly gathered: GatheredItem | undefined;
  /** Called when the card expands, so web gathers lazily as it does now. */
  readonly onExpand: () => void;
  readonly submit: PickSubmit;
}
```

`rows` values are `unknown` for the reason `store/rows.ts` already returns
`unknown`: the row-level surface does not know what any table holds, and
that knowledge belongs to the plugin. Each plugin narrows with the same
`in`-guard style the codebase already uses, never a cast — the "no cast to
silence a type error" rule applies here as everywhere.

## 5. How a card gets its data

Web keeps owning the store, and no new query is added.

`useGatheredItem` already issues **one** `byMediaItem` query that returns
every row for a media item across every synced table, plugin tables
included, and discards what it does not recognise (`gather.ts`). That
discard becomes a partition: rows whose table appears in the rendering
plugin's `tables` go to `rows`, the six host tables go on composing
`gathered` exactly as now.

Consequences, which are the point:

- No plugin imports IndexedDB, `store/rows.ts`, or anything async.
- A card is a pure function of its props and is testable by rendering it
  with literals.
- The collapsed row costs nothing new. `rows` for the collapsed state needs
  only the plugin's own tables, which is one `by_media_item` read.

**Open question deferred to the plan, not to implementation:** whether the
collapsed card's `rows` is fetched eagerly for every row on the page or
per-card. The list already holds every `MediaItemSyncRead`; it does not hold
plugin rows. Fetching per card is simplest and matches today's per-card
poster request; fetching once per page is fewer round trips. Either
satisfies this spec. Measure before choosing.

## 6. The registry, and what derives from it

`packages/web/src/plugins/registry.ts` is the one place naming plugins:

```ts
export const BROWSER_PLUGINS: readonly BrowserPlugin[] =
  [tvBrowser, movieBrowser, xxxBrowser];
```

Four existing hardcoded lists derive from it and stop being written by hand:

| today | after |
|---|---|
| `useCounts.ts`'s `type Category = 'tv' \| 'movie' \| 'xxx'` | derived from the registry |
| `useCounts.ts`'s `CATEGORIES` | `BROWSER_PLUGINS.map(p => p.id)` |
| `Shell.tsx`'s three literal `<Route>`s | one `.map` over the registry |
| `web/src/pluginLabels.ts` | `p.label`; the file is deleted |

`pluginLabels.ts` was added days ago with a documented `Object.hasOwn` guard
against prototype keys, because an unmapped id reached a heading. A registry
of objects has no prototype-key hazard, so that guard and its tests retire
with the file — deliberately, not by oversight.

Adding a plugin becomes: a new directory, plus one import line here.

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
