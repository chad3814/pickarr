# Media Card Detail Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a media item's poster, external links, description, cast and provider attribution inside the expanded browse card, with a gallery modal over the images that exist.

**Architecture:** Every field this renders is already in the IndexedDB replica and already assembled by `web/src/store/gather.ts`; it simply never crosses into `@pickarr/plugin-ui`, whose `GatheredItemView` declares only `releases`. Task 1 widens that seam. Tasks 2-5 build pure link helpers, inline icons, the gallery modal and the shared `MediaDetails` section in `plugin-ui`. Tasks 6-8 style it, render it from all three plugin cards, add the movie-only IMDb link, and pin the rendered geometry in a browser spec.

**Tech Stack:** TypeScript (`verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), React 19, `node:test` + `@testing-library/react`, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-25-media-card-details-design.md`

## Global Constraints

- **Never use the `any` TypeScript type.** Not in source, not in tests, not behind a cast.
- **`@pickarr/plugin-ui` must never import `@pickarr/web`** — web imports plugin-ui. Shapes are mirrored in `plugin-ui/src/types.ts`, and `gatherSatisfiesView` in `web/src/store/gather.ts` is the compile-time check that stops the two drifting.
- **`@pickarr/plugin-ui` must never import `@pickarr/openmetadata`** — that package's root reaches `node:sqlite`. Provider-reference parsing is therefore duplicated in the browser, deliberately; see Task 2.
- **No migration.** Every column this reads already exists. `movie_detail.imdb_id` is on disk and populated; only the sync projection is missing it.
- **Prefer the async form of an API over its synchronous twin.** Inside an `async` function, `await` it.
- **Tests never hand a live DOM element to `node:assert`'s equality helpers** — use `assert.ok(!screen.queryByText(x), '…')` or `packages/web/test/dom.ts`'s `gone()`. `scripts/check-test-hygiene.ts` fails the build on it.
- **`afterEach(cleanup)`**, never per-test `cleanup()` — a test that throws before its own cleanup hangs the whole file.
- **Assert literal strings, not values recomputed by the code under test.** `CLAUDE.md` records `groupAnchor` returning a constant while 70 tests passed.
- **Playwright's `getByRole(role, { name })` matches a substring** — pass `exact: true` for a control whose name is a common word.
- Run the gate with `npm run build`, `npm run check`, and `npm run e2e` **redirected to a file** (piping `npm run e2e` into `tail` SIGPIPEs the run and reports a false failure).

## Review Focus

These are input classes the spec implies but does not spell out. Each line's test is added to the task that owns the code.

1. **A media item with `provider: null`** — never claimed by a lookup. Must render no provider icons and no attribution line, never `data provided by null`. (Task 5)
2. **`releaseDate: null` or `description: null`** — must omit the line entirely, never `Release Date: null` or an empty paragraph. (Task 5)
3. **A person whose image 404s** — the cast entry must still render the name, with the placeholder glyph, rather than a broken image or a missing person. (Task 5)
4. **A gallery whose every image 404s** — must not open an empty modal with a caption and no picture. (Task 4)
5. **A `providerRef` that will not parse** — a format change must cost an icon, not produce a link to `https://www.themoviedb.org/movie/tmdb%3Amovie%3A335984`. This is the browser twin of the 743-dead-jobs incident. (Task 2)

---

### Task 1: Widen the gathered view

**Files:**
- Modify: `packages/plugin-ui/src/types.ts`
- Modify: `packages/plugin-ui/src/index.ts`
- Modify: `packages/web/src/store/gather.ts`
- Test: `packages/web/test/store/gather.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GatheredItemView` gains `readonly roles: readonly GatheredRoleView[]` and `readonly artwork: ArtworkUrlsView`. `GatheredRoleView` is `{ readonly id: number; readonly row: RoleSyncRead; readonly person: PersonSyncRead | undefined; readonly imageUrl: string }`. `ArtworkUrlsView` is `Readonly<Record<'poster' | 'background' | 'logo', string>>`.

- [ ] **Step 1: Write the failing test**

Add to `packages/web/test/store/gather.test.ts`, using that file's existing `freshDb()` and `seed()` helpers:

```ts
test('a gathered role carries the url its person’s picture is served from', async () => {
  // The url is spelled literally, never rebuilt by calling the helper that
  // produces it: a test whose expectation is computed by the code under
  // test cannot detect that code changing (see CLAUDE.md on `groupAnchor`,
  // which returned a constant while 70 tests passed).
  const db = await freshDb();
  await seed(db, [
    { op: 'upsert', table: 'media_item', id: 7, value: { pluginId: 'demo', title: 'A Show' } },
    { op: 'upsert', table: 'person', id: 9, value: { name: 'Alice', providerRef: 'tmdb:person:9' } },
    { op: 'upsert', table: 'role', id: 2, value: { mediaItemId: 7, personId: 9, role: 'actor' } },
  ]);

  const gathered = await gatherMediaItem(db, 7);

  assert.ok(gathered !== undefined);
  assert.equal(gathered.roles[0]?.imageUrl, '/api/artwork/person/9');
  // The media urls keyed on the item, not on the person -- the route takes
  // a different id column for each (`ARTWORK_QUERY`).
  assert.equal(gathered.artwork.poster, '/api/artwork/poster/7');
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/store/gather.test.ts`
Expected: FAIL — `imageUrl` is `undefined`.

- [ ] **Step 3: Add the person url to the gather**

In `packages/web/src/store/gather.ts`, beside `artworkUrls`:

```ts
/**
 * Where a person's picture is served from. Separate from `artworkUrls`
 * because the route keys this kind on `person_id` and the other three on
 * `media_item_id` (`host/src/api/artwork-route.ts`'s `ARTWORK_QUERY`), so
 * one function taking a media item id could not produce it.
 */
function personImageUrl(personId: number): string {
  return `/api/artwork/person/${String(personId)}`;
}
```

Add `imageUrl` to the `GatheredRole` interface:

```ts
  /** Where this person's picture is served from; 404s for most people. */
  readonly imageUrl: string;
```

and set it wherever `gatherRole` builds its result: `imageUrl: personImageUrl(row.personId)`.

- [ ] **Step 4: Mirror the shapes in plugin-ui**

In `packages/plugin-ui/src/types.ts`, import `PersonSyncRead` and `RoleSyncRead` from `@pickarr/contract` alongside the existing imports, then add above `GatheredItemView`:

```ts
/** Mirrors `ArtworkUrls` in `web/src/store/gather.ts`. Urls, never rows -- artwork is not replicated (#79). */
export type ArtworkUrlsView = Readonly<Record<'poster' | 'background' | 'logo', string>>;

/** Mirrors `GatheredRole` in `web/src/store/gather.ts`. */
export interface GatheredRoleView {
  readonly id: number;
  readonly row: RoleSyncRead;
  /**
   * `undefined` while the person named by this role has not replicated --
   * log order is not group order, so a role can land before its person.
   */
  readonly person: PersonSyncRead | undefined;
  readonly imageUrl: string;
}
```

and widen the view:

```ts
export interface GatheredItemView {
  readonly releases: readonly GatheredReleaseView[];
  readonly roles: readonly GatheredRoleView[];
  readonly artwork: ArtworkUrlsView;
}
```

Export both new types from `packages/plugin-ui/src/index.ts` beside `GatheredItemView`.

- [ ] **Step 5: Run the test and the typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/store/gather.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS. `gatherSatisfiesView` is what proves the widened view is satisfied; if it errors, `GatheredItem` and the view have drifted and the *view* is wrong, not the check.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-ui/src packages/web/src/store/gather.ts packages/web/test/store/gather.test.ts
git commit -m "Pass roles and artwork urls through the card seam"
```

---

### Task 2: Provider links

**Files:**
- Create: `packages/plugin-ui/src/links.ts`
- Create: `packages/plugin-ui/test/links.test.ts`
- Modify: `packages/plugin-ui/src/index.ts`
- Modify: `docs/superpowers/specs/2026-09-25-media-card-details-design.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `providerRefId(providerRef: string): string | undefined`; `mediaLink(provider: string | null, providerRef: string | null): ExternalLink | undefined`; `personLink(provider: string | null, providerRef: string): string | undefined`; `providerDisplayName(provider: string): string | undefined`; `interface ExternalLink { readonly label: string; readonly href: string }`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-ui/test/links.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaLink, personLink, providerDisplayName, providerRefId } from '../src/links.ts';

// Every reference below was read off a live `/api/v1/lookup` answer, and
// every url was verified by status code. They are not constructed to fit
// the parser -- inventing fixtures for a third party's format is what cost
// the artwork feature its first deployment (743 dead jobs).

test('a tmdb reference is composite and a tvdb or tpdb one is bare', () => {
  assert.equal(providerRefId('tmdb:movie:335984'), '335984');
  assert.equal(providerRefId('tmdb:tv:1399:1:1'), '1399');
  assert.equal(providerRefId('tmdb:person:30614'), '30614');
  assert.equal(providerRefId('184871'), '184871');
  assert.equal(providerRefId('5e8911b9-8e6d-4fa9-af95-f4788281551e'), '5e8911b9-8e6d-4fa9-af95-f4788281551e');
});

test('a reference this build cannot read yields no link, rather than a url that 404s', () => {
  // Review Focus 5. The browser twin of the artwork incident: a format
  // change must cost an icon, never produce
  // `themoviedb.org/movie/tmdb%3Amovie%3A335984`.
  assert.equal(providerRefId('184871:s14'), undefined, 'a tvdb season is not an id');
  assert.equal(providerRefId(''), undefined);
  assert.equal(mediaLink('tmdb', '184871:s14'), undefined);
  assert.equal(mediaLink('tmdb', null), undefined, 'an unclaimed item has no ref');
  assert.equal(mediaLink(null, '335984'), undefined, 'an unclaimed item has no provider');
  assert.equal(mediaLink('imdb', '335984'), undefined, 'no pattern for this provider');
});

test('media links are the id-addressable route each provider actually serves', () => {
  // Spelled literally. `thetvdb.com/series/184871` is a **404** -- TheTVDB's
  // pages are slug-based and `/dereferrer/<type>/<id>` is the id route.
  // Verified by status code, not inferred from TMDB's shape.
  assert.deepEqual(mediaLink('tmdb', 'tmdb:movie:335984'), {
    label: 'TMDb', href: 'https://www.themoviedb.org/movie/335984',
  });
  assert.deepEqual(mediaLink('tmdb', 'tmdb:tv:1399:1:1'), {
    label: 'TMDb', href: 'https://www.themoviedb.org/tv/1399',
  });
  assert.deepEqual(mediaLink('tvdb', '184871'), {
    label: 'TVDb', href: 'https://thetvdb.com/dereferrer/series/184871',
  });
  assert.deepEqual(mediaLink('tpdb', '5e8911b9-8e6d-4fa9-af95-f4788281551e'), {
    label: 'TPDb', href: 'https://theporndb.net/scenes/5e8911b9-8e6d-4fa9-af95-f4788281551e',
  });
});

test('person links reach each provider’s own person page', () => {
  assert.equal(personLink('tmdb', 'tmdb:person:30614'), 'https://www.themoviedb.org/person/30614');
  assert.equal(personLink('tvdb', 'tvdb:person:7892648'), 'https://thetvdb.com/dereferrer/people/7892648');
  // ThePornDB's *API* answers 404 for `/performers/{ref}` -- which is why
  // the artwork source reads performers out of the scene payload -- but the
  // *website* resolves the same uuid. Verified; do not "fix" this back.
  assert.equal(
    personLink('tpdb', '7a7a5268-c6be-48fb-9e27-96f9f9144201'),
    'https://theporndb.net/performers/7a7a5268-c6be-48fb-9e27-96f9f9144201',
  );
  assert.equal(personLink('tvdb', '184871:s14'), undefined);
});

test('provider display names are for the attribution line', () => {
  assert.equal(providerDisplayName('tmdb'), 'The Movie Database');
  assert.equal(providerDisplayName('tvdb'), 'TheTVDB');
  assert.equal(providerDisplayName('tpdb'), 'ThePornDB');
  assert.equal(providerDisplayName('nobody'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --conditions development --test packages/plugin-ui/test/links.test.ts`
Expected: FAIL — cannot find `../src/links.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugin-ui/src/links.ts`:

```ts
/**
 * Where a media item and its people live on the provider that identified
 * them.
 *
 * **Every url here was verified by status code against the live site, not
 * inferred from another provider's shape.** One would have been wrong:
 * `https://thetvdb.com/series/184871` answers **404**, because TheTVDB's
 * pages are slug-based and `/dereferrer/<type>/<id>` is the route that
 * takes an id. `/dereferrer/season/{id}` also 404s, which costs nothing --
 * no media item is a season.
 *
 * **The reference parse is duplicated here, deliberately.** `tmdbId` and
 * `tvdbId` in `@pickarr/openmetadata`'s `src/artwork/` do the same job on
 * the server, but that package's root reaches `node:sqlite` and must never
 * be imported from browser code, so this cannot call them. The duplication
 * is one short function and the shapes it parses are pinned by
 * `test/links.test.ts` against references read off live lookup answers --
 * the same references those two modules' tests use. If openmetadata's
 * format changes, three places change.
 */

/** A link to a provider's own page, and the lettermark that labels it. */
export interface ExternalLink {
  readonly label: string;
  readonly href: string;
}

/** A tmdb id is digits; a tpdb id is a uuid. Neither contains a colon. */
const BARE_ID = /^[0-9]+$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The provider's own id inside an openmetadata reference.
 *
 * **openmetadata is not uniform across providers**, which is the whole
 * reason this is a function rather than the reference itself: TMDB sends
 * `tmdb:movie:335984` and `tmdb:tv:1399:1:1`, TheTVDB sends a bare
 * `184871`, ThePornDB sends a bare uuid. A TheTVDB *season* is
 * `184871:s14` and is refused rather than read as `184871`, which is the
 * series and not the season.
 */
export function providerRefId(providerRef: string): string | undefined {
  if (BARE_ID.test(providerRef)) return providerRef;
  const segments = providerRef.split(':');
  if (segments.length < 3) return undefined;
  const id = segments[2];
  return id !== undefined && /^[0-9]+$/.test(id) ? id : undefined;
}

/** `movie` or `tv` for a TMDB reference, from its own second segment. */
function tmdbType(providerRef: string): string | undefined {
  const type = providerRef.split(':')[1];
  return type === 'movie' || type === 'tv' ? type : undefined;
}

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  tmdb: 'The Movie Database',
  tvdb: 'TheTVDB',
  tpdb: 'ThePornDB',
};

/** The provider's full name, for the attribution line. `undefined` for one we have no name for. */
export function providerDisplayName(provider: string): string | undefined {
  return DISPLAY_NAMES[provider];
}

/**
 * The item's page on its provider, or `undefined` when there is none to
 * build -- an unclaimed item (`provider` and `providerRef` are null
 * together), a provider with no pattern, or a reference this build cannot
 * read. Never a url assembled from an unparsed reference.
 */
export function mediaLink(provider: string | null, providerRef: string | null): ExternalLink | undefined {
  if (provider === null || providerRef === null) return undefined;
  const id = providerRefId(providerRef);
  if (id === undefined) return undefined;

  if (provider === 'tmdb') {
    const type = tmdbType(providerRef);
    return type === undefined
      ? undefined
      : { label: 'TMDb', href: `https://www.themoviedb.org/${type}/${id}` };
  }
  if (provider === 'tvdb') {
    return { label: 'TVDb', href: `https://thetvdb.com/dereferrer/series/${id}` };
  }
  if (provider === 'tpdb') {
    return { label: 'TPDb', href: `https://theporndb.net/scenes/${id}` };
  }
  return undefined;
}

/** The person's page on the provider that named them, or `undefined`. */
export function personLink(provider: string | null, providerRef: string): string | undefined {
  const id = providerRefId(providerRef);
  if (provider === null || id === undefined) return undefined;
  if (provider === 'tmdb') return `https://www.themoviedb.org/person/${id}`;
  if (provider === 'tvdb') return `https://thetvdb.com/dereferrer/people/${id}`;
  if (provider === 'tpdb') return `https://theporndb.net/performers/${id}`;
  return undefined;
}
```

Export `mediaLink`, `personLink`, `providerDisplayName`, `providerRefId` and `type ExternalLink` from `packages/plugin-ui/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --conditions development --test packages/plugin-ui/test/links.test.ts`
Expected: PASS

- [ ] **Step 5: Correct the spec's claim about reuse**

The spec's "External links" section says the builder "reuses the same parse rather than repeating the mistake in the browser". It cannot — see the docblock above. In `docs/superpowers/specs/2026-09-25-media-card-details-design.md`, replace that sentence with:

```
`artwork/tmdb.ts`'s `tmdbId` and `artwork/tvdb.ts`'s `tvdbId` exist
because this exact assumption cost 743 dead jobs. This builder cannot
call them -- `@pickarr/openmetadata`'s root reaches `node:sqlite` and is
not importable from the browser -- so it carries its own parse, pinned
by the same live-read references those modules' tests use.
```

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-ui/src/links.ts packages/plugin-ui/test/links.test.ts packages/plugin-ui/src/index.ts docs/superpowers/specs/2026-09-25-media-card-details-design.md
git commit -m "Build provider links from a parsed reference, never a pasted one"
```

---

### Task 3: Inline icons

**Files:**
- Create: `packages/plugin-ui/src/icons.tsx`
- Create: `packages/plugin-ui/test/icons.test.tsx`
- Modify: `packages/plugin-ui/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DownloadTypeIcon({ type }: { type: string }): ReactElement`; `ProviderBadge({ label }: { label: string }): ReactElement`; `ImagePlaceholder({ label }: { label: string }): ReactElement`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-ui/test/icons.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup } from '@testing-library/react';
import { DownloadTypeIcon, ImagePlaceholder, ProviderBadge } from '../src/icons.tsx';

afterEach(cleanup);

test('a download-type icon names the type it stands for', () => {
  // The name is the whole accessibility of a glyph: without it a screen
  // reader announces nothing at all where a sighted user sees "torrent".
  render(<DownloadTypeIcon type="torrent" />);
  assert.ok(screen.getByRole('img', { name: 'torrent' }), 'the torrent icon is named');
});

test('an unknown download type still renders something named', () => {
  // `rss_item.download_type` is replica data of open range. A glyph this
  // build has no drawing for must not render an empty box with no name.
  render(<DownloadTypeIcon type="carrier-pigeon" />);
  assert.ok(screen.getByRole('img', { name: 'carrier-pigeon' }), 'the unknown type is still named');
});

test('a provider badge shows its lettermark as text', () => {
  // Text, not a path: `getByText` proves a sighted user sees the letters,
  // where an `aria-label` alone would pass while rendering nothing.
  render(<ProviderBadge label="TMDb" />);
  assert.ok(screen.getByText('TMDb'), 'the lettermark is rendered text');
});

test('the placeholder is named for what is missing', () => {
  render(<ImagePlaceholder label="No poster for Blockers" />);
  assert.ok(screen.getByRole('img', { name: 'No poster for Blockers' }), 'the placeholder is named');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/plugin-ui/test/icons.test.tsx`
Expected: FAIL — cannot find `../src/icons.tsx`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugin-ui/src/icons.tsx`:

```tsx
/**
 * The first icons in this codebase.
 *
 * Inline SVG rather than image files: no asset pipeline changes, no
 * second network request per card, and `currentColor` means both themes
 * are handled by the stylesheet that already sets text colour.
 *
 * **Provider marks are lettermarks, not the companies' logos.** The real
 * marks are trademarks with usage rules, and a row of link affordances is
 * recognisable without them. The Movie Database's attribution requirement
 * is met by the `data provided by` line `MediaDetails` renders.
 *
 * Every glyph carries `role="img"` and a `<title>`, referenced by
 * `aria-labelledby`, because an unlabelled `<svg>` announces nothing.
 */
import type { ReactElement } from 'react';
import { useId } from 'react';

/** A downward arrow into a tray -- a download, whatever the transport. */
const DOWNLOAD_PATH = 'M12 3v10m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2';

/** A magnet, for a torrent. */
const MAGNET_PATH = 'M6 4v7a6 6 0 0012 0V4h-4v7a2 2 0 01-4 0V4H6z';

/**
 * The glyph for a release's transport. An unrecognised value still
 * renders, named for itself: `download_type` comes from the replica and
 * is not a closed set this component can rely on.
 */
export function DownloadTypeIcon({ type }: { type: string }): ReactElement {
  const titleId = useId();
  return (
    <svg className="icon" viewBox="0 0 24 24" role="img" aria-labelledby={titleId}
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <title id={titleId}>{type}</title>
      <path d={type === 'torrent' ? MAGNET_PATH : DOWNLOAD_PATH} />
    </svg>
  );
}

/** A provider's lettermark, as text so it is legible and selectable. */
export function ProviderBadge({ label }: { label: string }): ReactElement {
  return <span className="badge">{label}</span>;
}

/** A picture glyph for an image slot with nothing in it. */
export function ImagePlaceholder({ label }: { label: string }): ReactElement {
  const titleId = useId();
  return (
    <svg className="placeholder" viewBox="0 0 24 24" role="img" aria-labelledby={titleId}
      fill="none" stroke="currentColor" strokeWidth="1.5">
      <title id={titleId}>{label}</title>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-5-5-4 4-2-2-7 7" />
    </svg>
  );
}
```

Export all three from `packages/plugin-ui/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/plugin-ui/test/icons.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-ui/src/icons.tsx packages/plugin-ui/test/icons.test.tsx packages/plugin-ui/src/index.ts
git commit -m "Add the first inline icons: transport, provider marks, placeholder"
```

---

### Task 4: The gallery modal

**Files:**
- Create: `packages/plugin-ui/src/Gallery.tsx`
- Create: `packages/plugin-ui/test/Gallery.test.tsx`
- Modify: `packages/plugin-ui/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Gallery({ urls, caption, onClose }: { urls: readonly string[]; caption: string; onClose: () => void }): ReactElement | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-ui/test/Gallery.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Gallery } from '../src/Gallery.tsx';

afterEach(cleanup);

function noop(): void {}

test('the gallery shows its images under a caption that is a real heading', () => {
  // A real `<h2>`, with the dialog named through `aria-labelledby` rather
  // than a duplicated `aria-label`. `CLAUDE.md` records a dialog that
  // passed eight unit tests and two Playwright specs on an `aria-label`
  // while rendering as unstyled text nobody could use.
  render(<Gallery urls={['/api/artwork/poster/1']} caption="Blockers" onClose={noop} />);

  const dialog = screen.getByRole('dialog', { name: 'Blockers' });
  assert.ok(dialog, 'the dialog is named by its heading');
  assert.ok(screen.getByRole('heading', { name: 'Blockers' }), 'the caption is a visible heading');
  assert.equal(screen.getAllByRole('img').length, 1);
});

test('an image that fails to load leaves the gallery', () => {
  // A 404 is the normal case here, not an error: most items have a poster
  // and nothing else. `MediaItemCard` already drops its browse poster this
  // way.
  render(
    <Gallery urls={['/api/artwork/poster/1', '/api/artwork/logo/1']} caption="Blockers" onClose={noop} />,
  );
  assert.equal(screen.getAllByRole('img').length, 2);

  fireEvent.error(screen.getAllByRole('img')[1]!);

  assert.equal(screen.getAllByRole('img').length, 1);
});

test('a subject whose every image fails closes rather than showing an empty frame', async () => {
  // Review Focus 4. An empty modal with a caption and no picture reads as
  // a bug; there is nothing to look at, so there is nothing to open.
  let closed = false;
  render(
    <Gallery urls={['/api/artwork/poster/1']} caption="Blockers" onClose={() => { closed = true; }} />,
  );

  fireEvent.error(screen.getAllByRole('img')[0]!);

  await waitFor(() => {
    assert.ok(closed, 'the gallery asked to be closed');
  });
});

test('Escape closes the gallery', () => {
  let closed = false;
  render(<Gallery urls={['/api/artwork/poster/1']} caption="Blockers" onClose={() => { closed = true; }} />);

  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

  assert.ok(closed, 'Escape asked to close');
});

test('focus moves into the gallery when it opens', () => {
  render(<Gallery urls={['/api/artwork/poster/1']} caption="Blockers" onClose={noop} />);

  // Compared as a boolean, never `assert.equal(document.activeElement,
  // element)` -- handing two live nodes to `node:assert` formats both and
  // kills the run. `scripts/check-test-hygiene.ts` fails the build on it.
  assert.ok(
    screen.getByRole('dialog').contains(document.activeElement),
    'focus is inside the dialog',
  );
});

test('an empty url list renders nothing at all', () => {
  const { container } = render(<Gallery urls={[]} caption="Blockers" onClose={noop} />);
  assert.equal(container.innerHTML, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/plugin-ui/test/Gallery.test.tsx`
Expected: FAIL — cannot find `../src/Gallery.tsx`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugin-ui/src/Gallery.tsx`:

```tsx
/**
 * A modal over one subject's images -- a media item's, or one person's.
 *
 * **It holds fewer pictures than the name suggests, and that is known.**
 * The artwork job stores one poster, one background and one logo per media
 * item and one picture per person, so a media gallery is at most three
 * images and a person's is exactly one. Storing every image a provider
 * returns is issue #79; this component is built so that widening storage
 * needs no change here.
 *
 * **A 404 is ordinary.** Most items have a poster and neither of the other
 * two, so an image that fails to load is dropped rather than shown broken,
 * the same way `MediaItemCard` drops its browse poster. A subject whose
 * every image fails asks to be closed: an empty frame under a caption
 * reads as a bug, and there is nothing to look at.
 */
import type { ReactElement } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

export interface GalleryProps {
  readonly urls: readonly string[];
  /** The media item's title or the person's name, shown as the heading. */
  readonly caption: string;
  readonly onClose: () => void;
}

export function Gallery({ urls, caption, onClose }: GalleryProps): ReactElement | null {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<readonly string[]>([]);

  const showing = urls.filter((url) => !failed.includes(url));

  // Focus moves in on open so Escape and Tab reach the dialog rather than
  // the page behind it.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Every image failed: there is nothing to show. Asked for in an effect
  // rather than during render, because calling a parent's setter while
  // rendering is a React error.
  useEffect(() => {
    if (urls.length > 0 && showing.length === 0) onClose();
  }, [urls.length, showing.length, onClose]);

  if (urls.length === 0) return null;

  return (
    <div className="gallery-backdrop" onClick={onClose}>
      <div
        className="gallery"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
        // The backdrop closes on click; a click on the dialog itself must
        // not bubble up to it and close the thing being looked at.
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id={headingId}>{caption}</h2>
        {showing.map((url) => (
          <img
            key={url}
            src={url}
            alt={caption}
            onError={() => {
              setFailed((previous) => (previous.includes(url) ? previous : [...previous, url]));
            }}
          />
        ))}
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/plugin-ui/test/Gallery.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-ui/src/Gallery.tsx packages/plugin-ui/test/Gallery.test.tsx packages/plugin-ui/src/index.ts
git commit -m "Add the gallery modal, which drops images that 404"
```

---

### Task 5: The MediaDetails section

**Files:**
- Create: `packages/plugin-ui/src/MediaDetails.tsx`
- Create: `packages/plugin-ui/test/MediaDetails.test.tsx`
- Modify: `packages/plugin-ui/src/index.ts`

**Interfaces:**
- Consumes: `GatheredItemView`, `GatheredRoleView` (Task 1); `mediaLink`, `personLink`, `providerDisplayName`, `type ExternalLink` (Task 2); `DownloadTypeIcon`, `ProviderBadge`, `ImagePlaceholder` (Task 3); `Gallery` (Task 4).
- Produces: `MediaDetails({ item, gathered, extraLinks }: MediaDetailsProps): ReactElement`, where `MediaDetailsProps` is `{ readonly item: MediaItemSyncRead; readonly gathered: GatheredItemView; readonly extraLinks?: readonly ExternalLink[] }`.
- Produces: `topBilled(roles: readonly GatheredRoleView[], limit: number): readonly GatheredRoleView[]`.

- [ ] **Step 1: Write the failing test for the cast selection**

Create `packages/plugin-ui/test/MediaDetails.test.tsx` with the pure function's tests first:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MediaItemSyncRead, PersonSyncRead, RoleSyncRead } from '@pickarr/contract';
import { MediaDetails, topBilled } from '../src/MediaDetails.tsx';
import type { GatheredItemView, GatheredRoleView } from '../src/types.ts';

afterEach(cleanup);

function person(id: number, name: string): PersonSyncRead {
  return { id, name, providerRef: `tmdb:person:${String(id)}`, createdAt: 0, updatedAt: 0 };
}

function role(
  id: number,
  personId: number,
  billingOrder: number | null,
  who: PersonSyncRead | undefined,
): GatheredRoleView {
  const row: RoleSyncRead = {
    id, mediaItemId: 1, personId, role: 'actor', name: null, billingOrder, createdAt: 0,
  };
  return { id, row, person: who, imageUrl: `/api/artwork/person/${String(personId)}` };
}

function item(overrides: Partial<MediaItemSyncRead> = {}): MediaItemSyncRead {
  return {
    id: 1, pluginId: 'movie', createdAt: 0, updatedAt: 0,
    provider: 'tmdb', providerRef: 'tmdb:movie:335984',
    title: 'Blockers', releaseDate: '2018-04-06', description: 'Three parents.',
    ...overrides,
  };
}

function gathered(overrides: Partial<GatheredItemView> = {}): GatheredItemView {
  return {
    releases: [],
    roles: [],
    artwork: {
      poster: '/api/artwork/poster/1',
      background: '/api/artwork/background/1',
      logo: '/api/artwork/logo/1',
    },
    ...overrides,
  };
}

test('one person billed twice appears once', () => {
  // A person can hold several roles on one item -- actor and director, or
  // two characters. "Five people" is five distinct persons, not five rows.
  const alice = person(7, 'Alice');
  const picked = topBilled([role(1, 7, 0, alice), role(2, 7, 1, alice)], 5);

  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.row.personId, 7);
});

test('billing order decides, with nulls last and name breaking ties', () => {
  // Spelled as a literal expected order, not recomputed by sorting again.
  const picked = topBilled([
    role(1, 3, null, person(3, 'Unbilled')),
    role(2, 1, 2, person(1, 'Third')),
    role(3, 2, 0, person(2, 'First')),
    role(4, 4, 1, person(4, 'Second')),
  ], 5);

  assert.deepEqual(picked.map((r) => r.person?.name), ['First', 'Second', 'Third', 'Unbilled']);
});

test('the sixth person is left out', () => {
  const roles = [1, 2, 3, 4, 5, 6].map((n) => role(n, n, n, person(n, `P${String(n)}`)));
  assert.equal(topBilled(roles, 5).length, 5);
});

test('a role whose person has not replicated is skipped', () => {
  // Log order is not group order, so a role can land before its person.
  // A nameless face is worse than a shorter cast.
  const picked = topBilled([role(1, 9, 0, undefined), role(2, 7, 1, person(7, 'Alice'))], 5);

  assert.deepEqual(picked.map((r) => r.person?.name), ['Alice']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/plugin-ui/test/MediaDetails.test.tsx`
Expected: FAIL — cannot find `../src/MediaDetails.tsx`.

- [ ] **Step 3: Write `topBilled` and the component**

Create `packages/plugin-ui/src/MediaDetails.tsx`:

```tsx
/**
 * What a media item is, shown above its release list.
 *
 * Shared rather than written three times: all three plugins render the
 * same section, and the alternative is three copies that drift. This is
 * the second web-shaped component in this package after `CardHeading`,
 * for the same reason.
 *
 * Everything here comes from the replica -- `media_item`'s own columns and
 * the `roles` the gather resolves -- except the images, which are urls the
 * host serves because artwork is deliberately not replicated (#79).
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import { Gallery } from './Gallery.tsx';
import { DownloadTypeIcon, ImagePlaceholder, ProviderBadge } from './icons.tsx';
import { mediaLink, personLink, providerDisplayName, type ExternalLink } from './links.ts';
import type { GatheredItemView, GatheredRoleView } from './types.ts';

export interface MediaDetailsProps {
  readonly item: MediaItemSyncRead;
  readonly gathered: GatheredItemView;
  /**
   * Links this card's own plugin knows about and the shared component
   * cannot. `plugin-movie` passes IMDb from `movie_detail.imdb_id`; the
   * other two pass nothing, having no such identity.
   */
  readonly extraLinks?: readonly ExternalLink[];
}

/**
 * The distinct people to show, most prominently billed first.
 *
 * **Distinct people, not roles.** One person can hold several roles on an
 * item, and five rows could be two people. De-duplicated on `personId`,
 * keeping the best-billed of that person's rows.
 *
 * `billingOrder` ascending with nulls last, then by name so the order is
 * total -- two runs over the same data must agree, and a provider that
 * leaves billing null for a whole cast would otherwise render in replica
 * order, which is arrival order.
 *
 * A role whose `person` has not replicated yet is dropped: it has no name
 * to show, and a nameless face is worse than a shorter cast.
 */
export function topBilled(roles: readonly GatheredRoleView[], limit: number): readonly GatheredRoleView[] {
  const best = new Map<number, GatheredRoleView>();
  for (const role of roles) {
    if (role.person === undefined) continue;
    const held = best.get(role.row.personId);
    if (held === undefined || rank(role) < rank(held)) best.set(role.row.personId, role);
  }
  return [...best.values()]
    .toSorted((a, b) => {
      const byBilling = rank(a) - rank(b);
      if (byBilling !== 0) return byBilling;
      return (a.person?.name ?? '').localeCompare(b.person?.name ?? '');
    })
    .slice(0, limit);
}

/** Nulls sort last, which `Number.MAX_SAFE_INTEGER` expresses without a branch at every comparison. */
function rank(role: GatheredRoleView): number {
  return role.row.billingOrder ?? Number.MAX_SAFE_INTEGER;
}

/** How many of the cast the section shows. */
const CAST_LIMIT = 5;

/** What the gallery is currently open over, or `undefined` for closed. */
interface OpenGallery {
  readonly urls: readonly string[];
  readonly caption: string;
}

export function MediaDetails({ item, gathered, extraLinks = [] }: MediaDetailsProps): ReactElement {
  const [open, setOpen] = useState<OpenGallery | undefined>(undefined);
  const [posterFailed, setPosterFailed] = useState(false);

  const cast = topBilled(gathered.roles, CAST_LIMIT);
  const own = mediaLink(item.provider, item.providerRef);
  const links = own === undefined ? extraLinks : [own, ...extraLinks];
  const transports = [...new Set(gathered.releases.map((release) => release.row.downloadType))].toSorted();
  const attribution = item.provider === null ? undefined : providerDisplayName(item.provider);

  return (
    <section className="details">
      <div className="details-head">
        <button
          type="button"
          className="poster"
          onClick={() => {
            setOpen({
              urls: [gathered.artwork.poster, gathered.artwork.background, gathered.artwork.logo],
              caption: item.title,
            });
          }}
        >
          {posterFailed ? (
            <ImagePlaceholder label={`No poster for ${item.title}`} />
          ) : (
            <img
              src={gathered.artwork.poster}
              alt={item.title}
              onError={() => {
                setPosterFailed(true);
              }}
            />
          )}
        </button>

        <div className="details-body">
          <p className="icon-row">
            {transports.map((type) => <DownloadTypeIcon key={type} type={type} />)}
            {links.map((link) => (
              <a key={link.href} href={link.href} target="_blank" rel="noreferrer noopener">
                <ProviderBadge label={link.label} />
              </a>
            ))}
          </p>
          {item.description !== null && <p className="description">{item.description}</p>}
        </div>
      </div>

      {cast.length > 0 && (
        <ul className="cast">
          {cast.map((role) => (
            <CastMember
              key={role.row.personId}
              role={role}
              provider={item.provider}
              onOpen={setOpen}
            />
          ))}
        </ul>
      )}

      <p className="details-foot">
        {item.releaseDate !== null && <span>Release Date: {item.releaseDate}</span>}
        {attribution !== undefined && <small>data provided by {attribution}</small>}
      </p>

      {open !== undefined && (
        <Gallery
          urls={open.urls}
          caption={open.caption}
          onClose={() => {
            setOpen(undefined);
          }}
        />
      )}
    </section>
  );
}

/**
 * One person: their picture, and their name linked to the provider's own
 * page for them.
 *
 * Its own component because it holds per-person state -- whether that
 * picture failed -- which a `map` in the parent cannot.
 */
function CastMember({
  role, provider, onOpen,
}: {
  role: GatheredRoleView;
  provider: string | null;
  onOpen: (gallery: OpenGallery) => void;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const name = role.person?.name ?? '';
  const href = role.person === undefined ? undefined : personLink(provider, role.person.providerRef);

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onOpen({ urls: [role.imageUrl], caption: name });
        }}
      >
        {failed ? (
          <ImagePlaceholder label={`No picture of ${name}`} />
        ) : (
          <img
            src={role.imageUrl}
            alt={name}
            onError={() => {
              setFailed(true);
            }}
          />
        )}
      </button>
      {href === undefined
        ? <span>{name}</span>
        : <a href={href} target="_blank" rel="noreferrer noopener">{name}</a>}
    </li>
  );
}
```

Export `MediaDetails`, `topBilled` and `type MediaDetailsProps` from `packages/plugin-ui/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/plugin-ui/test/MediaDetails.test.tsx`
Expected: PASS

- [ ] **Step 5: Add the rendering tests, including the Review Focus cases**

Append to `packages/plugin-ui/test/MediaDetails.test.tsx`:

```tsx
test('an unclaimed item renders no provider icon and no attribution', () => {
  // Review Focus 1. `provider` and `providerRef` are null together until a
  // lookup claims the item. `data provided by null` is the failure.
  render(
    <MediaDetails item={item({ provider: null, providerRef: null })} gathered={gathered()} />,
  );

  assert.ok(!screen.queryByText('TMDb'), 'no provider badge');
  assert.ok(!screen.queryByText(/data provided by/), 'no attribution line');
});

test('a null release date and a null description render nothing rather than the word null', () => {
  // Review Focus 2.
  render(
    <MediaDetails item={item({ releaseDate: null, description: null })} gathered={gathered()} />,
  );

  assert.ok(!screen.queryByText(/Release Date/), 'no release-date line');
  assert.ok(!screen.queryByText(/null/), 'the word null appears nowhere');
});

test('the attribution names the provider in full', () => {
  render(<MediaDetails item={item()} gathered={gathered()} />);

  assert.ok(screen.getByText('data provided by The Movie Database'), 'the full name is shown');
  assert.ok(screen.getByText('Release Date: 2018-04-06'), 'the release date is shown');
});

test('a person whose picture fails keeps their name and gets the placeholder', () => {
  // Review Focus 3. Most people have no picture -- the person artwork
  // route 404s for all but a few -- so this is the common path, not an
  // edge case.
  const alice = person(7, 'Alice');
  render(
    <MediaDetails item={item()} gathered={gathered({ roles: [role(1, 7, 0, alice)] })} />,
  );

  fireEvent.error(screen.getByAltText('Alice'));

  assert.ok(screen.getByText('Alice'), 'the name survives');
  assert.ok(screen.getByRole('img', { name: 'No picture of Alice' }), 'the placeholder is shown');
});

test('a person’s name links to their page on the provider', () => {
  const alice = person(30614, 'Alice');
  render(<MediaDetails item={item()} gathered={gathered({ roles: [role(1, 30614, 0, alice)] })} />);

  const link = screen.getByRole('link', { name: 'Alice' });
  assert.equal(link.getAttribute('href'), 'https://www.themoviedb.org/person/30614');
  // A new tab, and never a tab that can reach back into this one.
  assert.equal(link.getAttribute('rel'), 'noreferrer noopener');
});

test('clicking the poster opens the gallery captioned with the title', () => {
  render(<MediaDetails item={item()} gathered={gathered()} />);

  fireEvent.click(screen.getByRole('button', { name: 'Blockers' }));

  assert.ok(screen.getByRole('dialog', { name: 'Blockers' }), 'the gallery opened');
});

test('clicking a person’s picture opens the gallery captioned with their name', () => {
  const alice = person(7, 'Alice');
  render(<MediaDetails item={item()} gathered={gathered({ roles: [role(1, 7, 0, alice)] })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Alice' }));

  assert.ok(screen.getByRole('dialog', { name: 'Alice' }), 'the gallery opened for the person');
});

test('one icon per distinct transport, not one per release', () => {
  // `download_type` is an `rss_item` column, so an item really can hold
  // both an nzb and a torrent; a single icon would have to lie about one.
  const release = (id: number, downloadType: string) => ({
    id,
    row: {
      id, feedId: 1, filename: `f${String(id)}.mkv`, createdAt: 0, updatedAt: 0,
      downloadType, mediaItemId: 1, rankingScore: null, resolution: '1080p',
      resolutionDetail: null, lookupJson: null, deliveredAt: null,
    },
    downloads: [],
  });
  render(
    <MediaDetails
      item={item()}
      gathered={gathered({ releases: [release(1, 'torrent'), release(2, 'torrent'), release(3, 'nzb')] })}
    />,
  );

  assert.ok(screen.getByRole('img', { name: 'torrent' }), 'torrent shown once');
  assert.ok(screen.getByRole('img', { name: 'nzb' }), 'nzb shown');
  assert.equal(screen.getAllByRole('img', { name: 'torrent' }).length, 1, 'not once per release');
});
```

If `RssItemSyncRead` requires fields beyond those listed, add them from `packages/contract/src/sync.ts` rather than casting.

- [ ] **Step 6: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/plugin-ui/test/MediaDetails.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-ui/src/MediaDetails.tsx packages/plugin-ui/test/MediaDetails.test.tsx packages/plugin-ui/src/index.ts
git commit -m "Add the shared media detail section"
```

---

### Task 6: Style it and render it from all three cards

**Files:**
- Modify: `packages/web/src/styles/library.css`
- Modify: `packages/plugin-movie/src/browser.tsx`
- Modify: `packages/plugin-tv/src/browser.tsx`
- Modify: `packages/plugin-xxx/src/browser.tsx`

**Interfaces:**
- Consumes: `MediaDetails` (Task 5).
- Produces: nothing later tasks import.

- [ ] **Step 1: Render the section from each card**

In each of the three `browser.tsx` files, import `MediaDetails` from `@pickarr/plugin-ui` alongside the existing imports and change the expanded branch. For `plugin-movie`:

```tsx
      {expanded && gathered !== undefined && (
        <>
          <MediaDetails item={item} gathered={gathered} />
          <ReleaseList releases={gathered.releases} submit={submit} />
        </>
      )}
```

Do the same in `plugin-tv` and `plugin-xxx`, keeping each card's existing `CardHeading` line untouched.

- [ ] **Step 2: Add the styles**

Append to `packages/web/src/styles/library.css`. **Do not write `*/` inside a comment's example text** — a star followed by a slash closes the comment, and this has broken the build in this repo before. Note also that `npm run check` parses no CSS, so a broken rule is caught only by reading the built bundle.

```css
/* The expanded card's detail section: poster beside a body, then cast, then a footer line. */
.details { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem 0; }
.details-head { display: flex; gap: 1rem; align-items: flex-start; }
.details-body { flex: 1; min-width: 0; }

.details .poster { padding: 0; border: none; background: none; cursor: pointer; flex-shrink: 0; }
.details .poster img,
.details .poster .placeholder { width: 120px; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 4px; }
.details .poster .placeholder { color: var(--color-text-dim); background: var(--color-surface-2); padding: 1.5rem; }

.icon-row { display: flex; align-items: center; gap: 0.5rem; margin: 0 0 0.5rem; }
.icon-row .icon { width: 1.1rem; height: 1.1rem; color: var(--color-text-dim); }
.icon-row .badge {
  font-size: 0.75rem; padding: 0.1rem 0.35rem; border-radius: 3px;
  border: 1px solid var(--color-text-dim); color: var(--color-text-dim);
}
.icon-row a { text-decoration: none; }

.description { margin: 0; }

.cast { display: flex; gap: 0.75rem; list-style: none; margin: 0; padding: 0; }
.cast li { width: 72px; text-align: center; font-size: 0.75rem; }
.cast button { padding: 0; border: none; background: none; cursor: pointer; display: block; width: 100%; }
.cast img,
.cast .placeholder { width: 72px; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 4px; }
.cast .placeholder { color: var(--color-text-dim); background: var(--color-surface-2); padding: 1rem; }

.details-foot { display: flex; justify-content: space-between; align-items: baseline; margin: 0; }
.details-foot small { color: var(--color-text-dim); }

/* The gallery: a real overlay, because a dialog that is merely in the
   accessibility tree renders as an unstyled block of text -- see the
   IdentityChangeConfirm entry in CLAUDE.md. */
.gallery-backdrop {
  position: fixed; inset: 0; z-index: 10;
  display: flex; align-items: center; justify-content: center;
  background: rgb(0 0 0 / 70%);
}
.gallery {
  display: flex; flex-direction: column; gap: 0.75rem; align-items: center;
  max-width: 90vw; max-height: 90vh; overflow: auto;
  padding: 1rem; border-radius: 6px;
  background: var(--color-surface); color: var(--color-text);
}
.gallery h2 { margin: 0; font-size: 1rem; }
.gallery img { max-width: 80vw; max-height: 70vh; object-fit: contain; }
```

Every custom property used above is already defined in this stylesheet's palette — `--color-surface`, `--color-surface-2`, `--color-text`, `--color-text-dim` — so none is being invented here.

- [ ] **Step 3: Verify the CSS actually reached the bundle**

Run: `npm run build > /tmp/build.log 2>&1; echo $?`
Expected: `0`

Run: `grep -c "gallery-backdrop" packages/web/dist/assets/*.css`
Expected: at least `1`. A zero here means a comment closed early and swallowed the rules — the failure mode this step exists to catch, since nothing in `npm run check` parses CSS.

- [ ] **Step 4: Run the web tests**

Run: `npm run test:web > /tmp/web.log 2>&1; echo $?; tail -5 /tmp/web.log`
Expected: `0`, all passing. Existing card tests that assert on the expanded body may now find extra content; fix them by making the query specific, never by removing the assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/styles/library.css packages/plugin-movie/src/browser.tsx packages/plugin-tv/src/browser.tsx packages/plugin-xxx/src/browser.tsx
git commit -m "Render the detail section from all three cards, and style it"
```

---

### Task 7: The movie plugin's IMDb link

**Files:**
- Modify: `packages/plugin-movie/src/sync.ts`
- Modify: `packages/plugin-movie/src/browser.tsx`
- Modify: `packages/contract/src/sync.ts` (or wherever `MovieRead` is declared — check `packages/plugin-movie/src/sync.ts`'s import)
- Test: `packages/plugin-movie/test/sync.test.ts`
- Test: `packages/plugin-movie/test/browser.test.tsx`

**Interfaces:**
- Consumes: `MediaDetails`, `type ExternalLink`.
- Produces: `MovieRead` gains `readonly imdbId: string | null`.

- [ ] **Step 1: Write the failing projection test**

Add to `packages/plugin-movie/test/sync.test.ts`, following the file's existing seeding helper:

```ts
test('the projection carries imdb_id, which the card links to', () => {
  // The column already exists and `apply.ts` already fills it from the
  // lookup service's `details.imdbId`; it was simply never projected, so
  // the browser could not see an id that was on disk all along.
  const raw = seededDbWithMovie({ imdbId: 'tt15239678' });

  const rows = detail.read(raw, [1]);

  assert.equal(rows[1]?.imdbId, 'tt15239678');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --conditions development --test packages/plugin-movie/test/sync.test.ts`
Expected: FAIL — `imdbId` is `undefined`.

- [ ] **Step 3: Add it to the projection**

In `packages/plugin-movie/src/sync.ts`, add `imdb_id` to the SELECT and the mapping:

```ts
      `SELECT id, media_item_id, runtime_minutes, imdb_id, tagline FROM movie_detail WHERE id IN (${holes(ids)})`,
```

```ts
        imdbId: asTextOrNull(row.imdb_id),
```

and add to `MovieRead`:

```ts
  /** IMDb's `tt…` id, for the card's external link. Null for a film the service gave none for. */
  imdbId: string | null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --conditions development --test packages/plugin-movie/test/sync.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing card test**

Add to `packages/plugin-movie/test/browser.test.tsx`, which already exists — follow its existing render helper rather than writing a second one:

```tsx
test('a film with an imdb id links to IMDb, and one without shows no IMDb badge', () => {
  renderMovieCardExpanded({ imdbId: 'tt15239678' });
  const link = screen.getByRole('link', { name: 'IMDb' });
  assert.equal(link.getAttribute('href'), 'https://www.imdb.com/title/tt15239678/');

  cleanup();

  renderMovieCardExpanded({ imdbId: null });
  assert.ok(!screen.queryByText('IMDb'), 'no badge without an id');
});
```

Write `renderMovieCardExpanded` in that file to render `movieBrowser.Card` with a `gathered` whose `roles` and `artwork` are present, and `rows` carrying the `movie_detail` row.

- [ ] **Step 6: Declare the table and pass the link**

In `packages/plugin-movie/src/browser.tsx`, change `tables: []` to `tables: ['movie_detail']`, and build the link from the row:

```tsx
  // IMDb is this plugin's to supply: `imdb_id` is a `movie_detail` column,
  // and `MediaDetails` is shared by three plugins, two of which have no
  // IMDb identity at all.
  const imdbId = movieRowFrom(rows)?.imdbId ?? null;
  const extraLinks = imdbId === null
    ? []
    : [{ label: 'IMDb', href: `https://www.imdb.com/title/${imdbId}/` }];
```

and pass `extraLinks={extraLinks}` to `MediaDetails`.

`PluginRows` is `Readonly<Record<string, readonly unknown[]>>` — the rows
are `unknown`, and `plugin.ts`'s own docblock requires narrowing with `in`
guards rather than asserting, because a row written by one client build is
read against the next build's contract. So `movieRowFrom` narrows:

```tsx
/**
 * This item's `movie_detail` row, or `undefined`.
 *
 * Narrowed rather than asserted: `PluginRows` holds `unknown`, and the
 * replica outlives the build that wrote it -- a row from an older client
 * may not carry `imdbId` at all. A row that does not match is declined,
 * which costs an IMDb badge rather than throwing inside a card.
 */
function movieRowFrom(rows: PluginRows): { readonly imdbId: string | null } | undefined {
  const row = rows['movie_detail']?.[0];
  if (typeof row !== 'object' || row === null || !('imdbId' in row)) return undefined;
  const { imdbId } = row;
  if (imdbId !== null && typeof imdbId !== 'string') return undefined;
  return { imdbId };
}
```

Import `type PluginRows` from `@pickarr/plugin-ui` alongside the existing imports.

- [ ] **Step 7: Run the tests**

Run: `npm run test:web > /tmp/web.log 2>&1; echo $?; tail -5 /tmp/web.log`
Expected: `0`

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-movie packages/contract/src/sync.ts
git commit -m "Link a film to IMDb from the id movie_detail already held"
```

---

### Task 8: Browser spec for the rendered section

**Files:**
- Modify: `packages/e2e/tests/` — add to the browse spec that already expands a card, or create `media-details.spec.ts` following its nearest neighbour.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the spec**

`getByRole` cannot see whether a component is legible — `CLAUDE.md`'s `IdentityChangeConfirm` entry is the scar. This measures geometry.

```ts
test('the expanded card shows a styled detail section above the releases', async ({ page }) => {
  // …seed a media item with a release and expand its card, following the
  // existing browse spec's helpers…

  const details = page.locator('article section.details');
  await expect(details).toBeVisible({ timeout: 15_000 });

  // The section sits above the release list, which is the placement asked
  // for and the one a DOM-order assertion alone would not prove.
  const detailsBox = await details.boundingBox();
  const releasesBox = await page.locator('article ul[aria-label="releases"]').first().boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(releasesBox).not.toBeNull();
  expect(detailsBox!.y + detailsBox!.height).toBeLessThanOrEqual(releasesBox!.y + 1);

  // The poster slot has real size -- an unstyled `<button>` around a
  // failed image collapses to a few pixels, which every role-based query
  // would still pass.
  const poster = page.locator('article section.details .poster');
  const posterBox = await poster.boundingBox();
  expect(posterBox).not.toBeNull();
  expect(posterBox!.width).toBeGreaterThan(80);
  expect(posterBox!.height).toBeGreaterThan(120);
});

test('the gallery opens as an overlay covering the viewport', async ({ page }) => {
  // …expand a card as above…
  await page.locator('article section.details .poster').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  // A dialog that is merely in the accessibility tree renders inline as a
  // block of text. The backdrop covering the viewport is what distinguishes
  // an overlay from that, and `toBeVisible()` does not.
  const backdrop = page.locator('.gallery-backdrop');
  const backdropBox = await backdrop.boundingBox();
  const viewport = page.viewportSize();
  expect(backdropBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(backdropBox!.width).toBeGreaterThanOrEqual(viewport!.width - 1);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
```

The releases selector is `ul[aria-label="releases"]` — verified against `packages/plugin-ui/src/ReleaseList.tsx:283`, which renders `<ul aria-label="releases">` and no class.

- [ ] **Step 2: Check the step-timeout budget**

Each `test(...)` block's declared step timeouts must sum to less than `playwright.config.ts`'s `timeout`. Two 15s waits in one test is 30s against a 90s budget, which is fine; if you add more, `scripts/check-e2e-timeout-budget.test.ts` fails the build.

Run: `node --import tsx --conditions development --test scripts/check-e2e-timeout-budget.test.ts`
Expected: PASS

- [ ] **Step 3: Run the suite**

Run: `npm run e2e > /tmp/e2e.log 2>&1; echo $?; grep -E "passed|failed" /tmp/e2e.log | tail -3`
Expected: `0`, all specs passing. **Redirect, never pipe** — piping into `tail` SIGPIPEs the run and reports a false failure.

- [ ] **Step 4: Commit**

```bash
git add packages/e2e
git commit -m "Pin that the detail section and gallery render as more than an accessibility tree"
```

---

### Task 9: Full gate

- [ ] **Step 1: Run everything**

```bash
npm run build > /tmp/build.log 2>&1; echo "build=$?"
npm run check > /tmp/check.log 2>&1; echo "check=$?"
npm run e2e   > /tmp/e2e.log   2>&1; echo "e2e=$?"
```

Expected: all three `0`.

- [ ] **Step 2: Mutation-test the two pure functions**

Both are pure and both decide something a person sees. Revert each change afterwards.

| Mutant | Expected |
|---|---|
| `topBilled` returns `roles.slice(0, limit)` (no de-dup, no sort) | the de-dup and ordering tests fail |
| `rank` returns `0` for nulls instead of `MAX_SAFE_INTEGER` | the nulls-last test fails |
| `providerRefId` returns `providerRef` unchanged | the media-link and person-link tests fail |
| `mediaLink`'s tvdb arm returns `https://thetvdb.com/series/${id}` | the media-link test fails |

A mutant that no test catches means the test is missing, not that the mutant is uninteresting — add it in the owning task's file.

- [ ] **Step 3: Commit anything the gate changed**

```bash
git add -A
git commit -m "Gate the media detail section"
```
