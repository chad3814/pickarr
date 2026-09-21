# Importing a finished download — design

Closes **#96**. A pick downloads, `deliverCompleted` maps the client's
path and hands the file to the plugin that owns it — and
`onDownloadedFile` logs a line. `delivered` means "a plugin was told",
not "a file is in the library". This puts the file somewhere.

**A discarded first attempt is recorded in §9.** A slice was specced
and half-built to persist season and episode numbers before discovering
that `plugin-tv` already does. It is written down because the mistake
was mine and repeating it is cheap.

---

## 1. What exists

`deliverCompleted` already does the hard parts: it finds `completed`
rows with a `storage_path`, maps that path through `filepath_mapping`,
`stat`s the file, resolves the owning plugin, calls
`onDownloadedFile`, and only then marks the row `delivered`. A throw
anywhere in that sequence leaves the row `completed` and retries
forever, deliberately.

Each plugin already stores what a path needs:

| plugin | tables | holds |
|---|---|---|
| tv | `tv_series`, `tv_season`, `tv_release` | series title, season number, episode number, first air date, `kind` |
| movie | `movie_detail` + `media_item` | title, release date, runtime, imdb id, tagline, collection |
| xxx | `xxx_site`, `xxx_scene` | site name, released on, duration |

So the metadata problem is solved. What is missing is a destination, a
shape, and the copy.

## 2. The one contract gap

`DownloadedFile` is `{ path, sizeBytes, downloadClientId }`. **A plugin
cannot tell what it is importing.**

`deliver.ts` holds `row.rssItemId` at the call site — it uses it to
find the plugin — and does not pass it. `DownloadedFile` gains
**`rssItemId`** and **`mediaItemId: number | null`**.

A plugin could *almost* recover this itself by querying
`torrent_download`/`nzb_download` on `storage_path` and
`download_client_id`. That works only while no path mapping applies:
the column holds the client's raw path and the plugin is handed the
**mapped** one. It would break exactly when the mapping feature shipped
last slice is used, which is a worse failure than not having the field.

`mediaItemId` is nullable and explicit so an unmatched release is
visible at the boundary rather than discovered mid-import.

## 3. Destinations, and who owns a token

A host table, one row per plugin: a **root**, a **shape**, and an
**unmatched directory** (§6).

**Each plugin declares its own tokens.** `MediaPlugin` gains a declared
list beside `migrations` and `synced`. Only a plugin knows whether
`{season}` means anything, so only a plugin can say.

| plugin | tokens |
|---|---|
| tv | `series`, `season`, `episode`, `title`, `releaseDate`, `resolution`, `filename`, `ext` |
| movie | `title`, `year`, `releaseDate`, `collection`, `resolution`, `filename`, `ext` |
| xxx | `site`, `title`, `releaseDate`, `resolution`, `filename`, `ext` |

The host validates a shape against the declaring plugin's list **on
save** and refuses an unknown token, naming it. A typo is caught where
it is typed, not months later as a wrong path. The settings UI lists
the available tokens per plugin, read from the same declaration, so
the list cannot drift from what resolves.

`resolution`, `filename` and `ext` come from `rss_item` and the source
path, so every plugin has them; the rest are the plugin's own.

## 4. Copying

**Copy, always.** No move, no hardlink — the owner's decision, and it
keeps the download client's copy intact for seeding without this slice
needing an opinion about either.

**No cleanup on the download client.** Deliberately out of scope.

**Copy to a temporary name in the destination directory, then rename.**
A rename within a directory is atomic on every filesystem this runs on,
so a reader never sees a half-copied file and a crash mid-copy leaves a
temporary nobody mistakes for a library file. Copying straight to the
final name gives a partial file the right name, which is the one
outcome a media server will happily index.

## 5. A destination that already exists

**Refused, and the row is left for retry.** `deliverCompleted` already
treats a throw as "leave it `completed` and try next tick", and this is
the same class of condition: usually a re-grab, or two releases
resolving to one path, and either way overwriting destroys whichever
copy was better with nothing recorded.

The retry is visible — it logs each tick — which is the property that
makes refusing safe rather than silent.

## 6. An unmatched release

A file whose release never matched has `mediaItemId: null`: no title,
no series, no year. It is copied to **`<root>/<unmatched>/<filename>`**
and the row is marked delivered.

**`<unmatched>` is configurable per plugin and defaults to
`_unmatched`.** A third column on the same row as the root and the
shape. Per-plugin because the three libraries may already have
conventions, and a name that collides with an existing directory in one
library should not have to be tolerated in the others.

Three rules, each following one already in this spec:

- **Relative to the root, and it may not escape it.** The same check
  §7 applies to a resolved shape, applied to this value on save. An
  absolute path or a `..` segment is refused.
- **Empty is refused.** It would mean "put unmatched files in the
  library root", which is a real outcome and a bad one — unnamed
  releases interleaved with organised ones, and no way to tell them
  apart afterwards. A rule with no subject, as the mappings slice put
  it.
- **Nested is allowed.** `_pickarr/unmatched` is a legitimate answer
  and costs nothing to permit, since the escape check already governs
  what it may reach.

It is **not a token and not interpolated**. It is a literal directory
name, so nothing in it resolves and nothing in it can fail to resolve.

This is the owner's decision over not importing at all. The trade it
accepts, stated so nobody rediscovers it: those files are gathered
somewhere predictable and **nothing will ever organise them** — a later
lookup that matches the release will not move a file already imported,
because this slice has no notion of re-importing.

## 7. Failure, and what it must not do

Every failure leaves the row `completed` and logs — the existing
contract. Specifically:

- a shape that resolves to an empty segment, or escapes the root, is
  refused **before** any copy begins;
- a copy that fails part way leaves only the temporary, which the next
  tick overwrites;
- **no path, url or credential reaches a log line.** `last_error` is
  served by `/api/downloads` as `DownloadRead.lastError`, which is why
  that rule exists in that file (measured last slice).

A destination root that does not exist is **not** created. A missing
root is a misconfiguration an operator should see, not a directory tree
the importer invents somewhere unintended.

## 8. Acceptance

1. `DownloadedFile` carries `rssItemId` and `mediaItemId`, and
   `deliver.ts` passes the values it already holds.
2. A resolved TV episode with a shape of
   `{series}/Season {season}/{series} - S{season}E{episode}.{ext}`
   lands at exactly that path, with numbers zero-padded to two digits.
3. A film and a scene each land under their own plugin's shape, using
   `releaseDate`.
4. Saving a shape with an unknown token is refused, naming the token;
   saving one whose tokens are all declared succeeds.
5. A destination that exists is refused, the row stays `completed`, and
   the next tick tries again.
6. An unmatched release lands in `<root>/<unmatched>/` and is marked
   delivered, using the configured directory where one is set and
   `_unmatched` where none is.
6b. An unmatched directory that is empty, absolute, or escapes the root
   is refused on save, naming which.
7. The copy is atomic: an interrupted import leaves no file at the
   final path.
8. A token that resolves to nothing — a film with no collection —
   produces no empty path segment and no literal `{collection}`.
9. Nothing in the library is moved, renamed or deleted, and nothing is
   removed from a download client.

## 9. The slice that was specced and discarded

Recorded because the failure was mine and cheap to repeat.

Before this, a slice was designed to add `kind`, `year`, `parent_id`,
`details`, `season_number` and `episode_number` to `media_item`, with
ancestry as linked rows and a derived `listable` flag so browse could
exclude parents. One task of it was built.

**All of it already existed.** `plugin-tv` has `tv_series`,
`tv_season` and `tv_release`; it extracts `seasonNumber` and
`episodeNumber`, stores `details_json` verbatim, models ancestry, and
replicates. `plugin-movie` and `plugin-xxx` do the same for their
shapes.

The cause was a grep scoped to `packages/openmetadata/src` when the
answer was in `packages/plugin-tv`. **The identical scope error had
been made one slice earlier** — a sweep scoped to `packages/host` that
missed a live count in `packages/web` — and a warning about it was
written into the very plan that then repeated it.

Two consequences worth carrying:

- A claim that "no plugin does X" is a claim about **every package**,
  and this repository has eleven.
- The design that error produced was not merely redundant, it was
  wrong: it would have put plugin-specific columns in a host table, in
  a codebase whose whole shape is that plugins own their schema.

## 10. Out of scope

- **Re-importing.** A file already imported stays where it is, even if
  a later lookup improves its metadata (§6).
- **Cleanup on the download client** — the owner's decision.
- **Move and hardlink** — copy only.
- **Creating a missing destination root** (§7).
- **Anything about `import_mode`**, which remains `NOT NULL` with no
  reader. It described move-versus-copy, and copy is now the answer.
