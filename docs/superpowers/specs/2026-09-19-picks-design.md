# The pick button — design

**Predecessors:** `2026-09-18-feed-settings-design.md` and
`2026-09-19-download-clients-design.md`. Those built the first and second
write paths this API ever had. This is the third, and the one the other
two were leading to: it makes the download path reachable.

---

## 1. The gap

`Host.requestDownload(rssItemId)` has existed for several slices **with
no caller**. Everything behind it is built — `plugin.onDownloadRequest`
→ `ctx.downloads.submit` → a client adapter → a `torrent_download` or
`nzb_download` row → replicated back to the browser. Nothing reaches it.

`ReleaseList`'s own docblock has been saying so:

> or no download at all, since this slice is read-only and cannot pick
> one. A release with no `torrent_download` or `nzb_download` row is not
> an edge case here; it is the normal state of every release nobody has
> acted on yet, **because nobody can**.

This slice adds the caller.

## 2. Where the button goes

**One per release, inside the expanded card** — not one per media card.

`requestDownload` takes an `rssItemId`. A media card is a `media_item`,
which maps to many releases; `ReleaseList` already renders each release
with its filename, resolution and ranking score, and already holds the
id. Putting the button there means the operator picks the release they
chose, with no auto-selection rule to design and no way to act on
something they did not see.

**A release that already has a download shows its status and no button.**
`ReleaseList` renders status and percentage today. Picking is for
releases nobody has acted on, which is the normal state of nearly all of
them.

## 3. What the operator sees while it happens

A pick is asynchronous: the host hands it to a plugin, the plugin submits
to a client, the row replicates back. The button disables and reads
`Picking…` until a `torrent_download` or `nzb_download` row for that
release arrives, at which point `ReleaseList`'s existing status display
takes over.

**This does not work today, and §7 is why.** `useGatheredItem`
subscribes to the gathered `media_item` row only. Its docblock is
explicit that a correction depending on a *new* download row is "only
caught the next time something touches the media item itself". A
download row arriving notifies nothing this hook is listening to, so
`Picking…` would never resolve — the wedge shape that cost a fix round
in each of the last two slices.

## 4. The client a pick goes to

**The policy already exists and is already correct, except in one case.**
`clients/select.ts`'s `selectClientForFeed`:

| case | behaviour |
|---|---|
| feed names a client | use it |
| named client is the wrong type | refuse, naming feed and client |
| named client does not exist | refuse |
| names none, no client of that type | refuse, naming the type |
| names none, exactly one of that type | use it |
| names none, several of that type | **refuses to guess** |

Only the last row changes: it selects **at random** among the matching
candidates.

**The reasoning it replaces is kept, because it is not wrong.** That
branch argues:

> A FIRST match would not be: it is exactly the 1.x bug wearing a better
> name. 1.x sent every pick to `downloadClients[0]` regardless of how
> anything was configured, so a second client of the same type could
> receive nothing at all, forever, with no error.

That objection is to *first*-match, and random is not first-match: over
many picks every candidate receives work, which is precisely the failure
1.x had. The comment is **amended** to say what changed and why the old
argument does not reach the new behaviour — not deleted.

Random selection goes through an injected chooser, so tests are
deterministic. The host already injects `now` for the same reason.

**Health is not consulted, because there is no health.**
`download_client` has no status, no `last_seen`, no failure counter, and
the reconcile job records nothing per-client. Random routing across a
dead client is therefore possible where two clients of one type exist.
Filed as **#93** rather than solved here; the single-client case, which
is nearly all installs, is unaffected.

## 5. Why picks fail today, and the two real defects behind it

A pick on any feed created through the settings UI throws:

> `openmetadata: rss item N is in a feed that names no download client,
> and a submission cannot say "the default"`

`AddFeedInput` has no `downloadClientId`, so every UI-created feed has it
`NULL`. That was correct when feeds shipped — no download client could
exist yet — and the download-clients slice ended that condition.

But the fix is **not** a field on the feed form. Two defects sit behind
this message:

1. **The plugin bypasses the policy.** `onDownloadRequest` reads
   `rss_feed.download_client_id` itself and throws on `NULL`. It never
   calls `selectClientForFeed`. Then `submit` calls that function anyway,
   purely to check the id the plugin just guessed. The single-client case
   that works everywhere else is broken *only* on the pick path, by a
   plugin reading a column it does not own.
2. **The contract cannot express "you decide".**
   `DownloadSubmission.downloadClientId` is a required `number`. The
   plugin's comment names this exactly — "a required number with no way
   to say that" — and refuses to invent host policy, correctly.

So: `downloadClientId` is **removed**, the plugin stops supplying one,
and `submit` resolves through `selectClientForFeed`. The contract's own
docblock already assigns this job to the host —

> The host resolves a submission to the client that received it … that
> resolution and the wiring behind it live in `@pickarr/host`.

*Amended during Task 1's fix round. This section first said the field
becomes **optional**, and that was wrong in a way only a measurement
found.* Leaving it optional kept `submit`'s check that a supplied id
agrees with the feed's client — a check written when selection was
deterministic. Once selection draws at random there is no single such
client, so that check compared a supplied id against a **fresh draw**
and refused a perfectly valid candidate: measured at **2010/3000 =
67.0%**, exactly `(n-1)/n`.

The repair first proposed here was to validate "is the supplied id among
the feed's candidates". That is worse. It says what to *validate* and
never what to **use**, so the row is still written against the draw and
a submission naming client 1 is silently recorded against client 3 — and
a silent misroute is a worse failure than a loud refusal, because nobody
reports it.

Removing the field removes the trap instead of re-specifying it. Nothing
supplied one: every real `onDownloadRequest` omitted it, and the two
sites that passed one used doubles that never reach real `submit`. The
compiler confirms the case is now unrepresentable — `TS2353` at all 13
construction sites. A future caller that genuinely needs to force a
client should reintroduce it with validate-**and-use** semantics, not
validate-only.

— so this is an existing responsibility being honoured, not a new one.

## 6. The route

`POST /api/picks`, body `{ rssItemId: number }`, session-guarded,
`methods: ['POST']`. A thin adapter over a host capability, exactly as
`/api/feeds` and `/api/download-clients` are: shape-checked here,
every value-level invariant in the host.

**`requestDownload` throws where the other two write paths return
refusals as values.** It is wrapped rather than changed in place, so the
route can map each refusal to a status and the UI can give each its own
sentence. Codes live in `@pickarr/contract`, one definition both sides
derive from — the fix the download-clients review required after finding
them hand-copied.

Refusals: `unknown-release`, `plugin-not-registered`, `no-client-of-type`,
`client-type-mismatch`, `already-submitted`. Plus the envelope codes
`invalid-shape` and `malformed-body` the previous slices established.

`already-submitted` is caught from the real partial unique index on
`(download_client_id, client_ref)`, not pre-checked — the same race-safe
shape as `duplicate-url` and `duplicate-name`.

## 7. The subscription `Picking…` depends on

`useGatheredItem` gains a subscription to inserts on `torrent_download`
and `nzb_download`, re-gathering when one arrives. `subscribeInserts` is
the same mechanism the two settings lists already use to show a new row
without refetching, and it fires for a genuine insert — which a new
download row is.

This is a change to a **shipped hook that all three browse screens use**,
so it carries its own tests and a mutation proving the new subscription
is load-bearing. Its docblock's careful account of what it deliberately
does not subscribe to is amended, not deleted.

## 8. Acceptance

1. `POST /api/picks` submits a download and answers `202 { accepted: true }`.
2. A feed naming no client, with exactly one client of its type, picks
   successfully — the case that fails today.
3. With several clients of one type, repeated picks reach more than one
   of them (the injected chooser makes this deterministic in test).
4. Each refusal reads as its own sentence; an unrecognised code and an
   offline submit each read differently again, and no outcome leaves the
   button pending.
5. A release with a download shows status and no button.
6. `Picking…` resolves when the row arrives, driven by the replica
   subscription and not by a timer.
7. No credential, url or path in any message, log or response body.

## 9. Out of scope

- **Health-aware selection** — #93.
- **A download client field on the feed form.** §5 explains why it is not
  the fix; a feed that wants a specific client can still say so, and
  nothing in this slice removes that.
- **Cancelling or retrying a download.** This slice creates picks. The
  `already-submitted` refusal names the state; acting on it is a
  different surface.
- **Auto-picking by rank.** The ranking score is displayed; nothing acts
  on it automatically.
