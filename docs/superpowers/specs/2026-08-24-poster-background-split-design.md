# Poster and background are two images — Design

Date: 2026-08-24
Status: approved for planning
Branch: `poster-background-split`

## 1. What this corrects

A poster is portrait artwork, roughly 2:3. A background is landscape, roughly 16:9. They
are different pictures of different shapes, and this codebase stores the second under the
first's name.

`group_metadata` has one image per group, in `poster_url` and `poster_path`. When ThePornDB
offers a poster that is really a synthesised crop of a background, `readPosterUrl`
substitutes the background and returns it — and that background is then written to
`poster_path`, served from `GET /api/groups/:id/poster`, and reported to the SPA as
`hasPoster: true`.

The detection is already correct and already documented. `isBackgroundCrop` recognises
TPDB's thumbnailer marker; `backgroundFromCrop` recovers the source URL out of the crop
URL; `readOfferedPoster`'s own comment records that the studio `image` field is 1279x719
and that "nothing downstream may assume a portrait aspect ratio". Only the destination is
wrong.

Measured against `pickarr-2026-08-24-2.db` (3,682 groups, 1,508 with an image):

| what is stored in `poster_url` | rows |
|---|---|
| a `/background/` URL — landscape | 1,494 |
| a synthesised `800x1200` crop | 0 |
| a TPDB `/poster/` path — probably a genuine poster | 11 |
| a studio-CDN URL — shape recorded nowhere | 3 |

So 99.1% of this library's "posters" are backgrounds. The mislabelling is the norm, not an
edge case.

This is phase 2a of two. Phase 2b is the poster-led card redesign, which needs an honest
model underneath it and gets its own design. The image gallery — browsing every image a
group has, poster then background then performer portraits — is later still, and §7 records
what this phase does to make it cheap.

## 2. Scope

In scope:

- Two independent image slots per group: poster (portrait) and background (landscape).
- Classification by **measured aspect ratio**, not by URL shape.
- A migration that re-files the existing rows and discards synthesised crops.
- `GET /api/groups/:id/background`, and `hasBackground` on the metadata view.
- The repair script repointed at the background columns — and then retired, once it was
  clear the migration left it nothing to find. See §5.3.

Explicitly out of scope:

- **Any change to what the user sees.** §6 is deliberately a no-op: the card renders
  exactly as it does today. A model correction that also moves pixels is two changes in one
  review.
- **The card redesign.** Phase 2b.
- **The image gallery.** Later; §7 only avoids painting it into a corner.
- **Backfilling posters for the 1,494 background-only groups.** The crop marker is TPDB
  saying it had no portrait artwork and synthesised one, so re-asking returns the same crop.
  Those groups correctly have a background and no poster. That is not a gap; it is the truth
  the old field name concealed.
- **Performer artwork.** `performer-face-*` and `performer-image-*` are already correctly
  named and separately stored. Nothing here touches them.

## 3. The data model

`group_metadata` gains `background_url` and `background_path`, mirroring the existing
`poster_url` and `poster_path`. Two independent nullable pairs: a group may have a poster, a
background, both, or neither.

The schema comment carries the definitions, so the distinction cannot quietly rot again:

```
-- poster:     portrait artwork, ~2:3. TPDB's `/poster/` path and the `posters` set.
-- background: landscape artwork, ~16:9. TPDB's `/background/` path, and the studio
--             `image` field the client documents as 1279x719.
-- Which column an image lands in is decided by its measured aspect ratio, never by
-- its URL — see `classifyArtwork`.
```

### 3.1 Aspect is measured, not inferred

URL shape is a decent heuristic and an unreliable rule, and this library proves it. Of the
14 rows above that are neither a `/background/` path nor a crop, three are studio-CDN URLs
whose shape nothing in the payload records:

```
https://teenmegaworld.net/content/contentthumbs/41/49/514149-1x.webp
https://jesseloadsmonsterfacials.com/visitors/photos/tour_carlykiss.jpg
https://s57-pub-ct.high-cdn.com/pics/scene/18/26/41826_8_scenedefault_8__433_rs_e84f5c40_v1.webp
```

These were opened and checked by hand. The first is a **background**. The second is a
**poster**. The third did not resolve. Two indistinguishable-looking URLs, opposite shapes —
and the guess a reader is tempted to make from the filenames (`1x.webp` and `scenedefault`
read like stills; `tour_carlykiss.jpg` reads like a tour thumbnail) gets the first right and
the second wrong.

That is the whole argument for measuring. A rule built on URL shape would have misfiled one
of the two images anyone could actually verify, and there is no reason to believe a larger
sample behaves better. A downloaded image is measured and classified by what it is.

**The rule:** `width > height` is a background; anything else — portrait or square — is a
poster. Square goes to poster because the destination that crops it least is the 2:3 slot
phase 2b builds, and because a square scene still is far likelier to be a cropped portrait
than a cropped landscape.

### 3.2 Dimensions are not stored

Classification happens once, at fetch, and its output is which column the row lands in. The
width and height themselves are not persisted: nothing else needs them, and a column that
exists only to justify a decision already taken is a column that will drift from the file it
describes. Re-classification, if it is ever wanted, re-measures — §5.3's backfill does
exactly that, offline, from the files already on disk.

## 4. Reading the provider's answer

`readPosterUrl` splits into two readers that no longer substitute for each other. Neither
decides a shape; both hand candidates to the classifier.

- **`readPosterCandidate`** — the `posters` set (`large`, then `full`), then the bare
  `poster` field. Returns `null` when the offered image carries the crop marker.
- **`readBackgroundCandidate`** — the `background` object (`full`, then `large`), then
  `backgroundFromCrop` recovering the source out of a crop URL, then the studio `image`
  field.

`image` moves from the poster reader to the background reader. That is not a new judgement;
it is applying the one `readOfferedPoster` already documents.

### 4.1 The synthesised crop is discarded

Today, when the background cannot be recovered, the code keeps the crop and says why: "a
synthesised poster is poor artwork, but it is better than a card with no image."

That reasoning has expired. The crop is portrait, so under the corrected model it would be
filed as a poster and shown on the card ahead of a clean performer portrait, because phase
2b's rule puts the poster first. An upscaled, logo-stamped centre-slice would outrank a real
headshot.

So a crop is never stored, under either name. Where its source can be recovered we keep the
source; where it cannot, the group has neither image and phase 2b gives it a performer
portrait. This is the existing comment's own logic — the background is "the better image by
every measure available" — carried to its conclusion.

## 5. Caching and classification

### 5.1 The keys

`artwork.ts` gains `groupArtworkKey(groupId, kind: 'poster' | 'background')` returning
`group-${kind}-${groupId}`, mirroring `performerArtworkKey`'s `performer-${kind}-${id}`
exactly.

New group artwork stops using the bare group id as its key, and that is load-bearing rather
than tidiness. A legacy background sits on disk at `<id>.jpg`, and §5.3's migration leaves it
there. If a newly-fetched poster for that group were also written to `<id>.jpg` it would
overwrite the background. Nothing writes the bare name again, so nothing can.

### 5.2 Where the measurement happens

`cacheImage` already downloads to a unique `.part` temp file and renames it into place, and
the gap between those two steps is where the image exists on disk but has no name yet. That
is where it is measured.

The consequence is that the caller cannot pass a key, because the key depends on the answer.
`cacheImage` splits:

- `fetchImage(deps, url)` — download, validate the content type, write the temp file, measure
  it, and return `{ tempPath, kind, extension }` or `null`.
- `commitImage(deps, temp, key)` — rename the temp file to `${key}.${extension}`.

`runMetadataPass` then fetches each candidate, and commits it under the key its measured kind
dictates. A poster candidate that measures landscape is committed as a background, and vice
versa; the provider's field names stop being the last word.

Failures stay independent. A poster that downloads and a background that 404s leaves the
poster stored and `background_path` null, which is what two nullable pairs are for.

Two candidates can disagree with their own field names, and the rule has to be total rather
than leave the second case to whoever writes it:

- The **poster** column takes the poster candidate when it measures portrait; failing that,
  the background candidate when *it* measures portrait; otherwise null.
- The **background** column takes the background candidate when it measures landscape;
  failing that, the poster candidate when *it* measures landscape; otherwise null.

So each column prefers the reader named for it and falls back to the other, and a payload
whose two candidates both measure landscape yields a background and no poster rather than an
arbitrary winner. If both readers return the *same* URL — possible if a provider repeats one
image across fields — it is fetched and measured once, not twice.

**Dimensions are read with `image-size`** (2.0.2), a sixth runtime dependency for
`@pickarr/core`. It is pure JavaScript with no transitive dependencies, ships its own types,
and is ESM-native, which matters in a `"type": "module"` package. The alternative considered
was parsing PNG's `IHDR`, JPEG's `SOF` markers and WebP's `VP8`/`VP8L`/`VP8X` chunks by hand
— about 80 lines for the three formats `ARTWORK_CONTENT_TYPES` accepts. The dependency won
on the grounds that a wrong dimension is a wrong classification, and this is not a good place
to be subtly wrong.

**A known limitation, recorded rather than solved:** neither approach reads EXIF orientation,
so a JPEG stored landscape with a rotation flag that makes it *display* portrait will be
classified as a background. TPDB's own CDN is unlikely to serve one; a studio CDN is exactly
where it would appear. If a misfiled image is ever noticed, the fix is an orientation read in
the classifier and a re-run of §5.3's backfill, not a schema change.

### 5.3 Migration 15, and the backfill beside it

The migration moves column values and touches no files. That is a hard constraint, not a
choice: migrations here are `{ version, up(db) }` running raw SQL against the database, and
`artworkDir` is not resolved until `main.ts`. It does not need to touch files — `poster_path`
holds a bare filename, so moving the value to `background_path` leaves it pointing at the
same file, which keeps serving.

Classification by URL, because SQL is all the migration has:

| `poster_url` matches | action | rows in `pickarr-2026-08-24-2.db` |
|---|---|---|
| `%/background/%` | move both values to the background pair, null the poster pair | 1,494 |
| the `800x1200` or `/smart/` crop marker | null the poster pair — discard, per §4.1 | 0 |
| anything else | leave as a poster | 14 |

The last branch knowingly leaves the three unknown-shape studio images filed as posters. SQL
cannot measure them, and a guess is what §3.1 rejects. They are corrected by the backfill:

`scripts/reclassify-artwork.ts` walks every row holding a poster or background path, measures
the cached file, and corrects the row when the measurement disagrees with the column. Offline —
no network, no API key, reading only files already on disk. Re-runnable, and a no-op once
clean. It is the same shape as `repair-background-posters.ts`, which did the same kind of
one-shot correction and has since been deprecated and removed — migration 15 nulls exactly the
rows that script selected, so it can never find one again. It remains in git history for
anyone tracing how this was corrected before the measurement existed.

Correcting a row means one of two things, and which one depends on the destination column.

**Move**, when the destination is empty: the url and the path relocate together, and the
cached file keeps serving from its new column. This is the common case — a migration 15
leftover has one slot filled and the other free. When *both* slots are filled and both
disagree, the two are swapped directly rather than routed through a vacated slot, so the row
never passes through a state where one side is momentarily empty.

**Clear**, when the destination is already occupied: the mismatching slot is nulled and
nothing relocates. A row can legitimately hold a correct background by the time the backfill
runs — the table above leaves the unknown-shape studio images filed as posters, and the
service may fetch a real background for one of them in the meantime. Moving the misfiled
poster in regardless would overwrite that correct image, so the misfiling is discarded
instead. This is the judgement §4.1 makes for the synthesised crop, applied here: an image
that cannot be correctly placed is not stored under a name that misdescribes it. Occupancy is
judged on either column being non-null, since a row can hold a url whose image was never
cached.

A cleared slot's file is then deleted. Nothing references it once the column is nulled, and
an unreferenced file in the artwork directory is indistinguishable from a live one — nulling
the column is the decision, deleting the file is that decision carried out.

With one exception, and it is the reason this paragraph exists rather than being left to the
reader. The file is *kept* when the surviving slot holds no image that was successfully
measured: a url whose image was never cached, a path whose file is missing, or bytes that
cannot be measured. Occupancy is deliberately generous, so all three count as occupied and
reach the clear — but in each of them the cleared file is the only readable image the row
has, and the destination it deferred to holds nothing. Deleting it would leave the group with
no artwork at all, and nothing would refetch it, since a confirmed answer is not re-asked at
any age. An orphaned file wastes disk and can be recovered by hand; a deleted sole image
cannot. The asymmetry decides it.

Both a move and a clear are database writes, so `--dry-run` performs neither, and deletes no
file either.

## 6. What the user sees: nothing

`MetadataView` gains `hasBackground: boolean`. `GET /api/groups/:id/background` mirrors the
poster route, including why that route is not a `@fastify/static` handler: it reads exactly
one column, joins it onto `artworkDir`, and the id is validated as a positive integer by zod
before it reaches the filesystem.

`MediaCard` today shows the image when `metadata.hasPoster`, and for 1,494 groups that
"poster" is a background. The moment `hasPoster` tells the truth those cards go blank. So the
card shows the poster when there is one and **otherwise the background** — which reproduces
today's rendering exactly, because today it shows whichever image won.

That fallback is temporary and phase 2b deletes it deliberately: the card becomes poster,
then first performer portrait, then a placeholder, and the background moves to the gallery. It
exists here so that this phase has no visual diff and no regression window if 2b lands later.
A reader who mistakes it for the intended design will build the wrong thing in 2b, so it
carries a comment saying so.

## 7. What this leaves for the gallery

The gallery wants an ordered list of every image a group has: poster, background, then each
performer's portrait. After this phase those are four addressable routes — two group images
and the two existing performer ones — with a boolean each saying whether they exist. That is
enough to build the list client-side without another schema change.

A normalised `group_images` table would suit the gallery better and is deliberately not built
here. Two column pairs mirror the table's existing shape, need one migration, and leave the
upsert protection in §8 where it already is. When the gallery lands and the list becomes
ordered and open-ended, that is the moment to normalise, with a real consumer to shape it.

## 8. The upsert asymmetry, mirrored

`poster_path` is deliberately absent from `recordMetadataAnswer`'s `DO UPDATE SET`, and the
existing comment explains why: it names a file already fetched to disk rather than something a
provider answer carries, only `setPosterPath` fills it, and updating it from `excluded` would
blank a cached poster on every refetch. There is a regression test for exactly that.

`background_path` gets identical treatment and a `setBackgroundPath` beside `setPosterPath`.
`background_url` *does* participate in the upsert, exactly as `poster_url` does, because it is
part of the answer.

## 9. Testing

- **`readPosterCandidate`** returns `null` for a crop rather than substituting a background;
  returns the `posters` set's `large` before `full`; falls through to the bare `poster` field.
- **`readBackgroundCandidate`** prefers the `background` object's `full`, recovers from a crop
  URL when the object is absent, and falls through to the studio `image` field.
- **A payload carrying both** yields both, independently.
- **`classifyArtwork`** calls a 1279x719 image a background, an 800x1200 a poster, and a
  square a poster (§3.1), for each of JPEG, PNG and WebP.
- **A candidate that measures against its field name** is committed to the other column —
  the assertion that the provider's naming is no longer authoritative.
- **`fetchImage`/`commitImage`** leave no `.part` file behind on a failed download, and two
  concurrent fetches for one group do not collide (the existing `randomUUID` temp naming
  already covers this; the test pins it across the split).
- **Independent failure:** a poster that downloads and a background that 404s leaves one
  column set and the other null.
- **Migration 15**, one test per branch of §5.3's table, including that a real poster is left
  alone.
- **The upsert**, mirroring the existing `poster_path` regression test: a refetch does not
  blank a cached `background_path`.
- **Route and view:** `/background` serves the file and 404s when the column is null;
  `hasBackground` reflects the column.
- **Web:** the card falls back to the background when there is no poster (§6).

## 10. Verification

`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
`npm run e2e -w @pickarr/e2e`.

Then two checks the suite cannot make, because fixtures prove branches and only real data
proves the classification matches reality:

1. Run migration 15 against a copy of `pickarr-2026-08-24-2.db` and assert the counts come out
   1,494 moved, 0 discarded, 14 left — and against `pickarr-2026-08-24.db`, 952 / 0 / 11. Both
   files are copies; the live installation is on another machine.
2. Run `scripts/reclassify-artwork.ts --dry-run` against the same copy and record what it would
   move. The three studio images are the expected finding; anything else moving is a
   classification bug worth understanding before the script is run for real.

## 11. Risks

- **`image-size` is a new runtime dependency** in a project with five. It is small, typed and
  dependency-free, but it is a supply-chain surface that did not exist before, on a path that
  runs against every image the metadata worker fetches.
- **EXIF orientation is unread** (§5.2). A rotated JPEG is misclassified. Recorded, not solved.
- **The three studio-CDN rows are misfiled until the backfill runs.** One is known to be a
  background and is filed as a poster; one is genuinely a poster and correctly filed by
  accident; one does not resolve, so only a measurement of the cached file can place it. The
  migration cannot measure and will not guess, so the window between migration and backfill
  is a known inconsistency rather than a surprise.
- **Phase 2b must delete §6's fallback.** If it does not, the card keeps showing landscape
  backgrounds cropped into a 2:3 slot, which is the outcome this whole phase exists to make
  impossible.
