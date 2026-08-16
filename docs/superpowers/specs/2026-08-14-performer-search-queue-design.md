# Performer search queue — Design

Date: 2026-08-14
Status: approved for planning
Branch: `feature/performer-search-queue`

## 1. What this adds

A fallback way to attach performers to a group when a scene lookup could not.

Performers reach a group exactly one way today: `recordMetadataAnswer` calls
`upsertPerformers` and `setGroupPerformers` with the cast that came attached to a
*confirmed scene*. A group whose scene lookup settled without a confirmation —
`state = 'none'`, or a confirmation that named nobody — has no cast and no path to
one. Nothing retries, because from the metadata queue's point of view the question
was asked and answered.

This adds a second, weaker source: after a group's scene lookup settles with no cast,
queue a performer search on the first two words of its title, and link the result when
exactly one performer matches unambiguously.

The weakness is the point. The leading words of `display.title` are the *scene* title,
not a cast list, so most searches will match nothing and link nothing. The match rule
is built so that the common outcome of a bad guess is silence rather than a wrong cast
written across a library.

## 2. Scope

In scope:

- A `performer_queue` table, enqueued when a scene lookup settles on a castless group.
- A `searchPerformers` client method against TPDB's `/performers` endpoint.
- A pass that drains the queue, matches, and links on a confident match.
- A plugin seam for "what should I search for", so core stays media-agnostic.

Out of scope:

- **Any UI.** Linked performers render through the existing card path; nothing new is
  surfaced, and there is no review or confirmation screen. Auto-link or nothing.
- **A manual "search performers" button.** The lazy-trigger pattern `/api/browse` uses
  for metadata is not repeated here. If it turns out to be wanted, it is additive.
- **Re-running over existing groups.** No backfill migration. Only groups whose scene
  lookup settles *after* this ships get queued. A backfill is a one-line insert if the
  linking rate justifies it later.
- **Artwork fetching.** A linked performer arrives with urls and no files, and
  `performersNeedingArtwork` already drives that pass. Stated so nobody adds a second
  fetch path.
- **`site_performers` as a match source.** See §6.

## 3. The plugin seam

```ts
// packages/plugin-api/src/types.ts
performerQuery?(identity: GroupIdentity): string | null;
```

Alongside the existing `siteCandidates` and `metadataQuery`, and for the same reason
those exist: the plugin says what to ask, the host decides how and when to ask it. Core
never learns what a title's leading words mean.

`plugin-scenes` returns the first two words of `display.title`. That field is already
site-stripped, date-stripped and quality-suffix-stripped by `buildRelease`, so no new
stripping is needed — `display.subtitle` is the site and the quality tokens live in
`quality`.

**Fewer than two words returns `null`,** and the group is never queued. This follows the
lesson `resolve-sites.ts` records at length: a one-word query is how you confirm the
wrong entity. `Free.Use.Fantasy` resolves to the real-but-wrong site `Free` on a
one-word retry, and a one-word performer query has the same shape of failure with the
same kind of consequence.

A plugin that does not implement the method never enqueues. That is how a media type
with no notion of performers opts out — by saying nothing, not by core special-casing
it.

## 4. The queue

```sql
CREATE TABLE performer_queue (
  group_id     INTEGER PRIMARY KEY REFERENCES media_groups (id),
  requested_at INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      INTEGER NOT NULL,
  last_error   TEXT
);
```

`metadata_queue`'s shape exactly, because it is the same kind of thing: one row per
group, at most, drained by a worker with backoff and a give-up count.

**No stored query column.** The query is recomputed from the group on each pass, the way
`metadata_queue` recomputes `plugin.metadataQuery`. A title corrected by hand between
enqueue and drain then changes what gets searched, instead of a frozen string outliving
the text it was derived from.

`enqueuePerformerSearch(db, groupId, now)` is idempotent — an id already queued keeps its
existing `requested_at` and `next_at` rather than jumping the line — and refuses two
cases outright:

- the group already has rows in `group_performers`;
- the plugin yields no query.

Both refusals are silent successes, not errors. The caller is a pass draining a queue,
and a group not worth asking about is not a failure.

### 4.1 `clearGroupMetadata` must clear this row

**`performer_queue` is added to `clearGroupMetadata`, in that function and not at its
call sites.** This is not housekeeping — it is the one thing `docs/known-issues.md`
records this project getting wrong twice, both times found after the feature shipped:

- **A merge deletes the source group.** `editGroup`'s merge branch calls `deleteGroup`,
  and the group tables reference `media_groups (id)` with **no cascade**. A group holding
  an invisible queue row therefore fails the foreign key and returns a 500 — a normal
  action broken by a row nobody can see. That is verbatim what happened to
  `metadata_queue`: "merging any group that had ever been browsed failed the foreign key".
- **An edit rewrites the identity the answer described.** An auto-linked performer is an
  answer to a title. Correct that title by hand and the linked cast describes the reading
  the human just overruled, with nothing clearing it.

`clearGroupMetadata` already deletes from `group_metadata`, `metadata_queue`,
`metadata_candidates` and `group_performers`, and its doc comment already anticipates
"whatever the third one turns out to be — a path that mutates a group's identity or
display, or deletes a group, has to call it, in the same transaction as the change
itself." This is that third one. Adding the delete inside that function is what makes
every existing caller correct without any of them being touched.

There is a trap the known-issues entry warns about specifically, and it applies here:
`editGroup`'s merge branch calls `clearGroupMetadata` as a *foreign-key precondition* for
the `deleteGroup` below it, not as a statement that the answer went stale. Its presence
makes the plain-edit path look covered on a skim. Both paths need a test.

## 5. Where the enqueue happens

One call site, in `runMetadataPass`, immediately after `outcome` is known, gated on
`outcome.kind !== 'deferred'`.

A single site is deliberate. This codebase's repeated lesson — `deriveUpgradeReleaseId`,
`failDownload`'s flag re-derivation — is that an invariant re-derived by whichever caller
remembers is an invariant that holds on some paths. `runMetadataPass` is the only place
*the pass* settles a row, so every settle path within it inherits the enqueue by
construction.

It is not the only place in the codebase a metadata row settles. `http/server.ts:713-719`
calls `answerUnaskable` for a group its plugin could never look up, settling the row as
`state = 'none'` without enqueueing a performer search. That asymmetry is unresolved rather
than argued for, and it is recorded here so nobody reads "one call site" as a claim that no
second settle path exists.

It is currently **latent**, and for the scenes plugin the two conditions cannot co-occur.
Reaching that line requires `metadataAnswerability` to answer `'unaskable'`, which for a
plugin that has both metadata hooks means `sceneMetadataQuery` yielded no query — and it
does that only when `display.subtitle` is absent or empty, or when `display.title` is
empty. `buildRelease` refuses a release whose site slug is empty and writes the site into
`display.subtitle`, so no scenes group has an empty subtitle. And an empty title is not the
other half of a co-occurrence either: `scenePerformerQuery` splits `display.title` into
words and returns `null` below two, so a group with an empty title has nothing to enqueue.

The case that *would* reach it is a future plugin implementing `performerQuery` without
both metadata hooks: `metadataAnswerability` answers `'unaskable'` on the missing hooks
alone, `answerUnaskable` settles the row, and a performer query that exists is never asked.

`confirmed` and `none` both settle. `deferred` has not settled: the row will be asked
again, and a group whose scene lookup is still in flight has not yet failed to produce a
cast. The castless check in `enqueuePerformerSearch` is what makes `confirmed` safe to
include — a confirmation that supplied a cast is refused there, a confirmation that
named nobody is queued.

## 6. The client method

```
GET {baseUrl}/performers?q=<query>&page=1&per_page=100
Authorization: Bearer <apiKey>
```

Confirmed against the live API, not inferred. One page only, like `searchScenes` and
unlike `searchSites`' `MAX_PAGES` walk.

`per_page` is the client's existing `PER_PAGE` (100) rather than a smaller page. The
match rule below turns on *how many* candidates match exactly, and that is only honestly
decidable over the results actually seen — a narrow page hides a second exact match on
page two and converts an ambiguity into a confident wrong link. When `meta.last > 1` the
pass logs that it judged on a truncated set, following the same no-silent-caps habit as
the site-search total handling.

Same error discipline as the existing two search methods: `redactToken` on every message,
`RateLimited` on a 429 with `Retry-After`, an explicit timeout so a server that accepts
the connection and sends nothing cannot hang the pass.

### Reading a result

| Payload | Field |
|---|---|
| `id` (uuid string) | `sourceUuid` |
| `slug` | `slug` |
| `name` | `name` |
| `face` | `faceUrl` |
| `image` | `imageUrl` |
| `is_parent` | `kind`: `true` → `'performer'`, else `'performer-site'` |
| `aliases[]` | match input only; see §7 |

`name`, never `full_name` — the client already documents this, and it is load-bearing
here: `full_name` carries a disambiguation suffix (`Jessica Jaymes (2005)`) that could
never equal a two-word query.

**`readPerformers` cannot be reused as-is.** It derives `kind` from the presence of a
nested `parent`, which a scene's site-performers have and a top-level `/performers`
result does not — it *is* the parent, and says so with `is_parent`. Reusing it would
stamp every auto-linked performer `performer-site` and link them all to alias pages. The
shared slug/uuid/name/face/image reading is factored into one helper, with each caller
supplying how `kind` is decided.

Entries missing slug, uuid or name are dropped, exactly as `readPerformers` drops them
and for the same reason: the slug is the whole link, and an absent uuid collides with
every other such row under `UNIQUE (source, source_uuid)`.

### Return type

```ts
interface PerformerSearchResult {
  readonly performer: MetadataPerformer;
  readonly aliases: readonly string[];
}
```

`MetadataPerformer` gains nothing. Aliases are a search-time matching concern, and
putting them on the type that describes a scene's cast would push them into every
consumer that has no use for them. What gets *linked* is a plain `MetadataPerformer`, so
`upsertPerformers` and `setGroupPerformers` are untouched.

## 7. The match rule

Query and candidate strings are normalised the same way — case-folded, punctuation and
whitespace collapsed — and then, in order:

1. **Exact `name` match.** Exactly one candidate → link it. **Two or more → link nothing
   and stop.** No fall-through to aliases: a tie among exact name matches is the
   strongest ambiguity available, and breaking it with a weaker signal would be
   backwards.
2. **Exact `aliases[]` match,** consulted only when tier 1 found zero. Exactly one
   candidate has an alias equal to the query → link it. Two or more → nothing.
3. Otherwise nothing.

A candidate matching on both tiers is simply a tier-1 hit; tier 1 wins and tier 2 is
never reached.

Aliases are in scope because the provider searches them and because **the filenames are
where aliases come from** — a release is named with whatever the site billed, which is
frequently an alias rather than the canonical name. Excluding them would reject the
majority of real hits. Ranking them second is what keeps that breadth from costing
precision: a canonical name is a stronger claim than a billing alias, so when both are
available the name decides.

`site_performers` is deliberately not a match source. It is the site-scoped alias
namespace — names belonging to `performer-site` entities, which are a different identity
than the one being linked — and admitting it would widen tier 2 with names that do not
describe the row written. Worth revisiting only if alias coverage proves short.

## 8. Linking

On a confident match: `upsertPerformers` for the one performer, then link it.

**The castless check is re-done inside the write transaction.** A metadata refetch can
fill the cast between enqueue and drain, and `setGroupPerformers` deletes the group's
existing rows before inserting — so a search settling a moment after a confirmed scene
landed would replace a real cast with a one-name guess. Re-checking under the same
transaction that writes is what makes that impossible rather than unlikely.

With that guard, `setGroupPerformers` is reused rather than an additive insert written:
`position` is assigned from array order in exactly one place today, and a second writer
is a second place that could disagree about billing order.

A row is removed from the queue whether or not anything was linked. A search that ran and
matched nothing **is** an answer — the rule `resolve-sites.ts` and `runMetadataPass` both
state — and leaving the row queued would spend a request per pass forever rediscovering
the same silence. A search that could not be *made* learned nothing and defers.

## 9. The pass

`runPerformerPass(deps)`, mirroring `runMetadataPass`:

- drains up to `perTick` due rows, ordered `(requested_at, group_id)`;
- sequential, not concurrent — self-rate-limiting, and a pass this small gains nothing
  from concurrency;
- reuses `backoffFor` for deferrals;
- gives up after `MAX_PERFORMER_ATTEMPTS`, deleting the row so it stops costing a
  `perTick` slot forever;
- a 429 sets a cooldown and **breaks the whole pass**, because a rate limit is a fact
  about the service and not about one row;
- a database failure while answering or deferring one row bumps that row's
  attempts/next_at outside the failed transaction, so a poison row cannot abort every
  pass forever on the same id — the defect `runMetadataPass` documents having had.

`createPerformerRunner` wraps it with the cooldown held across calls, exactly as
`createMetadataRunner` does, and logs a skipped tick once per cooldown rather than once
per tick.

**Driven by the existing metadata tick, after the metadata pass.** No new config knob: a
second interval to tune is a second thing to get wrong, and the two passes talk to the
same rate-limited service, so sharing one cadence is what keeps the combined request rate
predictable. Running after is what orders the producer before the consumer: the pass that
settles rows castless has to run before the pass that drains them.

A row enqueued this tick is searched in the **same** tick, not the next one.
`insertPerformerSearch` writes `next_at = now`, `duePerformerQueue` selects
`next_at <= ?`, and each pass reads its clock fresh when it runs — so a row the scene pass
just wrote is already due moments later when the performer pass reads the queue. This is
worth stating because it sets the tick's worst-case request count: the sum of both passes'
`perTick`, not `perTick` itself.

## 10. Failure handling

| Situation | Behaviour |
|---|---|
| Plugin yields no query | Never queued. Nothing to defer. |
| Group already has a cast | Never queued; and if it gains one before the drain, the transaction-time re-check skips the write. |
| Search returns zero results | Answer. Row removed, nothing linked. |
| Zero exact matches among results | Answer. Row removed, nothing linked. |
| Two or more matches at the winning tier | Answer. Row removed, nothing linked. |
| HTTP 429 | Row keeps its `next_at`; pass breaks and sets a cooldown. |
| HTTP error, timeout, unreadable JSON | Defer with backoff; give up after `MAX_PERFORMER_ATTEMPTS`. |
| Group deleted between enqueue and drain | Unreachable: the delete paths clear the row first (§4.1), and the foreign key enforces it. A missing group is silence, not an error. |
| Group merged away while queued | `clearGroupMetadata` removes the row in the same transaction as the delete (§4.1). Without that, a 500. |
| Plugin throws building the query | Caught and treated as a deferral, matching `confirmMetadata`'s handling. |

## 11. Testing

**Plugin (`plugin-scenes`):** two-word extraction from `display.title`; a one-word title
yields `null`; punctuation and case normalise; a title whose leading words carry
quality-ish junk (there should be none, since `buildRelease` strips it — pin that).

**Enqueue:** idempotent, and does not reset `requested_at`; refused on a group with a
cast; refused when the plugin yields no query; queued on `confirmed`-with-no-cast; queued
on `none`; **not** queued on `deferred`.

**Match rule:** one exact name match links; an alias-only match links; a name match wins
over another candidate's alias match; two name matches link nothing *and do not fall
through to aliases*; two alias matches link nothing; zero matches link nothing. Each of
these asserts what was written to `group_performers`, not only the return value.

**Pass:** a 429 breaks the pass and sets the cooldown; give-up after
`MAX_PERFORMER_ATTEMPTS` removes the row; a row whose write throws still has its attempts
bumped, so the next pass reaches the row behind it; a cast filled between enqueue and
drain is not clobbered.

**Lifecycle (§4.1):** merging a group that holds a `performer_queue` row succeeds rather
than returning a foreign-key 500 — the regression that shipped twice; and a plain identity
edit clears the row and the linked cast. Two tests, because `editGroup`'s merge branch
already calls `clearGroupMetadata` and makes the edit path look covered when it is not.

**Client:** `kind` is `'performer'` for an `is_parent` result and `'performer-site'`
otherwise — that is the mislabel guard, and it should fail if the reader is swapped for
`readPerformers`; an entry with no slug is dropped; the api key is redacted from every
error path; `meta.last > 1` logs the truncation.

## 12. Known limitation, stated deliberately

This will link nothing for most groups, and that is the designed outcome rather than a
shortfall to fix later. Two words of a scene title are a guess that those words name a
performer; the tiered exact-match rule exists so that a wrong guess writes nothing.

If the linking rate proves too low to be worth the requests, the next moves in rough
order of cost are: match against the raw feed title's leading words before the site is
stripped; try the first *three* words as a second query; or match against a
locally-accumulated performer-name dictionary built from confirmed casts. All three are
additive and none is assumed here.
