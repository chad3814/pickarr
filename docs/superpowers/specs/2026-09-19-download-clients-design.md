# Adding download clients — design

**Status:** written autonomously while the repo owner was away, with
standing authority to decide every fork and to commit unsigned. Every
decision that could reasonably have gone the other way is recorded in §8
so it can be reviewed rather than excavated.

**Predecessor:** `2026-09-18-feed-settings-design.md`. That slice built
the first write path this API ever had; this one is the second, and
follows its shapes deliberately. Where it departs, §8 says why.

---

## 1. The gap

`download_client` has no production writer. `createDownloadClients`
reads rows, `scheduleKnownDownloadClients` schedules a reconcile for
each at boot, and the qBittorrent and SABnzbd adapters drive them — but
nothing creates one. An install has download clients only if something
outside Pickarr put them in the database.

This is exactly the gap `rss_feed` had before the feed-settings slice,
with one difference that shapes the whole design: **creating a download
client means storing a credential.**

## 2. What makes this harder than feeds

A feed's secret is *inside* its url (a tracker passkey), which is why
that slice redacted the url on projection and why issue #78 records
that the redaction is partial — `redactUrl` knows `apikey` and nothing
else.

A download client's credential is not in its url. Since migration 14 it
is not in the row at all: `api_key_secret_name` and
`password_secret_name` hold the *name* of a secret, the value lives in
the `secret` table, and `username` is plaintext because a username is
not a credential. `Secrets.saveSecret(name, value)` already exists, and
its own docblock anticipates this feature —

> "That is what lets a container deployment override a credential the
> settings UI stored, without the settings UI knowing."

So the credential never needs to reach a column. What it does have to
do is cross the wire once, in a request body, and reach `saveSecret`
without touching a log, an error message, or a response.

## 3. The write path

`POST /api/download-clients` → `Host.addDownloadClient` → a
`download_client` row + a `secret` row → `scheduleReconcile`.

The route is a thin adapter, as `POST /api/feeds` is: it checks the
body's *shape* and nothing else. Every value-level invariant lives in
the host capability, which returns refusals as values rather than
throwing.

**The credential's path is the design.** `addDownloadClient` generates
a secret name (`randomUUID()`, the same shape migration 14 used for the
credentials it moved), calls `saveSecret(name, value)`, and writes only
the name to the row. The value is never logged, never echoed, and never
returned. A failure after `saveSecret` leaves an orphaned `secret` row,
which is harmless — an unreferenced name resolves for nobody — and is
preferable to the alternative ordering, where a row could reference a
secret that was never stored.

### Refusals

`unknown-implementation`, `bad-auth-shape`, `duplicate-name`,
`bad-url`, and the two envelope codes the feeds slice already defined
(`invalid-shape`, `malformed-body`). Codes live in
`@pickarr/contract` — one definition, both sides deriving from it, as
the feed-settings final review established. The client owns every
sentence a human reads.

`duplicate-name` is caught from the real constraint violation on
`download_client_name`, not pre-checked, so two concurrent creates
cannot both pass a check and then collide.

## 4. Auth shapes

`readClientConfig` already decides a row down to one of three:

| implementation | kind | credential |
|---|---|---|
| `sabnzbd` | `sabnzbd` | api key, always |
| `qbittorrent` | `qbittorrent-bearer` | api key |
| `qbittorrent` | `qbittorrent-login` | username + password |

The form offers the implementation, and for qBittorrent the choice
between the two. SABnzbd has one strategy and is not asked.

`type` (`torrent`/`nzb`) is **derived from `implementation`** by the
host, never sent by the client. `readClientConfig` treats a
type/implementation mismatch as a fatal misconfiguration, so accepting
both from a browser is accepting the ability to construct a row that
cannot work.

`import_mode` is `NOT NULL` and has **no reader anywhere in 2.0** — the
only references are the migration and the Drizzle schema. The host
writes a constant. It is not a form field, because a field whose value
nothing consumes is a question with no right answer.

## 5. The replica projection

`download_client` joins `HOST_SYNCED_TABLES`, so the settings list
reads from the replica like every other list.

Projected: `id, name, type, implementation, url, username, category,
createdAt, updatedAt`.

**Not projected: `api_key_secret_name`, `password_secret_name`.** A
secret name is safe to log by this codebase's own rule, but it is the
layout of the secret store and the browser has no use for it.

**The url is normalised to `origin + pathname` before projection**, not
passed through `redactUrl`. This is deliberately stronger than the
feeds precedent. `redactUrl` matches the query parameter `apikey` and
nothing else — it does not touch userinfo, so
`http://user:hunter2@qbit:8080` would reach the replica intact. Parsing
the url and rebuilding it from its origin and path drops userinfo,
query and fragment structurally, which is a closed door rather than a
pattern that has to anticipate every shape. A download client's address
is host, port and base path; nothing else is part of its identity.

*This is the one place this slice is safer than the one it copies.*
Issue #78 remains open for feeds, where the secret is genuinely part of
the url and cannot be dropped the same way.

## 6. The screen

The existing `/settings` route gains a second section. Download clients
are settings; a separate route would split one page across two urls for
no reason a user could name.

The list shows each client by name, implementation, address and
category. The form takes name, implementation, auth strategy (for
qBittorrent), the credential fields that strategy needs, url and
category.

**The credential field is write-only.** It is never read back from the
replica, because it is not there; editing is out of scope for this
slice, and a field showing a placeholder for "something is stored" is
the smallest honest thing. The list says whether a client has a
credential configured, not what it is.

## 7. Acceptance

1. `POST /api/download-clients` creates a row and a secret, and answers
   `201 { id }`.
2. The credential appears in no log line, no error message and no
   response body — pinned by a test that greps the captured logs.
3. The row reaches the replica with no secret name and with a url
   carrying no userinfo, query or fragment — pinned by a test that
   sends `http://user:pw@host:8080/x?y=z` and asserts what lands.
4. Each refusal reads as its own sentence; an unrecognised code renders
   a fallback rather than a blank or a wedged form.
5. A reconcile is scheduled on create, without a restart.
6. The screen is reachable from the nav and legible without its
   stylesheet's rules, pinned two-sided (import removed **and**
   stylesheet gutted).

## 8. Decisions taken without asking

Recorded for review. Each names what else was available.

1. **Sync `download_client` rather than add a GET.** Consistent with
   feeds and with "lists come from the replica only". The alternative
   avoids projecting anything at all, at the cost of a second list
   mechanism in one screen.
2. **`origin + pathname` instead of `redactUrl`.** See §5. The
   alternative — reuse `redactUrl` for consistency — would import #78's
   known gap into a path that does not need it.
3. **Derive `type` from `implementation`.** The alternative lets a
   client send both and refuses mismatches, which is more code to
   reject a request that should not be expressible.
4. **Constant `import_mode`.** The alternative is a form field for a
   column nothing reads.
5. **A section on `/settings`, not a new route.** Reversible cheaply if
   the page grows.
6. **`saveSecret` before the row insert**, accepting a possible orphan
   secret over a possible dangling reference.
7. **No edit or delete.** This slice adds the missing *writer*; editing
   is a separate surface with its own questions (rotating a credential,
   what happens to in-flight downloads). Out of scope, not forgotten.
8. **No connection test before saving.** Tempting, and the reconcile
   scheduled on create will surface a bad credential anyway. A
   synchronous probe inside the POST would put a third-party service's
   latency inside a user-facing request.
