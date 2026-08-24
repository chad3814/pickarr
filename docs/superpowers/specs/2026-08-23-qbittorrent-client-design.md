# qBittorrent download client — Design

Date: 2026-08-23
Status: designed, not implemented
Branch: `feat/49-qbittorrent-download-client-support`
Issue: [#49](https://github.com/chad3814/pickarr/issues/49)

## 1. What this adds

A second `DownloadClient` implementation, so a torrent indexer's release has
somewhere to go. `DownloadClient` (`clients/types.ts`) was written with a torrent
client in mind and only SABnzbd implements it; `addUrl`, `snapshot`, `mapPath` and
the `category` all map onto qBittorrent's WebUI API without argument.

What does not map is seeding, and that is the whole of the interesting part.
A usenet download is spent once imported. A torrent is not: its data has to stay
where it is, and the job has to stay in the client, or the ratio is abandoned and
on a private tracker the account can follow. Two of Pickarr's existing behaviours
assume the usenet reading, and both have to become client-dependent rather than
universal.

The prerequisite [#34](https://github.com/chad3814/pickarr/issues/34) named in the
issue is done: a feed now names the client its picks go to, so a torrent
indexer's release can reach a torrent client at all.

## 2. Decisions taken, and by whom

These were settled with the repository owner before design, and they are the
reason several obvious-looking features are absent below.

**The download directory and the library are on different filesystems.** So
hardlink import is impossible here, and the `hardlink` import mode the issue asks
about is **not built**. Copy is the mode, and the cost — the data exists twice for
as long as the torrent seeds — is accepted rather than engineered around. A
future single-volume installation is what would justify the third mode; building
it now would be a mode nobody can run.

**A torrent is left completely alone after import.** Pickarr marks its own row
imported and never asks qBittorrent to remove the job. qBittorrent's
`/torrents/delete` removes the torrent from the client whether or not
`deleteFiles` is set, which stops the seed; there is no "forget this but keep
seeding" operation, so the correct number of calls is zero. Pruning the client's
list stays a human decision, exactly as emptying `trashDir`
(`docs/known-issues.md`, [#36](https://github.com/chad3814/pickarr/issues/36))
and the artwork cache already are.

**A stalled torrent stays pending and visible.** A torrent with no seeders sits at
0% indefinitely and is *present* in every poll, so the missing-poll counter that
fails an absent usenet job never fires. Nothing is added to fail it. It shows on
the Downloads tab with its state and its progress, and giving up is a human
decision. This is the same asymmetry the parser and the site lookup are already
built around: an error you can see beats a guess you cannot.

**qBittorrent 5.x is the minimum supported version.** With one wrinkle, in §4.

## 3. Scope

In scope:

- A `qbittorrent` member of the download-client config, discriminated on the
  `type` literal that already exists.
- Both authentication methods qBittorrent offers, because the newer one is not
  available on the whole supported range.
- `clients/qbittorrent.ts` implementing `DownloadClient`.
- Three small changes to `DownloadClient` itself, §5.
- A state reader with the same warn-on-unrecognised discipline `historyOutcome`
  has.

Out of scope, deliberately:

- **The `hardlink` import mode.** §2.
- **Removing torrents, and any seeding, ratio or auto-management policy.** §2.
  qBittorrent owns all of it.
- **Stall detection or auto-failing.** §2.
- **`.torrent` file upload.** `/torrents/add` accepts a `torrents` multipart body
  as well as `urls`; only `urls` is implemented, because an indexer gives Pickarr
  a URL or a magnet and nothing in the pipeline holds torrent file bytes.
- **A version probe at construction.** Rejected with reasons in §4.
- **Web UI changes.** The Settings form already renders whatever the client
  config schema describes; §9 says what that means in practice.

## 4. Authentication, and why both methods are required

qBittorrent has two, and the newer one does not cover the supported range.

**Cookie login** — `POST /api/v2/auth/login` with `username` and `password`,
answering a `SID` cookie which every later request carries. Available throughout
5.x.

**API key** — an `Authorization: Bearer <key>` header, no login call and no
session. The key is 32 characters, the literal prefix `qbt_` followed by 28
alphanumerics, generated in Preferences → WebUI → API Key. It requires
**v5.2.0 or WebAPI v2.14.1**, not 5.x generally, which is the wrinkle: an
installation on 5.0 or 5.1 has no key to configure. Both methods therefore stay,
and the config takes exactly one of them (§6).

One documented property shapes the client's structure rather than just its
headers: **an API key cannot call the auth endpoints at all.** So the key path is
not "log in differently" — it is a path with no login, no cookie, no session
expiry and, critically, **no 403 re-login branch**. The two strategies are
genuinely different shapes, not one shape with a different credential, and the
implementation should reflect that rather than collapsing them behind a shared
`authenticate()` that does nothing in one case.

A 401 or 403 while an API key is configured reports a message naming v5.2.0.
Without that, an operator on 5.0 with a valid-looking key gets an authentication
failure with no hint that the *server* is what is wrong.

**A version probe at construction was considered and rejected.** Reading
`/api/v2/app/webapiVersion` at startup would catch the too-old case before the
first real request, but it costs a request per boot to pre-empt an error that
already explains itself, and it puts a version-comparison table into the client
that has to be maintained against a project that renames things. The error
message is the cheaper instrument.

## 5. Changes to `DownloadClient`

Three, all in `clients/types.ts`, all small, and each is a change to an interface
another module depends on rather than an addition beside it.

### 5.1 `FetchLike` gains an optional init

```ts
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
```

Today it is `(url: string) => Promise<Response>`, which was sufficient because
SABnzbd is GET-only — every parameter including the api key rides in the query
string (`clients/sabnzbd.ts:232`). qBittorrent needs POST with a form body for
both `auth/login` and `torrents/add`, and a header for the key.

The parameter is optional, so SABnzbd's call site and its test doubles do not
move. `healthcheck.ts:20` declares its own private `FetchLike` and is untouched.

The alternative — a second seam, `HttpLike`, used only by torrent clients — was
rejected: two seams means two kinds of test double, and the third client picks
one by coin flip.

### 5.2 `remove` becomes optional

```ts
remove?(ref: string, deleteFiles: boolean): Promise<void>;
```

The cleanup loop in `pipeline/reconcile.ts:738-746` walks finished history entries
and calls `client.remove(entry.ref, true)`. It must skip a client that does not
implement it, and `ReconcileResult.removed` must not count what did not happen.

Optionality rather than a `reclaimsFinishedJobs: boolean` flag, because a flag
leaves a `remove` on the interface that must never be called — which is the shape
of a future bug — while an absent method cannot be called by accident and the
type checker says so at the call site.

The doc comment on `remove` currently argues that the client is asked to delete
rather than Pickarr doing it. That argument stands; what needs adding is why a
client may decline to have the method at all.

### 5.3 `addUrl` gains a `label`

```ts
addUrl(url: string, name: string, label: string): Promise<string>;
```

`name` is the release title with the marker appended (`clientJobName`,
`db/downloads.ts`); `label` is the marker alone (`downloadLabel`), which since
[#28](https://github.com/chad3814/pickarr/issues/28) carries a per-installation
salt. The caller already holds both — it builds one from the other — so passing
both is strictly less lossy than making the client re-derive it.

qBittorrent needs the marker *separately* from the name, because it goes in a
different field (§7.2). The alternative is a second copy of
`LABEL_MARKER_PATTERN` outside `db/downloads.ts`, and a marker vocabulary in two
places is precisely how [#30](https://github.com/chad3814/pickarr/issues/30)
happened.

SABnzbd ignores the parameter: its marker travels inside the name, via `nzbname`.
That is worth a sentence in its implementation rather than left to look like an
oversight.

## 6. Config

`downloadClientSchema` becomes a discriminated union on `type`. The existing
member keeps `type: z.literal('sabnzbd')` unchanged. The new one:

```
id            string, min 1
type          'qbittorrent'
url           url
apiKey        optional, `qbt_` + 28 alphanumerics, or a `file:` reference
username      optional, min 1
password      optional, min 1, or a `file:` reference
category      string, min 1
importMode    'move' | 'copy'
pathMappings  as today
```

Refined so that **exactly one** of `apiKey` or (`username` *and* `password`) is
present. Both, or neither, or a half-filled pair, is a config error naming the
client id — settled at parse time rather than at the first request.

`apiKey` and `password` both reach the existing `file:` secret-reference
machinery (`SECRET_REFERENCE_PREFIX`, `config/schema.ts:9`), so neither has to sit
in the config file. The `apiKey` shape check follows the precedent of SABnzbd's
length refinement, and exempts a `file:` reference the same way, since the schema
is looking at the path rather than the resolved secret.

**`importMode` stays `z.enum(['move', 'copy'])` and `parseConfig` refuses `move`
for a qBittorrent client by name.** Narrowing the type to `z.literal('copy')`
would be a stronger guarantee, and it was rejected on consistency: cross-field
rules in this config are already enforced in `parseConfig` — a feed naming an
unconfigured plugin, and since #34 a feed naming an unconfigured client — and a
narrowed literal would additionally force `config/editable.ts:31` and the Settings
form's `importMode` control to become conditional on client type, which is a UI
change in service of a validation.

## 7. The client

`packages/core/src/clients/qbittorrent.ts`, factory
`createQbittorrentClient(config, fetchImpl)` mirroring
`createSabnzbdClient`'s shape (`clients/sabnzbd.ts:225`), including the default
`fetchImpl` carrying `AbortSignal.timeout(TIMEOUT_MS)`.

### 7.1 Requests

Every request carries either the `Authorization: Bearer` header or the `SID`
cookie, decided once at construction from which credential the config holds.
On the cookie path only, a 403 triggers one re-login and one retry; a second 403
fails.

**No credential ever appears in an error message**, following the rule
`clients/sabnzbd.ts:231` already states for the api key. For qBittorrent that
means the error must not carry the request headers either, which is a different
hazard from SABnzbd's query-string one and worth its own comment.

### 7.2 `addUrl`

`POST /api/v2/torrents/add`, form-encoded, with:

- `urls` — the release URL or magnet
- `category` — `config.category`
- `rename` — `name`, so the client's own UI shows something legible
- `tags` — `label`

then `GET /api/v2/torrents/info?tag=<label>` and read `hash` from the single
result. That hash is the ref.

**The tag is what identifies the job, not the name, and the reason is magnets.**
For a magnet, qBittorrent has no metadata at add time and reports the infohash as
the torrent's name until it arrives — the `metaDL` state. A lookup keyed on the
name we sent would miss during that window, intermittently, depending on swarm
speed. A tag is set at add time and does not depend on metadata.

This is the same idea as the label recovery in `reconcile.ts`: recognise our own
job by a marker we chose, rather than by free text the client may rewrite. Reusing
the marker means the tag is per-installation salted, so two Pickarr instances
against one qBittorrent do not read each other's torrents — the property #28
established for SABnzbd, inherited rather than rebuilt.

If the lookup returns no rows or more than one, `addUrl` throws naming the label.
More than one means two downloads share a marker, which is a bug elsewhere and
must not be resolved by picking arbitrarily.

### 7.3 `snapshot`

One `GET /api/v2/torrents/info`, unfiltered, matching the existing contract that
a snapshot is everything the server holds so `complete` can mean something
(`ClientSnapshot.complete`). Each torrent maps to a queue or history entry by
§8.

Field mapping: `hash` → `ref`, `name` → `name`, `category` → `category` (with the
client's empty-string-means-none normalised to `null`, as the interface requires),
`progress` → `percentage`, `content_path` → `storagePath`.

`percentage` is an integer 0–100, not a fraction: `clients/sabnzbd.ts:480` parses
it with `parseInt` and `routes/Downloads.tsx:208` renders it as `{percentage}%`.
qBittorrent's `progress` is a float 0–1, so it is `Math.round(progress * 100)`.
Passing the fraction through would render every torrent as `0%` until it finished.

`content_path` rather than `save_path`: `save_path` is the containing directory,
while `content_path` is the torrent's own file or folder within it, which is what
the importer needs to list.

`complete` is true when the request succeeded. Unlike SABnzbd there is no paging
and no reported total to disagree with, so there is no partial-snapshot case to
detect — worth stating in a comment, because a reader who knows the SABnzbd
implementation will look for one.

### 7.4 `remove`

Not implemented. §2.

### 7.5 `mapPath`

**Extract the loop at `clients/sabnzbd.ts:571-578` into a shared helper** — say
`applyPathMappings(mappings, clientPath)` in a small module both clients import —
and have each `mapPath` delegate to it.

A second copy would be the cheaper edit, and it is the wrong one here. `mapPath`
is the translation a recursive delete used to be aimed through, and the interface
comment on `remove` says so explicitly; two copies free to drift is not a risk
worth eight saved lines. The extraction is behaviour-preserving and the existing
SABnzbd mapping tests cover it.

## 8. State mapping

The equivalent of `historyOutcome` (`clients/sabnzbd.ts`), with the same
discipline: an explicit table, and a warning for anything not in it.

| `state` | Reads as |
|---|---|
| `downloading`, `metaDL`, `stalledDL`, `queuedDL`, `forcedDL`, `allocating`, `checkingDL`, `checkingResumeData`, `moving`, `pausedDL`, `stoppedDL` | queue |
| `uploading`, `stalledUP`, `queuedUP`, `forcedUP`, `checkingUP`, `pausedUP`, `stoppedUP` | history, `completed` |
| `error`, `missingFiles` | history, `failed` |
| anything else, including `unknown` | queue, warn once per process |

Three things about this table are deliberate.

**Both `paused*` and `stopped*` are accepted, and the docs did not settle which is
right.** The WebUI API 5.0 wiki documents `pausedUP`/`pausedDL` and does not
mention `stopped*`; qBittorrent 5.0 renamed the concept to Stop in its user
interface, and the documentation does not say whether the API followed. Accepting
both costs two rows. Guessing wrong means a completed torrent reads as
unrecognised. The warning is what will tell us which is actually emitted, and the
table should be trimmed once a real server has answered.

**A seeding torrent is `completed`, not still-in-queue.** From Pickarr's side the
download is finished the moment the data is there; that the client goes on
uploading is the client's business. Reading `uploading` as queue would leave the
row downloading forever, which is the same defect the stall decision declines to
create.

**Unrecognised reads as queue, not failed.** A state we do not know is a state we
cannot conclude anything from, and the interface is explicit that a snapshot may
never be used to conclude absence. Queue is the reading that changes nothing;
`failed` would destroy a download over a vocabulary gap, which is exactly what
`historyOutcome`'s own comment records happening to SABnzbd's multi-part jobs.

## 9. Wiring

`main.ts:211-212` constructs a client per config entry and today always calls
`createSabnzbdClient`. It becomes a switch on `clientConfig.type`, exhaustive over
the union so a third client is a type error rather than a silent SABnzbd.

`config/editable.ts` and the Settings form already carry `type` through; the form
renders the fields the schema describes. What it will *not* do without further
work is show the right credential field per client type — an operator editing a
qBittorrent client in Settings sees the union's fields. That is a follow-up, and
`EditableFeed`'s own comment records the hazard it belongs to: a field the form
does not model is dropped when the record is renamed. This design does not change
the form, and a qBittorrent client should be configured in `config.json` until it
does.

## 10. Tests

Against an injected `fetchImpl`, in `packages/core/test/clients/qbittorrent.test.ts`:

- **The state table, row by row.** One case per state, asserting queue-or-history
  and the outcome. Then an invented state asserting it lands in queue and warns
  once, and that a second occurrence does not warn again.
- **`addUrl`** posts the four fields, then resolves the hash from the tag lookup.
  Assert the *request*, not just the answer: `tags` is the label and `rename` is
  the name, since swapping them would still return a hash and still pass a
  weaker test.
- **`addUrl` with no rows, and with two rows**, both throwing and naming the
  label.
- **Both auth paths.** Key path: every request carries the bearer header and no
  login is issued. Cookie path: login once, `SID` on later requests, one re-login
  on 403, failure on a second. Assert no credential appears in any thrown
  message — the SABnzbd suite has the equivalent for the api key.
- **`snapshot`** maps `content_path`, normalises an empty category to `null`, and
  converts `progress` 0–1 to a percentage. A `progress: 1` torrent in a seeding
  state is `completed`.
- **`remove` is absent**, asserted directly, so making it a no-op later is a
  test failure rather than a quiet regression.

In `packages/core/test/config/load.test.ts`:

- Exactly-one-credential: both refused, neither refused, username without
  password refused, each valid form accepted. Each error names the client id.
- `importMode: 'move'` on a qBittorrent client refused by name.
- A malformed `apiKey` refused; a `file:` reference exempted from the shape check.

In `packages/core/test/pipeline/reconcile.test.ts`:

- A finished job on a client with no `remove` is not removed, `removed` stays 0,
  and the rest of the pass still runs. This is the one that would catch cleanup
  quietly reaching for a method that is not there.

## 11. Risks

**The tag lookup is a second round trip that can lose a race.** If
`/torrents/info?tag=` is asked before qBittorrent has registered the add, it
answers nothing and `addUrl` throws — the submission succeeded but Pickarr has no
ref. The label recovery in `reconcile.ts` is exactly the machinery for that: the
next poll finds a job carrying our marker and adopts it. Worth stating in the
implementation, because the throw looks like a failure and is in fact recoverable.

**Copy mode doubles the storage for as long as a torrent seeds.** Accepted in §2,
but it is the thing most likely to surprise later, and it belongs in the README
beside the client config rather than only here.

**Nothing prunes qBittorrent's list.** By design, and the same shape as
`trashDir`. It should be said out loud in `docs/known-issues.md` so it is a known
cost rather than a discovery.

**The state table is written from documentation, not from a server.** §8 says
which part is uncertain. The first real run is the measurement, and the warning
is the instrument.
