# Settings — Design

Date: 2026-08-13
Status: approved for planning
Branch: `settings-tab`

## 1. What this adds

A fifth tab, `Settings`, holding two things: a form that edits `config.json`, and a button
that backs up the SQLite database and downloads it.

Today the only way to change any of Pickarr's configuration is to edit `config.json` by
hand on the host and restart the container, and the only way to take a copy of the
database is to know where it lives and to know that copying a WAL database with `cp` is
not safe. Both are things the running service already knows how to do correctly and can
offer.

The tab is separated from the other four by an em dash in the nav, because it is not a
view of the library — it is a view of the installation.

## 2. Scope

In scope:

- A `Settings` nav entry, after an em dash separator, and a `/settings` route.
- `GET`/`PUT` of an editable projection of `config.json`, with secrets write-only.
- A schema-driven form covering every field `configSchema` models.
- An explicit `Restart now` action, so a saved config can be applied.
- A back-up-and-download action over `node:sqlite`'s online backup API.

Explicitly out of scope:

- **Hot reload.** Nothing re-reads configuration into the running process. Config is read
  once at boot (`main.ts`), and the scheduler, download-client map and plugin registry are
  all built once from it; swapping any of them live is its own design. A save is applied
  by restarting, and the UI says so.
- **Authentication.** Pickarr has none today, and this adds none. §5 is about what that
  means for secrets, not a step toward fixing it.
- **Restoring a backup.** Downloading a copy is safe and reversible; writing one back over
  a live database is neither, and would need a shutdown-and-replace path with its own
  design.
- **Editing anything not in `configSchema`.** Unknown keys in the file are preserved
  untouched (§6) but are not surfaced for editing.
- **Server-side backup retention.** Nothing is kept on the box; see §8.

## 3. Nav and routing

`App.tsx` gains one link and one separator:

```tsx
<NavLink to="/failed">Failed</NavLink>
<span className="nav-separator" aria-hidden="true">—</span>
<NavLink to="/settings">Settings</NavLink>
```

`aria-hidden` on the separator is not decoration-by-habit: without it a screen reader
announces "em dash" as a nav item between the two groups, which is noise for the one class
of user who cannot see the visual grouping it exists to convey. `nav`'s existing
`display: flex; gap: 1rem` spaces it already, so `styles.css` needs only
`.nav-separator { opacity: 0.4; }`.

## 4. Splitting `loadConfig`

`loadConfig` currently does four things in one function: reads the file, schema-parses it,
applies three cross-field checks, and resolves `file:` secret references. The save route
needs the middle two without the first and with the fourth run only as a rehearsal, so
these become separately callable, with no behaviour change to `loadConfig` itself:

- `parseConfig(json, source)` — `configSchema.safeParse` plus the duplicate-feed-id,
  duplicate-client-id and feed-references-a-configured-plugin checks. Touches no
  filesystem.
- `resolveSecrets(config)` — the existing `file:` resolution, plus the two
  post-resolution checks (`MIN_API_KEY_LENGTH` for a download client, non-empty for
  `siteLookup`) that exist precisely because the schema only ever saw the path.
- `loadConfig(path)` — read → `parseConfig` → `resolveSecrets` → `PICKARR_PORT` override.

The reason to run `resolveSecrets` on save at all, and throw the result away, is §7: a
config that parses but whose `file:` reference is missing or empty will fail at boot, and
boot is now something a button in the UI triggers.

## 5. Secrets are write-only

`downloadClients[].apiKey` and `siteLookup.apiKey` are the two secret-bearing fields. Both
may hold either a literal key or a `file:` path to one.

The API is unauthenticated and bound to `0.0.0.0`. A `GET /api/config` that returned
literal keys would hand a LAN peer the SABnzbd and ThePornDB credentials for the asking,
so it does not return them. The projection is a discriminated union rather than a redaction
sentinel, so that no real value can ever be mistaken for "unchanged":

```ts
type SecretView = { kind: 'file'; path: string } | { kind: 'set' };
type SecretEdit =
  | { kind: 'keep' }
  | { kind: 'file'; path: string }
  | { kind: 'literal'; value: string };
```

A `file:` value is returned as its path, because a path is not a secret and being able to
see and correct it is most of the value of showing the field at all. A literal key is
returned as `{ kind: 'set' }` and its bytes never leave the process.

`{ kind: 'keep' }` is resolved against the on-disk document by `id` for download clients.
Renaming a client's `id` and sending `keep` in the same request is therefore a 400 that
asks for the key, rather than a guess about which entry was meant.

## 6. The editable projection

Two pure functions in a new `config/editable.ts`:

- `toEditableConfig(document)` — the shape `GET /api/config` returns: every field
  `configSchema` models, with secrets as `SecretView`.
- `applyEdits(document, submitted)` — folds a submission back over the document.

`applyEdits` mutates a structured copy of the **parsed on-disk document**, never a freshly
constructed object. That is what preserves both key order and any key the form does not
model, so saving from the UI cannot silently delete a field a future version of Pickarr
understands but this form does not. The file is rewritten as
`JSON.stringify(document, null, 2) + '\n'`; nothing is lost to reformatting because JSON
has no comments to lose.

That guarantee holds one level deep as well as at the top: `server`, `database`,
`metadata`, each download client, each feed, and `siteLookup` are each *merged* — patched
over a structured clone of whatever already sat at that key — rather than replaced with a
freshly built object. A key nested inside one of these blocks that this form does not
model (a setting a newer Pickarr understands, a field added by hand) survives a save the
same way a top-level one does. The one exception is `plugins`: the form already treats
every one of a plugin's settings as something it models, add and remove included, so there
is no "unknown key" left inside that block for a merge to preserve. Two further conditions
apply to a download client or a feed specifically: the block has to already exist on disk
(a newly added client has nothing to merge with), and its `id` must not have changed in
this same submission — an `id` change has no existing entry to match, for the same reason
`applyEdits` refuses a `keep` for a renamed client's api key (§5).

**A no-op save still writes every schema default.** `applyEdits` always writes `server`,
`metadata` (and its `enabled`, `intervalSeconds`, `perTick` fields), each feed's
`intervalSeconds`, each download client's `pathMappings`, and `siteLookup.baseUrl` when a
site lookup is configured — whether or not the on-disk document already had them. A config
that omitted `metadata.perTick` to track whatever Pickarr currently defaults it to no
longer omits it after the first save from this form: the value in the file at the moment of
that save is pinned there from then on, and no longer follows a future change to the
built-in default. This is a real, user-visible consequence of saving from the form rather
than hand-editing the file, not a bug — but it is one the merge above does not fix, because
these are fields the form *does* model, not unknown ones.

If `config.json` is currently unparseable JSON, `GET /api/config` answers with the parse
error and the form renders read-only. There is no document to fold edits into, and
fabricating one would mean a save discarding whatever is actually on disk.

## 7. Saving

`PUT /api/config` is, in order: `applyEdits` → `parseConfig` → `resolveSecrets` as a
rehearsal → write to a temporary file in the same directory → `rename` over
`config.json`. All filesystem work is `fs.promises`.

The rehearsal and the ordering are the substance. Every check that boot would apply is
applied *before* anything is written, so a save cannot produce a file that crash-loops the
container — which matters far more now that §9 puts a restart behind a button. The
`rename` is what makes the write atomic: a process killed mid-save leaves either the old
file or the new one, never a truncated one.

A rejection is a 400 carrying the same `path: message` detail string `loadConfig` already
builds, so the form can point at the field that was refused. The file is untouched on any
rejection, and that is an explicit test rather than an implied property.

Success returns `{ savedAt, restartRequired: true }`.

`GET /api/config` also returns `restartRequired: boolean`, computed by deep-comparing the
parsed document on disk against the parsed document the process booted with, which
`main.ts` captures at startup and passes through `ServerDeps` as `bootConfigDocument`.
Parsed rather than textual, so that reindenting the file by hand — or this route's own
rewrite of a document it did not change — does not read as a pending restart. Without it
the "restart to apply" notice would
vanish on a page reload, leaving a saved-but-unapplied config with nothing on screen
saying so.

`PICKARR_PORT` overrides `server.port` at boot. `GET /api/config` reports
`portOverride: number | null` so the form can say the port field is currently being
overridden, instead of presenting a value the running service is not using.

## 8. Backup and download

`GET /api/database/backup` calls `backup(db, tempPath)` from `node:sqlite` — the online
backup API, which is consistent under WAL and does not block writers, and which is the
reason this is worth offering at all rather than telling someone to copy a file. The
temporary file is created beside the database so the copy is same-filesystem.

The stream is sent with `content-disposition: attachment; filename="pickarr-<YYYY-MM-DD>.db"`,
dated from `deps.now()`.

The temporary file is `unlink`ed immediately after its read stream is opened. POSIX keeps
the bytes alive until the last descriptor closes, so the data still streams correctly while
there is no longer a name for it in `/config` — which means an aborted download, a
disconnected client, or a killed process cannot leave a stray multi-megabyte copy in the
config volume. This is the whole reason nothing needs pruning.

`GET` rather than `POST`: it does not change the database, and a plain `GET` is what lets
the browser use the filename the server chose.

## 9. Restarting

`POST /api/restart` answers 202 and then runs the shutdown from the reply's `finish` event,
so the acknowledgement is on the wire before teardown begins.

`buildServer` never calls `process.exit`. It calls an injected `deps.requestRestart()`,
which in `main.ts` is the same function the signal handlers use: the body currently inlined
in the `SIGINT`/`SIGTERM` loop (`scheduler.stop()`, `server.close()`, `db.close()`,
`exit(0)`) is extracted into one `shutdown()` with three triggers instead of two copies.
Keeping `process.exit` out of the HTTP layer is also what makes the route testable.

Exiting 0 is a restart rather than a stop only because something restarts the process.
`docker-compose.example.yml` uses `restart: unless-stopped`, so the documented deployment
does. Run outside Docker, or with `restart: no`, this button stops Pickarr — which is why
it is an explicit, separately-labelled action rather than something a save does on your
behalf. `recoverInterruptedWork` already resets interrupted imports at boot, so a restart
taken mid-import is a case the system is built to survive.

## 10. Server surface

`ServerDeps` gains `configPath: string`, `databasePath: string`,
`bootConfigDocument: JsonValue` (the `JsonValue` already exported by `core/src/json.ts`,
which is what `loadConfig` reads the file into), and `requestRestart(): void`. Response types live in `http/views.ts` and are mirrored by
hand into `web/src/api/client.ts`, following the convention that file already documents:
`packages/web` does not depend on `packages/core`.

| Route | Purpose |
| --- | --- |
| `GET /api/config` | Editable projection, `portOverride`, `restartRequired` |
| `PUT /api/config` | Validate, rehearse, atomically write |
| `POST /api/restart` | 202, then graceful shutdown |
| `GET /api/database/backup` | Online backup, streamed as an attachment |

## 11. The Settings screen

Five files rather than one, matching how `Failed.tsx` delegates its form to `ManualForm`:

- `routes/Settings.tsx` — page shell: load, notices, Save, Restart now, Back up & download.
- `components/settings/ConfigForm.tsx` — the scalar sections (`server`, `database`,
  `trashDir`, `metadata`, `siteLookup`) and composition of the three list editors.
- `components/settings/SecretField.tsx` — the three-state secret control.
- `components/settings/DownloadClientFields.tsx`, `FeedFields.tsx` — add/remove row editors.
- `components/settings/PluginFields.tsx` — the record-of-records editor.

State is one draft in `useState`, updated immutably; `Save` is disabled until the draft
differs from the loaded snapshot.

Numeric fields (`server.port`, `feeds[].intervalSeconds`, `metadata.intervalSeconds`,
`metadata.perTick`) are held as text in the draft and converted at submit. A non-numeric
value is reported in the form rather than round-tripped for a 400.

`SecretField` renders `{ kind: 'file' }` as an editable path and `{ kind: 'set' }` as a
disabled "set" marker beside a `Replace` button that swaps in an empty input. Untouched, it
submits `{ kind: 'keep' }`. A download client added in the form has no on-disk secret to
keep, so its field starts as `{ kind: 'literal', value: '' }` — an empty literal, which
`resolveSecrets` refuses in the rehearsal with the same message a hand-edited file would get.

`metadata.artworkDir` is optional, and left empty it stays absent from the file rather than
being written as an empty string; the field's placeholder names the default (`artwork/`
beside the database) that `resolveArtworkDir` applies.

`PluginFields` tracks each value's type (`string | number | boolean | string[]`), because
`configSchema` permits all four and an edit must not turn a list into a string. Adding a key
asks which type it is.

`Back up & download` goes through `fetch` → check `response.ok` → object URL → click →
revoke, rather than a bare `<a download>`. An anchor gives nowhere to report a backup that
failed. The cost is that the file passes through browser memory; at this project's scale a
database is single-digit megabytes.

## 12. Testing

Core, under the existing `node:test` layout:

- `test/config/editable.test.ts` — literal keys redacted, `file:` paths passed through,
  unknown keys and key order surviving `applyEdits`, `keep` resolved by client id, `keep`
  against a renamed id refused.
- `test/config/load.test.ts` — `parseConfig` and `resolveSecrets` directly, and
  `loadConfig` unchanged by the split of §4.
- `test/http/server.test.ts` — `GET` redacts; a valid `PUT` writes atomically and leaves no
  temporary file; **an invalid `PUT` 400s and leaves the file byte-identical**; a `PUT`
  against an unparseable on-disk file; `POST /api/restart` replies 202 and calls the
  injected `requestRestart` exactly once; the backup route returns a file whose SQLite
  header is intact, with the expected `content-disposition`, leaving nothing behind.

Web, `packages/web/test/Settings.test.tsx`: sections render from a fetched config; a literal
secret shows as set and submits `keep`; a replaced secret submits `literal`; a 400 renders
its detail; `Restart now` posts; a failed backup surfaces an error. No fake timers — they
hang this test run (commit `ed0de07`).

E2E, `packages/e2e/tests/settings.spec.ts`: edit a scalar, save, assert the file on disk
changed; click backup and assert the download is a valid SQLite file. Restart is
deliberately not exercised here, because it would tear down the harness; the injected-dep
unit test covers it.

`npm run check` and `npm run build` gate the work.
