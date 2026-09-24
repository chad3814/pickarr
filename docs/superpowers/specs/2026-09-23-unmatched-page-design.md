# Unmatched page: expandable cards, and the lookup answer behind them

**Date:** 2026-09-23
**Status:** proposed

## The problem

`/unmatched` renders a bare `<ul>` of filenames:

```
Unmatched
─────────────────────────────────
Some.Show.S01E01.1080p-GROUP.mkv
Another.Release.2024.WEB-DL.mkv
```

Three things are wrong with it, and one is invisible.

1. **It stops at 24 rows and says nothing.** `readUnmatched` collects until
   `PAGE_SIZE`, and the component renders whatever it got. `Category` gained
   infinite scroll *and* a Load more button; this screen got neither. With
   500 unmatched releases an operator sees 24 of them, for ever, with
   nothing on screen suggesting there are more.
2. **A filename alone does not say which feed produced it.** `rss_item`
   carries `feedId`, and `rss_feed` joined the synced set, so the feed's
   *name* is resolvable in the browser now. Without it, "one misconfigured
   feed is producing all of this" is not a conclusion this screen can
   support.
3. **Nothing says why an item is unmatched** — even though the host already
   knows and already tells the client. `rss_item.resolution` is
   `pending | resolved | refused | unresolved` and `resolutionDetail` is a
   sentence naming what the service did recognise. Both are on
   `RssItemSyncRead` today and neither is rendered anywhere.
4. **The lookup answer itself is discarded.** `engine.ts` reads a
   `LookupEnvelope`, derives `resolution` and `resolutionDetail` from it,
   and drops the rest. When an operator wants to know *why* the service
   failed on a name, the evidence no longer exists.

## What this builds

Each unmatched release becomes an expandable card, styled like an `xxx`
browse card — filename as the title, feed name dimmed at the right:

```
┌──────────────────────────────────────────────────────┐
│ Some.Show.S01E01.1080p-GROUP.mkv        Example Feed │
└──────────────────────────────────────────────────────┘
```

Expanded:

```
┌──────────────────────────────────────────────────────┐
│ Some.Show.S01E01.1080p-GROUP.mkv        Example Feed │
│                                                      │
│ Unresolved · arrived 2 Sep 14:20 · torrent           │
│ the lookup service recognised site Foo and           │
│ performers A, B in "Some.Show…", but not the item    │
│                                                      │
│ {                                                    │
│   "lookupId": "lk_01H…",                             │
│   "state": "unresolved",                             │
│   "confidence": 0.31,                                │
│   "media": { … },                                    │
│   "suggestions": { … }                               │
│ }                                                    │
└──────────────────────────────────────────────────────┘
```

## Architecture

### The card is web's, not a plugin's

An unmatched release has no `media_item` and therefore no plugin card — but
it should not *look* like a different app. Web already holds the
`<article>` that every browse card renders into, and
`@pickarr/plugin-ui` exports the two pieces that make a title line:
`CardHeading` (with the `trailing` slot added for the adult card) and
`useExpansion`.

So `Unmatched` composes those directly.

**This section first said the title line needed "no new CSS" -- that
`article`, `article h2 button` and `article h2 button small` already
styled it, and only the expanded body was new. That stopped being true
when a card's title went from wrapping to truncating.** The reversal was
made so a trailing label stays visible whatever the headline's length,
and it cannot be had from the rules that already existed: the branch adds
`article h2 button span` (`flex: 1; min-width: 0; overflow: hidden;
text-overflow: ellipsis; white-space: nowrap`) and rewrites
`article h2 button small`, replacing `margin-left: auto` with
`flex-shrink: 0` -- the label now holds its place because the headline is
the flexible item, not because a margin pushes it.

Both rules are unscoped, and deliberately: keeping a trailing label
legible is every card's business, not this screen's, so the browse cards
get the same treatment. So the accurate statement is that the title line
needs **no new markup** -- it is the same two shared components -- while
the CSS under it changed for every card that has a trailing label. The
expanded body is new on top of that.

This is the first web-side consumer of `CardHeading`. That is the point of
the component living in `plugin-ui` rather than in each plugin — but it does
mean `plugin-ui` is no longer "the plugin seam" exclusively, and its own
docblock should say so.

### Storing the lookup answer

**A new nullable column, `rss_item.lookup_json`**, written by the lookup
engine and replicated to clients.

Four rules bound it, and each is load-bearing:

1. **Only when the lookup did not resolve.** A resolved item is not
   unmatched and its envelope would never be read — and `media` on a
   resolved envelope is the largest thing the service returns. Written on
   the `refused` and `unresolved` terminal branches only.
2. **Cleared the instant the release is linked to a media item.** Without
   this the column only ever grows.

   **The clear happens in `relinkRssItem`'s own `UPDATE`, not in the
   `setResolution` that follows it** — an amendment made after the branch
   shipped, because the original placement had a real hole. The engine
   links the release, then hands off to the plugin's `apply` and to
   `attachPeople`, and only then records the resolution. A throw in either
   middle step left the release linked, and therefore off `/unmatched`,
   with its answer retained; the lookup job retries and then
   **dead-letters**, so a persistently failing plugin stranded up to the
   cap per release, permanently, on a row no screen shows.

   The invariant is really about the link rather than the resolution — an
   answer is reachable only while `media_item_id IS NULL` — so it is
   enforced in the statement that changes `media_item_id`. Unlinking
   deliberately does not clear: a release returning to unmatched is
   exactly the state an answer belongs to.
3. **`media` IS stored**, on the repo owner's instruction, reversing an
   earlier draft of this rule. The reasoning that excluded it was: `media`
   is the largest field the service returns, and it is null whenever a
   lookup fails so nothing is lost. **The second half turned out to be
   false** — implementing the engine wiring found that `validate.ts`
   parses `media` regardless of the lookup's state, so a refused or
   unresolved envelope may carry a full payload. That makes it *worth*
   keeping rather than safe to drop: when the service half-identified
   something and then declined to commit, the media it was considering is
   the most direct evidence of why. The cap below is what bounds it.
4. **Capped at 32 KB.** A pathological response must not be able to grow
   every client's replica without limit. Over the cap, the column stores a
   short marker instead of the envelope, and the card renders that.

   **32 KB rather than the 8 KB first chosen, because rule 3 changed.**
   `Media` carries a synopsis, an arbitrary `details` object, parents and
   a full cast; fifty people run about 6 KB on their own, so an 8 KB cap
   would replace exactly the richest answers with the marker and leave the
   thin ones visible — the opposite of useful. The cost is bounded by how
   many releases are unmatched at once, which is normally a short tail:
   500 of them at the cap is about 16 MB of replica, and only
   non-resolved releases store anything at all.

**Serialised from the validated shape, never from the response bytes.**
`validate.ts` has already parsed the response into a `LookupEnvelope` by
the time the engine sees it, so what is stored is a re-serialisation of a
shape the contract declares. The one exception is `parsed`, which the type
itself documents as "carried through unvalidated beyond object or null" —
arbitrary third-party JSON. It is also the single most useful field for
diagnosing a bad parse, so it is stored, and this paragraph is the record
that it is the one part of this column that is not shape-checked.

**Why this needs stating at all:** `sync/tables.ts` excludes
`rss_item.link` from the replica on the reasoning that a passkey in it
would become "a copy sitting in a browser's storage indefinitely". A new
string column crossing the same boundary is exactly the decision that
policy exists to make deliberate. The envelope is the lookup service's
answer about a filename; the filename is already in the replica, and the
service is given no credentials belonging to the tracker the release came
from. It is not redacted through `redactSecrets`, because that would mangle
`lookupId` — an opaque token of exactly the shape its hex and alphanumeric
rules match — and destroy the field most useful for correlating with the
service's own logs.

### Paging

Infinite scroll plus a retained Load more button, the same shape
`Category` uses, over `useInfiniteScroll`.

`readUnmatched` already walks pages and stops at 24 collected. It grows a
cursor so a second call resumes where the first stopped, rather than
re-walking. The existing measurement stands and gets worse with paging —
21 page reads per refresh at 500 rows, always to exhaustion when the
unmatched set is short — so the walk keeps its coalescing refresher and the
cursor is reset on any wake, since a re-read cannot trust a cursor taken
before the change.

## Components

| File | Responsibility |
|---|---|
| `packages/contract/src/sync.ts` | `RssItemSyncRead.lookupJson: string \| null` |
| `packages/host/src/db/migrate.ts` | `ALTER TABLE rss_item ADD COLUMN lookup_json TEXT` — additive, so the sync triggers survive |
| `packages/host/src/db/schema.ts` | the drizzle column, for the DDL-parity guard |
| `packages/host/src/sync/tables.ts` | the projection, and the three guards that pin it |
| `packages/host/src/media/writer.ts` | `setResolution` gains the envelope argument |
| `packages/openmetadata/src/engine.ts` | serialises, caps, and hands it over on the two non-resolved branches; clears it on resolve |
| `packages/web/src/library/Unmatched.tsx` | cards, expansion, the feed-name join, paging |
| `packages/web/src/library/useFeedNames.ts` | `feedId → name`, read from the `rss_feed` replica (planned as `useUnmatchedFeeds.ts`; renamed on the way in, since nothing about it is specific to this screen) |
| `packages/web/src/styles/library.css` | the expanded body only |

## Testing

- **Host:** the engine writes on `refused`/`unresolved`, writes nothing on
  `resolved`, **clears** on a resolve that follows a failure, and caps an
  oversized envelope. The cap and the clear are the two that a happy-path
  test would miss.
- **Sync:** the three existing `rss_item` guards extend to the new field —
  field coverage, projection key list, drizzle/DDL parity. A migration test
  that the column is added without rebuilding the table, since a rebuild
  silently drops the sync triggers (`docs/database-migrations.md`).
- **Web:** a card renders filename and feed name; expanding shows the state,
  the detail and the JSON; an item with no envelope expands without an empty
  `<pre>`; paging past 24.
- **Browser:** one spec. The card must *look* like a card and not like an
  unstyled block, and `getByRole` cannot see that — the same gap
  `CLAUDE.md` records for `IdentityChangeConfirm`.

  **This bullet first said the spec "measures the title line against a
  real `xxx` card's geometry, so 'styled like the xxx category' is a
  pinned claim". It does not, and no comparison against another category
  was ever written.** The shipped spec measures the unmatched card
  *against itself*: the gap between the feed label's right edge and the
  card's, the label's box against its own text width, its line count and
  the filename's by distinct `Range` rect tops, and `scrollWidth` against
  `clientWidth` for both the truncated filename and the wrapping answer
  well. Nothing in it visits another category route.

  That is the weaker claim, and it is the right one to make: the two
  screens are held together by *sharing the rules*, not by a test that
  compares them, and the one comparison that would have been meaningful —
  the browse card's own geometry — is pinned by that card's own spec,
  which this branch repaired rather than reused.

## Out of scope

- **Actions on a row** — retry, dismiss, manual match. Each needs a host
  route; none is needed to read the screen.
- **Issue #98's browse-list half.** `resolution` still renders beside each
  release filename in `ReleaseList`, where it reads as a quality marker.
  Left deliberately, to be handled as its own change.
- **Indexing "`mediaItemId` is null".** Still not bought; still a third
  schema bump. The walk cost is unchanged by this work.
