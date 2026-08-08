# Manual metadata — Design

Date: 2026-08-07
Status: approved for planning
Branch: `manual-metadata`

## 1. What this adds

Two related abilities, both of them the same underlying thing — a human overriding the
parser:

1. **A Failed tab.** Every feed item the parser refused, listed with the reason, with a
   form to describe it by hand. Saving turns it into a real group and release, and it
   leaves the Failed tab for Browse.
2. **Editing on Browse.** The same form, applied to something that parsed successfully
   but parsed *wrong*.

The parser reached 94% on a 5,000-title corpus and will not reach 100%; the residue is
names with no date, no recognisable site, or no structure at all. Today those items are
recorded as `parse_error` and never seen again by anyone but the log. This makes them
recoverable, and makes a wrong parse correctable rather than permanent.

## 2. Scope

In scope:

- Listing, fixing and dismissing parse failures.
- Editing a group's identity and display; editing a release's quality.
- A plugin contract for describing editable fields, so core stays media-agnostic.

Out of scope:

- **Moving files already imported.** Changing a group's identity changes where *future*
  imports land. Files already on disk stay where they are. Renaming a live library is a
  separate feature with its own failure modes.
- **Re-parsing.** Nothing re-runs the parser over existing items, then or now. The
  `edited_at` columns below exist so that a future re-parse pass can leave hand-entered
  data alone; nothing reads them yet.
- **Un-dismissing from the UI.** Dismissed items are hidden, not deleted, and the API
  can still return them. No button in this cut.
- **Merging groups that have history.** See §7.3.

## 3. Where the data lives

This is the constraint the whole design follows from.

A **failed item** is a `feed_items` row with `parse_error` set and no `releases` row.

A **successful item** is that same `feed_items` row, plus a `releases` row holding its
`quality` JSON and `score`, plus a `media_groups` row holding the `identity_key`,
`display` JSON and `search_text` shared by every release of the same thing.

So identity and display are **group-level** — editing them affects every release in the
group and every future import — while quality is **release-level**, and drives that one
release's score and the resolution and group tokens in its library path.

## 4. Plugin contract

Four new hooks on `MediaTypePlugin`, all optional:

```ts
export type ManualFieldType = 'text' | 'number' | 'select';

export interface ManualField {
  readonly name: string;
  readonly label: string;
  readonly type: ManualFieldType;
  /** Which half of the record this field belongs to. */
  readonly scope: 'identity' | 'quality';
  readonly required?: boolean;
  /** Permitted values, for `type: 'select'`. */
  readonly options?: readonly string[];
  readonly placeholder?: string;
  readonly help?: string;
}

export interface MediaTypePlugin {
  // ...existing members...

  /** The fields a human may fill in to describe a release this plugin handles. */
  manualFields?(): readonly ManualField[];

  /** Values from those fields, turned into a release — or why they cannot be. */
  fromManualValues?(
    values: Readonly<Record<string, string>>,
  ): { media: ParsedRelease } | { error: string };

  /** The inverse, to prefill an edit form for something already parsed. */
  toManualValues?(media: ParsedRelease): Record<string, string>;

  /** Best-effort prefill for a name that failed to parse. May return nothing. */
  suggestManualValues?(releaseName: string): Record<string, string>;
}
```

`scope` is what lets one schema drive three different forms:

| Form | Fields shown | What core uses from the result |
|---|---|---|
| Fix a failed item | all | `identityKey`, `display`, `quality` |
| Edit a group | `identity` | `identityKey`, `display` |
| Edit a release | `quality` | `quality` |

**Contract rule:** `fromManualValues` must produce a correct `identityKey` and `display`
from the `identity`-scoped values alone. Core does not send quality values when editing a
group, and ignores `media.quality` if one comes back.

**Degradation.** A plugin implementing none of these gets no edit UI: core hides the Fix
and Edit controls for its items. Dismiss still works, because dismissing is core's own
business and needs no plugin knowledge.

**Manual values are never stored.** Only the resulting `ParsedRelease` is persisted, in
exactly the columns a parsed one uses; `toManualValues` reconstructs the form values on
demand. Two consequences worth stating: an edited record is indistinguishable from a
parsed one everywhere downstream (import, scoring, paths), and a plugin renaming a field
later orphans nothing, because no field name was ever written to the database.

## 5. Identity construction

The scenes plugin's `fromManualValues` **must build its identity key through the same
code the parser uses** — `slug()`, the site canonicalisation, and the `--` component
boundary. This requires extracting a shared `buildRelease({ site, anchor, title, quality })`
from `parse.ts` and calling it from both places.

This is not tidiness. The identity key is injective on its component multiset only
because `slug()` can never emit `--` any other way, and `path-template.ts` depends on
that same property one layer down. A second, hand-rolled key builder that slugs even
slightly differently puts a manually-entered release in a different group from its
parsed siblings and on a different library path — silently, with nothing failing.

The property this buys, and which the tests assert: for any name the parser handles,

```
parse(name) → toManualValues → fromManualValues  ===  parse(name)
```

### Scenes field list

| name | type | scope | notes |
|---|---|---|---|
| `site` | text | identity | required |
| `anchorKind` | select | identity | `date` \| `episode` \| `none`, required |
| `date` | text | identity | `YYYY-MM-DD`, required when `anchorKind` is `date` |
| `episode` | text | identity | e.g. `E1178`, required when `anchorKind` is `episode` |
| `title` | text | identity | required |
| `resolution` | select | quality | `2160p` \| `1080p` \| `720p` \| `480p` \| `` |
| `source` | text | quality | |
| `videoCodec` | text | quality | |
| `audioCodec` | text | quality | |
| `releaseGroup` | text | quality | |
| `container` | text | quality | |

Validation, with the offending field named in every message: `site` and `title` must be
non-empty after slugging; `date` must match `YYYY-MM-DD` and be a real calendar date;
`episode` must match `/^[Ee]\d+$/` and is normalised to lowercase (`e1178`), matching the
parser; `anchorKind: none` leaves the anchor empty, which the key format already permits.

## 6. Data model

Migration 3:

```sql
ALTER TABLE feed_items  ADD COLUMN dismissed_at INTEGER;
ALTER TABLE media_groups ADD COLUMN edited_at   INTEGER;
ALTER TABLE releases     ADD COLUMN edited_at   INTEGER;
```

`dismissed_at` drives the Failed tab's default filter. The two `edited_at` columns record
that a human, not the parser, produced the current values — written by the operations in
§7, read by nothing yet (see §2).

## 7. Operations

### 7.1 Resolve a failed item

Preconditions: the feed item exists, has a non-null `parse_error`, and has no release.
Otherwise 404 or 409.

1. `fromManualValues(values)` → `ParsedRelease`, or 400 with the plugin's message.
2. Validate the returned shape and compute `score`, using the **same** checks
   `ingestEntries` already applies to a parse result.
3. In one transaction: find the group by `(plugin, identityKey)` and create it if absent;
   insert the release against this feed item; clear `parse_error` and `dismissed_at`;
   re-derive the group's upgrade flag.

`edited_at` is set on the release always, and on the group **only when this operation
created it**. Joining an existing group does not mark that group as hand-edited — nothing
about it was edited, and a future re-parse pass has no reason to treat it as protected.

`dismissed_at` is cleared because fixing a dismissed item is a legitimate change of mind,
reachable through `includeDismissed`. An item cannot be both dismissed and resolved.

If the item's feed is no longer in configuration, `pluginForFeed` returns null and the
request is a 409 naming the feed: there is no plugin to build the release with, and
guessing one would file the item under the wrong media type.

Steps 2 and 3 are `ingestEntries`' tail. They are **extracted into a shared function and
called from both**, not copied. The upgrade/bump rule must not come to exist twice — that
class of duplication is what `deriveUpgradeReleaseId` was introduced to end.

Joining an existing group is the expected case, not an edge case: a failure is very often
a scene already present from another release.

### 7.2 Dismiss a failed item

Sets `dismissed_at`. 409 if the item has no `parse_error` — there is nothing to dismiss
about an item that parsed.

### 7.3 Edit a group

1. `fromManualValues({ ...toManualValues(current), ...submitted })` → use `identityKey`
   and `display` only.
2. If the key is unchanged, update `display` and `search_text`.
3. If the key now belongs to **another** group, merge into it: move this group's releases
   over, re-derive the target's upgrade flag, delete the emptied source group, and return
   the target.
4. Otherwise update `identity_key`, `display`, `search_text`.

In all cases set `edited_at`, and never touch `list_rank_at` — an edit is not an arrival.

**The merge is refused with 409 when the source group has any `downloads` row or any
`imported_files` row.** Those tables reference `group_id`; the target may already carry
its own pick, its own upgrade flag and its own imported files, and silently reconciling
two picks is a guess. The message names the obstruction. Lifting this restriction later
is a self-contained change.

### 7.4 Edit a release

1. `fromManualValues({ ...toManualValues(current), ...submitted })` → use `quality` only.
2. Write `quality` and `score = plugin.score(quality)`; set `edited_at`.
3. Re-derive the group's upgrade flag **without** bumping `list_rank_at`.

Step 3 needs a new `refreshUpgradeFlag(db, groupId)` in `db/groups.ts`, deriving through
the existing `deriveUpgradeReleaseId` and writing only `upgrade_release_id`. `flagUpgrade`
cannot be reused: it bumps.

A quality edit changes where future imports of that release land. Anything already
imported keeps the path it was given (§2).

## 8. HTTP API

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/manual-fields` | | `{ [pluginId]: ManualField[] }` |
| GET | `/api/failed?cursor=&limit=&includeDismissed=` | | `{ items: FailedItemView[], nextCursor }` |
| POST | `/api/feed-items/:id/resolve` | `{ values }` | `{ group: GroupView, joinedExisting: boolean }` |
| POST | `/api/feed-items/:id/dismiss` | | `{ id, dismissedAt }` |
| PATCH | `/api/groups/:id` | `{ values }` | `{ group: GroupView, mergedInto: number \| null }` |
| PATCH | `/api/releases/:id` | `{ values }` | `{ group: GroupView }` |

```ts
interface FailedItemView {
  id: number;
  feedId: string;
  plugin: string;          // so the SPA picks the right schema
  rawTitle: string;
  link: string;
  parseError: string;
  firstSeenAt: number;
  publishedAt: number | null;
  suggestedValues: Record<string, string>;
  dismissedAt: number | null;
}
```

`GroupView` gains `manualValues`, `ReleaseView` gains `manualValues`, both populated by
`toManualValues`, so an edit form opens without a round trip. Both are absent (undefined)
for a plugin that does not implement the hook, which is how the SPA decides whether to
offer the control.

Failed items are paginated by keyset on `(first_seen_at DESC, id ASC)`, matching Browse's
existing convention and its reasoning about ingest order: within one batch every item
shares a timestamp, and ingest walks a newest-first feed, so ascending id inside a tie is
newest-first. The cursor is `"<firstSeenAt>:<id>"`, as Browse's is.

`includeDismissed` is absent or `1`; absent means dismissed items are excluded. The
default list is a worklist, and the flag is how a dismissed item stays reachable for
fixing (§7.1) despite having no un-dismiss button.

Mapping a feed item to its plugin needs feed configuration the HTTP layer does not have
today: `ServerDeps` gains `pluginForFeed(feedId): MediaTypePlugin | null`.

## 9. Web UI

A fourth nav tab, **Failed**, at `/failed`. Each row: raw title, the refusal reason, the
feed it came from, and **Fix…** / **Dismiss**. Fix expands an inline form; saving removes
the row and reports whether it joined an existing group or made a new one.

One shared `ManualForm` component, rendered from `ManualField[]`, used by all three
forms, with a live identity-key preview so the consequence of a change is visible before
it is saved.

Browse gains an **Edit** control on the card (identity and display) and one per release
row (quality). Both patch the affected card in place from the response, the way picking
now does — never by refetching, which discards pages loaded past the first.

## 10. Testing

**Plugin.** The round-trip property of §5 over a table of representative names — dated,
episode-numbered, dateless, multi-word site, component-boundary title. Validation
rejections, each naming its field. Identity keys built manually are byte-identical to
parsed ones for the same content.

**Core.** Resolve creating a group; resolve joining an existing group; resolve rejected
for an item that already parsed. Dismiss, and its 409. Group edit: display-only, key
change, merge, merge refused for a group with a download, merge refused for a group with
an imported file. Release edit: rescored, upgrade flag re-derived, `list_rank_at`
unchanged. A plugin implementing none of the hooks: no crash, no manual values, dismiss
still works.

**Web.** Failed tab renders and paginates; Fix submits and removes the row; Dismiss
removes the row; Browse edit patches in place and does not collapse pagination.

Note for whoever writes the web tests: `assert.equal(screen.queryByText(x), null)` inside
`waitFor` OOM-kills the run — formatting the AssertionError deep-inspects a live DOM
element, several hundred times. Compare booleans instead. See `gone()` in
`packages/web/test/Browse.test.tsx`.

## 11. Known risks

- **A wrong manual identity is as durable as a right one.** Nothing validates a key
  against reality; a typo'd site makes a new group and a new library directory. The
  identity-key preview in the form is the only guard, and it is a visual one.
- **Editing a group with imported files leaves those files behind** under the old path,
  while future imports use the new one. The group's history then spans two layouts.
- **`suggestManualValues` is best-effort by definition.** It runs on names the parser has
  already refused, so it will often return little or nothing. It must never throw; a
  suggestion is a convenience, not a contract.
