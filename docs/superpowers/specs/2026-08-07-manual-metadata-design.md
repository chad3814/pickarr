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

- **Moving files already imported.** This held until 2026-08-16. Until then, changing a
  group's identity changed only where *future* imports land, and files already on disk
  stayed where they were. It does not hold any more: an identity change a human makes now
  renames the files that identity already placed — see
  `docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md`. Re-rendering
  the whole library after a `pathTemplate` change is a different thing, config-driven and
  library-wide rather than one group at a time, and remains out of scope (issue #22).
- **Re-parsing.** Nothing re-runs the parser over existing items, then or now. The
  `edited_at` columns below exist so that a future re-parse pass can leave hand-entered
  data alone; nothing reads them yet.
- **Un-dismissing from the UI.** Dismissed items are hidden, not deleted, and the API can
  still return them. No un-dismiss *button* in this cut — but the Failed tab does carry a
  "Show dismissed" checkbox, because otherwise `includeDismissed` has no caller in the SPA
  and a dismissal is unrecoverable in practice while claiming not to be. Fixing a shown
  dismissed item clears its `dismissed_at` (§7.1), which is the recovery path.
- **Merging groups that have history.** This held until 2026-08-16, and §7.3 below still
  records why it was the right call at the time. It does not hold any more — see §7.3's
  final paragraph and
  `docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md` §5: a merge
  with history now runs once the human confirms a read-only plan of its consequences,
  rather than being refused.

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

This is a universal claim and it rests on one thing that is easy to break by accident:
`display.title` must be a *reversible* rendering of whatever the key was built from. The
bracketed-listing shape joins its title parts with ` - ` and `fromManualValues` splits
them back out on ` - `, so no part may contain that separator. `prettify` put one back —
it rewrites `.` and `_` as spaces, so the single part `Kylie.-.Page` rendered as
`Kylie - Page` and the two-part title became indistinguishable from a three-part one.
`collapsePartSeparator` in `parse.ts` restores the invariant, and does so without moving
any key, because `slug()` reduces both ` - ` and `-` to a single `-`. Anything that
changes how a display title is spelled has to keep that reversibility or the claim above
stops being true.

### Title order is a field, not an inference

The bracketed-listing shape builds its scene slug from title parts **sorted** and joined
with `--`, because those trackers put performer and title on either side of each other;
every other shape slugs the title as one piece. Two releases can therefore have the same
display title and legitimately different keys, and nothing in a `ParsedRelease` says
which rule produced it — a dotted name containing `.-.` renders a display title with
` - ` in it while its scene slug has no `--`.

Inferring the rule from punctuation in the title silently re-keys that release the first
time someone edits it. So the structure is an explicit field, `titleOrder`:

- `fixed` → the slug is `slug(title)`, the title read as one piece.
- `any` → the title is split on ` - `, each part slugged, sorted, joined with `--`.

`toManualValues` sets it from the key it already has (`any` when the scene segment
contains `--`), which makes the round trip exact for both shapes. A new manual entry
defaults to `fixed`.

### Scenes field list

| name | type | scope | notes |
|---|---|---|---|
| `site` | text | identity | required |
| `anchorKind` | select | identity | `date` \| `episode` \| `none`, required |
| `date` | text | identity | `YYYY-MM-DD`, required when `anchorKind` is `date` |
| `episode` | text | identity | e.g. `E1178`, required when `anchorKind` is `episode` |
| `title` | text | identity | required |
| `titleOrder` | select | identity | `fixed` \| `any`, per above |
| `resolution` | select | quality | `` \| `4320p` \| `2160p` \| `1440p` \| `1080p` \| `720p` \| `540p` \| `480p` |
| `source` | text | quality | |
| `videoCodec` | text | quality | |
| `audioCodec` | text | quality | the parser never emits this; editable so a human can |
| `releaseGroup` | text | quality | |
| `container` | text | quality | `quality.extras.container` |
| `vr` | select | quality | `` \| `yes` → `quality.extras.vr` |
| `upscaled` | select | quality | `` \| `yes` → `quality.extras.upscaled` |
| `interlaced` | select | quality | `` \| `yes` → `quality.extras.interlaced` |

The three boolean extras are here because `extractQuality` sets them, and a token the
form cannot represent is a token the round trip drops. `bitrateKbps` and `sizeBytes` have
no field: nothing in the scenes plugin writes them today, and inventing controls for
values no code produces is speculative. Whoever makes the parser emit them must add the
fields in the same change, or an edit will silently discard them.

Validation, with the offending field named in every message: `site` and `title` must be
non-empty after slugging; `date` must match `YYYY-MM-DD` and be a real calendar date;
`episode` must match `/^[Ee]\d+$/` and is normalised to lowercase (`e1178`), matching the
parser; `anchorKind: none` leaves the anchor empty, which the key format already permits.

## 6. Data model

Migration 3:

```sql
ALTER TABLE feed_items   ADD COLUMN dismissed_at INTEGER;
ALTER TABLE media_groups ADD COLUMN edited_at    INTEGER;
ALTER TABLE releases     ADD COLUMN edited_at    INTEGER;
CREATE INDEX feed_items_failed
  ON feed_items (first_seen_at DESC, id) WHERE parse_error IS NOT NULL;
```

The partial index is what keeps the Failed tab's keyset pagination from scanning a
`feed_items` table that grows without bound — failures are a small minority of it, and
the predicate keeps the index that size rather than the table's.

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

**A resolve may move `list_rank_at`.** Resolving is a release *arriving* — it just took a
slower route through a human — so if it beats a picked release it earns its group a place
at the top of the list, exactly as ingest would have. Correcting an existing record is not
an arrival and does not. The merge branch of §7.3 is the third case that bumps, and for
this same reason: it brings a release into a group that did not have it.

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

In all cases set `edited_at` — on the surviving group, which for a merge is the target.

**A merge may move `list_rank_at`; the other two branches may not.** A release moving into
a group and beating its pick *is* an arrival at that group — it merely took a slower route,
in through a human, exactly as a resolve does (§7.1). The motivating case is one scene
downloaded at 1080p and later re-encoded at 2160p under a name the parser reads
differently: correcting the second group's identity merges it in and flags the upgrade, and
if the group does not rise in the browse list the user has to go looking for the thing they
just fixed. The same scene fixed from the Failed tab bumps, and one outcome reached two ways
must not be ordered two ways.

The guard is **ingest's, shared rather than restated** — `earnsListBump` in `db/groups.ts`,
called by both `commitRelease` and the merge: bump only when a release being moved in beats
*both* the target's picked release and anything already flagged on it, and strictly on both
sides. A merge that brings in nothing better does not bump; moving a pair of also-ran encodes
across is not an arrival. Neither is a release that only ties an already-flagged upgrade —
the group is in the browse list on that flag's account already, so bumping would re-sort the
list around an arrival that offers nothing new. The bumping merge calls `flagUpgrade`, the
rest `refreshUpgradeFlag`.

The scores must be read **before** `moveReleasesToGroup` runs, or the comparison is against a
target that already holds the incoming releases.

**The rule that an edit does not bump still holds for the two cases it was written for** —
correcting a group's display (step 2/4 above) and correcting a release's quality (§7.4) —
because neither introduces a release the group did not already have.

**A merge does not overwrite the target's display.** The submitted values were the user's
way of *naming* which existing scene this is, and the target is already that scene,
described by whatever produced it. Taking the display too would let a hasty edit rewrite
a record the user was only pointing at. The releases move; the target's own description
stands.

**The merge was refused with 409 when the source group had any `downloads` row or any
`imported_files` row.** Those tables reference `group_id`; the target may already carry
its own pick, its own upgrade flag and its own imported files, and silently reconciling
two picks is a guess. That reasoning was sound, and it is why the refusal was the right
call at the time — but nothing ever deletes a `downloads` row, so the refusal turned out
to be permanent for any group ever picked from, not a "try again later".

§5 of `docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md` replaces
the refusal: a merge with history now shows the user a read-only plan of every
consequence, and only a plan the user confirms is applied.

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
| PATCH | `/api/groups/:id` | `{ values, planDigest? }` | `{ group: GroupView, mergedInto: number \| null, renamed: number, trashed: number, failed: { path: string, error: string }[] }` |
| PATCH | `/api/releases/:id` | `{ values }` | `{ group: GroupView \| null }` |
| POST | `/api/manual-preview` | `{ plugin, values }` | `{ identityKey }` or `{ error }` |

`PATCH /api/releases/:id` answers `group: null` for the same reason `/api/groups/:id/pick`
does: a null is the route saying "this group is no longer in the list you are showing".
Step 3 of §7.4 re-derives the upgrade flag, and on a group that is browsable *only* because
of that flag — picked, with something better on offer — downgrading the better release
clears it and takes the group out of Browse. A 404 would be a lie, because the group still
exists; returning it as a `GroupView` is worse, because the client patches the card back in
and the list goes on offering a group it no longer contains. That stale card is actionable:
Pick on it queues an `upgrade` (the kind comes from `state = 'picked'`), and importing an
upgrade trashes the live file and repoints `picked_release_id` — a downgrade executed as an
upgrade, on files. The route must be able to say the group left, so the client can drop it.

`/api/manual-preview` exists because §11 names the identity-key preview as the only guard
against a wrong manual identity, and the key can only be built by the plugin, on the
server. It writes nothing. The form debounces calls to it and shows the key, or the
plugin's own complaint, under the fields.

It answers **200 with `{ error }`** when the plugin rejects the values, reserving 4xx for
a malformed body, an unknown plugin, and a plugin with no manual hooks. A rejection is
the normal state of a half-typed form — the endpoint is called on every keystroke, and a
date reading `2026-0` is not a client error. Returning 4xx there would make the SPA's
fetch helper throw on ordinary typing.

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
forms. The two forms that edit an identity — Fix on Failed, and Edit on a Browse card —
carry a live identity-key preview, so the consequence of a change is visible before it is
saved. The per-release quality form does not, and must not: a quality edit cannot change
the identity key (§7.4), so a preview there would answer a question the form does not
ask — and, given only quality values, the answer would be the plugin complaining about
the identity fields it was never sent.

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
change, merge. The two tests that once asserted a 409 for a merge whose source held a
download or an imported file are rewritten, not deleted, to assert the replacement
behaviour — the plan/confirm/apply sequence of
`docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md` §9 — and stand
as the record that this was once refused. The merge's bump rule and both of its
boundaries: an incoming release that beats the target's pick bumps `list_rank_at`, one
that beats nothing does not, and one that beats the pick but only ties an
already-flagged upgrade does not. Release edit: rescored, upgrade flag re-derived,
`list_rank_at` unchanged. A plugin implementing none of the hooks: no crash, no manual
values, dismiss still works.

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
- **Editing a group with imported files left those files behind**, under the old path,
  while future imports used the new one, and the group's history then spanned two
  layouts. This held until 2026-08-16. It does not hold any more: an identity change now
  renames the files that identity already placed, so the two layouts do not diverge. See
  `docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md` §5.
- **A rename can interleave with a concurrent import for the same survivor.** Phases 2 and 3
  of that same design's `editGroup` (§5) hold no lock across their `await`s, and the
  scheduled import pipeline runs in the same process — nothing stops an upgrade import for
  the survivor group from landing between one file's rename and the next. Traced through,
  the worst case is a failed rename reported in `failed` with the row still truthful: §5.1's
  failure model already covers exactly that outcome, and §5.2's retry finishes it. Recorded
  here rather than fixed because nothing about it is wrong, only interleaved.
- **`suggestManualValues` is best-effort by definition.** It runs on names the parser has
  already refused, so it will often return little or nothing. It must never throw; a
  suggestion is a convenience, not a contract.
