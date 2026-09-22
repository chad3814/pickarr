# Choosing which files a finished download puts in the library — design

A pick of *Swiss Family Robinson* completed in SABnzbd as a directory,
`Swiss.Family.Robinson.1960.WIDESCREEN.NTSC.USA.DVD9-AndreMor`, holding
`Swiss Family Robinson (1960) (USA).iso` and a `.mds.mds` sidecar. The
import failed every tick with `copy-failed` / `EISDIR`: nothing in
pickarr looks inside a directory. The client's path — a file for a
single-file torrent, a directory for almost everything else and for
every SABnzbd job — reaches `copyFile` unchanged.

This slice makes the **plugin** decide which files a download
contributes, because only the plugin knows whether it expects one file
(a film) or many (a season pack). The host keeps the filesystem and the
copy.

---

## 1. What exists

- `deliverOne` (`host/src/clients/deliver.ts`) maps the client's
  `storage_path`, `stat`s it, and hands a `DownloadedFile { path,
  sizeBytes, downloadClientId, rssItemId, mediaItemId }` to the owning
  plugin's `onDownloadedFile`. A throw leaves the row `completed` and
  retries next tick, forever.
- `onDownloadedFile` in the shared engine (`openmetadata/src/engine.ts`)
  calls `ctx.library.place(file, resolveTokens)` once, logs a refusal by
  ids and code, and throws.
- `place` (`host/src/media/import.ts`) copies exactly one file: to
  `<root>/<shape>` for a matched release, to
  `<root>/<unmatched>/<basename(file.path)>` for an unmatched one.
- `plugin-tv`'s `tv_release.kind` is `episode`, `season` or `series`.
  No episode count is stored anywhere, and the OpenMetadata `Media`
  schema has no field for one.

## 2. Where each piece lives

```
deliverOne (host, unchanged)  -- DownloadedFile{path: file OR directory} -->  engine.onDownloadedFile
  1. entries  = await ctx.library.list(file)      host walks it; a plain file lists as itself
  2. expected = await spec.expects(file, ctx)     plugin: single, or episodes (+ season)
  3. chosen   = select(entries, expected, ...)    pure; a selection refusal, or the entries to copy
  4. for each chosen entry with no <id>_placement row:
       outcome = await ctx.library.place(file, entry, resolveTokens-over-the-entry)
       placed  -> insert the placement row
       refusal -> log, throw (row stays completed)
```

- **The host lists and copies; it never selects.** It has no idea what
  a season pack is.
- **The plugin selects; it never touches `node:fs`.** The importer
  design gave the filesystem to the host, and path-leak protection
  (§7 there) is enforced in one place. A plugin sees relative paths
  and sizes, and hands entries back.
- **Selection runs over the whole listing before any copy.** A pack
  whose contents are wrong copies nothing.

## 3. Candidates

A **candidate** is a file that:

- has one of these extensions, compared case-insensitively:
  `mkv mp4 m4v avi mov wmv mpg mpeg ts m2ts webm iso`; and
- does not contain `sample`, case-insensitively, anywhere in its
  **relative** path. `Sample/foo.mkv` and `foo.sample.mkv` are
  excluded. The release directory's own name is not part of the
  relative path, so a film titled *The Sample* is not excluded by its
  folder.

## 4. Selection

### 4.1 `single` — a film, a scene, one television episode

Exactly one candidate is copied.

| candidates | outcome |
|---|---|
| 0 | refusal `no-video-file` |
| 1 | that candidate |
| 2+ | refusal `too-many-video-files` |

No choosing by size: two candidates in a single-file download means the
download is not what the plugin thinks it is, and a human decides.

### 4.2 `episodes` — a television season or series pack

Every candidate is copied, provided:

- every candidate's filename carries an `SxxEyy` marker, else
  `episode-marker-missing`;
- no (season, episode) pair appears twice across all candidates, else
  `episode-marker-duplicate`. A multi-episode file (`S01E01E02`,
  `S01E01-E02`) contributes every episode it names;
- for a **season** pack whose season number is known, every marker
  names that season, else `too-many-video-files` — a file from another
  season is one more file than the pack should hold. A **series** pack
  has no season restriction;
- there is at least one candidate, else `no-video-file`.

Numbering need not be contiguous: a pack of E01, E02, E05 is accepted.

The marker is matched case-insensitively against the filename (the last
segment of the relative path): `S` then one or two digits, `E` then one
to three digits, optionally followed by further `E<digits>` or
`-E<digits>` groups.

### 4.3 Unmatched — `mediaItemId === null`

No selection. The plugin cannot know what an unmatched release is, so
**every file** in the listing is copied — candidates, sidecars and
samples alike — preserving its relative layout under a directory named
for the release:

```
<root>/<unmatched>/<release name>/<relative path>
```

- A **directory** download's release name is the directory's name as
  it is: `Swiss.Family.Robinson.1960.WIDESCREEN.NTSC.USA.DVD9-AndreMor`.
- A **single-file** download's release name is its filename without its
  extension, so even a lone file gets a directory:
  `Foo.2020.1080p.mkv` lands at `_unmatched/Foo.2020.1080p/Foo.2020.1080p.mkv`.

This replaces the importer design's `<root>/<unmatched>/<filename>`.

## 5. The contract

`packages/contract/src/library.ts`:

```ts
/** One regular file inside a finished download. */
export interface DownloadEntry {
  /** Absolute, host-built. Handed back to `place`; never logged. */
  readonly path: string;
  /** `/`-separated, under the download root. A plain-file download is its own basename. */
  readonly relativePath: string;
  readonly sizeBytes: number;
}

export interface LibraryImporter {
  list(file: DownloadedFile): Promise<readonly DownloadEntry[] | ImportRefusal>;
  place(
    file: DownloadedFile,
    entry: DownloadEntry,
    resolveTokens: () => Promise<TokenValues>,
  ): Promise<ImportOutcome>;
}
```

- **`list`** walks `file.path` recursively with `lstat`, returning
  regular files only; symlinks and anything else that is not a regular
  file are skipped, not followed. A plain file lists as one entry.
  Entries are sorted by `relativePath` so the order is deterministic.
  Any filesystem rejection becomes a new `ImportRefusalCode`,
  **`list-failed`**, carrying the `errno` and nothing else — the same
  rule `copy-failed` follows, for the same reason.
- **`place` takes the download and the entry.** The unmatched
  destination needs both: the release name comes from `file.path`, the
  layout from `entry.relativePath`. Passing both keeps §4.3's rule in
  the host, where the importer design put §6's.
- **`place` verifies the entry belongs to the download.** It refuses,
  with a new `ImportRefusalCode`, **`foreign-entry`**, an entry whose `path` is not
  `file.path` itself (a plain-file download) or does not lie under
  `file.path` joined with `entry.relativePath`. A plugin cannot use
  `place` to copy an arbitrary file.
- **Matched destinations are unchanged**, except that `resolveTokens`
  now resolves over the entry: the engine builds it from
  `{ ...file, path: entry.path, sizeBytes: entry.sizeBytes }`, so
  `{filename}` and `{ext}` describe the episode, not the folder.
- **Every unmatched segment is checked** the way the resolved shape
  already is: the control-character check and the final
  `startsWith(root + sep)` check apply to the whole joined path.
- **`DownloadedFile.path`** is documented as a file or a directory.
  `deliverOne` still `stat`s it — that is its existence check — and
  `sizeBytes` is documented as meaningless for a directory. Sizes come
  from `list`.

`packages/contract/src/plugin.ts` is otherwise unchanged. The selection
refusals are **not** `ImportRefusalCode`s: the host never produces them.

## 6. The engine and the plugins

`LookupPluginSpec` gains a required

```ts
type Expectation =
  | { readonly kind: 'single' }
  | { readonly kind: 'episodes'; readonly season: number | null };

expects(file: DownloadedFile, ctx: PluginContext): Promise<Expectation>;
```

called only for a matched release. Required rather than defaulted, for
the reason `check` gives: a plugin that forgot it should not compile.

| plugin | answer |
|---|---|
| movie | `single` |
| xxx | `single` |
| tv, `kind = 'episode'` | `single` |
| tv, `kind = 'season'` | `episodes`, `season` = `tv_season.season_number` (`null` if unknown) |
| tv, `kind = 'series'` | `episodes`, `season: null` |

`select` is a pure function exported from `@pickarr/openmetadata`,
taking the entries and the expectation (or "unmatched") and returning
either the entries to copy or a selection refusal:

```ts
type SelectionRefusalCode =
  | 'no-video-file'
  | 'too-many-video-files'
  | 'episode-marker-missing'
  | 'episode-marker-duplicate';
```

`onDownloadedFile` logs a selection refusal exactly as it logs an
import refusal today — ids and code — and throws, so the row stays
`completed` and the next tick re-evaluates it. A download a human fixes
on disk (deletes the extra file) imports on the next tick with nothing
to reset.

## 7. Retrying a partly-placed download

A ten-episode pack that places six and then fails `ENOSPC` must not be
stuck: on retry, episodes one to six would answer `destination-exists`,
a refusal that never clears on its own.

Each plugin gains a table, generated by a new openmetadata helper
`placementTableMigration(pluginId, version)` in the manner of
`lookupTableMigration`:

```sql
CREATE TABLE <id>_placement (
  id            INTEGER PRIMARY KEY,
  rss_item_id   INTEGER NOT NULL REFERENCES rss_item (id),
  relative_path TEXT NOT NULL,
  placed_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX <id>_placement_entry ON <id>_placement (rss_item_id, relative_path);
```

Each plugin lists it as **its own version 3**: the engine owns version
1, each plugin's existing migration is version 2, and a helper-appended
version would collide with the next migration a plugin writes.

- Before placing an entry, the engine skips it if a row exists for
  (`rssItemId`, `relativePath`).
- After `place` answers `placed`, the engine inserts the row.
- An entry with no row that answers `destination-exists` is a real
  conflict and is refused as today.
- **Processing stops at the first refusal.** What was placed is
  recorded, so the next tick resumes where this one stopped.
- **The residual window, named.** The row is written after the rename.
  A crash between the two leaves one file placed and unrecorded, and
  the retry answers `destination-exists` for it. Closing this would
  need the host to write a plugin's table, which reverses the ownership
  this design keeps; the window is one sqlite insert wide and is left
  open.

## 8. Failure, and what it must not do

- **No path in any log line or thrown message**, relative paths and
  filenames included — the importer design's §7 rule. Logs carry
  `rssItemId`, `mediaItemId`, the refusal code, `errno`, and counts:
  entries listed, candidates, placed, skipped as already placed.
- **Every refusal, selection or import, leaves the row `completed`.**
  Nothing here calls `failRow`. Manual intervention means fixing the
  files, the destination or the configuration; the next tick notices.

## 9. Acceptance

- The *Swiss Family Robinson* layout — one `.iso`, one `.mds.mds` —
  places exactly the `.iso` into the film's shaped destination.
- A single-file download of a film still places that file.
- A film directory holding two video files, neither a sample, is
  refused `too-many-video-files` and copies nothing.
- A film directory holding the film and `Sample/sample.mkv` places the
  film.
- A season-1 pack of E01, E02, E05 places three files; adding an
  `S02E05` file refuses it `too-many-video-files`; adding a second
  `S01E02` refuses it `episode-marker-duplicate`; adding
  `extras.mkv` refuses it `episode-marker-missing`.
- A series pack spanning seasons 1 and 2 places every episode.
- An unmatched directory download copies every file, sidecars
  included, under `_unmatched/<directory name>/`; an unmatched
  single-file download lands at `_unmatched/<stem>/<file>`.
- A pack whose fourth copy fails places the rest on the next tick
  without a `destination-exists`.
- `place` refuses `foreign-entry` for an entry that does not lie under the download.
- `list` skips a symlink, and a listing failure refuses `list-failed`
  with an errno and no path.

## 10. Testing

TDD throughout.

- **`select`** — pure, table-driven in `openmetadata`: extension case;
  a `sample` subdirectory; a release folder named with `sample` that
  must not exclude its files; single with 0, 1 and 2 candidates;
  missing, duplicate and multi-episode markers; a wrong season in a
  season pack; mixed seasons in a series pack; season `null`.
- **`list`** — real temporary directories in `host`: a plain file,
  nested directories, a skipped symlink, sorted order, `list-failed`.
- **`place`** — the new unmatched layout for both download shapes; an
  entry outside the download refused `foreign-entry`; matched placement unchanged.
- **engine** — resume after a mid-pack refusal; a recorded entry
  skipped; a selection refusal copies nothing; no path in any log
  call's arguments.
- **each plugin** — its `expects` answer, including tv's season number
  for a season pack.

## 11. Out of scope

- Fetching episode counts from the metadata service.
- A UI for resolving a stuck download; the row's `completed` state and
  the log line are the whole of the signal, as today.
- Deleting placement rows. They are a few bytes per imported file and
  nothing reads them after the download is delivered.
- Disc structures (`VIDEO_TS/`, `BDMV/`): their `.vob`/`.m2ts` pieces
  are not one film per file. A `BDMV` holding several `.m2ts` files
  refuses `too-many-video-files` and waits for a human, which is the
  right outcome until someone designs for them.
