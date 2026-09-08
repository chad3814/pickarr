# Pickarr 2.0 Slice E — The Read API

The fifth slice of the 2.0 backend. Four slices have built writers: a plugin
contract, a feed reader, a job dispatcher, download submission, and reconcile.
**Nothing reads.** `MediaWriter` covers every write to the shared tables and has
no counterpart, so slice A's spec already recorded the consequence — *"the read
API is slice E's, and until it exists every plugin will improvise one"* — and the
test double proves it, hand-writing SQL against `rss_item` through the untyped
`ctx.db`. Reconcile then added five columns per download table that nothing can
read at all.

This slice builds the read side once, for both consumers that need it.

## 1. What this slice delivers

- **One query layer** over the shared tables, with keyset cursors. Every read in
  the slice goes through it.
- **`MediaReader` on `PluginContext`** — the typed counterpart to `MediaWriter`,
  so a plugin stops improvising SQL against tables it does not own.
- **An HTTP read API**, read-only, served from `node:http`: keyset-paginated sync
  endpoints and artwork bytes.
- **Tombstones, migration 9** — so a client that has cached a media item learns
  when a merge deletes it.

### 1.1 Not in this slice, deliberately

- **No mutations. Not one endpoint.** 1.x's server has twenty-four routes, most
  of them writes — config, restart, backup, pick, dismiss, retry, requery,
  manual fields. None arrives here. A read API that also writes is two slices
  wearing one name, and the write surface needs decisions this slice does not
  have to make.
- **No client.** The IndexedDB rewrite is the next slice; this one gives it
  something to sync against.
- **No auth, and the server binds to loopback only.** See §8 — this is a stated
  consequence, not an oversight.
- **No WebSocket and no SSE.** The client polls with a cursor. A push channel is
  an optimisation of a protocol that does not exist yet.
- **No search, no filtering beyond the cursor and media type, no sort options.**
  Keyset pagination and one order.

## 2. The forks, and how each was decided

**The cursor is `(updated_at, id)`, not `id`.** Slice A's spec describes the flow
as *"the client provides a media type and the last media item id it has"*, and
justified integer rowids by it. That flow only ever sees **appends**. Reconcile
updates rows constantly — status, percentage, `absent_since` — and an id cursor
would never show a client any of it. A composite cursor ordered
`(updated_at, id)` sees appends and updates both, and the `id` tiebreak is what
makes it stable when several rows share a millisecond. This supersedes slice A's
wording; the rowid justification still holds, because the tiebreak needs
monotonic orderable ids for exactly the reason given there.

**The download union's cursor carries a third component, `transport`.**
`(updated_at, id)` is a key on any *one* table, because `id` there is that
table's `INTEGER PRIMARY KEY`. It is not a key across `torrent_download` and
`nzb_download`: `id` is a per-table rowid, so one row from each table can carry
the same `(updated_at, id)` pair exactly, and a cursor naming that pair cannot
say which of the two it stood after. The next page's `id > ?` then drops the
other one, silently and permanently — measured at 400 rows across the two
tables, 399 ever served. So the downloads read orders and pages by
`(updated_at, transport, id)`, which *is* a total order: `transport` is constant
within each branch of the union and the two values are disjoint.

This is a second cursor type (`UnionCursor`), not a third optional field on the
first. `exactOptionalPropertyTypes` makes an optional field awkward at every
construction site, and a cursor whose meaning depends on which route issued it
is the shape of a later bug. The two things being paged genuinely have
different keys.

**The keyset predicate is a row-value comparison, not the `OR` form.** For a
cursor `(t, i)` the predicate is

```sql
WHERE (updated_at, id) > (?, ?)
```

and **not** the equivalent-looking

```sql
WHERE (updated_at > ?) OR (updated_at = ? AND id > ?)
```

The two return exactly the same rows. Only the first can be turned into an
index seek. The `OR` form plans as `SCAN rss_item USING INDEX rss_item_updated`
— which *names* the index while reading the whole of it from entry one — so its
cost grows with how far a client has paged: measured at 200,000 rows,
0.30 / 4.02 / 7.85 ms per page at cursor depths 1,000 / 100,000 / 199,000,
against a flat 0.20 ms for the row-value form. `node:sqlite` is synchronous, so
that is blocked event loop, growing as the table does.

The mechanism matters because it decides how not to repair it: the two `?` in
the `OR` form are distinct parameters, so nothing tells SQLite they hold the
same value and it cannot derive the `updated_at >= ?` range the disjunction
implies. One numbered parameter used twice (`?1`) does seek, but the row-value
form says the same thing in a single comparison instead of relying on the
planner noticing the repetition.

Strictly `>`, never `>=`: the cursor row has already been served. The index
tests assert **the columns the seek itself names** — the plan must read
`SEARCH media_item USING INDEX media_item_sync (plugin_id=? AND updated_at>?)`
and not merely contain the index's name, and not merely contain `SEARCH`.
That took three iterations, and the middle one is recorded here because it is
the belief that let the slow form survive being written down in this section
as correct:

1. **The index is named.** Insufficient: `SCAN t USING COVERING INDEX t_u`
   names the index while reading the whole of it, which is exactly how the
   `OR` predicate hid.
2. **The plan says `SEARCH`.** Also insufficient, and this is what this
   section originally mandated. For a query with a leading equality the `OR`
   form still plans as `SEARCH media_item USING INDEX media_item_sync
   (plugin_id=?)` — a genuine seek, of the *plugin*, followed by a walk of
   every one of that plugin's rows, measured at 9.84 ms per page against
   0.18 ms.
3. **The seek names its columns.** The cursor's column has to appear inside
   the parentheses, because that fragment is the only part of the plan the
   two predicate forms differ on.

**Deletes get tombstones, in a savepoint that already exists.** `media_item`
rows really are deleted: `MediaWriter.dropMediaItem` removes one along with its
poster, background and logo rows, inside `SAVEPOINT drop_media_item`. A client
holding item 500 would otherwise never learn it was merged away, and no cursor
over live rows can express absence. A tombstone insert joins that savepoint, so
the row's disappearance and the record of it commit together or not at all.

The alternative — a global generation counter and a full resync whenever it moves
— was rejected because merges are routine, and it would make every one of them
cost a full refetch of everything.

**Artwork's content type is sniffed from the bytes, never stored.** The artwork
store writes a fixed `.bin` suffix on purpose: the path is a pure function of
`(mediaItemId, url)` so that a CDN re-serving a png as a jpg overwrites in place
rather than orphaning the old file. That decision means **no content type exists
anywhere in the schema**, and a browser `<img>` needs one. Adding a
`content_type` column would create a second source of truth that the very
re-serve the store was designed for could desync. Sniffing magic bytes on read
cannot drift, because it is derived from the bytes being served.

**Validators are weak, and that is forced.** The cached path is a hash of
`(mediaItemId, url)` — *not* of the content — so it is stable across a re-fetch
and cannot serve as a strong validator. `ETag: W/"<mtime>-<size>"` with
`Last-Modified` is what the filesystem actually knows. Claiming a strong ETag
from a path that survives content changes would be a lie a cache would believe.

**`node:http`, no framework.** Six routes, read-only, on loopback. The host has
no HTTP dependency today and this is not the reason to acquire one.

**One query layer, and the HTTP handlers contain no SQL.** Both consumers —
plugins in-process, the client over HTTP — call the same functions. Two readers
with their own queries would drift on exactly the questions that matter: what
counts as deleted, what a null `client_ref` means, which rows are terminal.

**`MediaReader` returns plain data, not Drizzle rows**, for the same reason
`MediaWriter` takes plain data: the plugin has never seen the host's schema
types, and handing it a typed row would couple every plugin to our migrations.

## 3. Schema, migration 9

```sql
CREATE TABLE deleted_media_item (
  media_item_id INTEGER PRIMARY KEY,
  plugin_id     TEXT    NOT NULL,
  deleted_at    INTEGER NOT NULL
);
CREATE INDEX deleted_media_item_at ON deleted_media_item (deleted_at, media_item_id);

CREATE INDEX media_item_sync    ON media_item (plugin_id, updated_at, id);
```

`media_item_id` is the primary key rather than a surrogate: one tombstone per
id is the whole truth there is to record. An id *can* be reused — SQLite hands
the highest rowid out again once its row is deleted, measured against
`node:sqlite`, and the dedup path drops exactly the newest row — so the write
is an upsert (`ON CONFLICT (media_item_id) DO UPDATE`) that moves the
tombstone's owner and time forward. A plain INSERT would abort on the key and
take the whole second deletion down with it, leaving the loser of that claim
alive. "Forward" is only forward **within one plugin**: when the reused id is
taken by a *different* plugin, moving the owner forward is what overwrites the
first plugin's record of its own deletion. See §8 — the trade is real and this
is still the least-bad side of it.

`plugin_id` is copied onto the tombstone because the row it names is
gone by the time anyone reads it, and a client syncing one media type must not
be told about another's deletions.

`rss_item` gets **no new `(updated_at, id)` index**: `rss_item_updated` has
covered exactly those columns since migration 1, byte for byte, and the read
API uses it. An earlier draft of this spec created a second one under a
different name — two identical B-trees, both maintained on every `rss_item`
write, for a query that can only ever use one. A test asserts exactly one index
covers those columns.

It does get one index it has never had, in **migration 10**:

```sql
CREATE INDEX rss_item_media_item ON rss_item (media_item_id);
```

`MediaReader.rssItemsFor` — "every release found for this media item" — filters
on `media_item_id`, which nothing had ever indexed, so that query planned as a
bare `SCAN rss_item`. It is asked **once per media item**, so a plugin walking
its library scanned the whole of `rss_item` once for every item in it. One
column, not `(media_item_id, id)`: an index entry already carries the rowid, so
the query's `ORDER BY id` needs no sort on top — measured, no
`USE TEMP B-TREE FOR ORDER BY` in the plan.

Migration 10 also carries the half of migration 5's rename that migration 5 did
not do:

```sql
UPDATE rss_item SET download_type = 'nzb' WHERE download_type = 'usenet';
```

Migration 5 renamed `'usenet'` to `'nzb'` on `rss_feed` **and only there**,
while `feeds/reader.ts` copies a feed's `download_type` onto every `rss_item`
it inserts — so every rss item written before migration 5 ran still held
`'usenet'`. `RssItemRead.downloadType` is typed `'torrent' | 'nzb'`, which was
a lie for exactly those rows.

This does not make the column safe by construction, and the read layer's
refusal stays: `download_type` is TEXT with no CHECK, and `PluginContext.db`
hands a plugin the raw connection, so a row written *after* this migration can
still carry any string. The union is honest because the read boundary enforces
it, not because the schema does — see §4.

The sync indexes exist because every cursor query orders by
`(updated_at, id)` and filters by plugin. **A test asserts each index is
*sought*, and asserts which columns that seek names**, via
`EXPLAIN QUERY PLAN` against the query text the code itself exports —
reconcile shipped two status indexes that no query ever used, and nothing
noticed until a reviewer measured a 153 ms tick. Neither weaker assertion
holds: `SCAN … USING INDEX …` names an index while reading all of it, and a
bare `SEARCH` is satisfied by a seek of the leading `plugin_id` followed by a
walk of everything behind it. So the assertion looks for the seek's own
column list — `(plugin_id=? AND updated_at>?)`. See §2 for the three
iterations that got there and the row-value predicate that earns the seek.

## 4. `MediaReader`

```ts
export interface MediaItemRead {
  id: number; title: string; releaseDate: string | null; description: string | null;
  provider: string | null; providerRef: string | null;
  createdAt: number; updatedAt: number;
}
export interface RssItemRead {
  id: number; feedId: number; filename: string; link: string;
  mediaItemId: number | null; resolution: string; resolutionDetail: string | null;
  downloadType: 'torrent' | 'nzb'; deliveredAt: number | null;
}
export interface DownloadRead {
  id: number; rssItemId: number; downloadClientId: number;
  transport: 'torrent' | 'nzb'; status: string; clientRef: string | null;
  infohash: string | null; percentage: number | null;
  absentSince: number | null; deliveredAt: number | null; lastError: string | null;
}

export interface MediaReader {
  mediaItem(id: number): Promise<MediaItemRead | null>;
  mediaItemByProviderRef(provider: string, ref: string): Promise<MediaItemRead | null>;
  rssItemsFor(mediaItemId: number): Promise<RssItemRead[]>;
  downloadsFor(rssItemId: number): Promise<DownloadRead[]>;
}
```

Reaches `PluginContext` as **`read`**, beside the existing `media` writer.
`media` is not renamed: every plugin, the test double and the flow tests all
name it, and a rename would churn every one of them to no benefit.

`mediaItemByProviderRef` was called `mediaItemByExternalReference` in the first
draft of this section, and the name was wrong in a way that mattered: it points
at the `external_reference` table, and this reads `media_item.provider` /
`media_item.provider_ref` — the pair `media_item_provider_ref` dedups on and
the pair `MediaWriter` writes. `external_reference` exists (migration 1) and
**has no writer at all**; slice A's spec records it as unreachable through the
contract. Querying it would be dead code that looks like coverage, so it is
deliberately not consulted, and the method is named for the fact it actually
looks up.

**A plugin sees only its own.** `mediaItem` and `mediaItemByProviderRef` filter
on the calling plugin's id directly, the way `MediaWriter` already scopes its
writes. `rssItemsFor` and `downloadsFor` take an id rather than a plugin id,
but ownership is still checked, one join further on: an rss item belongs to a
feed and a feed names its plugin (`rss_item.feed_id -> rss_feed.plugin_id`,
the join `db/owner.ts`'s `ownerPluginId` already uses), and a download
belongs to an rss item. An id belonging to another plugin's feed reads back
`[]`, not that plugin's releases -- a plugin that could read another's items
would be reading a schema it has never seen, and the `None`-category class of
bug says what happens when one subsystem interprets another's vocabulary.

That leaves one asymmetry, and it is `MediaWriter`'s, not `MediaReader`'s:
`ctx.media.setResolution` and `ctx.media.dropMediaItem` still take any id and
act on it regardless of who wrote the row. Scoping the writer the same way is
a later slice's change.

`downloadsFor` reads both download tables and tags each row with its
`transport`, the same shape `DownloadRow.table` already carries internally.
`status` is `string`, not the host's union: the vocabulary is the host's and will
grow, and a plugin pinned to today's six values would break on the seventh.

## 5. The HTTP API

Read-only. Six routes.

```
GET /api/health                          → { ok: true, version }
GET /api/media?type=<t>&since=<cursor>   → { items, cursor, done }
GET /api/rss-items?since=<cursor>        → { items, cursor, done }
GET /api/downloads?since=<cursor>        → { items, cursor, done }
GET /api/deletions?type=<t>&since=<cursor> → { ids, cursor, done }
GET /api/artwork/:kind/:mediaItemId      → bytes
```

`/api/deletions` takes a `type` for the same reason `/api/media` does, and it
has to: a tombstone carries the `plugin_id` that owned the deleted row
precisely because there is no `media_item` left to join to, and §4 above is
explicit that one media type's client must not be handed another's deletions.
This route was first written here without a `type`, which left it with no
plugin id to pass `deletionsSince` and no way to scope what it answered.
Corrected during Task 6, which is where the two halves met.

A cursor is an opaque string the client echoes back — `<updatedAt>.<id>`, or
`<updatedAt>.<transport>.<id>` on `/api/downloads`, whose two tables are two
separate rowid spaces (see §2's fork on the union cursor) — encoded
so a client cannot be tempted to construct one. `done: true` means the page
reached the end of what exists now, which is the client's signal to stop paging
and start polling. Page size is fixed and stated in one constant.

`:kind` is `poster` | `background` | `logo`. A media item with no artwork of that
kind is a 404, not an empty 200. A row whose `path` is null — recorded but never
fetched — is also a 404: there are no bytes, and a zero-length 200 would cache as
though there were.

**A missing `type` is a 400, and a non-GET is a 405.** Both routes that need a
`type` to name a plugin — `/api/media` and `/api/deletions` — answer
`400 { error: 'a type query parameter is required' }` when it is absent *or*
empty. That is deliberately not the 404 a well-formed unknown type gets: a
request with no type is malformed and every poll will repeat it until the
client is fixed, while `?type=tv` on a host that serves no tv plugin is a
well-formed question with a real answer (`404 unknown media type: tv`). And
because the API is read-only, the method is checked *before* the path: any
method but GET is `405 { error: 'method not allowed' }`, on a known route and
an unknown one alike, `HEAD /api/health` included. A router that matched only
paths would answer a POST with a page of data, which is not something this API
should ever appear to accept. All of the above measured against the running
server, not read off the code.

**Every response is JSON except artwork.** Errors are
`{ error: <message> }` with a status, and **no error carries a path, a url or a
query string** — the redaction rules from slice C apply to anything this server
writes, and a download row's `last_error` is already redacted at rest.

## 6. Where it runs

`main.ts` starts the server after `host.start()` and stops it before
`host.stop()`. Port from `PICKARR_READ_API_PORT`, default 8787, **bound to `127.0.0.1`**.

Shutdown closes the listener and does not wait for in-flight requests to drain,
matching what the dispatcher already does with in-flight jobs: a read that is
abandoned mid-response costs a client one retry, and waiting is the coupling the
job slice deliberately removed.

## 7. Testing

The properties worth pinning, each because it fails silently:

1. **A cursor sees an update, not only an append.** Change a row's `updated_at`
   behind an existing cursor and assert the next page contains it. An
   id-cursored implementation fails this, which is the whole reason for §2's
   first fork.
2. **A cursor is stable across rows sharing one `updated_at`.** Several rows on
   the same millisecond, paged one at a time, each appearing exactly once.
3. **A deleted item reaches the client.** `dropMediaItem`, then a `/deletions`
   page carrying its id — and the tombstone is in the same savepoint, so a
   forced failure mid-drop leaves neither the deletion nor the tombstone.
4. **A plugin cannot read another plugin's rows.** A media item by id and by
   *provider* reference — `mediaItemByProviderRef`, the name §4 explains;
   `external_reference` is a different table and is deliberately not
   consulted — both `null` rather than an error. And an rss item or a
   download reached through another plugin's feed, both `[]` rather than an
   error, for the same reason: "not yours" and "not there" must stay one
   answer.
5. **Each sync index is *sought*, by the columns its seek names**, via
   `EXPLAIN QUERY PLAN` against the exported query builder — not a restated
   lookalike, and neither "an index is named" nor a bare `SEARCH`, both of
   which the slow predicate satisfies. See §2.
6. **Artwork's content type comes from the bytes.** A png served as
   `image/png` and a jpeg as `image/jpeg` from the same `.bin` suffix.
7. **A null artwork path is a 404**, not a zero-length 200.
8. **No error response carries a url, a path or a query string.** One assertion
   per error route, asserting the absence of a recognisable secret.

## 8. Consequences

- **The API is unauthenticated.** Anything that can reach the port can read every
  media item, every feed item and every download. Loopback binding is the whole
  of the protection, so a reverse proxy or a container publishing that port
  exposes the library. Auth is the next slice's to add, and it is a real gap
  until then, not a theoretical one.
- **A client's first sync reads everything.** No snapshot, no compaction — a
  library of 50,000 items pages through 50,000 items once. Acceptable because it
  happens once per client, and the alternative needs a bulk format nothing
  consumes yet.
- **Tombstones accumulate forever.** Nothing prunes them, because pruning needs
  to know the oldest cursor any client still holds, and no client registers
  itself. One row per deleted media item is small; the decision to prune belongs
  with whatever first tracks clients.
- **A media item id reused across plugins erases the first plugin's unread
  deletion.** There is one tombstone row per `media_item_id`, and
  `dropMediaItem`'s upsert sets `plugin_id = excluded.plugin_id`. So: alpha's
  item 1 is dropped and tombstoned to alpha; SQLite hands id 1 back to the next
  `createMediaItem`, which is beta's; beta drops it. Alpha's tombstone is now
  beta's, `/api/deletions` for alpha's media type stops reporting id 1, and an
  alpha client that had not polled inside that window never learns item 1 was
  deleted — and cannot ever, because the live row is gone, so nothing in its
  media-item stream corrects the record either. Reproduced against
  `node:sqlite` with the real writer and the real `deletionsSince`, and the
  owner half of it is already pinned by a test — `test/media/writer.test.ts`
  asserts the re-tombstoned row names the *second* plugin.

  It is nonetheless the least-bad option available with one row per id, which
  is why the code is not changed: keeping the older tombstone loses *beta's*
  deletion instead, and a plain INSERT aborts on the primary key (errcode
  1555) and rolls the whole second deletion back, so no deletion is recorded
  at all and the duplicate row stays alive — which is the bug the upsert was
  added to fix. Closing it properly means a tombstone keyed on
  `(plugin_id, media_item_id)`, or ids that are never handed out twice, and
  both are larger than this slice. The exposure needs a cross-plugin reuse to
  open at all, since SQLite only hands an id back when the row deleted was the
  highest one.
- **`updated_at` is a wall clock.** A clock moved backwards can hide a row from a
  cursor that has already passed its new timestamp. Nothing in the host uses a
  monotonic sequence today, and adding one is a bigger change than this slice;
  the exposure is a manual clock change on the host, and it is recorded rather
  than fixed.
- **Nothing reads `ranking_score`, `role`, `person` or `filepath_mapping`.** They
  have no reader after this slice either. Only what a client needs to render and
  a plugin needs to decide is here.
