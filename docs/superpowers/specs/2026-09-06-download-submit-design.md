# Pickarr 2.0 Slice C — Submitting a Download

The fourth slice of the 2.0 backend. A pick reaches a real download client and
you can see it there. Nothing polls the client afterwards and nothing imports a
file — those are the next two slices, and they are deliberately designed against
tables this one creates rather than the reverse.

## 1. What this delivers

- **`download_client` says what it downloads and which software it is** — two
  facts with two different lifetimes.
- **Two download tables**, one per client type, recording what was submitted and
  the client's own reference for it.
- **Two client adapters**, qBittorrent and SABnzbd, behind slice A's
  `DownloadClients.submit()`.
- **Credential redaction** in every error path, including one that leaks today.

### 1.1 The decisions taken before this spec

- **`type` and `implementation` are separate columns.** `type` is `torrent` or
  `nzb` and picks the download table; `implementation` is `qbittorrent` or
  `sabnzbd` and picks the API adapter. The first axis is expected to stay at two
  values forever; the second is expected to grow. One column holding both would
  conflate a stable fact with a growing one.
- **One download table per type, split on day one.** `torrent_download`
  additionally stores the infohash — available before the client is called when
  the link is a magnet, and the key a tracker and a client both agree on.
  `nzb_download` has no equivalent at any point.
  The rest of the divergence — seeders and ratio against par2 repair and unpack
  state — arrives with reconcile, but the split is justified now rather than on
  a promise.
- **`nzb`, not `usenet`.** Slice B's `rss_feed.download_type` says `usenet`,
  which would make a feed's type and a client's type two spellings of one
  concept on two tables that must be compared. This slice renames the feed's
  value. `nzb` names the file; `usenet` names the transport.
- **No label marker and no installation salt.** 1.x decorates every job name
  with a per-installation token so one Pickarr never adopts another's jobs.
  That guards a scenario nobody has met, and Radarr and Sonarr need no such
  discriminator: they recognise their work by the reference recorded at submit
  and the category submitted under, both of which we already have. The marker's
  only real use is a submission that succeeded while its ref went unrecorded,
  and that case belongs to reconcile. See §10 for what accepting this costs.
- **The transport is the existing per-hostname queue**, except qBittorrent's
  legacy cookie login. `HostFetch` returns parsed bodies and cannot expose
  `Set-Cookie`, so that one request uses `fetch` directly. It is the only thing
  outside the queue, and it is the uncommon path: qBittorrent 5.2.0 and newer
  authenticate with a bearer token, which is a header and needs nothing special.

### 1.2 What this slice is not

- **No polling.** Nothing reads a client's queue or history, so a submitted
  download has no status beyond "we submitted it". `ClientSnapshot` and its
  `complete` flag are reconcile's.
- **No importing.** `download_client.import_mode` and every
  `filepath_mapping` row stay unread, and `onDownloadedFile` still has no
  caller.
- **No client management UI or API.** Rows are seeded, as feeds are. The API
  slice owns configuration.
- **No third implementation.** Transmission, Deluge and NZBGet are why
  `implementation` is a column rather than a boolean, and nothing more.

## 2. Client identity

```
download_client
  type            'torrent' | 'nzb'          -- picks the download table
  implementation  'qbittorrent' | 'sabnzbd'  -- picks the adapter
```

`type` already exists as bare `TEXT NOT NULL` with nothing constraining or
documenting it; this slice gives it a meaning and adds `implementation`
alongside.

**A mismatch between the two is a configuration error, not a runtime
possibility to handle.** A `torrent` client whose implementation is `sabnzbd`
cannot work, so the adapter factory rejects the pairing when the row is read
rather than discovering it at the first submission.

## 3. The two download tables

Both carry the submit columns:

```
  id                 INTEGER PRIMARY KEY
  rss_item_id        INTEGER NOT NULL REFERENCES rss_item (id)
  download_client_id INTEGER NOT NULL REFERENCES download_client (id)
  client_ref         TEXT                      -- null until the client answers
  status             TEXT    NOT NULL          -- 'submitting' | 'submitted' | 'failed'
  attempts           INTEGER NOT NULL DEFAULT 0
  last_error         TEXT
  created_at         INTEGER NOT NULL
  updated_at         INTEGER NOT NULL
```

`torrent_download` adds `infohash TEXT`, nullable — see §7, where a magnet
supplies it and a `.torrent` URL does not.

**`infohash` and `client_ref` hold the same string for a torrent, and are still
two columns.** They record different facts: `infohash` is what we parsed from
the link and therefore *know we submitted*, written before the client is
called; `client_ref` is what the client *confirmed back*. The pair distinguishes
three states a single column cannot — nothing submitted, submitted but
unconfirmed, and confirmed — and the middle one is exactly what a crash between
request and response leaves behind. For an nzb there is no such distinction,
which is the other half of why the tables differ.

**`client_ref` is nullable and that is the point.** A row is written *before*
the client is called, so a submission that crashes between the request and the
response leaves evidence rather than nothing. A unique index on
`(download_client_id, client_ref)` keeps two rows from claiming one job, and the
many rows still waiting on an answer coexist because SQLite exempts NULL from a
unique constraint. The `WHERE client_ref IS NOT NULL` clause — the same partial
shape 1.x uses — is therefore an intent marker and an index-size saving, not the
mechanism: dropping it changes no insert's outcome. Implementation found this
worth stating, because the reason it is safe is not the reason it looks safe.

**Status is deliberately three values, not a state machine.** `submitting` is
written first, `submitted` when a ref comes back, `failed` when the client
refuses. Reconcile owns everything after that and will add its own values; a
richer vocabulary invented now would be guessing at its needs.

## 4. Transport and auth

| implementation | auth | transport |
|---|---|---|
| SABnzbd | `apikey` query parameter | the per-hostname queue |
| qBittorrent ≥ 5.2.0 | `Authorization: Bearer` | the per-hostname queue |
| qBittorrent < 5.2.0 | username and password, `SID` cookie | **raw `fetch`**, login only |

Everything that can go through the queue does, inheriting its pacing, its
thirty-second timeout, and the slot-release guarantee that a rejected request
cannot wedge a hostname.

**The cookie login is the one exception and it needs raw `fetch` for a specific
reason.** `HostFetch`'s methods return parsed bodies, so a caller cannot reach
response headers, and the `SID` must be read from `Set-Cookie`. It must be read
with `getSetCookie()`: `Headers.get('set-cookie')` folds every cookie in the
response into one comma-joined string that cannot be split back apart safely,
because a cookie value may itself contain a comma.

Once logged in, the cookie is replayed on subsequent requests **through the
queue** — only the login itself is outside it.

## 5. Redaction

**One error path leaks a credential today.** The queue's failure message is
`fetch ${url} failed: ${status} ${statusText}`, and SABnzbd's API key travels in
the query string, so any failed SABnzbd call writes the key into an error and
into whatever logs it. That is live in merged code, not a new risk from this
slice.

Credentials reach a client through **three different channels**, so redaction is
not one pattern:

- a **query parameter** — SABnzbd's `?apikey=`
- a **header** — qBittorrent's `Authorization: Bearer`
- a **form body field** — qBittorrent's legacy `password=`

One shared helper covers all three and is used by both the queue's error path
and the adapters' own. Two copies of a redaction rule is how a channel gets
covered in one place and missed in the other.

**Exhaustiveness arms log the discriminant alone, never the object.** A download
client config serialised into an error message prints an api key or a password.
1.x learned this and says so at its `never` arm; the same discipline applies
anywhere a client row is stringified.

## 6. Choosing a client

1. The feed's `download_client_id`, when it names one.
2. Otherwise, the **only** client whose `type` matches the feed's
   `download_type` — if exactly one exists.
3. Otherwise, a loud error naming the feed and what to fix.

**Never "the first client".** 1.x sent every pick to `downloadClients[0]`
regardless of configuration, so a second client could receive nothing at all;
that is why a feed can name a client now. Falling back to a *sole* match is safe
because it is unambiguous by construction — falling back to a *first* match is
the same bug with a nicer name.

`submit()` verifies the client exists and that its `type` matches the feed's
`download_type` before calling anything. A magnet handed to an nzb client fails
confusingly downstream, and the row would record a submission that never
happened.

## 7. Getting the reference back

The two clients are **asymmetric here, and it shapes the code**.

**SABnzbd answers directly.** `addurl` with `{ name: <url>, cat, nzbname }`
returns `nzo_ids`; the first is the ref.

**qBittorrent does not.** `POST /api/v2/torrents/add` returns no identifier at
all. The ref has to come from somewhere else:

- **A magnet link carries the infohash**, which *is* qBittorrent's ref. Parse it
  from the link, store it in `torrent_download.infohash`, and use it as
  `client_ref` with no lookup at all.
- **A `.torrent` URL does not.** The infohash is inside the file, so after
  adding, the torrent must be found by category and name via
  `/api/v2/torrents/info` and its `hash` read off. 1.x notes this lookup can
  come back empty because the add has not registered yet — **that is
  recoverable, not a failure**, and the row stays `submitting` for a retry
  rather than being marked `failed`.

So a magnet is one request and a `.torrent` URL is two, and only the second can
legitimately come back without a ref on the first attempt.

## 8. Traps inherited from 1.x

Each of these cost someone a debugging session already.

- **qBittorrent answers wrong credentials with HTTP 200** and a body saying so.
  A `res.ok` check reads that as success, so bad credentials would present as a
  working client that silently never accepts a job. The body must be inspected.
- **qBittorrent reports an infohash of zero before metadata arrives.** Zero
  means "not registered yet", which is recoverable; it is not a ref.
- **A category of `None` or the empty string means no category**, not a category
  named "None". The adapter maps both to null before anything compares.

## 9. Testing

Both adapters are tested against **fakes only**. `download_client` holds
`api_key`, `username` and `password`, so no test may reach a real client and no
tooling on this slice may select those columns.

The properties worth pinning, chosen because each fails silently:

1. **A magnet's ref needs no lookup.** Submit a magnet and assert exactly one
   request was made, with the infohash taken from the link.
2. **A `.torrent` URL's empty first lookup is a retry, not a failure.** Assert
   the row stays `submitting` with no `last_error`.
3. **HTTP 200 with a failure body is a failure.** The qBittorrent login fake
   answers 200 and a refusal; assert the submission fails and says why.
4. **Every credential channel is redacted.** Three assertions, one per channel,
   each against an error message built from a failing request.
5. **A sole-client fallback works and an ambiguous one does not.** One matching
   client submits; two matching clients produce an error naming the feed.
6. **A type mismatch is refused before any request is made.** Assert zero
   requests, not merely an error.

## 10. Consequences

- **A submitted download has no status beyond "submitted".** Nothing advances
  it, so until reconcile lands, a completed download looks identical to one
  still running. That is the honest shape of a submit-only slice.
- **Dropping the label marker narrows reconcile's options.** A submission that
  succeeds while its ref goes unrecorded leaves a job in our category whose ref
  we do not know. Reconcile will have to match it on category and name, or leave
  it alone. Leaving it alone means the job downloads and is never imported —
  **a leak, not a loss**, recoverable by hand. Accepted deliberately rather than
  carrying a discriminator no comparable tool needs.
- **The cookie login is unpaced and untimed.** It is one request on the legacy
  path, and the queue covers everything after it. If that path ever becomes
  common, the right fix is a header-capable method on the queued fetch, not a
  second HTTP client.
- **`import_mode` and `filepath_mapping` remain unread**, as does
  `onDownloadedFile`. Five tables had no writer before this slice; two of them
  now do.
