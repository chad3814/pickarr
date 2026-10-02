# Requery and manual edit: fixing what a release was matched to

## Problem

A release is identified once, by its filename, when its feed is polled. If the lookup
got it wrong, or could not identify it, an operator has one tool: the Retry button on
the Unmatched page, which runs the same filename lookup again and refuses to run at all
for a release that is already matched. Nothing can move a release to the right media
item, nothing can supply a better name than the filename, and a media item left with
no releases stays on the browse page for ever.

## Goal

From a release line on a category page, or from an unmatched card: run the lookup again,
look the release up under a corrected name, or link it to a media item the library
already knows, choosing that item from an autocomplete. A media item that loses its last
release disappears, with its plugin rows and artwork.

## Decisions already made

| Question | Decision |
|---|---|
| What "edit" offers | Both: choose a known media item (autocomplete over the replica's catalog, same category), or type a corrected name and have the host re-run the lookup with it in place of the filename. No provider title search exists and none is added. |
| An item left with no releases | Deleted: its plugin rows (through a plugin hook), its roles, its artwork rows and files, and a tombstone so replicas drop it. |
| Where the controls live | Each release line in an expanded card gets Requery and Edit beside Pick. Each unmatched card's Actions gets Edit beside Retry. Edit opens an inline form. |
| Who owns the move | The host (`relinkRssItem` and `dropMediaItem` already live there). Plugins contribute two hooks: delete their rows for a dropped item, and accept a lookup request with an optional name. The existing retry route is unchanged. |

## Facts this design rests on

Read from the tree on 2026-10-02:

- `rss_item.media_item_id` has one writer, `MediaWriter.relinkRssItem` (`media/writer.ts`), called once in the engine's resolved path on a null-to-id transition. A non-null link also clears `lookup_json`.
- `media/retry.ts` refuses `already-matched` for a linked release, so nothing today re-identifies a matched one.
- `PRAGMA foreign_keys = ON`. `role.media_item_id`, `tv_release.media_item_id`, `movie_detail.media_item_id` and `xxx_scene.media_item_id` all `REFERENCES media_item (id)` with no cascade, so `DELETE FROM media_item` fails while any of them points at the row. `dropMediaItem` deletes the three artwork tables, writes a `deleted_media_item` tombstone, deletes the item inside a savepoint, and removes artwork files best-effort. It does not touch `role` or plugin rows, and nothing calls it except the dedup path, where the loser has neither.
- The host cannot name a plugin's tables. `MediaPlugin` (`contract/src/plugin.ts`) has `onNewRssItems`, `onDownloadedFile`, `onDownloadRequest`.
- The engine (`openmetadata/src/engine.ts`) enqueues a `lookup` job with payload `{ rssItemIds: number[] }`; the job reads `id, filename` for each and posts the filenames to the lookup service. The service identifies a name string; a typed title stands in for a filename.
- `applyResolved` creates a media item, claims the provider ref (dedup drops the newer duplicate), relinks the release, writes `<plugin>_lookup`, applies plugin rows, attaches people, sets `resolved`.
- `useGatheredItem` re-gathers when the `media_item` row changes or a download for one of its releases arrives; a release moving on or off an item does not re-gather by itself.
- The replica's `catalog` (Phase 5) answers `listCatalog({ pluginId, filter, term }, { limit })` with media item ids whose haystack (title, year, filenames, people) contains the term.
- Write-route conventions: shape guards in `api/request-shapes.ts`, one exhaustive status `switch` per route in `api/refusal-status.ts`, codes in `@pickarr/contract`, prose only in the browser, no row contents in a response body or log line. `sendJson` yields `answered | offline | expired`.
- `plugin-ui`'s `CardProps` carries `submit: PickSubmit` and nothing else writable; `ReleaseList` renders each release line and owns the Pick button's pending state, which clears when the download row arrives. `Unmatched.tsx`'s `RetryButton` clears pending when the row's `updatedAt` advances.
- No combobox, datalist or listbox exists anywhere in the browser packages.

## 1. The host

### 1.1 The route

`POST /api/releases/:id/identify`, in `ROUTES`, guarded. The body is one of:

```ts
{ mode: 'requery' }
{ mode: 'name'; name: string }                 // trimmed, non-empty
{ mode: 'media-item'; mediaItemId: number }
```

Answers:

- `202 { accepted: true }` for `requery` and `name`: the lookup runs as a job.
- `200 { outcome: 'linked', mediaItemId }` for `media-item`: the move completes before the answer.
- `{ refusal }` with a code from `IDENTIFY_RELEASE_REFUSALS` in `@pickarr/contract`:

| Code | Status | When |
|---|---|---|
| `invalid-shape` | 400 | the body is none of the three shapes, or `name` is empty after trimming |
| `unknown-release` | 422 | no `rss_item` with that id |
| `plugin-not-registered` | 422 | the release's feed names a plugin that is not loaded |
| `unknown-media-item` | 422 | `media-item` mode and no such item |
| `wrong-plugin` | 422 | `media-item` mode and the item's `plugin_id` is not the release's |
| `already-linked` | 409 | `media-item` mode and the release already points at that item |

The id comes from the path through `idAt`, a bad id answering `UNKNOWN_ROUTE` as the retry route does. No title, name or filename appears in any response body or log line.

`/api/unmatched/:id/retry` is unchanged. Requery of an unmatched release through the new route is the same operation.

### 1.2 `reassignRelease`

`Host.reassignRelease(rssItemId, mediaItemId)` in a new `packages/host/src/media/reassign.ts`. Inside one savepoint, `reassign_release`:

1. Read the release's current `media_item_id` (`previous`, possibly null) and its owning plugin.
2. `relinkRssItem(rssItemId, mediaItemId)` (clears `lookup_json`); set `lookup_state = 'resolved'`, `lookup_state_detail = NULL`; set the target item's `updated_at` to now.
3. If `previous` is non-null and differs from the target:
   - if no other `rss_item` has `media_item_id = previous`: `await plugin.onMediaItemDropped(previous, ctx)`, then `DELETE FROM role WHERE media_item_id = ?`, then `dropMediaItem(previous)`;
   - otherwise set `previous`'s `updated_at` to now.
4. Release the savepoint. Any throw rolls it back, so a failing plugin hook leaves the release where it was.

The two `updated_at` bumps are what carries the move to the browser: `useGatheredItem` re-gathers on a `media_item` row change, the sync log emits both rows, and the catalog recomputes both from the `rss_item` op. `dropMediaItem`'s artwork file removal stays best-effort after its own savepoint, as today.

### 1.3 `identifyRelease`

`Host.identifyRelease(rssItemId, request)` validates and dispatches:

- release missing → `unknown-release`; plugin not registered → `plugin-not-registered`;
- `media-item`: item missing → `unknown-media-item`; `plugin_id` differs → `wrong-plugin`; already linked to it → `already-linked`; else `reassignRelease` and `{ outcome: 'linked', mediaItemId }`;
- `requery` / `name`: `await plugin.onLookupRequest(rssItemId, hint, ctx)` where `hint` is `{ name }` or `undefined`; `{ accepted: true }`.

`main.ts` wires `identifyRelease: (id, request) => host.identifyRelease(id, request)` into `ReadServerDeps`; the e2e harness mirrors it.

### 1.4 Two hooks on `MediaPlugin`

```ts
/** Delete this plugin's own rows for `mediaItemId`. The host deletes roles, artwork and the item afterwards, in the same savepoint. */
onMediaItemDropped(mediaItemId: number, ctx: PluginContext): Promise<void>;
/** Identify this release again: by `hint.name` when given, else by its filename. The release may already be matched. */
onLookupRequest(rssItemId: number, hint: { name: string } | undefined, ctx: PluginContext): Promise<void>;
```

Both are required. A plugin that cannot drop its rows would leave a foreign-key violation behind the host's delete; the e2e harness's stub plugins implement both trivially (no rows to drop; `onLookupRequest` is a no-op like their `onNewRssItems`).

### 1.5 The engine

`LookupPluginSpec` gains `dropRows(mediaItemId: number, raw: DatabaseSync): void`; each shipped plugin supplies its deletes (`tv_release`; `movie_detail`; `xxx_scene`). `createLookupPlugin` implements:

- `onMediaItemDropped`: `spec.dropRows(id, raw)`.
- `onLookupRequest`: set the release's `lookup_state = 'pending'`, `lookup_state_detail = NULL`, `updated_at = now`; upsert the `<plugin>_lookup` row with do-nothing as `onNewRssItems` does; enqueue a `lookup` job with payload `{ rssItemIds: [rssItemId], names: { [rssItemId]: name } }` (the `names` key present only for a hint).

The `lookup` job: `readLookupPayload` accepts the optional `names` map; the names posted to the service are `names[id] ?? filename`. `applyResolved` changes in one place: where it calls `relinkRssItem`, it now reads the release's current link first and, if that link is non-null and differs from `claim.kept`, calls `ctx.media.reassignRelease(rssItemId, claim.kept)` (exposed on `MediaWriter`) so the orphan rule runs for lookups too; otherwise it relinks as before. `<plugin>_lookup` records the last lookup's answer, not the current link: a direct `media-item` assignment leaves it alone, and this is the documented meaning of that table from here on.

A lookup never unlinks: `unresolved` and `refused` answers set state and detail and leave `media_item_id` as it was.

## 2. What the browser reads

Nothing new from the host. Autocomplete candidates come from the replica: `listCatalog({ pluginId, filter: 'all', term }, { limit: 8 })`, then `getRows('media_item', ids)` for `title` and `releaseDate`. The move arrives through sync as today.

## 3. The browser

### 3.1 The submit seam

`plugin-ui` gains, beside `PickSubmit`:

```ts
export type IdentifyRequest = { mode: 'requery' } | { mode: 'name'; name: string } | { mode: 'media-item'; mediaItemId: number };
export type IdentifyOutcome = { accepted: true } | { outcome: 'linked'; mediaItemId: number } | { refusal: IdentifyReleaseRefusalCode | 'offline' | 'expired' | 'unrecognised' };
export interface Candidate { mediaItemId: number; title: string; year: string | null; }
export interface IdentifySubmit {
  identify(rssItemId: number, request: IdentifyRequest): Promise<IdentifyOutcome>;
  suggest(pluginId: string, term: string): Promise<readonly Candidate[]>;
}
```

`CardProps` gains `identify: IdentifySubmit`; the three plugins' cards pass it to `ReleaseList`, which gains the same prop. `web` implements `identify` in `library/postIdentify.ts` over `sendJson` (status and body mapped as `postPick` does; `IDENTIFY_REFUSAL_MESSAGES` gives every code and `offline`/`expired`/`unrecognised` a distinct sentence) and `suggest` in `library/suggestCandidates.ts` over the store (`normalizeTerm`, catalog, media item rows; `year` is the first four characters of `releaseDate` when present). `Shell.tsx` wires both into `Category` and `Unmatched`.

### 3.2 The release line

`ReleaseRow` gains two buttons after Pick, in this order: `Requery`, `Edit`.

- **Requery** posts `{ mode: 'requery' }`. The label reads `Requerying…` and the button is disabled from the click until the row's `updatedAt` advances (the host bumps it when it sets `pending`), or until a refusal, which renders as `<div role="alert">` with its sentence, as Pick does.
- **Edit** replaces the three buttons with the `IdentifyForm` (§3.3) for that release. Cancel or success restores them.
- The line gains a status span after the resolution span when `lookupState` is `pending` (`Looking up…`), `unresolved` (`unresolved`) or `refused` (`refused`), so a requery's progress and outcome show on a matched release. Nothing renders for `resolved`.

### 3.3 `IdentifyForm`

One component in `plugin-ui`, used by both pages. Props: `pluginId`, `rssItemId`, `identify: IdentifySubmit`, `onDone(): void`, `onCancel(): void`.

- `<form>` with a labelled text input `Title`, an ARIA combobox: `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls` naming the listbox, `aria-activedescendant` naming the highlighted option, `autoComplete="off"`.
- Typing is debounced 150 ms, then `suggest(pluginId, term)` fills a `<ul role="listbox">` of up to 8 `<li role="option">`, each reading `Title (Year)` or `Title` when there is no year, plus one final option `Look up as "<typed>"` whenever the trimmed input is non-empty. ArrowDown/ArrowUp move the highlight (wrapping), Enter chooses the highlighted option, Escape closes the list; clicking an option chooses it.
- Choosing a candidate fills the input with its label and remembers its `mediaItemId`; choosing the look-up option clears any remembered id. Editing the input after a choice clears the remembered id.
- `Save` is disabled while the trimmed input is empty or a request is in flight. It posts `{ mode: 'media-item', mediaItemId }` when an id is remembered, else `{ mode: 'name', name: trimmed }`.
- `accepted` or `linked` calls `onDone()`. A refusal renders `<div role="alert">` with the sentence and keeps the form open. `Cancel` calls `onCancel()`.

### 3.4 The unmatched card

`UnmatchedDetail`'s Actions gain `Edit` beside Retry, opening `IdentifyForm` in place of the two buttons with the card's plugin id (the feed's `pluginId`, read beside the feed name). Retry is unchanged. After `onDone`, the row goes pending until its `updatedAt` advances, as Retry does; a `linked` outcome removes the card on the next sync.

### 3.5 Styling

`library.css`, structural selectors only: `ul[aria-label='releases'] li form`, `dl form` for the unmatched card, `[role='combobox']`, `[role='listbox']`, `[role='option']`, `[role='option'][aria-selected='true']`. No class attributes.

## 4. Edge cases

- **Assigning to the item it already has** refuses `already-linked`; the sentence shows and the form stays open.
- **A candidate from another category** cannot be suggested (scoped by plugin) and is refused `wrong-plugin` if forged.
- **The previous item keeps other releases**: it is bumped, not dropped, and its card re-gathers without the moved release.
- **A name lookup resolves to the item the release already had**: the dedup keeps the item; nothing is dropped.
- **A name lookup is unresolved or refused**: the line shows the state; the link is unchanged. A lookup never unlinks.
- **A dead lookup job** leaves `pending` as today; the Activities page lists the job. Not improved here.
- **A plugin hook throws**: the savepoint rolls back, the route answers 500, the browser shows the unrecognised sentence, the release is where it was.
- **Whitespace-only name**: Save is disabled; the host refuses `invalid-shape` if forged.
- **The target item is dropped between suggest and Save** (another tab moved its last release): `unknown-media-item`.
- **Two tabs**: a move seen through sync clears the other tab's pending state the same way.

## 5. Testing

Every test is written to fail first.

- **Host**
  - `reassignRelease`: moves the link, sets `resolved`/`NULL` detail, clears `lookup_json`, bumps the target; drops an orphaned previous item (hook called before the deletes, roles gone, tombstone written, artwork rows gone, `media_item` gone); keeps and bumps a previous item that still has a release; a throwing hook rolls everything back including the relink; a null previous item drops nothing.
  - `identifyRelease`: each refusal code from its condition; `media-item` answers `linked`; `requery` and `name` call the plugin's `onLookupRequest` with `undefined` and `{ name }`.
  - Route: three modes with their statuses and bodies; every refusal's status; no name, title or filename in any response or log line; bad ids answer 404; anonymous 401 before 405.
  - Engine: `onLookupRequest` sets `pending`, bumps `updated_at`, enqueues one job with `names` only when hinted; the job posts the name in place of the filename and the filename otherwise; `applyResolved` on a release linked elsewhere goes through `reassignRelease` and drops the orphan; on a release linked to the same item it does not.
  - Each plugin's `dropRows` deletes its rows for that item and leaves a neighbour's.
- **Web**
  - `postIdentify`: `accepted`, `linked`, each refusal, `expired`, `offline`, `unrecognised`; all sentences distinct; request shape for each mode.
  - `suggestCandidates`: scoped by plugin, capped at 8, year from `releaseDate`, null year.
  - `IdentifyForm`: combobox roles and attributes; options from `suggest` after the debounce (spy on `setTimeout`); the look-up option present once typed; keyboard navigation and `aria-activedescendant`; Enter chooses; Escape closes; Save disabled when empty; `media-item` body after a choice; `name` body after the look-up option; editing after a choice reverts to `name`; refusal alert; `onDone` on success; Cancel.
  - `ReleaseRow`: Requery pending until `updatedAt` advances, not on 202; refusal alert; Edit swaps in the form and Cancel restores; status span for the three states and none for `resolved`.
  - `Unmatched`: Edit opens the form with the feed's plugin id; Retry unchanged.
- **e2e**
  - Seed a matched release under one media item and a second media item in the same category. Open the first card, Edit, type the second title, choose it, Save: the release appears under the second card and the first card is gone within the sync window. Requery on a matched release answers 202 and the line reads `Looking up…`.
- **Mutations** (each must redden a test): orphan check ignores other releases; hook called after `dropMediaItem`; target `updated_at` bump removed; `names` ignored by the job; `wrong-plugin` check removed; `already-linked` check removed; `aria-activedescendant` never set; Save enabled when empty; Requery clears pending on 202; the look-up option omitted.

## Out of scope

- A provider-side title search.
- Editing a media item's title or metadata.
- Bulk reassignment.
- Recovering or retrying a dead lookup job.
- Changing `/api/unmatched/:id/retry`.
