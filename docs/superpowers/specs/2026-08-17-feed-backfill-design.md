# Feed backfill — Design

Date: 2026-08-17
Status: implemented without review — decisions taken autonomously, see §13
Superseded in part: §5's "no web UI" was reversed on `feat/settings-feed-backfill`; see
the note in §5 and the limitation struck from §12.
Branch: `feat/47-follow-rss-pagination-to-backfill-older-items`
Issue: [#47](https://github.com/chad3814/pickarr/issues/47)

## 1. What this adds

A second, slower pass that walks a feed's pagination backwards so a fresh install
can build a backlog instead of only ever seeing what happened to be on page one
while it was looking.

Today `fetchFeed` requests `feed.url` verbatim (`feeds/fetch-feed.ts:7`) and
nothing anywhere appends a query parameter to a feed URL. So Pickarr sees a scene
only if it is polling when that scene is on the feed's first page, and a feed's
history is unreachable by construction.

The property that makes walking backwards tolerable is already in place: ingest
dedupes on `UNIQUE (feed_id, guid)` (`db/migrations.ts:18`) and
`insertFeedItem` answers `null` for a row it did not insert
(`db/feed-items.ts:55`), which `ingestEntries` treats as a no-op
(`ingest/ingest.ts:121`). Re-reading a page costs a handful of rejected inserts.

## 2. Scope

In scope:

- A page parameter and an injectable fetch on the feed fetch layer.
- Per-feed `backfill` config, **absent by default**, so this ships inert.
- A `feed_backfill` table holding each feed's walk position and terminal state.
- A pass on its own timer and its own mutex, registered only when configured.
- Ordering rules so a backfilled item does not masquerade as a new arrival.

Out of scope, deliberately:

- **The web UI.** `backfill` is config.json only. See §5 for why this is safe and
  what it costs.
- **Detecting the pagination style.** See §4.
- **Retrying a failed page.** `fetchFeed` throws on any non-2xx with no retry
  today (`fetch-feed.ts:12`) and `backoffFor` exists but no feed path uses it. A
  failed page ends the pass and the position does not advance, so the next pass
  retries it an hour later. That is the retry, and it is enough for a backlog
  walk that has no deadline.
- **A "backfill now" or "reset backfill" control.** `Scheduler.ingestNow` already
  exists with zero callers and no HTTP route reaches the scheduler at all
  (`http/server.ts` receives only `untrackedFor`). Adding a route is additive.
- **Deriving progress from `feed_items` instead of storing it.** No index supports
  "oldest item for feed X", so that is a scan of the largest table.

## 3. Fetching a page

`fetchFeed` gains an options argument rather than a new sibling function, because
the live poll and the backfill differ only in which page they want:

```ts
export interface FetchFeedOptions {
  /** Zero-based page index. 0 is what the live poll asks for. */
  page?: number;
  /** Required to page past 0; a page index alone has nothing to compose. */
  pagination?: FeedPagination;
  fetchImpl?: FetchImpl;
}

export async function fetchFeed(feed: FeedConfig, options?: FetchFeedOptions): Promise<FeedEntry[]>
```

`FetchImpl` is the type `clients/theporndb.ts:37` already defines for exactly this
reason, and it is imported rather than redeclared. Without it there is no way to
test a page walk at all — there is currently no test for `fetch-feed.ts` and
nothing in the repo mocks global `fetch`.

**The URL is composed with `new URL`, never string concatenation.** A feed URL
already carries the indexer's own query — `config.example.json:30` is
`https://your-indexer.example/rss?t=6000&apikey=...` — so appending `&offset=` as
`theporndb.ts:533` does for its own base URL would be wrong here in the general
case and unreadable in the specific one. `page: 0` composes no parameters at all,
so the live poll's request is byte-identical to today's.

## 4. Pagination style is configured, never detected

```ts
backfill: z
  .object({
    style: z.enum(['newznab', 'page']),
    pageSize: z.number().int().positive().default(100),
    pagesPerPass: z.number().int().min(2).default(2),   // the floor is load-bearing, see §11a
    maxPages: z.number().int().positive().default(100),
  })
  .optional();
```

Absent means no backfill, which is why this ships inert and why an existing
install is unaffected.

`newznab` sets `offset` and `limit`; `page` sets `page`, one-based. Detection was
rejected: the issue names the consequence — a wrong guess re-ingests page one
forever — and there is nothing in an RSS document to detect *from*. Nothing reads
channel-level pagination hints today, and Newznab's `<newznab:response
offset= total=>` is absent from the generic feeds this also has to serve. A guess
that is wrong in the silent direction is the worst available outcome, so the
config states it or the feature stays off.

**`pageSize` must match what the indexer actually returns per page**, because
`newznab` offsets are computed from it. A `pageSize` larger than the truth skips
items; smaller re-reads them. Re-reading is harmless (§1); skipping is not. This
is the one field a user can get quietly wrong, and §7's guard does not catch it —
noted in §12.

## 5. Why no web UI, and what it costs

> **Reversed.** The form now models `backfill`, on a follow-up branch. The argument
> below stands as written except for the part that mattered most: the rename footgun
> in the last paragraph existed *only because* the field was unmodelled, so it was a
> cost the decision created rather than one it accepted. Modelling the field removes
> it. Kept here because the nine-file accounting is still the reason it was not done
> the first time.

`applyEdits` documents its own guarantee (`config/editable.ts:212-228`): a key the
form does not model survives a save, including a key *inside* a feed block, as
long as that feed's `id` did not change in the same submission. So a hand-written
`backfill` block is preserved through UI edits without the form knowing it exists.

That is worth taking, because the alternative is nine files for one advanced
field — `feedSchema`, `EditableFeed`, both halves of `editable.ts`, the shape
mirror in `http/server.ts:278-285`, the hand-maintained mirror in
`web/src/api/client.ts:416-417`, `FeedDraft`, `FeedFields` with a `blankFeed`
default that must track the zod default, and the string-typed draft conversion.
Two of those are type mirrors kept in sync by a comment.

**The cost, stated plainly: renaming a feed's `id` through the Settings UI drops
its `backfill` block**, because `applyEdits` matches feeds by id and a changed id
has no existing entry to merge with. The walk then restarts from page zero, which
is cheap and idempotent rather than damaging — but the configuration is gone
silently. A test pins the preservation behaviour so that at least the common case
cannot regress unnoticed.

## 6. Position is a real table, not `app_state`

`app_state`'s own doc comment rules itself out (`db/migrations.ts:478-492`): a row
there is "something singular, operational, and never read in bulk… Not anything
with enough structure to want columns; that earns a real table." Per-feed progress
with a state and a reason is exactly that, and storing JSON in `value` would
violate it outright.

```sql
CREATE TABLE feed_backfill (
  feed_id    TEXT    PRIMARY KEY,
  next_page  INTEGER NOT NULL,
  pages_read INTEGER NOT NULL,
  state      TEXT    NOT NULL,
  detail     TEXT,
  updated_at INTEGER NOT NULL
)
```

`next_page` is a **zero-based page index, not an offset**, for both styles. The
offset arithmetic (`page * pageSize`) and the one-based `?page=` conversion both
live in URL composition, so the stored position means the same thing regardless of
style and survives a style being corrected.

`state` is `'running' | 'done' | 'exhausted' | 'broken'`, and the distinction
between the last three is the point:

- `done` — a page came back with no items. The feed's history is read.
- `exhausted` — `maxPages` was reached. There is more, and we stopped anyway.
- `broken` — the indexer is not paginating (§7). Do not ask again.

`detail` carries why, so the difference is legible from the database without
reading logs. `feed_id` is a config id and deliberately has no foreign key: a feed
removed from config leaves a harmless orphan row that means "if you add this feed
back, here is where its walk was."

**The migration version is chosen last.** `migrate.ts:4-26` records four real
version collisions, and this branch will sit behind others.

## 7. The guard against an indexer that ignores pagination

The bound in §4 caps the damage but does not detect the cause. An indexer that
ignores `offset` serves page one forever, and every page of it is entirely known,
so the walk would end as `done` — reporting "history caught up" for a feed whose
history was never read.

So the pass compares each fetched page's guid set against the previous page's.
Identical, or a subset, means the parameter had no effect: stop, record `broken`,
and say which parameter was ignored. This is done in the pass from the
`FeedEntry[]` it already holds, so nothing about `IngestResult` has to change.

Subset rather than strict equality because a feed being written to while we walk
can legitimately shift items between pages — but it cannot legitimately produce a
page whose every item was on the page before it.

## 8. Backfilled items must not look new

Two separate mechanisms, and the issue names only the second.

**A new group's position.** `insertGroup` writes `created_at` into `list_rank_at`
as well (`db/groups.ts:70-80`), so a group created from a 2019 scene would sort as
though it arrived today. `insertGroup` gains an explicit `listRankAt`, defaulting
to `createdAt` so every existing caller is unchanged.

**The bump.** `commitRelease` calls `flagUpgrade` when `earnsListBump`
(`ingest/commit.ts:212`), and `flagUpgrade`'s own docstring calls itself "the only
write in the system that [moves list_rank_at]". A backfilled 2160p beating a
picked 1080p legitimately clears that bar — the issue's point.

But suppressing the whole thing would be wrong: a better encode existing *is*
worth knowing. What is not wanted is the re-sort. `refreshUpgradeFlag` already
exists for precisely this distinction — "re-derives the flag and nothing else",
because "that is earned only by something *happening* to the group". A backfill
discovering history is not something happening. So backfill flags without
bumping, and the choice is between two functions that already encode the rule
rather than a new branch inside either.

This is threaded as a named concept rather than a boolean:

```ts
export type Arrival = { kind: 'live' } | { kind: 'backfill'; publishedAt: number | null };
```

`ingestEntries` takes it as a trailing optional argument defaulting to
`{ kind: 'live' }`, so every existing caller — including the e2e harness and four
inline `IngestResult` literals in `scheduler.test.ts` — compiles untouched.

## 9. The pass, and why it must not touch the ingest mutex

Registered on the optional-runner pattern the metadata pass established
(`pipeline/scheduler.ts:193-221`): a `runBackfill?: () => Promise<void>` dep plus
`backfillIntervalMs?`, spread in as a pair, timers created only when the runner is
present. That also keeps `scheduler.test.ts:272-309` — which asserts an exact
timer count — passing, and earns its own analogous test.

The pass takes **its own mutex, with `tryRun`**. It must not take `ingestMutex`,
and this is not a preference: that mutex is shared by every feed and uses queueing
`run` (`scheduler.ts:43`, `:50`, `:165`), so a walk holding it across N fetches of
up to 30s each would stall every live poll and stack their ticks up behind it.

Two independent ingests running concurrently is safe, and the reason is worth
recording because it is not obvious from the mutex: `ingestEntries` is
**synchronous** — it returns `IngestResult`, not a promise, and there is no `await`
between its `BEGIN` and `COMMIT`. Node is single-threaded, so two flows can
interleave only at their `await` points, which are the fetches. The database work
of one ingest cannot be interleaved with the other's, so neither the
`(feed_id, guid)` constraint nor `UNIQUE (plugin, identity_key)`
(`migrations.ts:32`) can be raced.

Default interval: one hour. **The bound is also the rate limit.** Backfill goes
through the same site-resolution path as the live poll, deliberately — skipping it
would key backfilled groups differently from live ones and split the same scene
across two groups, which is worse than being slow. `pagesPerPass: 2` at
`pageSize: 100` is ~200 titles an hour reaching `resolveSitesForBatch`, against a
provider the metadata passes also budget for.

## 10. Failure handling

- **A page fetch throws.** End the pass for that feed. Do not advance
  `next_page`; do not change `state`. The next pass retries it (§2).
- **`ingestEntries` throws.** It rethrows after `ROLLBACK`, abandoning the rest of
  the page (`ingest.ts:146-149`). Same handling: the position does not advance, so
  the page is re-read, which is idempotent.
- **One feed's failure does not end the pass for other feeds**, matching
  `ingestAllNow`'s existing per-feed `catch` (`scheduler.ts:78-88`).
- A feed in `done`, `exhausted` or `broken` is skipped without a fetch.

## 11. Testing

- `fetch-feed.test.ts` — new file, the first test of this module: `page: 0`
  composes the URL unchanged; `newznab` sets `offset`/`limit` and preserves the
  indexer's existing query; `page` style is one-based.
- `commit`/`ingest` — a backfilled item's group takes `list_rank_at` from
  `publishedAt`; a backfilled release that beats the pick sets the upgrade flag
  **without** moving `list_rank_at`; the live path is unchanged.
- `feed-backfill.test.ts` — the position table, in the `app-state.test.ts` style.
- `backfill.test.ts` — the pass: stops on an empty page (`done`) and *not* on a
  page whose every item was already known; stops at `maxPages` (`exhausted`);
  stops and records `broken` when two consecutive pages carry the same guids, and
  does so before handing that page to ingest; walks at most `pagesPerPass`;
  resumes from the stored position; starts at page one; a failed fetch leaves the
  position alone; one feed's failure does not stop another's; a feed with no
  `backfill` config is never fetched; pages are filed as history, never as
  arrivals.
- `scheduler.test.ts` — a timer is registered only when `runBackfill` is supplied.

Injected `now: () => number` on the pass deps, per `pipeline/metadata.ts:50`, and
`mock.timers` for the scheduler, per the existing scheduler tests.

## 11a. Two decisions the implementation changed

Recorded because both contradict what §1 and the issue say, and a reader
comparing them should find the disagreement explained rather than assume drift.

**"Stop when every item on a page was already known" cannot work, and is not
what was built.** It is the issue's own proposed rule and it ends every walk
before it starts: page one of a feed the live poll has been reading is
*entirely* known, every time, by construction. A page of known items is the
expected case near the top of a feed and says nothing about what is below it. The
only honest end-of-history signal is a page with **no items at all**, and that is
what `done` now means. Termination does not depend on the discarded rule —
`maxPages` bounds an endless feed either way.

Strictly empty rather than "shorter than `pageSize`", which is the analogous
`theporndb.ts:583` guard, because `parseRss` drops items missing a title or link
(`parse-rss.ts:80`): a full page of malformed entries would read as short and end
the walk early. Costing one extra fetch at the end is the cheaper mistake.

**`pagesPerPass` has a floor of 2, not 1.** The repeat guard in §7 compares a page
against the one before it *within the same pass*, holding nothing across passes.
At one page per pass there is never a previous page, so the guard would silently
never run and an indexer ignoring the parameter would land in `done` — exactly the
outcome §7 exists to prevent. Making the floor structural was preferred to
persisting a guid fingerprint in the position row, which would work across passes
but adds a column and a serialisation format to carry a value that is only ever
used once. Someone wanting a gentler walk raises the interval, which costs
nothing.

Also worth noting, though it contradicts nothing: **the walk starts at page one,
not page zero.** Page zero is what the live poll requests every interval, so
walking it would spend a fetch re-reading the freshest thing the install has.

## 12. Known limitations, stated deliberately

- **A dateless feed cannot be ordered.** `FeedEntry.publishedAt` is
  `number | null` (`parse-rss.ts:3-8`), and a backfilled item without one falls
  back to `now` — reintroducing exactly the problem §8 exists to prevent, for that
  feed. Inventing a timestamp is worse than a visible, documented degradation, and
  biasing it old would be inventing one.
- **A wrong `pageSize` skips items silently** (§4). §7's guard catches a parameter
  being *ignored*, not one being *miscalibrated*.
- ~~**Renaming a feed's id in the UI drops its backfill config** (§5).~~ Fixed by
  modelling the field in the form; the submission carries the block, so there is
  nothing for a rename to fail to merge with.
- **A page of entirely malformed items reads as empty and ends the walk as
  `done`.** `parse-rss.ts:80` drops items missing a title or link before the pass
  ever counts them, so "the feed returned nothing" and "the feed returned nothing
  I could parse" are the same observation from here.
- **A feed that errors past its last page never reaches `done`.** An indexer that
  answers 503 rather than an empty page for an out-of-range offset makes the pass
  retry that page every interval, forever — one request an hour, logged each time,
  and `maxPages` does not bound it because a page that failed was never read.
  Harmless but untidy; a consecutive-failure count in the position row would fix
  it and was judged not worth a column.

## 13. Decisions taken without review

Built while the requester was unavailable, having judged the issue not
straightforward: its own "What needs deciding" section carries four open
questions, and each one changes the shape of the work. Every one of them is
answered above — §4 pagination style, §4/§6 the bound, §9 the cadence, §8
ordering — with the alternative recorded rather than only the choice.

The mitigation for deciding alone is that **the feature is inert until a feed
opts in**, so none of it reaches an existing install until someone writes a
`backfill` block by hand. If a decision here is wrong, it is wrong in a file
nobody has yet edited.
