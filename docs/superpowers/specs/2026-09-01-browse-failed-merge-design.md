# Browse ⊕ Failed — Design

The Failed tab is deleted. The names the parser refused appear as cards in
Browse's own list, interleaved with the groups by recency, and the ones a reader
has set aside move to a Dismissed tab of their own.

## 1. What this delivers

A name the parser refused is currently invisible from the screen where a reader
is looking at their library. Fixing one means remembering it is there, going to
another tab, and working a list that has no relationship to what Browse shows.
After this change the refusal sits in the list, in the position its arrival time
earns it, with the same `Fix…` form it has now.

Both card kinds render in both of Browse's views — the card list and the
master/detail split view — so switching views never changes which items exist.

### 1.1 What this is not

- **No un-dismiss.** There is no endpoint for it today and this adds none. A
  dismissed item leaves the Dismissed tab by being fixed.
- **No change to what makes a group browsable.** `BROWSABLE` in
  `packages/core/src/db/groups.ts` is untouched.
- **No Picks pagination.** Still its own separate piece of work.
- **No new visual language for a failed card.** It reuses the media card's frame
  and the error colour the app already uses for failures.

### 1.2 The cost this accepts, stated first

Measured on a real database: **3161 browsable groups against 142 open failed
items**, and the failed items' `first_seen_at` spans 2026-08-22 to 08-25, inside
the groups' 07-22 to 08-27 range. Interleaved strictly by recency, a failed card
arrives roughly every twenty-second card through that window, and the newest page
is all groups.

This was raised before the design was chosen and chosen anyway, deliberately: the
alternative — a block of failed cards above or below the groups — keeps them
findable but makes the merge cosmetic. Recording it here so nobody later reads
the ratio as an oversight.

## 2. One list, ordered by the server

`/api/browse` stops returning groups and returns a discriminated union:

```ts
export type BrowseItem =
  | { kind: 'group'; group: GroupView }
  | { kind: 'failed'; item: FailedItemView };

export interface BrowseResponse {
  items: BrowseItem[];
  nextCursor: string | null;
}
```

The ordering is the server's to own, for the reason `views.ts` already gives
about `BROWSABLE`: a client deciding for itself from two lists "would be a second
copy of that rule, free to drift", and a client that patched a card into a
position the server would not have returned is a list that quietly stops matching
the database.

**The query.** Each branch is bounded by the cursor and limited *before* the
union, so the outer sort never sees more than two pages' worth:

```sql
SELECT 'group' AS kind, id, list_rank_at AS sort_key FROM media_groups
 WHERE <BROWSABLE> AND <keyset> AND <search?>
 ORDER BY list_rank_at DESC, id ASC LIMIT :limit
UNION ALL
SELECT 'failed' AS kind, id, first_seen_at AS sort_key FROM feed_items
 WHERE parse_error IS NOT NULL AND dismissed_at IS NULL AND <keyset> AND <search?>
 ORDER BY first_seen_at DESC, id ASC LIMIT :limit
ORDER BY sort_key DESC, kind ASC, id ASC LIMIT :limit
```

Both branches have a purpose-built index — `media_groups_browse (list_rank_at
DESC)` and the partial `feed_items_failed (first_seen_at DESC, id) WHERE
parse_error IS NOT NULL` — so each is an index scan stopping at `limit`. The
outer `ORDER BY` sorts at most twice whatever each branch was limited to. The
route over-fetches by one as all three paginated routes do — a page exactly
`limit` long is otherwise ambiguous between "there is more" and "that was
everything" — so at the default `limit` of 30 each branch takes 31 and the outer
sort sees at most 62 rows. That bound is the whole reason the branches are
limited individually rather than unioned whole.

Then two hydration queries, one per kind, and the union's order is preserved when
the page is assembled: three queries per page regardless of page size. This is
the discipline `/api/downloads` states for itself — "one query for the whole
page's groups, not one per row" — and issues #31 and #33 are the defects it exists
to avoid repeating.

## 3. The cursor, which is the riskiest part of this change

Today's cursor is the string `"<sortKey>:<id>"`, parsed into
`KeysetCursor { sortKey, id }` and shared by three routes. A malformed cursor is a
400 and **not** "start from the beginning" — that is issue #33, where treating it
as the start meant a list paged forever.

`(sortKey, id)` is not a total order across this union: a `media_groups.id` and a
`feed_items.id` are unrelated namespaces, so two rows sharing a timestamp have no
stable relative order. The cursor therefore gains a discriminator and becomes
`"<sortKey>:<kind>:<id>"`, compared as `(sortKey DESC, kind ASC, id ASC)`.

`kind` is compared as the literal strings `'failed' < 'group'`, which is their
alphabetical order and also the order the `UNION`'s outer `ORDER BY kind ASC`
produces — one rule, expressed the same way in the SQL and in the cursor
comparison. That agreement is the requirement: a tiebreak that differs between
the two is exactly how a row gets served twice or skipped, which is #33's failure
mode with a new cause.

**This is the same rule plus a discriminator, not a second cursor rule.** The
two-component form stays valid for `/api/downloads` and `/api/dismissed`;
`/api/browse` mints and accepts the three-component form only, and rejects a
two-component cursor as malformed with the same 400 the other routes use. A
cursor a client is holding from before this change is malformed under it — the
SPA starts from no cursor on mount, so the window is a live tab mid-scroll at
deploy time.

## 4. `failed-card`, converted from `failed-row`

Same frame as `media-card`, so an interleaved list keeps one rhythm rather than
alternating between two card shapes. The poster slot renders an empty placeholder
at the same 6rem width the media card uses — a feed item has no artwork, and
collapsing the slot would make every failed card a different height.

It carries what the row carries: `rawTitle` as the heading, `parseError` in the
error colour, the feed id, and the `Fix…` / `Dismiss` actions with `FixForm`
rendered inline when open. `FixForm` moves with it unchanged, including the reason
it is a separate component — `ManualForm` seeds once and never again, so a single
form moved between items would keep showing the first one's suggestions.

`.failed-row`'s styles are renamed to `.failed-card` along with the element,
because a class named for a row on an element that is a card is the kind of name
this project treats as a defect. `base.css:47-48` names `.failed-row h2` in a
comment explaining a cascade-layer interaction; that comment is updated with it.

## 5. `GroupList` learns a second row kind

Its props change from `groups: readonly GroupView[]` and `selectedId: number |
null` to the union and a composite selection:

```ts
interface Props {
  items: readonly BrowseItem[];
  selected: { kind: 'group' | 'failed'; id: number } | null;
  onSelect: (selected: { kind: 'group' | 'failed'; id: number }) => void;
}
```

A bare id cannot address a row any more, for the same reason the cursor needs a
discriminator: the two id spaces overlap. Every place Browse compares a selection
to a row has to compare both halves.

The listbox contract is unchanged — `role="listbox"`, `aria-selected` per row, a
roving `tabIndex` so exactly one row is in the tab order, and ArrowUp/ArrowDown
moving selection and DOM focus. A failed row's accessible name is its `rawTitle`.
The clearing effect that drops a selection filtered out by a term keeps working on
the composite key.

The detail pane renders `MediaCard` or `FailedCard` by kind. A failed item's pane
is where its `Fix…` form opens in split view.

## 6. Acting on a failed card

Both actions already exist and neither changes server-side.

`Fix…` calls `resolveFeedItem`, drops the failed item from the list, and shows the
notice Failed shows now — `"<title> joined an existing group"` or `"became a new
group"`. **The resolved group does not appear until the next page load,** and the
screen says so through that notice rather than pretending otherwise: patching a
new group into a keyset-ordered list means computing where the server would have
put it, which is the client re-deriving the server's ordering rule that §2 exists
to prevent.

`Dismiss` calls `dismissFeedItem` and drops the item, unconditionally — Browse
shows only open items, so a dismissed one no longer belongs in the list. This is
simpler than Failed's version, which had to decide between dropping and flipping
depending on its toggle.

## 7. Nav

```
Browse
Picks
Dismissed
────────────  (hr)
Settings
ThemeToggle
```

The `<hr>` keeps the meaning its comment states — the library above, the
installation below — so Dismissed sits above it and that comment needs no change.
An earlier draft of this design put Dismissed below the rule as an
infrequently-used feature, which would have made that comment false about the
markup beside it.

## 8. The Dismissed tab

The old Failed route, filtered to dismissed items, keeping its pager and its
`Fix…` form with the live identity preview — because `Failed.tsx` is right that
listing a dismissed item is how it "stays fixable". It shows the `Dismissed`
badge in place of a Dismiss button, as the row does today.

**`/api/failed` becomes `/api/dismissed` and loses its `includeDismissed`
parameter.** Open failed items are queried inside the browse route's union, so
this route's only consumer wants dismissed items and nothing needs "all" any more.
The rename is not cosmetic: a route called `failed` that returns only dismissed
items is a false name, and this codebase treats those as defects. It keeps the
two-component cursor.

## 9. Testing

- **The interleaving order** — a page containing both kinds comes back in
  recency order, and a group and a failed item sharing a timestamp come back in a
  fixed order. Assert the order, not just the membership.
- **The cursor across pages** — page two starts exactly after page one's last
  row, with no row served twice and none skipped, including when the boundary row
  is a failed item and when it is a group. This is the test that would catch #33
  recurring; it needs a fixture with interleaved timestamps, not one list after
  the other.
- **A two-component cursor is a 400 on `/api/browse`** and still valid on
  `/api/dismissed`.
- **Search matches both kinds** — a term matching a group's `search_text` and one
  matching a failed item's `raw_title`, and one matching both. Note the
  asymmetry: `search_text` is stored pre-lowercased (`groups.ts:442`), while
  `raw_title` is not, so the failed branch lowercases at query time.
- **`GroupList` with both row kinds** — selection, keyboard movement, the roving
  tab stop, and a failed row's accessible name. Each with its own test: a single
  test that "the list renders rows" passes for every one of these.
- **The detail pane renders by kind**, and a failed item's `Fix…` form opens in
  split view.
- **`Fix…` drops the row and shows the notice; `Dismiss` drops the row.**
- **e2e: four sites, enumerated, because three of them do not mention a path.**
  Grepping for the href alone is how a stale nav assertion survived the Downloads
  merge until e2e failed on it, so these were found by grepping the *label* too:
  - `theme.spec.ts:182` sweeps `['/', '/picks', '/failed', '/settings']` —
    `/failed` becomes `/dismissed`.
  - `smoke.spec.ts:15` asserts a `Failed` nav link is visible — becomes
    `Dismissed`.
  - `settings.spec.ts:42` is the one to be careful with. It asserts nav
    **geometry**: that `hr.nav-separator` sits below the `Failed` link and above
    `Settings`, deliberately replacing an older `toContainText('Failed—Settings')`
    because "a rule contributes no text". With `Failed` gone its locator returns
    null and the test fails on `expect(failed).not.toBeNull()`. The link above the
    rule becomes `Dismissed`, which preserves the exact property being tested —
    the rule below the last library link, above the installation one.
  - `retry.spec.ts:81` asserts `.release-current` reads `Failed` and **must not be
    touched.** That is a download's status label on a release row, unrelated to
    the nav. A label sweep that changed it would break a passing test for no
    reason.

Every rule above with more than one branch is mutation-checked per branch: break
that branch, prove that test and no other fails.

## 10. Consequences

- **`BrowseResponse.groups` becomes `items`**, and every consumer on Browse
  changes with it — `usePagedList`'s element type, the card list, `GroupList`, the
  selection state, and the clearing effect.
- **Three lists no longer page identically.** `server.ts` currently celebrates
  that browse, failed and downloads share one cursor rule. After this, browse
  carries a third component the other two do not. The shared parser keeps one
  implementation and the comment saying "three lists paging identically" must be
  corrected rather than left standing.
- **A live tab mid-scroll at deploy time** holds a two-component browse cursor,
  which becomes a 400. It recovers on reload; nothing is lost.
- **The 22:1 dilution** of §1.2.
