# OpenMetadata Media Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three media plugins — tv, movie, xxx — that turn the filenames a feed poll delivered into identified `media_item` rows by asking `POST https://openmetadata.nexus/api/v1/lookup`.

**Architecture:** One library, `@pickarr/openmetadata`, owns the typed client, the per-plugin state table, and the whole lookup→poll→apply state machine as a factory: `createLookupPlugin(spec, deps)` returns a complete `MediaPlugin`. Each plugin package is a spec — id, media type, wire category, its own migrations, one `apply` function — plus its own tables. The flow exists once; only what a resolved answer *means* is split three ways.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`), Node 24+, `node:sqlite`, `drizzle-orm` 1.0.0-rc.4, `node:test` + `node:assert/strict`, esbuild, oxlint, tsgo.

**Spec:** `docs/superpowers/specs/2026-09-11-openmetadata-plugins-design.md`

## Global Constraints

- **Never the `any` type**, and no casts that stand in for one. `.oxlintrc.json` sets `typescript/no-explicit-any: "error"`.
- **2-space indent, semicolons, single quotes**, matching every file in `packages/`.
- **Import with explicit `.ts` extensions** (`allowImportingTsExtensions`), and `import type` for type-only imports (`verbatimModuleSyntax`).
- **`@pickarr/openmetadata` and the three plugin packages must not import from `@pickarr/host`** — production code or tests. They depend on `@pickarr/contract`, `drizzle-orm` and `node:sqlite` only. This is the rule `packages/host/test/double/plugin.ts` documents: a plugin that reached into the host's own modules would prove the host composes with itself rather than that the contract is sufficient.
- **The API key is a credential.** Used only as an `Authorization` header. Never logged, never written to a table, never put in a job payload, never an operand of a `node:assert` call. Tests use the literal fake key `'test-key'`.
- **The plugin id is the table prefix.** `migratePlugin` (`packages/host/src/db/migrate.ts:864`) diffs `sqlite_master` after each migration and throws on any table not starting with `<pluginId>_`.
- **Plugin ids and categories:** `tv`/`tv`, `movie`/`movies`, `xxx`/`xxx` (id / wire category). The singular `movie` is the contract's `MediaType`; the plural `movies` is the wire category.
- **Verification per task:** `npm run lint && npm run typecheck && npm run test:server` must pass before each commit. The full `npm run check` and `npm run build` run in Task 13.
- **Commit style:** a sentence saying what the commit does, no `feat:`/`fix:` prefixes — matching `git log`.

---

## File Structure

**Created — `packages/openmetadata/` (`@pickarr/openmetadata`)**

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Wire types mirroring the OpenAPI schemas; `SecretResolver`; the lookup-category union. |
| `src/validate.ts` | Narrowing functions: `unknown` → wire types, throwing `TypeError` naming the bad field. |
| `src/client.ts` | `createLookupClient` — batch POST with 100-name chunking, poll GET, bearer auth. |
| `src/table.ts` | `lookupTableMigration(pluginId)` and `lookupTable(pluginId)` — the shared state table, generated per prefix. |
| `src/engine.ts` | `createLookupPlugin(spec, deps)`: `onNewRssItems`, the `lookup` and `poll` handlers, the branch, the resolved path. |
| `src/index.ts` | Public exports. |
| `src/testing.ts` | `createFakeLookupService`, `createRecordingMedia` — the `./testing` subpath, used by all three plugin packages and the host flow test. |
| `test/validate.test.ts` | Validation: every malformed field named. |
| `test/client.test.ts` | Chunking, auth header, poll url, response shape. |
| `test/table.test.ts` | Generated DDL, prefix, unique index. |
| `test/engine-branch.test.ts` | The four non-resolved outcomes. |
| `test/engine-resolved.test.ts` | The resolved path, people, the dedup race. |
| `test/engine-jobs.test.ts` | `onNewRssItems`, chunk→job mapping, the poll ceiling. |
| `test/testing.test.ts` | The fake answers in request order, with no echoed name. |

**Created — three plugin packages**, each with `src/index.ts` (the factory and its spec), `src/migrations.ts` (its own DDL), `src/apply.ts` (what a resolved answer means), and `test/apply.test.ts`: `packages/plugin-tv/`, `packages/plugin-movie/`, `packages/plugin-xxx/`. The DDL needs no test of its own — each `apply.test.ts` runs the migrations to get its tables, so a broken one fails there, and the prefix rule is asserted against the real `migratePlugin` in Task 12.

**Created — host**

| File | Responsibility |
| --- | --- |
| `packages/host/src/secrets.ts` | `ResolveSecret` type and the env-backed stub. |
| `packages/host/test/secrets.test.ts` | The stub resolves, and names the variable when unset. |
| `packages/host/test/plugins/flow.test.ts` | All three real plugins against the real host and the fake service. |

**Modified**

| File | Change |
| --- | --- |
| `packages/host/src/main.ts:131` | `SHIPPED_PLUGINS` const → `shippedPlugins(deps)`; add `resolveOpenmetadataUrl`; build the three plugins in `main`. |
| `package.json` | `build` script gains the four packages, dependency order. |
| `packages/host/package.json` | `dependencies` gain the three plugin packages. |
| `docs/superpowers/specs/2026-09-11-openmetadata-plugins-design.md` | §4.2 amended with the probe's findings (Task 1). |

---

### Task 1: Probe the live API and amend the spec

The spec documents `details` keys for `scene` and `movie` only; an episode's are unknown (§4.2). One real request per category settles it before any table is written. **This task needs Chad's API key and is the only task that touches the network.**

**Files:**
- Modify: `docs/superpowers/specs/2026-09-11-openmetadata-plugins-design.md` (§4.2)

**Interfaces:**
- Consumes: nothing.
- Produces: the observed `details` keys per `kind`, recorded in the spec — Tasks 10–12 read them from there.

- [ ] **Step 1: Ask Chad to export the key into this shell**

Ask him to run, in this session:

```
! export PICKARR_OPENMETADATA_KEY='...'
```

Do not echo, cat, or print the variable. If he declines or the key is unavailable, stop and report: Tasks 2–9 do not depend on this one, but Task 10 does.

- [ ] **Step 2: Probe one name per category, writing only the keys to stdout**

```bash
probe() {
  curl -sS -X POST https://openmetadata.nexus/api/v1/lookup \
    -H "Authorization: Bearer $PICKARR_OPENMETADATA_KEY" \
    -H 'content-type: application/json' \
    -d "{\"category\":\"$1\",\"name\":\"$2\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s);console.log(process.argv[1],"| state:",e.state,"partial:",e.partial,"kind:",e.media?.kind,"| details:",JSON.stringify(e.media?.details),"| parents:",JSON.stringify((e.media?.parents??[]).map(p=>({kind:p.kind,title:p.title}))));})' "$1"
}
probe tv 'The.Bear.S03E01.1080p.WEB-DL.x264-GROUP.mkv'
probe movies 'Dune.Part.Two.2024.2160p.UHD.BluRay.x265-GROUP.mkv'
probe xxx 'Site.Name.24.01.15.Performer.Name.XXX.1080p.mp4'
```

Expected: three lines naming `state`, `kind`, the `details` object's keys and the parents' kinds. A 401 means the key is wrong; a 429 means wait and retry once.

- [ ] **Step 3: Record the findings in the spec**

Replace §4.2's closing paragraph ("Implementation begins with one real request…") with the observed keys — one line per `kind`, naming each key and its JSON type, and a sentence saying which of the documented `scene`/`movie` keys were confirmed. If an episode carries no season or episode number at all, say so explicitly: Task 10 then writes `NULL` into `tv_release.episode_number` and the number has to come from elsewhere in a later slice.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-11-openmetadata-plugins-design.md
git commit -m "Record what the lookup service actually answers for each category, since the document specifies details keys for only two of them"
```

---

### Task 2: The package, the wire types, and validation

**Files:**
- Create: `packages/openmetadata/package.json`, `packages/openmetadata/tsconfig.json`, `packages/openmetadata/src/types.ts`, `packages/openmetadata/src/validate.ts`, `packages/openmetadata/src/index.ts`
- Test: `packages/openmetadata/test/validate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LookupCategory`, `LookupState`, `MediaKind`, `MediaParent`, `MediaPerson`, `Media`, `MediaSuggestions`, `LookupEnvelope`, `LookupBatchResponse`, `SecretResolver`, `DetailValue`; `readEnvelope(value: unknown): LookupEnvelope`, `readBatchResponse(value: unknown): LookupBatchResponse`.

- [ ] **Step 1: Create the package files**

`packages/openmetadata/package.json` — note the two entry points; `./testing` is Task 4's file, declared now so the exports map is written once:

```json
{
  "name": "@pickarr/openmetadata",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./testing": {
      "development": "./src/testing.ts",
      "types": "./dist/testing.d.ts",
      "default": "./dist/testing.js"
    }
  },
  "scripts": {
    "build": "esbuild src/index.ts src/testing.ts --bundle --platform=node --format=esm --packages=external --outdir=dist",
    "typecheck": "tsgo --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@pickarr/contract": "*"
  }
}
```

`packages/openmetadata/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

Then `npm install` once from the repo root so the workspace link exists.

- [ ] **Step 2: Write the failing validation test**

`packages/openmetadata/test/validate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBatchResponse, readEnvelope } from '../src/validate.ts';

/** The smallest envelope the service can answer with: unresolved, nothing filled in. */
function unresolved(): Record<string, unknown> {
  return {
    lookupId: '11111111-1111-1111-1111-111111111111',
    state: 'unresolved',
    partial: false,
    cached: false,
    confidence: null,
    refusal: null,
    parsed: null,
    media: null,
    suggestions: null,
  };
}

function resolved(): Record<string, unknown> {
  return {
    ...unresolved(),
    state: 'resolved',
    confidence: 0.91,
    media: {
      id: '22222222-2222-2222-2222-222222222222',
      kind: 'movie',
      title: 'Dune: Part Two',
      releaseDate: '2024-03-01',
      year: 2024,
      provider: 'tmdb',
      providerRef: 'tmdb:movie:693134',
      overview: 'Paul unites with the Fremen.',
      details: { runtimeMinutes: 166, imdbId: 'tt15239678', tagline: null, collectionName: 'Dune' },
      parents: [],
      people: [{
        providerRef: 'tmdb:person:1',
        name: 'Timothée Chalamet',
        role: 'cast',
        characterName: 'Paul Atreides',
        billingOrder: 0,
      }],
    },
  };
}

test('reads a minimal unresolved envelope', () => {
  const envelope = readEnvelope(unresolved());
  assert.equal(envelope.state, 'unresolved');
  assert.equal(envelope.media, null);
  assert.equal(envelope.suggestions, null);
});

test('reads a resolved envelope, keeping every details key', () => {
  const envelope = readEnvelope(resolved());
  assert.equal(envelope.media?.kind, 'movie');
  assert.equal(envelope.media?.providerRef, 'tmdb:movie:693134');
  assert.deepEqual(envelope.media?.details, {
    runtimeMinutes: 166,
    imdbId: 'tt15239678',
    tagline: null,
    collectionName: 'Dune',
  });
  assert.equal(envelope.media?.people[0]?.role, 'cast');
});

test('keeps a details key the document never mentions', () => {
  const body = resolved();
  const media = body['media'];
  assert.ok(media !== null && typeof media === 'object');
  Object.assign(media, { details: { runtimeMinutes: 166, somethingNew: 'kept' } });
  assert.equal(readEnvelope(body).media?.details['somethingNew'], 'kept');
});

test('names the field that is wrong', () => {
  assert.throws(() => readEnvelope({ ...unresolved(), state: 'maybe' }), /state/);
  assert.throws(() => readEnvelope({ ...unresolved(), partial: 'no' }), /partial/);
  assert.throws(() => readEnvelope({ ...unresolved(), confidence: 'high' }), /confidence/);
  assert.throws(() => readEnvelope(null), /envelope/);
});

test('rejects a details value that is neither string, number nor null', () => {
  const body = resolved();
  const media = body['media'];
  assert.ok(media !== null && typeof media === 'object');
  Object.assign(media, { details: { nested: { no: true } } });
  assert.throws(() => readEnvelope(body), /details/);
});

test('reads a batch response and keeps each entry status', () => {
  const body = readBatchResponse({ results: [{ ...unresolved(), status: 200 }] });
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0]?.status, 200);
});

test('rejects a batch response whose results are not an array', () => {
  assert.throws(() => readBatchResponse({ results: {} }), /results/);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/validate.test.ts`
Expected: FAIL — cannot resolve `../src/validate.ts`.

- [ ] **Step 4: Write `src/types.ts`**

```ts
/**
 * The lookup API's wire shapes, mirrored from `openmetadata.json` (OpenAPI
 * 3.1) rather than inferred from a response. Where the document says a field
 * is required, it is required here; where it says `type: [x, "null"]`, it is
 * nullable here. Nothing is optional: the document marks every field of every
 * schema below as required, so an absent one is a service that changed and
 * `validate.ts` is where that is caught.
 */

/** `POST /api/v1/lookup`'s `category`. Note `movies`, plural, against the contract's `movie`. */
export type LookupCategory = 'tv' | 'movies' | 'books' | 'xxx';

export type LookupState = 'resolved' | 'unresolved' | 'pending';

export type MediaKind = 'movie' | 'series' | 'season' | 'episode' | 'book' | 'scene';

/** What `details` may hold: the document's `additionalProperties` is exactly this union. */
export type DetailValue = string | number | null;

/** An ancestor of a media record: the same fields as `Media` minus the four it does not carry. */
export interface MediaParent {
  readonly id: string;
  readonly kind: MediaKind;
  readonly title: string;
  /** ISO date, provider-supplied. */
  readonly releaseDate: string | null;
  readonly year: number | null;
  readonly provider: string;
  readonly providerRef: string;
}

export interface MediaPerson {
  readonly providerRef: string;
  readonly name: string;
  /** The service's own vocabulary -- `cast`, `director`, and whatever else it sends. */
  readonly role: string;
  readonly characterName: string | null;
  readonly billingOrder: number | null;
}

export interface Media extends MediaParent {
  readonly overview: string | null;
  /**
   * Whichever detail table matches `kind`, flattened. Keys differ by kind and
   * the document specifies them for `scene` and `movie` only, which is why
   * every plugin stores this object verbatim alongside the keys it reads.
   */
  readonly details: Readonly<Record<string, DetailValue>>;
  /** Nearest first: an episode's are its season, then its series. */
  readonly parents: readonly MediaParent[];
  readonly people: readonly MediaPerson[];
}

export interface SuggestedName {
  readonly name: string;
  readonly providerRef: string;
}

/** Present only when `state` is `unresolved`, and only for a name we part-recognise. */
export interface MediaSuggestions {
  readonly site: SuggestedName | null;
  readonly performers: readonly SuggestedName[];
}

export interface LookupEnvelope {
  readonly lookupId: string;
  readonly state: LookupState;
  /** The lookup ran out of time; a background job will finish it. Read before `state`. */
  readonly partial: boolean;
  readonly cached: boolean;
  /** 0 to 1. Null when nothing was scored. */
  readonly confidence: number | null;
  /** Why this name is not a media file. A refusal is a successful answer. */
  readonly refusal: string | null;
  /**
   * The parse behind the answer. Carried through unvalidated beyond "object or
   * null": nothing in this tree reads it, and the document gives it no shape.
   */
  readonly parsed: Readonly<Record<string, unknown>> | null;
  readonly media: Media | null;
  readonly suggestions: MediaSuggestions | null;
}

/** One entry of a batch answer: an envelope plus the status it would have had alone. */
export interface LookupBatchEntry extends LookupEnvelope {
  readonly status: number;
}

/**
 * A batch answer: one entry per item, **in the order the items were sent**,
 * carrying no echoed name. That is why `engine.ts` matches by position.
 */
export interface LookupBatchResponse {
  readonly results: readonly LookupBatchEntry[];
}

/**
 * How a credential is obtained. Structurally identical to the host's own
 * `ResolveSecret` (`packages/host/src/secrets.ts`) by design -- this package
 * must not import from `@pickarr/host`, and structural typing is what lets the
 * host pass its resolver in without either side depending on the other.
 *
 * Async and per-request rather than a resolved string: a store that rotates a
 * credential can, where a value read once at boot cannot.
 */
export type SecretResolver = (key: string) => Promise<string>;

/** The logical key the three plugins ask for. The host maps it to a variable. */
export const API_KEY_SECRET = 'openmetadata-api-key';
```

- [ ] **Step 5: Write `src/validate.ts`**

```ts
/**
 * `unknown` to wire types, one field at a time, throwing a `TypeError` that
 * names the field that is wrong.
 *
 * Narrowing functions rather than casts, and the reason is the failure a cast
 * produces instead: a service that renames `providerRef` would, behind a cast,
 * write a `media_item` row whose provider reference is the string
 * `"undefined"` -- claimed, unique, and wrong forever. Here it fails a job
 * with the field's name in the message.
 */
import type {
  DetailValue,
  LookupBatchEntry,
  LookupBatchResponse,
  LookupEnvelope,
  LookupState,
  Media,
  MediaKind,
  MediaParent,
  MediaPerson,
  MediaSuggestions,
  SuggestedName,
} from './types.ts';

function fail(field: string, why: string): never {
  throw new TypeError(`openmetadata: ${field} ${why}`);
}

function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(field, 'is not an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field, 'is not a string');
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(value, field);
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field, 'is not a boolean');
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, 'is not a number');
  return value;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(field, 'is not an array');
  return value;
}

const STATES: readonly string[] = ['resolved', 'unresolved', 'pending'];
const KINDS: readonly string[] = ['movie', 'series', 'season', 'episode', 'book', 'scene'];

function state(value: unknown): LookupState {
  const text = string(value, 'state');
  if (!STATES.includes(text)) fail('state', `is not a lookup state: ${text}`);
  return text as LookupState;
}

function kind(value: unknown, field: string): MediaKind {
  const text = string(value, field);
  if (!KINDS.includes(text)) fail(field, `is not a media kind: ${text}`);
  return text as MediaKind;
}

function details(value: unknown): Readonly<Record<string, DetailValue>> {
  const raw = object(value, 'media.details');
  const read: Record<string, DetailValue> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry === 'string') {
      read[key] = entry;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      read[key] = entry;
    } else {
      fail(`media.details.${key}`, 'is not a string, number or null');
    }
  }
  return read;
}

function parent(value: unknown, field: string): MediaParent {
  const raw = object(value, field);
  return {
    id: string(raw['id'], `${field}.id`),
    kind: kind(raw['kind'], `${field}.kind`),
    title: string(raw['title'], `${field}.title`),
    releaseDate: nullableString(raw['releaseDate'], `${field}.releaseDate`),
    year: nullableNumber(raw['year'], `${field}.year`),
    provider: string(raw['provider'], `${field}.provider`),
    providerRef: string(raw['providerRef'], `${field}.providerRef`),
  };
}

function person(value: unknown, field: string): MediaPerson {
  const raw = object(value, field);
  return {
    providerRef: string(raw['providerRef'], `${field}.providerRef`),
    name: string(raw['name'], `${field}.name`),
    role: string(raw['role'], `${field}.role`),
    characterName: nullableString(raw['characterName'], `${field}.characterName`),
    billingOrder: nullableNumber(raw['billingOrder'], `${field}.billingOrder`),
  };
}

function media(value: unknown): Media | null {
  if (value === null) return null;
  const raw = object(value, 'media');
  return {
    ...parent(raw, 'media'),
    overview: nullableString(raw['overview'], 'media.overview'),
    details: details(raw['details']),
    parents: array(raw['parents'], 'media.parents')
      .map((entry, index) => parent(entry, `media.parents[${index}]`)),
    people: array(raw['people'], 'media.people')
      .map((entry, index) => person(entry, `media.people[${index}]`)),
  };
}

function suggestedName(value: unknown, field: string): SuggestedName {
  const raw = object(value, field);
  return {
    name: string(raw['name'], `${field}.name`),
    providerRef: string(raw['providerRef'], `${field}.providerRef`),
  };
}

function suggestions(value: unknown): MediaSuggestions | null {
  if (value === null) return null;
  const raw = object(value, 'suggestions');
  const site = raw['site'];
  return {
    site: site === null ? null : suggestedName(site, 'suggestions.site'),
    performers: array(raw['performers'], 'suggestions.performers')
      .map((entry, index) => suggestedName(entry, `suggestions.performers[${index}]`)),
  };
}

/** One envelope: what a poll answers, and what each batch entry is built on. */
export function readEnvelope(value: unknown): LookupEnvelope {
  const raw = object(value, 'envelope');
  const parsed = raw['parsed'];
  return {
    lookupId: string(raw['lookupId'], 'lookupId'),
    state: state(raw['state']),
    partial: boolean(raw['partial'], 'partial'),
    cached: boolean(raw['cached'], 'cached'),
    confidence: nullableNumber(raw['confidence'], 'confidence'),
    refusal: nullableString(raw['refusal'], 'refusal'),
    // Shape-checked only: nothing reads it, and the document gives it none.
    parsed: parsed === null ? null : object(parsed, 'parsed'),
    media: media(raw['media']),
    suggestions: suggestions(raw['suggestions']),
  };
}

function batchEntry(value: unknown, index: number): LookupBatchEntry {
  const raw = object(value, `results[${index}]`);
  const status = raw['status'];
  if (typeof status !== 'number' || !Number.isInteger(status)) {
    fail(`results[${index}].status`, 'is not an integer');
  }
  return { ...readEnvelope(raw), status };
}

/** A batch answer. Entries stay in the order the service returned them. */
export function readBatchResponse(value: unknown): LookupBatchResponse {
  const raw = object(value, 'batch response');
  return {
    results: array(raw['results'], 'results').map((entry, index) => batchEntry(entry, index)),
  };
}
```

- [ ] **Step 6: Write `src/index.ts`**

```ts
export type {
  DetailValue,
  LookupBatchEntry,
  LookupBatchResponse,
  LookupCategory,
  LookupEnvelope,
  LookupState,
  Media,
  MediaKind,
  MediaParent,
  MediaPerson,
  MediaSuggestions,
  SecretResolver,
  SuggestedName,
} from './types.ts';
export { API_KEY_SECRET } from './types.ts';
export { readBatchResponse, readEnvelope } from './validate.ts';
```

- [ ] **Step 7: Run the test and the checks**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/validate.test.ts`
Expected: PASS, 7 tests.

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add packages/openmetadata package.json package-lock.json
git commit -m "Read the lookup service's answers field by field, so a service that renamed one fails a job instead of claiming a provider reference of \"undefined\""
```

---

### Task 3: The client

**Files:**
- Create: `packages/openmetadata/src/client.ts`
- Modify: `packages/openmetadata/src/index.ts`
- Test: `packages/openmetadata/test/client.test.ts`

**Interfaces:**
- Consumes: `readBatchResponse`, `readEnvelope`, `LookupCategory`, `SecretResolver`, `API_KEY_SECRET` (Task 2).
- Produces:

```ts
export const MAX_BATCH = 100;
export interface LookupClient {
  batch(category: LookupCategory, names: readonly string[]): Promise<readonly LookupBatchEntry[]>;
  poll(lookupId: string): Promise<LookupEnvelope>;
}
export interface LookupClientDeps {
  fetch: HostFetch;
  baseUrl: string;
  resolveSecret: SecretResolver;
  signal?: AbortSignal;
}
export function createLookupClient(deps: LookupClientDeps): LookupClient;
```

- [ ] **Step 1: Write the failing test**

`packages/openmetadata/test/client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostFetch } from '@pickarr/contract';
import { MAX_BATCH, createLookupClient } from '../src/client.ts';

interface Sent {
  url: string;
  method: string;
  authorization: string | undefined;
  names: readonly string[];
}

/** A `HostFetch` that records what it was asked and answers from a queue of bodies. */
function recordingFetch(bodies: readonly unknown[]): { fetch: HostFetch; sent: Sent[] } {
  const remaining = [...bodies];
  const sent: Sent[] = [];
  const fetch: HostFetch = {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : { items: [] };
      const items: unknown = (body as { items?: unknown }).items;
      sent.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization') ?? undefined,
        names: Array.isArray(items)
          ? items.map((item) => String((item as { name?: unknown }).name))
          : [],
      });
      const next = remaining.shift();
      if (next === undefined) throw new Error(`nothing scripted for ${url}`);
      return next as T;
    },
    async bytes(): Promise<Uint8Array> {
      throw new Error('bytes: not used by the lookup client');
    },
  };
  return { fetch, sent };
}

function entry(lookupId: string, status = 200): Record<string, unknown> {
  return {
    lookupId,
    state: 'unresolved',
    partial: false,
    cached: false,
    confidence: null,
    refusal: null,
    parsed: null,
    media: null,
    suggestions: null,
    status,
  };
}

test('sends one batch request, bearing the resolved key', async () => {
  const { fetch, sent } = recordingFetch([{ results: [entry('a'), entry('b')] }]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });

  const results = await client.batch('movies', ['one.mkv', 'two.mkv']);

  assert.equal(results.length, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, 'https://openmetadata.test/api/v1/lookup');
  assert.equal(sent[0]?.method, 'POST');
  assert.deepEqual(sent[0]?.names, ['one.mkv', 'two.mkv']);
  // The presence of the header, not the value: a credential is never an operand.
  assert.ok(sent[0]?.authorization?.startsWith('Bearer ') === true);
});

test('splits more than one hundred names across requests, in order', async () => {
  const names = Array.from({ length: MAX_BATCH + 5 }, (_, index) => `name-${index}.mkv`);
  const { fetch, sent } = recordingFetch([
    { results: names.slice(0, MAX_BATCH).map((_, index) => entry(`first-${index}`)) },
    { results: names.slice(MAX_BATCH).map((_, index) => entry(`second-${index}`)) },
  ]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });

  const results = await client.batch('tv', names);

  assert.equal(results.length, names.length);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.names.length, MAX_BATCH);
  assert.equal(sent[1]?.names.length, 5);
  assert.equal(results[0]?.lookupId, 'first-0');
  assert.equal(results[MAX_BATCH]?.lookupId, 'second-0');
});

test('asks nothing for an empty name list', async () => {
  const { fetch, sent } = recordingFetch([]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });
  assert.deepEqual(await client.batch('xxx', []), []);
  assert.equal(sent.length, 0);
});

test('polls by lookup id and reads a bare envelope', async () => {
  const { fetch, sent } = recordingFetch([entry('lookup-1')]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });

  const envelope = await client.poll('lookup-1');

  assert.equal(envelope.lookupId, 'lookup-1');
  assert.equal(sent[0]?.url, 'https://openmetadata.test/api/v1/lookup/lookup-1');
  assert.equal(sent[0]?.method, 'GET');
});

test('refuses a batch answer of the wrong length', async () => {
  const { fetch } = recordingFetch([{ results: [entry('a')] }]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });
  await assert.rejects(() => client.batch('movies', ['one.mkv', 'two.mkv']), /2 names.*1/);
});

test('trims a trailing slash off the base url', async () => {
  const { fetch, sent } = recordingFetch([entry('lookup-1')]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test/',
    resolveSecret: async () => 'test-key',
  });
  await client.poll('lookup-1');
  assert.equal(sent[0]?.url, 'https://openmetadata.test/api/v1/lookup/lookup-1');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/client.test.ts`
Expected: FAIL — cannot resolve `../src/client.ts`.

- [ ] **Step 3: Write `src/client.ts`**

```ts
/**
 * The two calls this tree makes to the lookup service.
 *
 * Always the batch shape, even for one name: a batch answers HTTP 200 with a
 * per-entry state where a single lookup can answer 202, so sending one shape
 * means reading one shape and there is no 202 path anywhere above this.
 */
import type { HostFetch } from '@pickarr/contract';
import type {
  LookupBatchEntry,
  LookupCategory,
  LookupEnvelope,
  SecretResolver,
} from './types.ts';
import { API_KEY_SECRET } from './types.ts';
import { readBatchResponse, readEnvelope } from './validate.ts';

/** The document's own ceiling: `LookupBatchRequest.items` is `maxItems: 100`. */
export const MAX_BATCH = 100;

const LOOKUP_PATH = '/api/v1/lookup';

export interface LookupClient {
  /**
   * Every name's answer, in the order the names were given -- across chunks,
   * so a caller never learns where a chunk boundary fell.
   */
  batch(category: LookupCategory, names: readonly string[]): Promise<readonly LookupBatchEntry[]>;
  poll(lookupId: string): Promise<LookupEnvelope>;
}

export interface LookupClientDeps {
  fetch: HostFetch;
  baseUrl: string;
  resolveSecret: SecretResolver;
  /** The dispatcher's per-job signal, forwarded so a job near its ceiling unwinds. */
  signal?: AbortSignal;
}

export function createLookupClient(deps: LookupClientDeps): LookupClient {
  const origin = deps.baseUrl.replace(/\/+$/, '');

  /**
   * Resolved per request rather than once per client: a store that rotates a
   * credential is the reason `SecretResolver` is async, and a value read once
   * would defeat it. The header is built here and nowhere else, so there is
   * one place a credential is ever attached to a request.
   */
  async function headers(extra?: Readonly<Record<string, string>>): Promise<Record<string, string>> {
    const key = await deps.resolveSecret(API_KEY_SECRET);
    return { authorization: `Bearer ${key}`, ...extra };
  }

  /**
   * `exactOptionalPropertyTypes` is on, so an explicit `signal: undefined` is
   * not the same as the property being absent -- two shapes rather than one
   * literal, the same way `main.ts` builds `createHost`'s options.
   */
  function init(base: { method: string; headers: Record<string, string>; body?: string }): RequestInit {
    return deps.signal === undefined ? base : { ...base, signal: deps.signal };
  }

  async function chunk(
    category: LookupCategory,
    names: readonly string[],
  ): Promise<readonly LookupBatchEntry[]> {
    const body = await deps.fetch.json<unknown>(`${origin}${LOOKUP_PATH}`, init({
      method: 'POST',
      headers: await headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ items: names.map((name) => ({ category, name })) }),
    }));
    const { results } = readBatchResponse(body);
    // The answers carry no echoed name, so position is the only thing tying
    // them to what was asked. A length mismatch would silently shift one
    // item's identity onto another; refused here instead.
    if (results.length !== names.length) {
      throw new Error(
        `openmetadata: asked about ${names.length} names and got ${results.length} answers`,
      );
    }
    return results;
  }

  return {
    async batch(category, names) {
      const answers: LookupBatchEntry[] = [];
      for (let start = 0; start < names.length; start += MAX_BATCH) {
        // eslint-disable-next-line no-await-in-loop -- chunks are sequential on purpose: the per-hostname fetch queue would serialise them anyway, and ordering the requests keeps the answers in the caller's order without a sort
        answers.push(...await chunk(category, names.slice(start, start + MAX_BATCH)));
      }
      return answers;
    },

    async poll(lookupId) {
      // `GET /api/v1/lookup/{id}` answers a bare envelope -- not wrapped in a
      // `result` key, which is where the host's own test double differs.
      const body = await deps.fetch.json<unknown>(
        `${origin}${LOOKUP_PATH}/${encodeURIComponent(lookupId)}`,
        init({ method: 'GET', headers: await headers() }),
      );
      return readEnvelope(body);
    },
  };
}
```

- [ ] **Step 4: Export it**

Add to `packages/openmetadata/src/index.ts`:

```ts
export type { LookupClient, LookupClientDeps } from './client.ts';
export { MAX_BATCH, createLookupClient } from './client.ts';
```

- [ ] **Step 5: Run the tests and the checks**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/client.test.ts`
Expected: PASS, 6 tests.

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add packages/openmetadata
git commit -m "Ask the lookup service in batches of a hundred, and refuse an answer list whose length does not match what was asked"
```

---

### Task 4: The fake service and the recording media double

Test infrastructure, exported from `./testing` so the engine's tests, all three plugin packages and the host's flow test drive one fake. Three fakes would be three chances to encode the wire shape wrongly, which is this slice's likeliest mistake.

**Files:**
- Create: `packages/openmetadata/src/testing.ts`
- Test: `packages/openmetadata/test/testing.test.ts`

**Interfaces:**
- Consumes: the wire types (Task 2).
- Produces:

```ts
export function resolvedEnvelope(fields: { lookupId: string; confidence?: number; media: Media }): LookupEnvelope;
export function refusedEnvelope(fields: { lookupId: string; refusal: string }): LookupEnvelope;
export function unresolvedEnvelope(fields: { lookupId: string; suggestions?: MediaSuggestions }): LookupEnvelope;
export function partialEnvelope(fields: { lookupId: string }): LookupEnvelope;
export function pendingEnvelope(fields: { lookupId: string }): LookupEnvelope;
export interface FakeLookupScript {
  batch: ReadonlyMap<string, LookupEnvelope>;
  polls: ReadonlyMap<string, readonly LookupEnvelope[]>;
}
export interface FakeLookupService {
  readonly fetch: HostFetch;
  readonly batchRequests: readonly (readonly string[])[];
  readonly pollRequests: readonly string[];
}
export function createFakeLookupService(script: FakeLookupScript): FakeLookupService;
export interface RecordingMedia {
  readonly writer: MediaWriter;
  readonly reader: MediaReader;
  readonly calls: readonly { method: string; args: readonly unknown[] }[];
  readonly items: ReadonlyMap<number, MediaItemRead>;
  /** Makes the next `claimProviderRef` report the given row as the winner. */
  loseNextClaim(winner: number): void;
}
export function createRecordingMedia(): RecordingMedia;
```

- [ ] **Step 1: Write the failing test**

`packages/openmetadata/test/testing.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeLookupService,
  createRecordingMedia,
  refusedEnvelope,
  unresolvedEnvelope,
} from '../src/testing.ts';

test('answers a batch in request order, with no echoed name', async () => {
  const service = createFakeLookupService({
    batch: new Map([
      ['a.mkv', unresolvedEnvelope({ lookupId: 'lookup-a' })],
      ['b.mkv', refusedEnvelope({ lookupId: 'lookup-b', refusal: 'a subtitle' })],
    ]),
    polls: new Map(),
  });

  const body = await service.fetch.json<{ results: readonly Record<string, unknown>[] }>(
    'https://openmetadata.test/api/v1/lookup',
    { method: 'POST', body: JSON.stringify({ items: [{ category: 'tv', name: 'b.mkv' }, { category: 'tv', name: 'a.mkv' }] }) },
  );

  assert.deepEqual(body.results.map((entry) => entry['lookupId']), ['lookup-b', 'lookup-a']);
  assert.ok(!('name' in (body.results[0] ?? {})), 'a real batch entry carries no name');
  assert.deepEqual(service.batchRequests, [['b.mkv', 'a.mkv']]);
});

test('answers successive polls for one lookup id', async () => {
  const service = createFakeLookupService({
    batch: new Map(),
    polls: new Map([['lookup-a', [
      unresolvedEnvelope({ lookupId: 'lookup-a' }),
      refusedEnvelope({ lookupId: 'lookup-a', refusal: 'a sidecar' }),
    ]]]),
  });

  const first = await service.fetch.json<Record<string, unknown>>('https://openmetadata.test/api/v1/lookup/lookup-a');
  const second = await service.fetch.json<Record<string, unknown>>('https://openmetadata.test/api/v1/lookup/lookup-a');

  assert.equal(first['state'], 'unresolved');
  assert.equal(second['refusal'], 'a sidecar');
  assert.deepEqual(service.pollRequests, ['lookup-a', 'lookup-a']);
});

test('throws for a name nothing scripted, rather than inventing an answer', async () => {
  const service = createFakeLookupService({ batch: new Map(), polls: new Map() });
  await assert.rejects(
    () => service.fetch.json('https://openmetadata.test/api/v1/lookup', {
      method: 'POST',
      body: JSON.stringify({ items: [{ category: 'tv', name: 'unscripted.mkv' }] }),
    }),
    /unscripted\.mkv/,
  );
});

test('the recording writer hands back rising ids and records its calls', async () => {
  const media = createRecordingMedia();
  const first = await media.writer.createMediaItem({
    pluginId: 'tv', title: 'One', releaseDate: null, description: null,
  });
  const second = await media.writer.createMediaItem({
    pluginId: 'tv', title: 'Two', releaseDate: null, description: null,
  });

  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(media.items.get(1)?.title, 'One');
  assert.deepEqual(media.calls.map((call) => call.method), ['createMediaItem', 'createMediaItem']);
});

test('a lost claim reports the winner and the caller row as dropped', async () => {
  const media = createRecordingMedia();
  const mine = await media.writer.createMediaItem({
    pluginId: 'tv', title: 'One', releaseDate: null, description: null,
  });
  media.loseNextClaim(42);

  assert.deepEqual(await media.writer.claimProviderRef(mine, 'tmdb', 'tmdb:movie:1'), {
    kept: 42,
    dropped: mine,
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/testing.test.ts`
Expected: FAIL — cannot resolve `../src/testing.ts`.

- [ ] **Step 3: Write `src/testing.ts`**

```ts
/**
 * The fake lookup service, and a recording `MediaWriter`/`MediaReader`.
 *
 * Shipped from the package under `./testing` rather than kept in a test
 * directory, because all three plugin packages and the host's flow test need
 * them. The alternative is each of those encoding the wire shape itself, and
 * the wire shape is where this slice is most exposed: a batch answer carries
 * **no echoed name** and its entries are positional, which is exactly what the
 * host's older `test/double/plugin.ts` gets wrong for our purposes.
 *
 * Nothing here touches `globalThis.fetch`, so no test has to put it back.
 */
import type {
  MediaItemInit,
  MediaItemRead,
  MediaItemUpdate,
  MediaReader,
  MediaWriter,
  ProviderClaim,
  Resolution,
  HostFetch,
} from '@pickarr/contract';
import type { LookupEnvelope, Media, MediaSuggestions } from './types.ts';

const BASE: Omit<LookupEnvelope, 'lookupId' | 'state'> = {
  partial: false,
  cached: false,
  confidence: null,
  refusal: null,
  parsed: null,
  media: null,
  suggestions: null,
};

export function resolvedEnvelope(
  fields: { lookupId: string; confidence?: number; media: Media },
): LookupEnvelope {
  return {
    ...BASE,
    lookupId: fields.lookupId,
    state: 'resolved',
    confidence: fields.confidence ?? 0.9,
    media: fields.media,
  };
}

/**
 * A non-media file, successfully identified as one. `state` is `resolved`,
 * because identifying a subtitle *is* a successful identification -- the
 * refusal is what makes it terminal.
 */
export function refusedEnvelope(fields: { lookupId: string; refusal: string }): LookupEnvelope {
  return { ...BASE, lookupId: fields.lookupId, state: 'resolved', refusal: fields.refusal };
}

export function unresolvedEnvelope(
  fields: { lookupId: string; suggestions?: MediaSuggestions },
): LookupEnvelope {
  return {
    ...BASE,
    lookupId: fields.lookupId,
    state: 'unresolved',
    suggestions: fields.suggestions ?? null,
  };
}

/** An answer that has not arrived: the state it *expects*, and nothing filled in. */
export function partialEnvelope(fields: { lookupId: string }): LookupEnvelope {
  return { ...BASE, lookupId: fields.lookupId, state: 'resolved', partial: true };
}

/** The other way the service says "not yet": a state rather than a flag. */
export function pendingEnvelope(fields: { lookupId: string }): LookupEnvelope {
  return { ...BASE, lookupId: fields.lookupId, state: 'pending' };
}

export interface FakeLookupScript {
  /** Keyed by filename. A name asked about but absent here is a test bug, not an answer. */
  batch: ReadonlyMap<string, LookupEnvelope>;
  /** Keyed by lookup id: successive poll answers, one consumed per GET. */
  polls: ReadonlyMap<string, readonly LookupEnvelope[]>;
}

export interface FakeLookupService {
  readonly fetch: HostFetch;
  /** Live view: the names each batch POST asked about, one array per request. */
  readonly batchRequests: readonly (readonly string[])[];
  readonly pollRequests: readonly string[];
}

function requestedNames(body: RequestInit['body']): string[] {
  if (typeof body !== 'string') {
    throw new TypeError('fake lookup service: a batch request must carry a JSON string body');
  }
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || !('items' in parsed)) {
    throw new TypeError('fake lookup service: a batch request body must carry items');
  }
  const items: unknown = parsed.items;
  if (!Array.isArray(items)) throw new TypeError('fake lookup service: items is not an array');
  return items.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('name' in item) || typeof item.name !== 'string') {
      throw new TypeError('fake lookup service: an item carries no name');
    }
    return item.name;
  });
}

const LOOKUP_PATH = '/api/v1/lookup';

export function createFakeLookupService(script: FakeLookupScript): FakeLookupService {
  const batchRequests: string[][] = [];
  const pollRequests: string[] = [];
  // Copied, so consuming an answer does not mutate the caller's script.
  const remaining = new Map<string, LookupEnvelope[]>(
    Array.from(script.polls, ([lookupId, answers]) => [lookupId, [...answers]]),
  );

  async function answer(url: string, init?: RequestInit): Promise<unknown> {
    const parsed = new URL(url);
    const method = init?.method ?? 'GET';

    if (method === 'POST' && parsed.pathname === LOOKUP_PATH) {
      const names = requestedNames(init?.body);
      batchRequests.push(names);
      // In request order, and with `status` on each entry: the document's
      // batch shape. No `name` anywhere, which is the point of this fake.
      return {
        results: names.map((name) => {
          const envelope = script.batch.get(name);
          if (envelope === undefined) {
            throw new Error(`fake lookup service: nothing scripted for "${name}"`);
          }
          return { ...envelope, status: 200 };
        }),
      };
    }

    const prefix = `${LOOKUP_PATH}/`;
    if (method === 'GET' && parsed.pathname.startsWith(prefix)) {
      const lookupId = decodeURIComponent(parsed.pathname.slice(prefix.length));
      pollRequests.push(lookupId);
      const next = remaining.get(lookupId)?.shift();
      if (next === undefined) {
        throw new Error(`fake lookup service: no poll answer left for lookup ${lookupId}`);
      }
      // A bare envelope, as `GET /api/v1/lookup/{id}` specifies.
      return next;
    }

    throw new Error(`fake lookup service: unexpected ${method} ${parsed.pathname}`);
  }

  const fetch: HostFetch = {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      return await answer(url, init) as T;
    },
    async bytes(): Promise<Uint8Array> {
      throw new Error('fake lookup service: nothing here serves bytes');
    },
  };

  return { fetch, batchRequests, pollRequests };
}

export interface RecordedCall {
  method: string;
  args: readonly unknown[];
}

export interface RecordingMedia {
  readonly writer: MediaWriter;
  readonly reader: MediaReader;
  readonly calls: readonly RecordedCall[];
  readonly items: ReadonlyMap<number, MediaItemRead>;
  readonly resolutions: ReadonlyMap<number, { resolution: Resolution; detail: string | null }>;
  readonly roles: readonly { mediaItemId: number; personId: number; role: string; name: string | null; billingOrder: number | null }[];
  /** Makes the next `claimProviderRef` report `winner` as the keeper. */
  loseNextClaim(winner: number): void;
}

/**
 * A `MediaWriter`/`MediaReader` pair that records rather than writes, so the
 * engine's tests need no database and no host schema. Ids rise from 1, which
 * is enough for a test to tell two rows apart and cheap enough not to pretend
 * to be sqlite.
 */
export function createRecordingMedia(): RecordingMedia {
  const calls: RecordedCall[] = [];
  const items = new Map<number, MediaItemRead>();
  const people = new Map<string, number>();
  const resolutions = new Map<number, { resolution: Resolution; detail: string | null }>();
  const roles: { mediaItemId: number; personId: number; role: string; name: string | null; billingOrder: number | null }[] = [];
  const links = new Map<number, number | null>();
  let nextItem = 0;
  let nextPerson = 0;
  let claimLoser: number | null = null;

  function record(method: string, ...args: readonly unknown[]): void {
    calls.push({ method, args });
  }

  const writer: MediaWriter = {
    async createMediaItem(init: MediaItemInit): Promise<number> {
      record('createMediaItem', init);
      nextItem += 1;
      items.set(nextItem, {
        id: nextItem,
        title: init.title,
        releaseDate: init.releaseDate,
        description: init.description,
        provider: null,
        providerRef: null,
        createdAt: 0,
        updatedAt: 0,
      });
      return nextItem;
    },
    async updateMediaItem(mediaItemId: number, update: MediaItemUpdate): Promise<void> {
      record('updateMediaItem', mediaItemId, update);
      const existing = items.get(mediaItemId);
      if (existing === undefined) throw new Error(`updateMediaItem: no media item ${mediaItemId}`);
      items.set(mediaItemId, { ...existing, ...update });
    },
    async claimProviderRef(mediaItemId: number, provider: string, ref: string): Promise<ProviderClaim> {
      record('claimProviderRef', mediaItemId, provider, ref);
      const existing = items.get(mediaItemId);
      if (existing !== undefined) {
        items.set(mediaItemId, { ...existing, provider, providerRef: ref });
      }
      if (claimLoser !== null) {
        const kept = claimLoser;
        claimLoser = null;
        return { kept, dropped: mediaItemId };
      }
      return { kept: mediaItemId, dropped: null };
    },
    async relinkRssItem(rssItemId: number, mediaItemId: number | null): Promise<void> {
      record('relinkRssItem', rssItemId, mediaItemId);
      links.set(rssItemId, mediaItemId);
    },
    async dropMediaItem(mediaItemId: number): Promise<void> {
      record('dropMediaItem', mediaItemId);
      items.delete(mediaItemId);
    },
    async attachPoster(mediaItemId, poster): Promise<void> { record('attachPoster', mediaItemId, poster.url); },
    async attachBackground(mediaItemId, background): Promise<void> { record('attachBackground', mediaItemId, background.url); },
    async attachLogo(mediaItemId, logo): Promise<void> { record('attachLogo', mediaItemId, logo.url); },
    async upsertPerson(person): Promise<number> {
      record('upsertPerson', person);
      const existing = people.get(person.providerRef);
      if (existing !== undefined) return existing;
      nextPerson += 1;
      people.set(person.providerRef, nextPerson);
      return nextPerson;
    },
    async attachRole(mediaItemId, role): Promise<void> {
      record('attachRole', mediaItemId, role);
      roles.push({ mediaItemId, ...role });
    },
    async setResolution(rssItemId, resolution, detail): Promise<void> {
      record('setResolution', rssItemId, resolution, detail);
      resolutions.set(rssItemId, { resolution, detail });
    },
  };

  const reader: MediaReader = {
    async mediaItem(id: number): Promise<MediaItemRead | null> {
      record('mediaItem', id);
      return items.get(id) ?? null;
    },
    async mediaItemByProviderRef(provider: string, ref: string): Promise<MediaItemRead | null> {
      record('mediaItemByProviderRef', provider, ref);
      for (const item of items.values()) {
        if (item.provider === provider && item.providerRef === ref) return item;
      }
      return null;
    },
    async rssItemsFor(): Promise<[]> { return []; },
    async downloadsFor(): Promise<[]> { return []; },
  };

  return {
    writer,
    reader,
    calls,
    items,
    resolutions,
    roles,
    loseNextClaim(winner: number): void { claimLoser = winner; },
  };
}
```

- [ ] **Step 4: Run the tests and the checks**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/testing.test.ts`
Expected: PASS, 5 tests.

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add packages/openmetadata
git commit -m "Ship one fake lookup service at the real wire shape, so three plugin packages cannot each encode a positional batch answer differently"
```

---

### Task 5: The shared state table, generated per prefix

**Files:**
- Create: `packages/openmetadata/src/table.ts`
- Modify: `packages/openmetadata/src/index.ts`, `packages/openmetadata/package.json` (add `drizzle-orm`)
- Test: `packages/openmetadata/test/table.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `lookupTableMigration(pluginId: string): Migration` (version 1), `lookupTable(pluginId: string)` (a Drizzle `sqliteTable` with columns `id`, `rssItemId`, `mediaItemId`, `lookupJobId`, `lookupId`, `providerRef`, `confidence`, `createdAt`, `updatedAt`), `lookupTableName(pluginId: string): string`.

- [ ] **Step 1: Write the failing test**

`packages/openmetadata/test/table.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { lookupTable, lookupTableMigration, lookupTableName } from '../src/table.ts';

function applied(pluginId: string): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  // The host's tables the DDL references. Minimal stubs: these tests are about
  // the generated table, and the real foreign keys are exercised by the host's
  // own flow test, which migrates the real schema.
  raw.exec('CREATE TABLE rss_item (id INTEGER PRIMARY KEY)');
  raw.exec('CREATE TABLE media_item (id INTEGER PRIMARY KEY)');
  lookupTableMigration(pluginId).up(raw);
  return raw;
}

test('is version 1 and names the table after the plugin', () => {
  assert.equal(lookupTableMigration('tv').version, 1);
  assert.equal(lookupTableName('tv'), 'tv_lookup');
});

test('creates the table and its unique index, both prefixed', () => {
  const raw = applied('movie');
  const names = raw.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String((row as { name: unknown }).name))
    .filter((name) => name !== 'rss_item' && name !== 'media_item');
  assert.deepEqual(names.toSorted(), ['movie_lookup', 'movie_lookup_rss_item']);
});

test('holds one row per rss item', () => {
  const raw = applied('xxx');
  raw.prepare('INSERT INTO rss_item (id) VALUES (1)').run();
  const insert = raw.prepare(
    'INSERT INTO xxx_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)',
  );
  insert.run(1, 10, 10);
  assert.throws(() => insert.run(1, 11, 11), /UNIQUE/);
});

test('leaves every column but the timestamps nullable, so a row exists before an answer does', () => {
  const raw = applied('tv');
  raw.prepare('INSERT INTO rss_item (id) VALUES (7)').run();
  raw.prepare('INSERT INTO tv_lookup (rss_item_id, created_at, updated_at) VALUES (7, 1, 1)').run();
  const row = raw.prepare('SELECT media_item_id, lookup_job_id, lookup_id, provider_ref, confidence FROM tv_lookup').get();
  assert.deepEqual(row, {
    media_item_id: null,
    lookup_job_id: null,
    lookup_id: null,
    provider_ref: null,
    confidence: null,
  });
});

test('the drizzle object names the same table and columns', () => {
  const table = lookupTable('tv');
  const raw = applied('tv');
  const columns = raw.prepare('SELECT name FROM pragma_table_info(?)').all('tv_lookup')
    .map((row) => String((row as { name: unknown }).name));
  assert.deepEqual(columns.toSorted(), [
    'confidence', 'created_at', 'id', 'lookup_id', 'lookup_job_id',
    'media_item_id', 'provider_ref', 'rss_item_id', 'updated_at',
  ]);
  // The Drizzle object is what the engine writes through; it must agree.
  assert.equal(table.rssItemId.name, 'rss_item_id');
  assert.equal(table.confidence.name, 'confidence');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/table.test.ts`
Expected: FAIL — cannot resolve `../src/table.ts`.

- [ ] **Step 3: Add `drizzle-orm` to the package**

In `packages/openmetadata/package.json`, `dependencies`:

```json
  "dependencies": {
    "@pickarr/contract": "*",
    "drizzle-orm": "1.0.0-rc.4"
  }
```

Run `npm install` from the repo root.

- [ ] **Step 4: Write `src/table.ts`**

```ts
/**
 * The state table every plugin built on this engine owns, generated from its
 * prefix.
 *
 * Generated rather than written three times because `migratePlugin` rejects a
 * table without the plugin's own prefix, so the three cannot share one table --
 * and three hand-written copies of one DDL are three chances for them to drift
 * apart. One generator, one shape, by construction.
 */
import type { Migration } from '@pickarr/contract';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export function lookupTableName(pluginId: string): string {
  return `${pluginId}_lookup`;
}

/**
 * The Drizzle handle the engine writes through.
 *
 * No `.references()` anywhere: the foreign keys in the migration below point
 * at the *host's* tables, whose Drizzle objects a plugin has no business
 * importing.
 */
export function lookupTable(pluginId: string) {
  return sqliteTable(lookupTableName(pluginId), {
    id: integer('id').primaryKey(),
    rssItemId: integer('rss_item_id').notNull(),
    /** Null until a lookup resolves: nothing identifies the item before then. */
    mediaItemId: integer('media_item_id'),
    /** The job that will identify it -- the id `JobQueue.enqueue` returned. */
    lookupJobId: integer('lookup_job_id'),
    /** The service's own id for the lookup: what a poll asks about. */
    lookupId: text('lookup_id'),
    /** `provider:ref`, copied here once a claim settles. */
    providerRef: text('provider_ref'),
    /** The service's own score, recorded so a threshold can be measured rather than invented. */
    confidence: real('confidence'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  });
}

/**
 * Every plugin's migration 1.
 *
 * Keyed per rss item, not per media item: the dedup points two rss items at
 * one media item, and a per-media-item key would make the loser's row collide
 * with the winner's.
 */
export function lookupTableMigration(pluginId: string): Migration {
  const table = lookupTableName(pluginId);
  return {
    version: 1,
    up: (db) => db.exec(`
CREATE TABLE ${table} (
  id            INTEGER PRIMARY KEY,
  rss_item_id   INTEGER NOT NULL REFERENCES rss_item (id),
  media_item_id INTEGER REFERENCES media_item (id),
  lookup_job_id INTEGER,
  lookup_id     TEXT,
  provider_ref  TEXT,
  confidence    REAL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX ${table}_rss_item ON ${table} (rss_item_id);
`),
  };
}
```

- [ ] **Step 5: Export it**

Add to `packages/openmetadata/src/index.ts`:

```ts
export { lookupTable, lookupTableMigration, lookupTableName } from './table.ts';
```

- [ ] **Step 6: Run the tests and the checks**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/table.test.ts`
Expected: PASS, 5 tests.

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add packages/openmetadata package.json package-lock.json
git commit -m "Generate each plugin's lookup state table from its own prefix, since migratePlugin will not let three plugins share one"
```

---

### Task 6: The branch that reads an answer

The decision logic, as a standalone function with its own tests. Task 7 wires it into a `MediaPlugin`. Split there because the branch is where the correctness lives — partial before state, refusal against unresolved, the dedup race — and it is worth a reviewer's gate on its own.

**Files:**
- Create: `packages/openmetadata/src/engine.ts`
- Modify: `packages/openmetadata/src/testing.ts` (add `createTestHarness`), `packages/openmetadata/src/index.ts`
- Test: `packages/openmetadata/test/engine-branch.test.ts`, `packages/openmetadata/test/engine-resolved.test.ts`

**Interfaces:**
- Consumes: `LookupEnvelope`, `Media`, `MediaSuggestions` (Task 2); `lookupTable`, `lookupTableMigration` (Task 5); `createRecordingMedia` (Task 4).
- Produces:

```ts
export const POLL_JOB = 'poll';
export const LOOKUP_JOB = 'lookup';
export const POLL_DELAY_MS = 30_000;
export const MAX_POLLS = 20;

export interface ApplyArgs {
  readonly media: Media;
  readonly mediaItemId: number;
  readonly raw: DatabaseSync;
  readonly ctx: PluginContext;
  readonly now: number;
}
export interface ApplyTarget {
  readonly rssItemId: number;
  readonly filename: string;
  readonly polls: number;
}
export interface EnvelopeDeps {
  readonly pluginId: string;
  readonly ctx: PluginContext;
  readonly raw: DatabaseSync;
  readonly db: LookupDb;
  readonly table: LookupStateTable;
  readonly now: number;
  apply(args: ApplyArgs): Promise<void>;
}
export function applyEnvelope(envelope: LookupEnvelope, target: ApplyTarget, deps: EnvelopeDeps): Promise<void>;
export function describeUnresolved(filename: string, suggestions: MediaSuggestions | null): string;
```

and, from `./testing`:

```ts
export interface TestHarness {
  readonly ctx: PluginContext;
  readonly raw: DatabaseSync;
  readonly media: RecordingMedia;
  readonly enqueued: readonly (JobEnqueue & { id: number })[];
  readonly logs: readonly { message: string; detail: Readonly<Record<string, unknown>> | undefined }[];
  insertRssItem(filename: string): number;
}
export function createTestHarness(deps?: { fetch?: HostFetch; now?: () => number }): TestHarness;
```

- [ ] **Step 1: Add `createTestHarness` to `src/testing.ts`**

Append to `packages/openmetadata/src/testing.ts` (and add `DatabaseSync`, `JobEnqueue`, `JobQueue`, `PluginContext`, `DownloadClients` to its imports):

```ts
export interface TestHarness {
  readonly ctx: PluginContext;
  readonly raw: DatabaseSync;
  readonly media: RecordingMedia;
  /** Every job enqueued, with the id `enqueue` answered -- rising from 1. */
  readonly enqueued: readonly (JobEnqueue & { id: number })[];
  readonly logs: readonly { message: string; detail: Readonly<Record<string, unknown>> | undefined }[];
  /** Inserts an `rss_item` row and returns its id. */
  insertRssItem(filename: string): number;
}

/**
 * A `PluginContext` over an in-memory database holding *stubs* of the two host
 * tables a plugin's own DDL references.
 *
 * Stubs rather than the real schema, because this package must not import from
 * `@pickarr/host`: what these tests prove is that a plugin written against the
 * contract behaves, and the real migrations, real foreign keys and real
 * dispatcher are proven by the host's own flow test. Foreign keys are left off
 * here (`node:sqlite`'s default), so a test may reference an rss item it never
 * inserted when the row itself is beside the point.
 */
export function createTestHarness(deps: { fetch?: HostFetch; now?: () => number } = {}): TestHarness {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE rss_item (id INTEGER PRIMARY KEY, filename TEXT NOT NULL)');
  raw.exec('CREATE TABLE media_item (id INTEGER PRIMARY KEY)');

  const media = createRecordingMedia();
  const enqueued: (JobEnqueue & { id: number })[] = [];
  const logs: { message: string; detail: Readonly<Record<string, unknown>> | undefined }[] = [];

  const jobs: JobQueue = {
    async enqueue(job: JobEnqueue): Promise<number> {
      const id = enqueued.length + 1;
      enqueued.push({ ...job, id });
      return id;
    },
  };

  const downloads: DownloadClients = {
    async submit(): Promise<string | null> {
      throw new Error('downloads.submit: not used by a lookup test');
    },
  };

  const fetch: HostFetch = deps.fetch ?? {
    async json(): Promise<never> { throw new Error('fetch.json: this test scripted no service'); },
    async bytes(): Promise<never> { throw new Error('fetch.bytes: nothing here serves bytes'); },
  };

  return {
    ctx: {
      db: raw,
      media: media.writer,
      read: media.reader,
      jobs,
      fetch,
      downloads,
      log: (message, detail) => logs.push({ message, detail }),
    },
    raw,
    media,
    enqueued,
    logs,
    insertRssItem(filename: string): number {
      const result = raw.prepare('INSERT INTO rss_item (filename) VALUES (?)').run(filename);
      return Number(result.lastInsertRowid);
    },
  };
}
```

- [ ] **Step 2: Write the failing branch test**

`packages/openmetadata/test/engine-branch.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-sqlite';
import {
  MAX_POLLS,
  POLL_DELAY_MS,
  POLL_JOB,
  applyEnvelope,
  describeUnresolved,
} from '../src/engine.ts';
import { lookupTable, lookupTableMigration } from '../src/table.ts';
import {
  createTestHarness,
  partialEnvelope,
  pendingEnvelope,
  refusedEnvelope,
  resolvedEnvelope,
  unresolvedEnvelope,
} from '../src/testing.ts';
import type { Media } from '../src/types.ts';

const PLUGIN_ID = 'tv';
const NOW = 1_700_000_000_000;

/** A harness with the plugin's own state table migrated and one rss item in it. */
function fixture(filename = 'item.mkv') {
  const harness = createTestHarness();
  lookupTableMigration(PLUGIN_ID).up(harness.raw);
  const rssItemId = harness.insertRssItem(filename);
  const table = lookupTable(PLUGIN_ID);
  const db = drizzle({ client: harness.raw });
  harness.raw.prepare(
    `INSERT INTO ${PLUGIN_ID}_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)`,
  ).run(rssItemId, NOW, NOW);
  const applied: { media: Media; mediaItemId: number }[] = [];
  const deps = {
    pluginId: PLUGIN_ID,
    ctx: harness.ctx,
    raw: harness.raw,
    db,
    table,
    now: NOW,
    apply: async (args: { media: Media; mediaItemId: number }) => {
      applied.push({ media: args.media, mediaItemId: args.mediaItemId });
    },
  };
  return { harness, deps, rssItemId, table, db, applied };
}

test('a partial answer polls, and leaves the resolution alone', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(partialEnvelope({ lookupId: 'lookup-1' }), { rssItemId, filename: 'item.mkv', polls: 0 }, deps);

  assert.equal(harness.enqueued.length, 1);
  assert.equal(harness.enqueued[0]?.kind, POLL_JOB);
  assert.deepEqual(harness.enqueued[0]?.payload, { lookupId: 'lookup-1', rssItemId, polls: 1 });
  assert.equal(harness.enqueued[0]?.runAt, NOW + POLL_DELAY_MS);
  // Nothing is known about the item yet, so nothing is recorded about it.
  assert.equal(harness.media.resolutions.size, 0);
});

test('a pending state polls too -- the state, not only the flag', async () => {
  const { harness, deps, rssItemId } = fixture();
  await applyEnvelope(pendingEnvelope({ lookupId: 'lookup-2' }), { rssItemId, filename: 'item.mkv', polls: 3 }, deps);
  assert.equal(harness.enqueued[0]?.kind, POLL_JOB);
  assert.deepEqual(harness.enqueued[0]?.payload, { lookupId: 'lookup-2', rssItemId, polls: 4 });
});

test('the last permitted poll gives up, naming the lookup id', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    pendingEnvelope({ lookupId: 'lookup-3' }),
    { rssItemId, filename: 'item.mkv', polls: MAX_POLLS },
    deps,
  );

  assert.equal(harness.enqueued.length, 0, 'no further poll is scheduled');
  const recorded = harness.media.resolutions.get(rssItemId);
  assert.equal(recorded?.resolution, 'unresolved');
  assert.match(recorded?.detail ?? '', /lookup-3/);
});

test('a refusal is terminal: the resolution says so and nothing else is written', async () => {
  const { harness, deps, rssItemId, applied } = fixture('item.srt');

  await applyEnvelope(
    refusedEnvelope({ lookupId: 'lookup-4', refusal: 'a subtitle' }),
    { rssItemId, filename: 'item.srt', polls: 0 },
    deps,
  );

  assert.deepEqual(harness.media.resolutions.get(rssItemId), { resolution: 'refused', detail: 'a subtitle' });
  assert.equal(harness.enqueued.length, 0);
  assert.equal(applied.length, 0);
  assert.equal(harness.media.items.size, 0, 'a refusal creates no media item to clean up');
});

test('an unrecognised name is unresolved, and says only that', async () => {
  const { harness, deps, rssItemId } = fixture('mystery.mkv');

  await applyEnvelope(unresolvedEnvelope({ lookupId: 'lookup-5' }), { rssItemId, filename: 'mystery.mkv', polls: 0 }, deps);

  const recorded = harness.media.resolutions.get(rssItemId);
  assert.equal(recorded?.resolution, 'unresolved');
  assert.match(recorded?.detail ?? '', /mystery\.mkv/);
  assert.equal(harness.enqueued.length, 0, 'a retry happens on request, not on a schedule');
});

test('an unresolved answer with suggestions names what was recognised', async () => {
  const { harness, deps, rssItemId } = fixture('site.performer.mp4');

  await applyEnvelope(
    unresolvedEnvelope({
      lookupId: 'lookup-6',
      suggestions: {
        site: { name: 'Maddie Wren', providerRef: 'tpdb:site:1' },
        performers: [{ name: 'A Performer', providerRef: 'tpdb:person:2' }],
      },
    }),
    { rssItemId, filename: 'site.performer.mp4', polls: 0 },
    deps,
  );

  const detail = harness.media.resolutions.get(rssItemId)?.detail ?? '';
  assert.match(detail, /Maddie Wren/);
  assert.match(detail, /A Performer/);
});

test('a resolved answer with no media throws rather than writing nothing quietly', async () => {
  const { deps, rssItemId } = fixture();
  const broken = { ...unresolvedEnvelope({ lookupId: 'lookup-7' }), state: 'resolved' as const };
  await assert.rejects(
    () => applyEnvelope(broken, { rssItemId, filename: 'item.mkv', polls: 0 }, deps),
    /lookup-7/,
  );
});

test('describeUnresolved reads differently with and without suggestions', () => {
  assert.match(describeUnresolved('a.mkv', null), /did not recognise/);
  assert.match(
    describeUnresolved('a.mkv', { site: { name: 'Site', providerRef: 'r' }, performers: [] }),
    /recognised site Site/,
  );
});

test('a partial answer that is also refused still polls -- partial is read first', async () => {
  const { harness, deps, rssItemId } = fixture();
  const both = { ...refusedEnvelope({ lookupId: 'lookup-8', refusal: 'a subtitle' }), partial: true };

  await applyEnvelope(both, { rssItemId, filename: 'item.mkv', polls: 0 }, deps);

  assert.equal(harness.enqueued[0]?.kind, POLL_JOB);
  assert.equal(harness.media.resolutions.size, 0);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/engine-branch.test.ts`
Expected: FAIL — cannot resolve `../src/engine.ts`.

- [ ] **Step 4: Write `src/engine.ts` — the branch and the resolved path**

```ts
/**
 * The lookup flow, shared by every plugin built on this package.
 *
 * The branch below is the whole reason this is one engine and not three
 * plugins: the order the outcomes are read in is a correctness property, not a
 * style, and `PluginContext`'s own documentation warns about two of them.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PluginContext } from '@pickarr/contract';
import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/node-sqlite';
import type { LookupEnvelope, Media, MediaSuggestions } from './types.ts';
import type { lookupTable } from './table.ts';

export const LOOKUP_JOB = 'lookup';
export const POLL_JOB = 'poll';

/** How long a poll waits before asking again. */
export const POLL_DELAY_MS = 30_000;

/**
 * How many polls one lookup may spend.
 *
 * A poll that answers "not yet" enqueues the *next* poll, so the job runner's
 * `attempts` never rises and nothing else bounds the sequence. Twenty polls at
 * thirty seconds is ten minutes, after which the item is left `unresolved`
 * naming its lookup id -- visible, rather than `pending` forever.
 */
export const MAX_POLLS = 20;

export type LookupDb = ReturnType<typeof drizzle>;
export type LookupStateTable = ReturnType<typeof lookupTable>;

/** What a plugin is handed for its own rows. `raw` is already narrowed. */
export interface ApplyArgs {
  readonly media: Media;
  readonly mediaItemId: number;
  readonly raw: DatabaseSync;
  readonly ctx: PluginContext;
  readonly now: number;
}

/** Which rss item an answer is about, and how many polls it has already cost. */
export interface ApplyTarget {
  readonly rssItemId: number;
  readonly filename: string;
  readonly polls: number;
}

export interface EnvelopeDeps {
  readonly pluginId: string;
  readonly ctx: PluginContext;
  readonly raw: DatabaseSync;
  readonly db: LookupDb;
  readonly table: LookupStateTable;
  readonly now: number;
  apply(args: ApplyArgs): Promise<void>;
}

/**
 * What to tell a human about a name the service did not recognise.
 *
 * A lookup for something the provider has not indexed fails the same way as
 * one we misread, and `suggestions` is how the two are told apart: "we have
 * never seen this" against "we know the site, not the scene".
 */
export function describeUnresolved(filename: string, suggestions: MediaSuggestions | null): string {
  const parts: string[] = [];
  if (suggestions !== null) {
    if (suggestions.site !== null) parts.push(`site ${suggestions.site.name}`);
    if (suggestions.performers.length > 0) {
      parts.push(`performers ${suggestions.performers.map((person) => person.name).join(', ')}`);
    }
  }
  if (parts.length === 0) return `the lookup service did not recognise "${filename}"`;
  return `the lookup service recognised ${parts.join(' and ')} in "${filename}", but not the item itself`;
}

/**
 * The service's people, de-duplicated by the provider's own person id as they
 * are written, in the order the service gave them.
 */
async function attachPeople(media: Media, mediaItemId: number, ctx: PluginContext): Promise<void> {
  for (const person of media.people) {
    // eslint-disable-next-line no-await-in-loop -- one person at a time: `attachRole` needs the id this upsert returns, and the roles have to land in billing order
    const personId = await ctx.media.upsertPerson({ name: person.name, providerRef: person.providerRef });
    // eslint-disable-next-line no-await-in-loop -- see above; this is the same person's own role
    await ctx.media.attachRole(mediaItemId, {
      personId,
      role: person.role,
      name: person.characterName,
      billingOrder: person.billingOrder,
    });
  }
}

/**
 * A resolved answer, in the one order that survives a lost dedup race.
 *
 * The media item is created late -- after the answer arrived -- so the three
 * outcomes that identify nothing have no row to clean up. `MediaWriter` does
 * offer `updateMediaItem`, so creating early is implementable; it would only
 * add a row to drop on every refusal.
 */
async function applyResolved(
  envelope: LookupEnvelope,
  media: Media,
  target: ApplyTarget,
  deps: EnvelopeDeps,
): Promise<void> {
  const { ctx } = deps;
  const mine = await ctx.media.createMediaItem({
    pluginId: deps.pluginId,
    title: media.title,
    releaseDate: media.releaseDate,
    description: media.overview,
  });

  const claim = await ctx.media.claimProviderRef(mine, media.provider, media.providerRef);
  if (claim.dropped !== null) {
    // Lost the race. Nothing points at our row yet -- the rss item is linked
    // below, to whichever row kept the reference -- so dropping it now leaves
    // nothing dangling.
    await ctx.media.dropMediaItem(claim.dropped);
  }
  await ctx.media.relinkRssItem(target.rssItemId, claim.kept);

  await deps.db.update(deps.table)
    .set({
      mediaItemId: claim.kept,
      lookupId: envelope.lookupId,
      providerRef: `${media.provider}:${media.providerRef}`,
      confidence: envelope.confidence,
      updatedAt: deps.now,
    })
    .where(eq(deps.table.rssItemId, target.rssItemId));

  // Against `claim.kept`, which may be a row another item wrote: every write
  // a plugin's `apply` makes is an upsert keyed on the media item or a
  // provider reference, so re-applying the winner's own answer is a no-op
  // rather than a duplicate.
  await deps.apply({ media, mediaItemId: claim.kept, raw: deps.raw, ctx, now: deps.now });
  await attachPeople(media, claim.kept, ctx);
  await ctx.media.setResolution(target.rssItemId, 'resolved', null);
}

/**
 * One answer, applied. The five outcomes, in the one order that reads them
 * correctly.
 */
export async function applyEnvelope(
  envelope: LookupEnvelope,
  target: ApplyTarget,
  deps: EnvelopeDeps,
): Promise<void> {
  const { ctx } = deps;

  // 1. Not here yet -- read FIRST, and per answer rather than per response. A
  //    batch always answers HTTP 200, and a partial entry carries the state it
  //    *expects* to reach, so neither the response arriving nor this entry's
  //    own state says whether the answer is present.
  if (envelope.partial || envelope.state === 'pending') {
    const polls = target.polls + 1;
    if (polls > MAX_POLLS) {
      await ctx.media.setResolution(
        target.rssItemId,
        'unresolved',
        `the lookup service never finished lookup ${envelope.lookupId} for "${target.filename}"`,
      );
      return;
    }
    await ctx.jobs.enqueue({
      kind: POLL_JOB,
      payload: { lookupId: envelope.lookupId, rssItemId: target.rssItemId, polls },
      runAt: deps.now + POLL_DELAY_MS,
    });
    // The resolution stays `pending`: nothing is known about this item yet.
    return;
  }

  // 2. A non-media file, successfully identified. Terminal: folding this into
  //    `unresolved` would retry a subtitle forever and show it to a reader as
  //    a problem they cannot fix.
  if (envelope.refusal !== null) {
    await ctx.media.setResolution(target.rssItemId, 'refused', envelope.refusal);
    return;
  }

  // 3. Not an error either: the name was not recognised, which is the state a
  //    human might fix. Nothing is enqueued -- a retry happens on request.
  if (envelope.state === 'unresolved') {
    await ctx.media.setResolution(
      target.rssItemId,
      'unresolved',
      describeUnresolved(target.filename, envelope.suggestions),
    );
    return;
  }

  // 4. Impossible per the document, which requires `media` on every envelope
  //    and fills it for a resolved one. Thrown rather than skipped: a resolved
  //    answer this code cannot use is a service change, and a job that failed
  //    is how anyone finds out.
  if (envelope.media === null) {
    throw new Error(`openmetadata: lookup ${envelope.lookupId} resolved with no media`);
  }

  // 5. The answer.
  await applyResolved(envelope, envelope.media, target, deps);
}
```

- [ ] **Step 5: Run the branch test**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/engine-branch.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Write the resolved-path test**

`packages/openmetadata/test/engine-resolved.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { applyEnvelope } from '../src/engine.ts';
import { lookupTable, lookupTableMigration } from '../src/table.ts';
import { createTestHarness, resolvedEnvelope } from '../src/testing.ts';
import type { ApplyArgs } from '../src/engine.ts';
import type { Media } from '../src/types.ts';

const PLUGIN_ID = 'movie';
const NOW = 1_700_000_000_000;

function movieMedia(): Media {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    kind: 'movie',
    title: 'Dune: Part Two',
    releaseDate: '2024-03-01',
    year: 2024,
    provider: 'tmdb',
    providerRef: 'tmdb:movie:693134',
    overview: 'Paul unites with the Fremen.',
    details: { runtimeMinutes: 166 },
    parents: [],
    people: [
      { providerRef: 'tmdb:person:1', name: 'First Billed', role: 'cast', characterName: 'Paul', billingOrder: 0 },
      { providerRef: 'tmdb:person:2', name: 'Second Billed', role: 'cast', characterName: 'Chani', billingOrder: 1 },
      { providerRef: 'tmdb:person:1', name: 'First Billed', role: 'director', characterName: null, billingOrder: null },
    ],
  };
}

function fixture() {
  const harness = createTestHarness();
  lookupTableMigration(PLUGIN_ID).up(harness.raw);
  const rssItemId = harness.insertRssItem('dune.mkv');
  harness.raw.prepare(
    `INSERT INTO ${PLUGIN_ID}_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)`,
  ).run(rssItemId, NOW, NOW);
  const applied: ApplyArgs[] = [];
  const deps = {
    pluginId: PLUGIN_ID,
    ctx: harness.ctx,
    raw: harness.raw,
    db: drizzle({ client: harness.raw }),
    table: lookupTable(PLUGIN_ID),
    now: NOW,
    apply: async (args: ApplyArgs) => { applied.push(args); },
  };
  return { harness, deps, rssItemId, applied };
}

function stateRow(harness: ReturnType<typeof fixture>['harness']) {
  return harness.raw.prepare(
    `SELECT media_item_id, lookup_id, provider_ref, confidence, updated_at FROM ${PLUGIN_ID}_lookup`,
  ).get();
}

test('creates the media item from the answer and claims its provider reference', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-1', confidence: 0.94, media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  const item = harness.media.items.get(1);
  assert.equal(item?.title, 'Dune: Part Two');
  assert.equal(item?.releaseDate, '2024-03-01');
  // `description` comes from the answer's `overview`.
  assert.equal(item?.description, 'Paul unites with the Fremen.');
  assert.equal(item?.provider, 'tmdb');
  assert.equal(item?.providerRef, 'tmdb:movie:693134');
  assert.deepEqual(harness.media.resolutions.get(rssItemId), { resolution: 'resolved', detail: null });
});

test('records the lookup id, the reference and the confidence on its own row', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-2', confidence: 0.81, media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  assert.deepEqual(stateRow(harness), {
    media_item_id: 1,
    lookup_id: 'lookup-2',
    provider_ref: 'tmdb:movie:693134',
    confidence: 0.81,
    updated_at: NOW,
  });
});

test('hands the plugin the media item it should write against', async () => {
  const { deps, rssItemId, applied } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-3', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.mediaItemId, 1);
  assert.equal(applied[0]?.media.providerRef, 'tmdb:movie:693134');
  assert.equal(applied[0]?.now, NOW);
});

test('writes each person once and each part in billing order', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-4', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  // Three parts, two people: the same provider ref plays cast and director.
  assert.equal(harness.media.roles.length, 3);
  assert.deepEqual(harness.media.roles.map((role) => role.role), ['cast', 'cast', 'director']);
  assert.equal(harness.media.roles[0]?.personId, 1);
  assert.equal(harness.media.roles[1]?.personId, 2);
  assert.equal(harness.media.roles[2]?.personId, 1, 'one person, two parts');
  assert.equal(harness.media.roles[0]?.name, 'Paul');
  assert.equal(harness.media.roles[0]?.billingOrder, 0);
});

test('a lost claim drops our row, links the winner, and applies against it', async () => {
  const { harness, deps, rssItemId, applied } = fixture();
  harness.media.loseNextClaim(99);

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-5', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  const methods = harness.media.calls.map((call) => call.method);
  assert.deepEqual(methods.slice(0, 4), ['createMediaItem', 'claimProviderRef', 'dropMediaItem', 'relinkRssItem']);
  assert.equal(harness.media.items.has(1), false, 'the row that lost is gone');
  assert.deepEqual(harness.media.calls[3]?.args, [rssItemId, 99]);
  assert.equal(applied[0]?.mediaItemId, 99, 'the plugin writes against the winner');
  assert.equal(stateRow(harness)?.['media_item_id'], 99);
});

test('the resolution is written last, after the rows a reader would then look for', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-6', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  const methods = harness.media.calls.map((call) => call.method);
  assert.equal(methods.at(-1), 'setResolution');
});

test('a null confidence is stored as null rather than refused', async () => {
  const { harness, deps, rssItemId } = fixture();
  const envelope = { ...resolvedEnvelope({ lookupId: 'lookup-7', media: movieMedia() }), confidence: null };

  await applyEnvelope(envelope, { rssItemId, filename: 'dune.mkv', polls: 0 }, deps);

  assert.equal(stateRow(harness)?.['confidence'], null);
});
```

- [ ] **Step 7: Run it**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/engine-resolved.test.ts`
Expected: PASS, 7 tests. (The implementation from Step 4 already covers this path; if any test fails, fix `applyResolved` — do not edit the test to match.)

- [ ] **Step 8: Export the engine's public names**

Add to `packages/openmetadata/src/index.ts`:

```ts
export type { ApplyArgs, ApplyTarget, EnvelopeDeps, LookupDb, LookupStateTable } from './engine.ts';
export {
  LOOKUP_JOB,
  MAX_POLLS,
  POLL_DELAY_MS,
  POLL_JOB,
  applyEnvelope,
  describeUnresolved,
} from './engine.ts';
```

- [ ] **Step 9: Run the checks and commit**

Run: `npm run lint && npm run typecheck && npm run test:server`
Expected: all clean.

```bash
git add packages/openmetadata
git commit -m "Read a lookup answer in the one order that survives it: not-yet before state, a refusal before an unrecognised name, and the media item created only once something identified it"
```

---

### Task 7: The plugin factory

**Files:**
- Modify: `packages/openmetadata/src/engine.ts`, `packages/openmetadata/src/index.ts`
- Test: `packages/openmetadata/test/engine-jobs.test.ts`

**Interfaces:**
- Consumes: everything from Task 6, plus `createLookupClient` (Task 3) and `lookupTableMigration` (Task 5).
- Produces:

```ts
export interface LookupPluginSpec {
  readonly id: string;
  readonly mediaType: MediaType;
  readonly category: LookupCategory;
  /** This plugin's own migrations, from version 2 up. */
  readonly migrations: readonly Migration[];
  /** Job handlers beyond `lookup` and `poll`. */
  readonly jobs?: Readonly<Record<string, JobHandler>>;
  apply(args: ApplyArgs): Promise<void>;
}
export interface LookupPluginDeps {
  now: () => number;
  baseUrl: string;
  resolveSecret: SecretResolver;
}
export function createLookupPlugin(spec: LookupPluginSpec, deps: LookupPluginDeps): MediaPlugin;
```

- [ ] **Step 1: Write the failing test**

`packages/openmetadata/test/engine-jobs.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOKUP_JOB, POLL_JOB, createLookupPlugin } from '../src/engine.ts';
import {
  createFakeLookupService,
  createTestHarness,
  partialEnvelope,
  refusedEnvelope,
  resolvedEnvelope,
} from '../src/testing.ts';
import { MAX_BATCH } from '../src/client.ts';
import type { ApplyArgs } from '../src/engine.ts';
import type { LookupEnvelope, Media } from '../src/types.ts';

const NOW = 1_700_000_000_000;

function sceneMedia(providerRef: string): Media {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    kind: 'scene',
    title: 'A Scene',
    releaseDate: '2026-01-15',
    year: 2026,
    provider: 'tpdb',
    providerRef,
    overview: null,
    details: { siteName: 'A Site', siteRef: 'tpdb:site:7' },
    parents: [],
    people: [],
  };
}

/** The plugin under test: the engine, with an `apply` that only records. */
function build(service?: { fetch: ReturnType<typeof createFakeLookupService>['fetch'] }) {
  const applied: ApplyArgs[] = [];
  const plugin = createLookupPlugin({
    id: 'xxx',
    mediaType: 'xxx',
    category: 'xxx',
    migrations: [],
    apply: async (args) => { applied.push(args); },
  }, {
    now: () => NOW,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });
  const harness = service === undefined
    ? createTestHarness()
    : createTestHarness({ fetch: service.fetch });
  // The engine's own migration, plus whatever the spec added.
  for (const migration of plugin.migrations) migration.up(harness.raw);
  return { plugin, harness, applied };
}

test('carries the engine state table as migration 1, before the spec migrations', () => {
  const plugin = createLookupPlugin({
    id: 'xxx',
    mediaType: 'xxx',
    category: 'xxx',
    migrations: [{ version: 2, up: (db) => db.exec('CREATE TABLE xxx_own (id INTEGER PRIMARY KEY)') }],
    apply: async () => {},
  }, { now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'test-key' });

  assert.deepEqual(plugin.migrations.map((migration) => migration.version), [1, 2]);
  assert.equal(plugin.id, 'xxx');
  assert.equal(plugin.mediaType, 'xxx');
  assert.deepEqual(Object.keys(plugin.jobs).toSorted(), [LOOKUP_JOB, POLL_JOB]);
});

test('keeps a spec job handler alongside its own two', () => {
  const plugin = createLookupPlugin({
    id: 'xxx',
    mediaType: 'xxx',
    category: 'xxx',
    migrations: [],
    jobs: { sweep: async () => {} },
    apply: async () => {},
  }, { now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'test-key' });

  assert.deepEqual(Object.keys(plugin.jobs).toSorted(), [LOOKUP_JOB, POLL_JOB, 'sweep']);
});

test('records a row per new rss item and one lookup job for the batch', async () => {
  const { plugin, harness } = build();
  const first = harness.insertRssItem('a.mp4');
  const second = harness.insertRssItem('b.mp4');

  await plugin.onNewRssItems([first, second], harness.ctx);

  assert.equal(harness.enqueued.length, 1);
  assert.equal(harness.enqueued[0]?.kind, LOOKUP_JOB);
  assert.deepEqual(harness.enqueued[0]?.payload, { rssItemIds: [first, second] });
  const rows = harness.raw.prepare('SELECT rss_item_id, lookup_job_id FROM xxx_lookup ORDER BY rss_item_id').all();
  assert.deepEqual(rows, [
    { rss_item_id: first, lookup_job_id: 1 },
    { rss_item_id: second, lookup_job_id: 1 },
  ]);
});

test('asks about nothing, and enqueues nothing, for an empty batch', async () => {
  const { plugin, harness } = build();
  await plugin.onNewRssItems([], harness.ctx);
  assert.equal(harness.enqueued.length, 0);
  assert.equal(harness.raw.prepare('SELECT count(*) AS n FROM xxx_lookup').get()?.['n'], 0);
});

test('splits more than one batch of ids into one job each', async () => {
  const { plugin, harness } = build();
  const ids = Array.from({ length: MAX_BATCH + 1 }, (_, index) => harness.insertRssItem(`n-${index}.mp4`));

  await plugin.onNewRssItems(ids, harness.ctx);

  assert.equal(harness.enqueued.length, 2);
  assert.equal((harness.enqueued[0]?.payload as { rssItemIds: number[] }).rssItemIds.length, MAX_BATCH);
  assert.equal((harness.enqueued[1]?.payload as { rssItemIds: number[] }).rssItemIds.length, 1);
  // Each row records the job that covers it, not merely the last one enqueued.
  const last = harness.raw.prepare('SELECT lookup_job_id FROM xxx_lookup WHERE rss_item_id = ?')
    .get(ids.at(-1));
  assert.equal(last?.['lookup_job_id'], 2);
});

test('the lookup handler asks about every name in the payload and applies each answer', async () => {
  const batch = new Map<string, LookupEnvelope>([
    ['a.mp4', resolvedEnvelope({ lookupId: 'lookup-a', media: sceneMedia('tpdb:scene:1') })],
    ['b.mp4', refusedEnvelope({ lookupId: 'lookup-b', refusal: 'a sidecar' })],
  ]);
  const service = createFakeLookupService({ batch, polls: new Map() });
  const { plugin, harness, applied } = build(service);
  const first = harness.insertRssItem('a.mp4');
  const second = harness.insertRssItem('b.mp4');
  harness.raw.prepare('INSERT INTO xxx_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?), (?, ?, ?)')
    .run(first, NOW, NOW, second, NOW, NOW);

  const handler = plugin.jobs[LOOKUP_JOB];
  assert.ok(handler !== undefined);
  await handler({ id: 1, kind: LOOKUP_JOB, payload: { rssItemIds: [first, second] }, attempts: 1 }, harness.ctx);

  assert.deepEqual(service.batchRequests, [['a.mp4', 'b.mp4']]);
  assert.equal(applied.length, 1, 'only the resolved answer reaches the plugin');
  assert.equal(harness.media.resolutions.get(second)?.resolution, 'refused');
});

test('the poll handler asks by lookup id and applies what comes back', async () => {
  const service = createFakeLookupService({
    batch: new Map(),
    polls: new Map([['lookup-c', [resolvedEnvelope({ lookupId: 'lookup-c', media: sceneMedia('tpdb:scene:2') })]]]),
  });
  const { plugin, harness, applied } = build(service);
  const rssItemId = harness.insertRssItem('c.mp4');
  harness.raw.prepare('INSERT INTO xxx_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)')
    .run(rssItemId, NOW, NOW);

  const handler = plugin.jobs[POLL_JOB];
  assert.ok(handler !== undefined);
  await handler(
    { id: 2, kind: POLL_JOB, payload: { lookupId: 'lookup-c', rssItemId, polls: 1 }, attempts: 1 },
    harness.ctx,
  );

  assert.deepEqual(service.pollRequests, ['lookup-c']);
  assert.equal(applied.length, 1);
  assert.equal(harness.media.resolutions.get(rssItemId)?.resolution, 'resolved');
});

test('a still-partial poll schedules the next one, counting up', async () => {
  const service = createFakeLookupService({
    batch: new Map(),
    polls: new Map([['lookup-d', [partialEnvelope({ lookupId: 'lookup-d' })]]]),
  });
  const { plugin, harness } = build(service);
  const rssItemId = harness.insertRssItem('d.mp4');
  harness.raw.prepare('INSERT INTO xxx_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)')
    .run(rssItemId, NOW, NOW);

  const handler = plugin.jobs[POLL_JOB];
  assert.ok(handler !== undefined);
  await handler(
    { id: 3, kind: POLL_JOB, payload: { lookupId: 'lookup-d', rssItemId, polls: 4 }, attempts: 1 },
    harness.ctx,
  );

  assert.deepEqual(harness.enqueued[0]?.payload, { lookupId: 'lookup-d', rssItemId, polls: 5 });
});

test('a malformed payload throws naming what it should carry', async () => {
  const { plugin, harness } = build();
  const lookup = plugin.jobs[LOOKUP_JOB];
  const poll = plugin.jobs[POLL_JOB];
  assert.ok(lookup !== undefined && poll !== undefined);
  await assert.rejects(
    () => lookup({ id: 4, kind: LOOKUP_JOB, payload: {}, attempts: 1 }, harness.ctx),
    /rssItemIds/,
  );
  await assert.rejects(
    () => poll({ id: 5, kind: POLL_JOB, payload: { rssItemId: 1 }, attempts: 1 }, harness.ctx),
    /lookupId/,
  );
});

test('a name the payload names but the database does not throws rather than being skipped', async () => {
  const service = createFakeLookupService({ batch: new Map(), polls: new Map() });
  const { plugin, harness } = build(service);
  const lookup = plugin.jobs[LOOKUP_JOB];
  assert.ok(lookup !== undefined);
  await assert.rejects(
    () => lookup({ id: 6, kind: LOOKUP_JOB, payload: { rssItemIds: [404] }, attempts: 1 }, harness.ctx),
    /404/,
  );
});

test('the two entry points this slice does not develop still do something real', async () => {
  const { plugin, harness } = build();
  await plugin.onDownloadedFile({ path: '/downloads/a.mp4', sizeBytes: 10, downloadClientId: 1 }, harness.ctx);
  assert.match(harness.logs[0]?.message ?? '', /download/);
  await assert.rejects(
    () => plugin.onDownloadRequest(harness.insertRssItem('e.mp4'), harness.ctx),
    /download client/,
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/engine-jobs.test.ts`
Expected: FAIL — `createLookupPlugin` is not exported.

- [ ] **Step 3: Append the factory to `src/engine.ts`**

Add these imports at the top of the file:

```ts
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import type {
  JobHandler,
  MediaPlugin,
  MediaType,
  Migration,
} from '@pickarr/contract';
import { drizzle as createDrizzle } from 'drizzle-orm/node-sqlite';
import { inArray } from 'drizzle-orm';
import type { LookupCategory, SecretResolver } from './types.ts';
import { MAX_BATCH, createLookupClient } from './client.ts';
import { lookupTable, lookupTableMigration } from './table.ts';
```

(The existing `import type { DatabaseSync }` and `import type { drizzle }` lines are replaced by the value imports above; `LookupDb` becomes `ReturnType<typeof createDrizzle>`.)

Then append:

```ts
export interface LookupPluginSpec {
  /** Also the required prefix for every table this plugin declares. */
  readonly id: string;
  readonly mediaType: MediaType;
  /** The wire category. `movies` for `mediaType: 'movie'` -- the one asymmetry. */
  readonly category: LookupCategory;
  /**
   * This plugin's own migrations, from version 2 up: version 1 is the engine's
   * state table, prepended by `createLookupPlugin`.
   */
  readonly migrations: readonly Migration[];
  /** Job handlers beyond the engine's `lookup` and `poll`. */
  readonly jobs?: Readonly<Record<string, JobHandler>>;
  /** The plugin's own rows for one resolved answer. Must be idempotent. */
  apply(args: ApplyArgs): Promise<void>;
}

export interface LookupPluginDeps {
  now: () => number;
  baseUrl: string;
  resolveSecret: SecretResolver;
}

/**
 * `PluginContext.db` is `unknown` by contract: the host has never seen this
 * plugin's schema, so it cannot hand back a handle typed to it. Narrowed once,
 * here, at the cost of a runtime check -- there is no compile-time route from
 * `unknown` to a connection.
 */
function asDatabase(db: unknown): DatabaseSync {
  if (!(db instanceof DatabaseSync)) {
    throw new TypeError('openmetadata: ctx.db is not a node:sqlite DatabaseSync');
  }
  return db;
}

/** One Drizzle handle per connection, remembered rather than rebuilt per entry point. */
const handles = new WeakMap<DatabaseSync, LookupDb>();

function ownTables(ctx: PluginContext): { raw: DatabaseSync; db: LookupDb } {
  const raw = asDatabase(ctx.db);
  const existing = handles.get(raw);
  if (existing !== undefined) return { raw, db: existing };
  const db = createDrizzle({ client: raw });
  handles.set(raw, db);
  return { raw, db };
}

function readInteger(row: Record<string, SQLOutputValue>, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') throw new TypeError(`openmetadata: column ${column} is not an integer`);
  return value;
}

function readText(row: Record<string, SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new TypeError(`openmetadata: column ${column} is not text`);
  return value;
}

/**
 * The filenames to look up, in the caller's order.
 *
 * Hand-written SQL against a table this plugin does not own, and still
 * `ctx.db` rather than `ctx.read`: `MediaReader` reaches rss items only
 * *through* a media item (`rssItemsFor`), and these have none yet -- they are
 * exactly the items a poll just delivered and this lookup is about to
 * identify.
 *
 * The caller's order rather than the database's, because that order decides
 * which of two items claiming one provider reference wins the dedup.
 */
function readRssItems(raw: DatabaseSync, ids: readonly number[]): { id: number; filename: string }[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = raw.prepare(`SELECT id, filename FROM rss_item WHERE id IN (${placeholders})`).all(...ids);
  const byId = new Map(rows.map((row) => [readInteger(row, 'id'), readText(row, 'filename')]));
  return ids.map((id) => {
    const filename = byId.get(id);
    if (filename === undefined) throw new Error(`openmetadata: rss item ${id} does not exist`);
    return { id, filename };
  });
}

function readLookupPayload(payload: unknown): number[] {
  if (typeof payload !== 'object' || payload === null || !('rssItemIds' in payload)) {
    throw new TypeError('openmetadata: a lookup payload must carry rssItemIds');
  }
  const ids: unknown = payload.rssItemIds;
  if (!Array.isArray(ids)) throw new TypeError('openmetadata: rssItemIds is not an array');
  return ids.map((id: unknown) => {
    if (typeof id !== 'number') throw new TypeError('openmetadata: rssItemIds holds a non-number');
    return id;
  });
}

function readPollPayload(payload: unknown): { lookupId: string; rssItemId: number; polls: number } {
  if (typeof payload !== 'object' || payload === null
    || !('lookupId' in payload) || !('rssItemId' in payload) || !('polls' in payload)) {
    throw new TypeError('openmetadata: a poll payload must carry lookupId, rssItemId and polls');
  }
  const { lookupId, rssItemId, polls } = payload;
  if (typeof lookupId !== 'string' || typeof rssItemId !== 'number' || typeof polls !== 'number') {
    throw new TypeError('openmetadata: a poll payload must carry lookupId, rssItemId and polls');
  }
  return { lookupId, rssItemId, polls };
}

/**
 * A complete `MediaPlugin` from a spec.
 *
 * Everything the three media types share is here; what they do not share is
 * `spec.apply` and `spec.migrations`. See the slice's spec for why the flow is
 * shared rather than copied: the branch order in `applyEnvelope` is the part
 * that is subtle, and three copies of it would be three chances to get it
 * wrong.
 */
export function createLookupPlugin(spec: LookupPluginSpec, deps: LookupPluginDeps): MediaPlugin {
  const table = lookupTable(spec.id);

  function envelopeDeps(ctx: PluginContext, raw: DatabaseSync, db: LookupDb): EnvelopeDeps {
    return {
      pluginId: spec.id,
      ctx,
      raw,
      db,
      table,
      now: deps.now(),
      apply: spec.apply,
    };
  }

  function clientFor(ctx: PluginContext, signal?: AbortSignal) {
    // Two shapes rather than one literal with `signal: undefined`:
    // `exactOptionalPropertyTypes` makes those different things.
    return signal === undefined
      ? createLookupClient({ fetch: ctx.fetch, baseUrl: deps.baseUrl, resolveSecret: deps.resolveSecret })
      : createLookupClient({ fetch: ctx.fetch, baseUrl: deps.baseUrl, resolveSecret: deps.resolveSecret, signal });
  }

  const lookup: JobHandler = async (job, ctx, signal) => {
    const { raw, db } = ownTables(ctx);
    const items = readRssItems(raw, readLookupPayload(job.payload));
    const answers = await clientFor(ctx, signal).batch(spec.category, items.map((item) => item.filename));

    for (const [index, item] of items.entries()) {
      const envelope = answers[index];
      if (envelope === undefined) {
        // `batch` already refuses a length mismatch; this is the compiler's
        // own question about an indexed read, answered rather than asserted.
        throw new Error(`openmetadata: no answer for "${item.filename}"`);
      }
      // eslint-disable-next-line no-await-in-loop -- answers are applied in the order they were asked for, because that order decides which of two items claiming one provider ref wins the dedup
      await applyEnvelope(
        envelope,
        { rssItemId: item.id, filename: item.filename, polls: 0 },
        envelopeDeps(ctx, raw, db),
      );
    }
  };

  const poll: JobHandler = async (job, ctx, signal) => {
    const { raw, db } = ownTables(ctx);
    // The rss item comes from the payload, never from `job.id`: both are
    // numbers, so the wrong one compiles and quietly resolves a stranger.
    const { lookupId, rssItemId, polls } = readPollPayload(job.payload);
    const [item] = readRssItems(raw, [rssItemId]);
    if (item === undefined) throw new Error(`openmetadata: rss item ${rssItemId} does not exist`);
    const envelope = await clientFor(ctx, signal).poll(lookupId);
    // The same branch as the batch, so a poll that is still partial enqueues
    // the next one through the very code that enqueued this one.
    await applyEnvelope(
      envelope,
      { rssItemId, filename: item.filename, polls },
      envelopeDeps(ctx, raw, db),
    );
  };

  return {
    id: spec.id,
    mediaType: spec.mediaType,
    migrations: [lookupTableMigration(spec.id), ...spec.migrations],
    jobs: { ...spec.jobs, [LOOKUP_JOB]: lookup, [POLL_JOB]: poll },

    async onNewRssItems(ids, ctx) {
      if (ids.length === 0) return;
      const { db } = ownTables(ctx);
      const at = deps.now();

      await db.insert(table).values(ids.map((rssItemId) => ({
        rssItemId,
        mediaItemId: null,
        lookupJobId: null,
        lookupId: null,
        providerRef: null,
        confidence: null,
        createdAt: at,
        updatedAt: at,
      })));

      // One job per chunk the service will accept, so a poll that delivered
      // three hundred names does not enqueue a job that cannot be sent as one
      // request. `enqueue`'s return is recorded rather than discarded: a job
      // id nothing keeps is a job nobody can trace back to the rows it is
      // identifying.
      for (let start = 0; start < ids.length; start += MAX_BATCH) {
        const chunk = ids.slice(start, start + MAX_BATCH);
        // eslint-disable-next-line no-await-in-loop -- each chunk's job id is recorded on its own rows before the next chunk is enqueued, so a crash between chunks leaves no row pointing at a job that covers different items
        const jobId = await ctx.jobs.enqueue({ kind: LOOKUP_JOB, payload: { rssItemIds: [...chunk] } });
        // eslint-disable-next-line no-await-in-loop -- see above
        await db.update(table)
          .set({ lookupJobId: jobId, updatedAt: at })
          .where(inArray(table.rssItemId, [...chunk]));
      }
    },

    async onDownloadedFile(file, ctx) {
      // Importing is out of scope for this slice (the spec's §1.2). Logged
      // rather than thrown: a plugin that failed a job for work it was never
      // asked to do would dead-letter every completed download.
      ctx.log('a download finished', { path: file.path, sizeBytes: file.sizeBytes });
    },

    async onDownloadRequest(rssItemId, ctx) {
      const { raw } = ownTables(ctx);
      const row = raw.prepare(
        `SELECT rss_feed.download_client_id AS download_client_id
           FROM rss_item JOIN rss_feed ON rss_feed.id = rss_item.feed_id
          WHERE rss_item.id = ?`,
      ).get(rssItemId);
      const clientId = row === undefined ? null : (row as { download_client_id: SQLOutputValue }).download_client_id;
      if (typeof clientId !== 'number') {
        // The column's meaning is "the host's default client", and
        // `DownloadSubmission.downloadClientId` is a required number with no
        // way to say that. Picking one here would be a plugin inventing host
        // policy, so the gap is left visible as a failed job -- see the
        // spec's §6.
        throw new Error(
          `openmetadata: rss item ${rssItemId} is in a feed that names no download client, `
          + 'and a submission cannot say "the default"',
        );
      }
      const reference = await ctx.downloads.submit({ rssItemId, downloadClientId: clientId });
      ctx.log('submitted a download', { rssItemId, reference });
    },
  };
}
```

- [ ] **Step 3b: Log a failed request before letting it fail the job**

Two notes on the imports above: merge `inArray` into the existing `import { eq } from 'drizzle-orm'` line rather than adding a second import from the same module, and replace the file's `import type { DatabaseSync }` and `import type { drizzle }` lines with the value imports, since `asDatabase` needs the class and `ownTables` the function.

The spec's §3.7 says a failed request is logged with its status. Errors still propagate — that is how the runner learns to retry — so this logs and rethrows rather than catching. Add to `src/engine.ts`:

```ts
/**
 * The url without its query, for a log line.
 *
 * The key travels in a header and never in a url, so this is not redaction of
 * a credential -- it is keeping a log line short and stable. `@pickarr/host`'s
 * own `redactUrl` does the credential case, and this package cannot import it.
 */
function loggableUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(an unparseable url)';
  }
}

/**
 * Runs one request, naming the status when it fails.
 *
 * `FetchFailedError` carries a numeric `status` and is not exported to
 * plugins, so the status is read structurally rather than by `instanceof`: a
 * 401 (a bad or revoked key), a 429 and a 503 are all worth telling apart in a
 * log, and none of them is worth swallowing -- the throw is what fails the job
 * and puts it on the runner's backoff curve.
 */
async function logged<T>(ctx: PluginContext, baseUrl: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const status = error instanceof Error && 'status' in error && typeof error.status === 'number'
      ? error.status
      : null;
    ctx.log('a lookup request failed', {
      url: loggableUrl(baseUrl),
      status: status ?? 'none',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
```

and wrap both call sites:

```ts
    const answers = await logged(ctx, deps.baseUrl, () =>
      clientFor(ctx, signal).batch(spec.category, items.map((item) => item.filename)));
```

```ts
    const envelope = await logged(ctx, deps.baseUrl, () => clientFor(ctx, signal).poll(lookupId));
```

Then add this test to `test/engine-jobs.test.ts`:

```ts
test('a failed request is logged with its status, and still fails the job', async () => {
  const failing = {
    fetch: {
      async json(): Promise<never> {
        const error = new Error('failed: 429 Too Many Requests');
        Object.assign(error, { status: 429 });
        throw error;
      },
      async bytes(): Promise<never> { throw new Error('not used'); },
    },
  };
  const { plugin, harness } = build(failing);
  const rssItemId = harness.insertRssItem('f.mp4');
  const handler = plugin.jobs[LOOKUP_JOB];
  assert.ok(handler !== undefined);

  await assert.rejects(
    () => handler({ id: 7, kind: LOOKUP_JOB, payload: { rssItemIds: [rssItemId] }, attempts: 1 }, harness.ctx),
    /429/,
  );

  assert.match(harness.logs[0]?.message ?? '', /lookup request failed/);
  assert.equal(harness.logs[0]?.detail?.['status'], 429);
  // The key travels in a header, so no log line could carry it -- and this one
  // carries no query string either.
  assert.equal(harness.logs[0]?.detail?.['url'], 'https://openmetadata.test/');
});
```

`build()`'s parameter type widens to `{ fetch: HostFetch }` to accept this; import `HostFetch` from `@pickarr/contract` in the test file.

- [ ] **Step 4: Run the test**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/engine-jobs.test.ts`
Expected: PASS, 12 tests. The `onDownloadRequest` test needs `rss_feed` in the harness — if it fails on a missing table, add `CREATE TABLE rss_feed (id INTEGER PRIMARY KEY, download_client_id INTEGER)` and a `feed_id` column on the harness's `rss_item` stub in `src/testing.ts`, defaulting `feed_id` to a feed row the harness inserts with a null client.

- [ ] **Step 5: Export the factory**

Add to `packages/openmetadata/src/index.ts`:

```ts
export type { LookupPluginDeps, LookupPluginSpec } from './engine.ts';
export { createLookupPlugin } from './engine.ts';
```

- [ ] **Step 6: Run the checks and commit**

Run: `npm run lint && npm run typecheck && npm run test:server`
Expected: all clean.

```bash
git add packages/openmetadata
git commit -m "Turn a spec into a whole plugin, with one lookup job per batch the service will accept and each job's id recorded on the rows it identifies"
```

---

### Task 8: The host's secret and base-url resolvers

**Files:**
- Create: `packages/host/src/secrets.ts`
- Modify: `packages/host/src/main.ts`
- Test: `packages/host/test/secrets.test.ts`, `packages/host/test/main.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ResolveSecret`, `createEnvSecretResolver(env: Readonly<Record<string, string | undefined>>): ResolveSecret`, `OPENMETADATA_API_KEY_VARIABLE`; and from `main.ts`, `resolveOpenmetadataUrl(configured: string | undefined): string`.

- [ ] **Step 1: Write the failing tests**

`packages/host/test/secrets.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENMETADATA_API_KEY_VARIABLE, createEnvSecretResolver } from '../src/secrets.ts';

test('resolves a known key from the environment it was given', async () => {
  const resolve = createEnvSecretResolver({ [OPENMETADATA_API_KEY_VARIABLE]: 'from-the-env' });
  // The resolved value is a credential and is never an assertion operand:
  // what is asserted is that resolving succeeded and said something.
  const secret = await resolve('openmetadata-api-key');
  assert.equal(secret.length, 'from-the-env'.length);
});

test('names the variable to set when it is unset', async () => {
  const resolve = createEnvSecretResolver({});
  await assert.rejects(() => resolve('openmetadata-api-key'), new RegExp(OPENMETADATA_API_KEY_VARIABLE));
});

test('an empty variable is an unset one', async () => {
  const resolve = createEnvSecretResolver({ [OPENMETADATA_API_KEY_VARIABLE]: '' });
  await assert.rejects(() => resolve('openmetadata-api-key'), new RegExp(OPENMETADATA_API_KEY_VARIABLE));
});

test('refuses a key it has no variable for, rather than answering an empty string', async () => {
  const resolve = createEnvSecretResolver({});
  await assert.rejects(() => resolve('some-other-secret'), /some-other-secret/);
});
```

Append to `packages/host/test/main.test.ts`:

```ts
test('resolveOpenmetadataUrl defaults, and refuses what is not an origin', () => {
  assert.equal(resolveOpenmetadataUrl(undefined), 'https://openmetadata.nexus');
  assert.equal(resolveOpenmetadataUrl(''), 'https://openmetadata.nexus');
  assert.equal(resolveOpenmetadataUrl('https://metadata.example.test'), 'https://metadata.example.test');
  // A trailing slash is trimmed, so nothing downstream builds a double slash.
  assert.equal(resolveOpenmetadataUrl('https://metadata.example.test/'), 'https://metadata.example.test');
  assert.throws(() => resolveOpenmetadataUrl('metadata.example.test'), /PICKARR_OPENMETADATA_URL/);
  assert.throws(() => resolveOpenmetadataUrl('https://metadata.example.test/api'), /PICKARR_OPENMETADATA_URL/);
});
```

and add `resolveOpenmetadataUrl` to that file's existing import from `../src/main.ts`.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/secrets.test.ts packages/host/test/main.test.ts`
Expected: FAIL — `../src/secrets.ts` does not resolve, and `resolveOpenmetadataUrl` is not exported.

- [ ] **Step 3: Write `packages/host/src/secrets.ts`**

```ts
/**
 * How the host answers a plugin's request for a credential.
 *
 * A stub, and deliberately shaped like the thing that replaces it: a secret
 * store is being built elsewhere, and this is the seam it drops into. What
 * makes the seam worth having now is what it already prevents -- no plugin
 * reads `process.env`, so no plugin decides where a credential lives, and the
 * one place that does is this file.
 *
 * Async because the real store will be: a resolver called per request can
 * serve a rotated credential, where a value read once at boot cannot.
 */
export type ResolveSecret = (key: string) => Promise<string>;

/** The logical key the openmetadata plugins ask for. */
export const OPENMETADATA_API_KEY = 'openmetadata-api-key';

/** The variable it is read from. */
export const OPENMETADATA_API_KEY_VARIABLE = 'PICKARR_OPENMETADATA_KEY';

/** Logical key to environment variable. One entry per credential a plugin may ask for. */
const VARIABLES: Readonly<Record<string, string>> = {
  [OPENMETADATA_API_KEY]: OPENMETADATA_API_KEY_VARIABLE,
};

/**
 * Takes the environment rather than reading `process.env` itself, so it is
 * testable without mutating the environment the whole process shares -- the
 * same rule `main.ts`'s resolvers follow.
 *
 * **Rejects rather than answering an empty string.** A resolver that answered
 * `''` would send `Authorization: Bearer ` and the first lookup would fail
 * with a 401, which says nothing about what to fix. Rejecting names the
 * variable to set, and the job's error carries that name.
 */
export function createEnvSecretResolver(
  env: Readonly<Record<string, string | undefined>>,
): ResolveSecret {
  return async (key: string): Promise<string> => {
    const variable = VARIABLES[key];
    if (variable === undefined) {
      throw new Error(`no secret is configured for "${key}"`);
    }
    const value = env[variable];
    // An empty variable is an unset one, exactly as it is for every
    // `PICKARR_*` value `main.ts` resolves: `KEY=` is what a compose file with
    // the key and no value passes.
    if (value === undefined || value === '') {
      throw new Error(`${variable} is not set, and a lookup cannot authenticate without it`);
    }
    return value;
  };
}
```

- [ ] **Step 4: Add `resolveOpenmetadataUrl` to `packages/host/src/main.ts`**

Beside the other resolvers:

```ts
/** The lookup service's origin when nothing says otherwise. */
const DEFAULT_OPENMETADATA_URL = 'https://openmetadata.nexus';

/**
 * `PICKARR_OPENMETADATA_URL`: where the lookup service lives, for a test
 * deployment or a proxy. The default is the real service.
 *
 * **Refused at boot when it is not a bare http origin**, on the same
 * reasoning as `resolvePublicUrl`: the plugins append `/api/v1/lookup` to
 * this, so a value carrying a path builds a url nobody configured, and a
 * value that is not a url at all fails every lookup job with a message about
 * `fetch` rather than about configuration. A trailing slash is trimmed rather
 * than refused -- it is what an operator types, and it changes nothing.
 *
 * Takes the variable's value rather than reading `process.env` itself, so it
 * is testable without mutating the environment the whole process shares.
 */
export function resolveOpenmetadataUrl(configured: string | undefined): string {
  if (configured === undefined || configured === '') return DEFAULT_OPENMETADATA_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(`PICKARR_OPENMETADATA_URL is not a url: ${configured}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`PICKARR_OPENMETADATA_URL is not an http url: ${configured}`);
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`PICKARR_OPENMETADATA_URL must be an origin with no path: ${configured}`);
  }
  return parsed.origin;
}
```

- [ ] **Step 5: Run the tests and the checks**

Run: `node --import tsx --conditions development --test packages/host/test/secrets.test.ts packages/host/test/main.test.ts`
Expected: PASS.

Run: `npm run lint && npm run typecheck && npm run test-hygiene`
Expected: all clean. (`test-hygiene` rule 3 forbids handing a credential to `node:assert`; the tests above assert only a length and an error message.)

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/secrets.ts packages/host/src/main.ts packages/host/test/secrets.test.ts packages/host/test/main.test.ts
git commit -m "Give a plugin one way to ask for a credential, so no plugin reads the environment and the store being built elsewhere has one place to land"
```

---

### Task 9: `@pickarr/plugin-tv`

The only plugin whose answers have a hierarchy. **Read Task 1's spec amendment first**: which `details` keys carry the season and episode numbers is what that probe settled, and the two constants below (`SEASON_NUMBER_KEY`, `EPISODE_NUMBER_KEY`) take their values from it.

**Files:**
- Create: `packages/plugin-tv/package.json`, `packages/plugin-tv/tsconfig.json`, `packages/plugin-tv/src/migrations.ts`, `packages/plugin-tv/src/apply.ts`, `packages/plugin-tv/src/index.ts`
- Test: `packages/plugin-tv/test/apply.test.ts`

**Interfaces:**
- Consumes: `ApplyArgs`, `LookupPluginDeps`, `createLookupPlugin` (Tasks 6–7); `createTestHarness` (Task 6).
- Produces: `createTvPlugin(deps: LookupPluginDeps): MediaPlugin`, `applyTv(args: ApplyArgs): Promise<void>`, `TV_MIGRATIONS: readonly Migration[]`.

- [ ] **Step 1: Create the package**

`packages/plugin-tv/package.json`:

```json
{
  "name": "@pickarr/plugin-tv",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/index.js",
    "typecheck": "tsgo --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@pickarr/contract": "*",
    "@pickarr/openmetadata": "*"
  }
}
```

`packages/plugin-tv/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

Run `npm install` from the repo root.

- [ ] **Step 2: Write `src/migrations.ts`**

```ts
/**
 * One migration, three tables: a series, its seasons, and one row per
 * downloadable thing.
 *
 * Version 2, not 1: version 1 is the engine's own state table, prepended by
 * `createLookupPlugin`. Every name starts with `tv_` because `migratePlugin`
 * enforces the plugin's id as the prefix and rejects a migration that creates
 * anything else.
 */
import type { Migration } from '@pickarr/contract';

export const TV_MIGRATIONS: readonly Migration[] = [{
  version: 2,
  up: (db) => db.exec(`
CREATE TABLE tv_series (
  id             INTEGER PRIMARY KEY,
  provider       TEXT NOT NULL,
  provider_ref   TEXT NOT NULL,
  title          TEXT NOT NULL,
  first_air_date TEXT,
  overview       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX tv_series_provider_ref ON tv_series (provider, provider_ref);

CREATE TABLE tv_season (
  id            INTEGER PRIMARY KEY,
  series_id     INTEGER NOT NULL REFERENCES tv_series (id),
  provider      TEXT NOT NULL,
  provider_ref  TEXT NOT NULL,
  season_number INTEGER,
  title         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX tv_season_provider_ref ON tv_season (provider, provider_ref);

CREATE TABLE tv_release (
  id             INTEGER PRIMARY KEY,
  media_item_id  INTEGER NOT NULL REFERENCES media_item (id),
  kind           TEXT NOT NULL,
  series_id      INTEGER NOT NULL REFERENCES tv_series (id),
  season_id      INTEGER REFERENCES tv_season (id),
  episode_number INTEGER,
  details_json   TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX tv_release_media_item ON tv_release (media_item_id);
`),
}];
```

- [ ] **Step 3: Write the failing test**

`packages/plugin-tv/test/apply.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { Media, MediaKind, MediaParent } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyTv } from '../src/apply.ts';
import { TV_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;

function harnessWithTables() {
  const harness = createTestHarness();
  for (const migration of TV_MIGRATIONS) migration.up(harness.raw);
  return harness;
}

function parent(kind: MediaKind, providerRef: string, title: string): MediaParent {
  return {
    id: `id-${providerRef}`,
    kind,
    title,
    releaseDate: '2024-06-26',
    year: 2024,
    provider: 'tmdb',
    providerRef,
  };
}

function episode(overrides: Partial<Media> = {}): Media {
  return {
    ...parent('episode', 'tmdb:episode:1', 'Tomorrow'),
    overview: 'Carmy reopens.',
    details: { seasonNumber: 3, episodeNumber: 1 },
    parents: [
      parent('season', 'tmdb:season:10', 'Season 3'),
      parent('series', 'tmdb:series:100', 'The Bear'),
    ],
    people: [],
    ...overrides,
  };
}

async function apply(harness: ReturnType<typeof harnessWithTables>, media: Media, mediaItemId: number) {
  await applyTv({ media, mediaItemId, raw: harness.raw, ctx: harness.ctx, now: NOW });
}

function rows(raw: DatabaseSync, sql: string): Record<string, unknown>[] {
  return raw.prepare(sql).all() as Record<string, unknown>[];
}

test('an episode writes its series, its season and one release row', async () => {
  const harness = harnessWithTables();

  await apply(harness, episode(), 1);

  assert.deepEqual(rows(harness.raw, 'SELECT provider_ref, title, first_air_date FROM tv_series'), [
    { provider_ref: 'tmdb:series:100', title: 'The Bear', first_air_date: '2024-06-26' },
  ]);
  assert.deepEqual(rows(harness.raw, 'SELECT provider_ref, season_number, title FROM tv_season'), [
    { provider_ref: 'tmdb:season:10', season_number: 3, title: 'Season 3' },
  ]);
  assert.deepEqual(
    rows(harness.raw, 'SELECT media_item_id, kind, series_id, season_id, episode_number FROM tv_release'),
    [{ media_item_id: 1, kind: 'episode', series_id: 1, season_id: 1, episode_number: 1 }],
  );
});

test('keeps the details object verbatim, including a key nothing reads', async () => {
  const harness = harnessWithTables();

  await apply(harness, episode({ details: { seasonNumber: 3, episodeNumber: 1, airedOn: '2024-06-27' } }), 1);

  const stored = rows(harness.raw, 'SELECT details_json FROM tv_release')[0]?.['details_json'];
  assert.deepEqual(JSON.parse(String(stored)), { seasonNumber: 3, episodeNumber: 1, airedOn: '2024-06-27' });
});

test('a second episode of the same season adds one release and no second parent', async () => {
  const harness = harnessWithTables();

  await apply(harness, episode(), 1);
  await apply(harness, episode({
    ...parent('episode', 'tmdb:episode:2', 'Next Time'),
    details: { seasonNumber: 3, episodeNumber: 2 },
    parents: [parent('season', 'tmdb:season:10', 'Season 3'), parent('series', 'tmdb:series:100', 'The Bear')],
    overview: null,
    people: [],
  }), 2);

  assert.equal(rows(harness.raw, 'SELECT id FROM tv_series').length, 1);
  assert.equal(rows(harness.raw, 'SELECT id FROM tv_season').length, 1);
  assert.deepEqual(
    rows(harness.raw, 'SELECT media_item_id, episode_number FROM tv_release ORDER BY media_item_id'),
    [{ media_item_id: 1, episode_number: 1 }, { media_item_id: 2, episode_number: 2 }],
  );
});

test('re-applying the same answer updates the row rather than adding one', async () => {
  const harness = harnessWithTables();

  await apply(harness, episode(), 1);
  await applyTv({ media: episode(), mediaItemId: 1, raw: harness.raw, ctx: harness.ctx, now: NOW + 1000 });

  const release = rows(harness.raw, 'SELECT id, updated_at FROM tv_release');
  assert.equal(release.length, 1);
  assert.equal(release[0]?.['updated_at'], NOW + 1000);
});

test('a season pack links at the season level with no episode number', async () => {
  const harness = harnessWithTables();
  const season: Media = {
    ...parent('season', 'tmdb:season:10', 'Season 3'),
    overview: null,
    details: { seasonNumber: 3 },
    parents: [parent('series', 'tmdb:series:100', 'The Bear')],
    people: [],
  };

  await apply(harness, season, 5);

  assert.deepEqual(
    rows(harness.raw, 'SELECT kind, season_id, episode_number FROM tv_release'),
    [{ kind: 'season', season_id: 1, episode_number: null }],
  );
  assert.equal(rows(harness.raw, 'SELECT season_number FROM tv_season')[0]?.['season_number'], 3);
});

test('a series pack links at the series level with no season', async () => {
  const harness = harnessWithTables();
  const series: Media = {
    ...parent('series', 'tmdb:series:100', 'The Bear'),
    overview: 'A restaurant.',
    details: {},
    parents: [],
    people: [],
  };

  await apply(harness, series, 6);

  assert.deepEqual(
    rows(harness.raw, 'SELECT kind, season_id, episode_number FROM tv_release'),
    [{ kind: 'series', season_id: null, episode_number: null }],
  );
  assert.equal(rows(harness.raw, 'SELECT overview FROM tv_series')[0]?.['overview'], 'A restaurant.');
});

test('an episode whose parents name no series throws', async () => {
  const harness = harnessWithTables();
  await assert.rejects(
    () => apply(harness, episode({ parents: [parent('season', 'tmdb:season:10', 'Season 3')] }), 1),
    /series/,
  );
});

test('a kind that cannot be television throws', async () => {
  const harness = harnessWithTables();
  await assert.rejects(
    () => apply(harness, episode({ kind: 'movie' }), 1),
    /movie/,
  );
});

test('a missing episode number is stored as null rather than guessed', async () => {
  const harness = harnessWithTables();
  await apply(harness, episode({ details: { seasonNumber: 3 } }), 1);
  assert.equal(rows(harness.raw, 'SELECT episode_number FROM tv_release')[0]?.['episode_number'], null);
});

test('an episode with no season parent still records its series', async () => {
  const harness = harnessWithTables();

  await apply(harness, episode({ parents: [parent('series', 'tmdb:series:100', 'The Bear')] }), 1);

  assert.deepEqual(
    rows(harness.raw, 'SELECT kind, series_id, season_id FROM tv_release'),
    [{ kind: 'episode', series_id: 1, season_id: null }],
  );
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/plugin-tv/test/apply.test.ts`
Expected: FAIL — cannot resolve `../src/apply.ts`.

- [ ] **Step 5: Write `src/apply.ts`**

```ts
/**
 * One resolved answer, written as television.
 *
 * The shared `media_item` row is the engine's; these three tables are what
 * television has that a film does not -- a series, its seasons, and the
 * numbers that order an episode within them.
 *
 * Every write is an upsert keyed on the unique index behind it, because a job
 * the runner retries after a crash must re-write rather than duplicate a
 * series. `RETURNING id` on each upsert is what makes that possible in one
 * statement: a select-then-insert would race with a second episode of the same
 * season arriving in the next job.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { ApplyArgs, DetailValue, Media, MediaParent } from '@pickarr/openmetadata';

/**
 * Which `details` key carries a season number, and which an episode number.
 *
 * The OpenAPI document specifies `details` keys for `scene` and `movie` only,
 * so these two were settled by probing the live service -- see the slice
 * spec's §4.2. `details_json` on `tv_release` holds the whole object anyway,
 * so a key that turns out to be named differently costs a read, not a
 * migration.
 */
const SEASON_NUMBER_KEY = 'seasonNumber';
const EPISODE_NUMBER_KEY = 'episodeNumber';

function readInteger(row: Record<string, SQLOutputValue> | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value !== 'number') {
    throw new TypeError(`plugin-tv: expected an integer ${column}, got ${String(value)}`);
  }
  return value;
}

/**
 * A detail that should be a whole number, or null.
 *
 * Null rather than a guess: an episode number this plugin invented would order
 * a library wrongly and never say where the number came from.
 */
function wholeNumber(details: Readonly<Record<string, DetailValue>>, key: string): number | null {
  const value = details[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  // The service sends some numbers as strings; a string of digits is still the
  // number it says it is, and anything else is not a number at all.
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function upsertSeries(
  raw: DatabaseSync,
  series: MediaParent,
  overview: string | null,
  now: number,
): number {
  const row = raw.prepare(`
    INSERT INTO tv_series (provider, provider_ref, title, first_air_date, overview, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      title          = excluded.title,
      first_air_date = excluded.first_air_date,
      -- COALESCE, not a replacement: a series learned as an episode's parent
      -- has no overview to offer, and overwriting one we already have with
      -- null would lose it on the next episode.
      overview       = COALESCE(excluded.overview, tv_series.overview),
      updated_at     = excluded.updated_at
    RETURNING id
  `).get(series.provider, series.providerRef, series.title, series.releaseDate, overview, now, now);
  return readInteger(row, 'id');
}

function upsertSeason(
  raw: DatabaseSync,
  seriesId: number,
  season: MediaParent,
  seasonNumber: number | null,
  now: number,
): number {
  const row = raw.prepare(`
    INSERT INTO tv_season (series_id, provider, provider_ref, season_number, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      series_id     = excluded.series_id,
      season_number = COALESCE(excluded.season_number, tv_season.season_number),
      title         = excluded.title,
      updated_at    = excluded.updated_at
    RETURNING id
  `).get(seriesId, season.provider, season.providerRef, seasonNumber, season.title, now, now);
  return readInteger(row, 'id');
}

function upsertRelease(
  raw: DatabaseSync,
  release: {
    mediaItemId: number;
    kind: string;
    seriesId: number;
    seasonId: number | null;
    episodeNumber: number | null;
    details: Readonly<Record<string, DetailValue>>;
    now: number;
  },
): void {
  raw.prepare(`
    INSERT INTO tv_release
      (media_item_id, kind, series_id, season_id, episode_number, details_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (media_item_id) DO UPDATE SET
      kind           = excluded.kind,
      series_id      = excluded.series_id,
      season_id      = excluded.season_id,
      episode_number = excluded.episode_number,
      details_json   = excluded.details_json,
      updated_at     = excluded.updated_at
  `).run(
    release.mediaItemId,
    release.kind,
    release.seriesId,
    release.seasonId,
    release.episodeNumber,
    JSON.stringify(release.details),
    release.now,
    release.now,
  );
}

function parentOfKind(media: Media, kind: 'series' | 'season'): MediaParent | null {
  return media.parents.find((candidate) => candidate.kind === kind) ?? null;
}

/**
 * The three shapes a television feed delivers, and what each one records.
 *
 * A kind that cannot be television throws rather than writing a row: that is
 * either a service bug or a category sent wrongly, and a row for it would bury
 * the evidence in the library.
 */
export async function applyTv(args: ApplyArgs): Promise<void> {
  const { media, mediaItemId, raw, now } = args;

  if (media.kind !== 'episode' && media.kind !== 'season' && media.kind !== 'series') {
    throw new Error(`plugin-tv: a tv lookup answered with kind ${media.kind}`);
  }

  // The series is the answer itself for a full-series pack, and a parent
  // otherwise. `NOT NULL` on `tv_release.series_id` is why this is refused
  // rather than defaulted: every one of the three shapes names a series, and
  // inventing a placeholder would put a row in the library naming nothing.
  const series = media.kind === 'series' ? media : parentOfKind(media, 'series');
  if (series === null) {
    throw new Error(`plugin-tv: ${media.kind} ${media.providerRef} names no series`);
  }
  const seriesOverview = media.kind === 'series' ? media.overview : null;
  const seriesId = upsertSeries(raw, series, seriesOverview, now);

  // The season is the answer itself for a season pack, a parent for an
  // episode, and absent for a series pack -- or for an episode the service
  // gave no season parent for, which is a shape the schema allows.
  const season = media.kind === 'season' ? media : parentOfKind(media, 'season');
  const seasonId = season === null
    ? null
    : upsertSeason(raw, seriesId, season, wholeNumber(media.details, SEASON_NUMBER_KEY), now);

  upsertRelease(raw, {
    mediaItemId,
    kind: media.kind,
    seriesId,
    seasonId,
    episodeNumber: media.kind === 'episode' ? wholeNumber(media.details, EPISODE_NUMBER_KEY) : null,
    details: media.details,
    now,
  });
}
```

- [ ] **Step 6: Write `src/index.ts`**

```ts
import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyTv } from './apply.ts';
import { TV_MIGRATIONS } from './migrations.ts';

/** Also the required prefix for every table this plugin declares. */
export const TV_PLUGIN_ID = 'tv';

/**
 * The television plugin: the shared lookup flow, plus what a resolved answer
 * means for television.
 *
 * `category` is `tv`, which happens to equal the id here -- it does not for
 * the film plugin, whose wire category is `movies`.
 */
export function createTvPlugin(deps: LookupPluginDeps): MediaPlugin {
  return createLookupPlugin({
    id: TV_PLUGIN_ID,
    mediaType: 'tv',
    category: 'tv',
    migrations: TV_MIGRATIONS,
    apply: applyTv,
  }, deps);
}

export { applyTv } from './apply.ts';
export { TV_MIGRATIONS } from './migrations.ts';
```

- [ ] **Step 7: Run the tests and the checks**

Run: `node --import tsx --conditions development --test packages/plugin-tv/test/apply.test.ts`
Expected: PASS, 10 tests.

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-tv package.json package-lock.json
git commit -m "Record television as a series, its seasons, and one row per downloadable thing, so a season pack and an episode reach the same series by the same join"
```

---

### Task 10: `@pickarr/plugin-movie`

**Files:**
- Create: `packages/plugin-movie/package.json`, `packages/plugin-movie/tsconfig.json`, `packages/plugin-movie/src/migrations.ts`, `packages/plugin-movie/src/apply.ts`, `packages/plugin-movie/src/index.ts`
- Test: `packages/plugin-movie/test/apply.test.ts`

**Interfaces:**
- Consumes: `ApplyArgs`, `LookupPluginDeps`, `createLookupPlugin`, `createTestHarness`.
- Produces: `createMoviePlugin(deps: LookupPluginDeps): MediaPlugin`, `applyMovie(args: ApplyArgs): Promise<void>`, `MOVIE_MIGRATIONS`, `MOVIE_PLUGIN_ID = 'movie'`.

- [ ] **Step 1: Create the package**

`packages/plugin-movie/package.json` — as Task 9's, with `"name": "@pickarr/plugin-movie"` and the same two dependencies, the same `scripts`, the same `exports`:

```json
{
  "name": "@pickarr/plugin-movie",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/index.js",
    "typecheck": "tsgo --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@pickarr/contract": "*",
    "@pickarr/openmetadata": "*"
  }
}
```

`packages/plugin-movie/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

Run `npm install` from the repo root.

- [ ] **Step 2: Write `src/migrations.ts`**

```ts
/**
 * One table: what a film has beyond the shared `media_item` row.
 *
 * Version 2, because version 1 is the engine's state table. The four columns
 * are the four keys the OpenAPI document specifies for `kind: 'movie'`;
 * `details_json` is everything it sends that those four do not name.
 */
import type { Migration } from '@pickarr/contract';

export const MOVIE_MIGRATIONS: readonly Migration[] = [{
  version: 2,
  up: (db) => db.exec(`
CREATE TABLE movie_detail (
  id              INTEGER PRIMARY KEY,
  media_item_id   INTEGER NOT NULL REFERENCES media_item (id),
  runtime_minutes INTEGER,
  imdb_id         TEXT,
  tagline         TEXT,
  collection_name TEXT,
  details_json    TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX movie_detail_media_item ON movie_detail (media_item_id);
`),
}];
```

- [ ] **Step 3: Write the failing test**

`packages/plugin-movie/test/apply.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Media } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyMovie } from '../src/apply.ts';
import { MOVIE_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;

function harnessWithTables() {
  const harness = createTestHarness();
  for (const migration of MOVIE_MIGRATIONS) migration.up(harness.raw);
  return harness;
}

function movie(details: Media['details']): Media {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    kind: 'movie',
    title: 'Dune: Part Two',
    releaseDate: '2024-03-01',
    year: 2024,
    provider: 'tmdb',
    providerRef: 'tmdb:movie:693134',
    overview: 'Paul unites with the Fremen.',
    details,
    parents: [],
    people: [],
  };
}

function detailRow(harness: ReturnType<typeof harnessWithTables>) {
  return harness.raw.prepare(
    'SELECT media_item_id, runtime_minutes, imdb_id, tagline, collection_name, updated_at FROM movie_detail',
  ).get();
}

test('writes the four documented keys', async () => {
  const harness = harnessWithTables();

  await applyMovie({
    media: movie({ runtimeMinutes: 166, imdbId: 'tt15239678', tagline: 'Long live the fighters', collectionName: 'Dune' }),
    mediaItemId: 3,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  assert.deepEqual(detailRow(harness), {
    media_item_id: 3,
    runtime_minutes: 166,
    imdb_id: 'tt15239678',
    tagline: 'Long live the fighters',
    collection_name: 'Dune',
    updated_at: NOW,
  });
});

test('an absent or null key is null, not an empty string', async () => {
  const harness = harnessWithTables();

  await applyMovie({
    media: movie({ runtimeMinutes: 166, tagline: null }),
    mediaItemId: 4,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  const row = detailRow(harness);
  assert.equal(row?.['imdb_id'], null);
  assert.equal(row?.['tagline'], null);
  assert.equal(row?.['collection_name'], null);
});

test('keeps every details key verbatim', async () => {
  const harness = harnessWithTables();

  await applyMovie({
    media: movie({ runtimeMinutes: 166, budget: 190000000 }),
    mediaItemId: 5,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  const stored = harness.raw.prepare('SELECT details_json FROM movie_detail').get()?.['details_json'];
  assert.deepEqual(JSON.parse(String(stored)), { runtimeMinutes: 166, budget: 190000000 });
});

test('re-applying updates the one row', async () => {
  const harness = harnessWithTables();
  const args = { media: movie({ runtimeMinutes: 166 }), mediaItemId: 6, raw: harness.raw, ctx: harness.ctx };

  await applyMovie({ ...args, now: NOW });
  await applyMovie({ ...args, media: movie({ runtimeMinutes: 167 }), now: NOW + 500 });

  const rows = harness.raw.prepare('SELECT runtime_minutes, updated_at FROM movie_detail').all();
  assert.deepEqual(rows, [{ runtime_minutes: 167, updated_at: NOW + 500 }]);
});

test('a runtime the service sent as a string is still a number', async () => {
  const harness = harnessWithTables();
  await applyMovie({ media: movie({ runtimeMinutes: '166' }), mediaItemId: 7, raw: harness.raw, ctx: harness.ctx, now: NOW });
  assert.equal(detailRow(harness)?.['runtime_minutes'], 166);
});

test('a kind that is not a film throws', async () => {
  const harness = harnessWithTables();
  await assert.rejects(
    () => applyMovie({
      media: { ...movie({}), kind: 'episode' },
      mediaItemId: 8,
      raw: harness.raw,
      ctx: harness.ctx,
      now: NOW,
    }),
    /episode/,
  );
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/plugin-movie/test/apply.test.ts`
Expected: FAIL — cannot resolve `../src/apply.ts`.

- [ ] **Step 5: Write `src/apply.ts`**

```ts
/**
 * One resolved answer, written as a film.
 *
 * The simplest of the three: a film has no parent this slice models, so
 * `media.parents` is expected to be empty and is ignored if it is not. One
 * upsert keyed on the media item, so a retried job re-writes rather than
 * duplicating.
 */
import type { DetailValue } from '@pickarr/openmetadata';
import type { ApplyArgs } from '@pickarr/openmetadata';

/** A detail that should be a whole number, or null. A string of digits counts. */
function wholeNumber(details: Readonly<Record<string, DetailValue>>, key: string): number | null {
  const value = details[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** A detail that should be text, or null. A number is not a tagline. */
function text(details: Readonly<Record<string, DetailValue>>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function applyMovie(args: ApplyArgs): Promise<void> {
  const { media, mediaItemId, raw, now } = args;
  if (media.kind !== 'movie') {
    throw new Error(`plugin-movie: a movies lookup answered with kind ${media.kind}`);
  }

  raw.prepare(`
    INSERT INTO movie_detail
      (media_item_id, runtime_minutes, imdb_id, tagline, collection_name, details_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (media_item_id) DO UPDATE SET
      runtime_minutes = excluded.runtime_minutes,
      imdb_id         = excluded.imdb_id,
      tagline         = excluded.tagline,
      collection_name = excluded.collection_name,
      details_json    = excluded.details_json,
      updated_at      = excluded.updated_at
  `).run(
    mediaItemId,
    wholeNumber(media.details, 'runtimeMinutes'),
    text(media.details, 'imdbId'),
    text(media.details, 'tagline'),
    text(media.details, 'collectionName'),
    JSON.stringify(media.details),
    now,
    now,
  );
}
```

- [ ] **Step 6: Write `src/index.ts`**

```ts
import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyMovie } from './apply.ts';
import { MOVIE_MIGRATIONS } from './migrations.ts';

/** Also the required prefix for every table this plugin declares. */
export const MOVIE_PLUGIN_ID = 'movie';

/**
 * The film plugin.
 *
 * `id` and `mediaType` are `movie`, singular, because that is the contract's
 * `MediaType`; `category` is `movies`, plural, because that is the wire
 * vocabulary. The two meet here and nowhere else.
 */
export function createMoviePlugin(deps: LookupPluginDeps): MediaPlugin {
  return createLookupPlugin({
    id: MOVIE_PLUGIN_ID,
    mediaType: 'movie',
    category: 'movies',
    migrations: MOVIE_MIGRATIONS,
    apply: applyMovie,
  }, deps);
}

export { applyMovie } from './apply.ts';
export { MOVIE_MIGRATIONS } from './migrations.ts';
```

- [ ] **Step 7: Run the tests and the checks**

Run: `node --import tsx --conditions development --test packages/plugin-movie/test/apply.test.ts`
Expected: PASS, 6 tests.

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-movie package.json package-lock.json
git commit -m "Record a film's four documented details, and keep the rest of what the service sends beside them"
```

---

### Task 11: `@pickarr/plugin-xxx`

**Files:**
- Create: `packages/plugin-xxx/package.json`, `packages/plugin-xxx/tsconfig.json`, `packages/plugin-xxx/src/migrations.ts`, `packages/plugin-xxx/src/apply.ts`, `packages/plugin-xxx/src/index.ts`
- Test: `packages/plugin-xxx/test/apply.test.ts`

**Interfaces:**
- Consumes: `ApplyArgs`, `LookupPluginDeps`, `createLookupPlugin`, `createTestHarness`.
- Produces: `createXxxPlugin(deps: LookupPluginDeps): MediaPlugin`, `applyXxx(args: ApplyArgs): Promise<void>`, `XXX_MIGRATIONS`, `XXX_PLUGIN_ID = 'xxx'`.

- [ ] **Step 1: Create the package**

`packages/plugin-xxx/package.json`:

```json
{
  "name": "@pickarr/plugin-xxx",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/index.js",
    "typecheck": "tsgo --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@pickarr/contract": "*",
    "@pickarr/openmetadata": "*"
  }
}
```

`packages/plugin-xxx/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

Run `npm install` from the repo root.

- [ ] **Step 2: Write `src/migrations.ts`**

```ts
/**
 * Two tables: the producing site, and the scene itself.
 *
 * The site is its own table because scenes from one site share it -- a scene's
 * `details` names the site every time, and a row per scene would store the
 * same name a thousand times and still have nowhere to hang a site's own
 * artwork or url later.
 *
 * Version 2, because version 1 is the engine's state table.
 */
import type { Migration } from '@pickarr/contract';

export const XXX_MIGRATIONS: readonly Migration[] = [{
  version: 2,
  up: (db) => db.exec(`
CREATE TABLE xxx_site (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX xxx_site_provider_ref ON xxx_site (provider, provider_ref);

CREATE TABLE xxx_scene (
  id               INTEGER PRIMARY KEY,
  media_item_id    INTEGER NOT NULL REFERENCES media_item (id),
  site_id          INTEGER REFERENCES xxx_site (id),
  duration_seconds INTEGER,
  released_on      TEXT,
  details_json     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX xxx_scene_media_item ON xxx_scene (media_item_id);
`),
}];
```

- [ ] **Step 3: Write the failing test**

`packages/plugin-xxx/test/apply.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Media } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyXxx } from '../src/apply.ts';
import { XXX_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;

function harnessWithTables() {
  const harness = createTestHarness();
  for (const migration of XXX_MIGRATIONS) migration.up(harness.raw);
  return harness;
}

function scene(providerRef: string, details: Media['details']): Media {
  return {
    id: `id-${providerRef}`,
    kind: 'scene',
    title: 'A Scene',
    releaseDate: '2026-01-15',
    year: 2026,
    provider: 'tpdb',
    providerRef,
    overview: null,
    details,
    parents: [],
    people: [],
  };
}

const SITE = { siteName: 'A Site', siteRef: 'tpdb:site:7' };

test('writes the site and the scene', async () => {
  const harness = harnessWithTables();

  await applyXxx({
    media: scene('tpdb:scene:1', { ...SITE, durationSeconds: 1800, releasedOn: '2026-01-15' }),
    mediaItemId: 2,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  assert.deepEqual(harness.raw.prepare('SELECT provider, provider_ref, name FROM xxx_site').all(), [
    { provider: 'tpdb', provider_ref: 'tpdb:site:7', name: 'A Site' },
  ]);
  assert.deepEqual(
    harness.raw.prepare('SELECT media_item_id, site_id, duration_seconds, released_on FROM xxx_scene').get(),
    { media_item_id: 2, site_id: 1, duration_seconds: 1800, released_on: '2026-01-15' },
  );
});

test('two scenes from one site share the site row', async () => {
  const harness = harnessWithTables();
  const common = { raw: harness.raw, ctx: harness.ctx, now: NOW };

  await applyXxx({ ...common, media: scene('tpdb:scene:1', SITE), mediaItemId: 1 });
  await applyXxx({ ...common, media: scene('tpdb:scene:2', SITE), mediaItemId: 2 });

  assert.equal(harness.raw.prepare('SELECT count(*) AS n FROM xxx_site').get()?.['n'], 1);
  assert.deepEqual(
    harness.raw.prepare('SELECT media_item_id, site_id FROM xxx_scene ORDER BY media_item_id').all(),
    [{ media_item_id: 1, site_id: 1 }, { media_item_id: 2, site_id: 1 }],
  );
});

test('a scene whose details name no site is still recorded', async () => {
  const harness = harnessWithTables();

  await applyXxx({
    media: scene('tpdb:scene:3', { durationSeconds: 600 }),
    mediaItemId: 3,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  assert.equal(harness.raw.prepare('SELECT count(*) AS n FROM xxx_site').get()?.['n'], 0);
  assert.equal(harness.raw.prepare('SELECT site_id FROM xxx_scene').get()?.['site_id'], null);
});

test('a site named without a reference is not written, since nothing could key it', async () => {
  const harness = harnessWithTables();

  await applyXxx({
    media: scene('tpdb:scene:4', { siteName: 'A Site' }),
    mediaItemId: 4,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  assert.equal(harness.raw.prepare('SELECT count(*) AS n FROM xxx_site').get()?.['n'], 0);
  assert.equal(harness.raw.prepare('SELECT site_id FROM xxx_scene').get()?.['site_id'], null);
});

test('a renamed site updates its row rather than adding one', async () => {
  const harness = harnessWithTables();
  const common = { raw: harness.raw, ctx: harness.ctx };

  await applyXxx({ ...common, media: scene('tpdb:scene:1', SITE), mediaItemId: 1, now: NOW });
  await applyXxx({
    ...common,
    media: scene('tpdb:scene:2', { siteName: 'A Site Renamed', siteRef: 'tpdb:site:7' }),
    mediaItemId: 2,
    now: NOW + 100,
  });

  assert.deepEqual(harness.raw.prepare('SELECT name, updated_at FROM xxx_site').all(), [
    { name: 'A Site Renamed', updated_at: NOW + 100 },
  ]);
});

test('keeps every details key verbatim, and falls back to the answer date', async () => {
  const harness = harnessWithTables();

  await applyXxx({
    media: scene('tpdb:scene:5', { ...SITE, unexpected: 'kept' }),
    mediaItemId: 5,
    raw: harness.raw,
    ctx: harness.ctx,
    now: NOW,
  });

  const row = harness.raw.prepare('SELECT released_on, details_json FROM xxx_scene').get();
  // `releasedOn` was absent, so the answer's own `releaseDate` stands in --
  // one date for a reader, rather than a null beside a date the media item has.
  assert.equal(row?.['released_on'], '2026-01-15');
  assert.deepEqual(JSON.parse(String(row?.['details_json'])), { ...SITE, unexpected: 'kept' });
});

test('a kind that is not a scene throws', async () => {
  const harness = harnessWithTables();
  await assert.rejects(
    () => applyXxx({
      media: { ...scene('tpdb:scene:6', SITE), kind: 'movie' },
      mediaItemId: 6,
      raw: harness.raw,
      ctx: harness.ctx,
      now: NOW,
    }),
    /movie/,
  );
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/plugin-xxx/test/apply.test.ts`
Expected: FAIL — cannot resolve `../src/apply.ts`.

- [ ] **Step 5: Write `src/apply.ts`**

```ts
/**
 * One resolved answer, written as a scene.
 *
 * The site is upserted first and the scene points at it, so scenes from one
 * site share a row. Both writes are upserts keyed on a unique index, because a
 * retried job must re-write rather than duplicate.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { ApplyArgs, DetailValue } from '@pickarr/openmetadata';

function wholeNumber(details: Readonly<Record<string, DetailValue>>, key: string): number | null {
  const value = details[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function text(details: Readonly<Record<string, DetailValue>>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readInteger(row: Record<string, SQLOutputValue> | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value !== 'number') {
    throw new TypeError(`plugin-xxx: expected an integer ${column}, got ${String(value)}`);
  }
  return value;
}

function upsertSite(
  raw: DatabaseSync,
  site: { provider: string; providerRef: string; name: string },
  now: number,
): number {
  const row = raw.prepare(`
    INSERT INTO xxx_site (provider, provider_ref, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      name       = excluded.name,
      updated_at = excluded.updated_at
    RETURNING id
  `).get(site.provider, site.providerRef, site.name, now, now);
  return readInteger(row, 'id');
}

export async function applyXxx(args: ApplyArgs): Promise<void> {
  const { media, mediaItemId, raw, now } = args;
  if (media.kind !== 'scene') {
    throw new Error(`plugin-xxx: an xxx lookup answered with kind ${media.kind}`);
  }

  const siteName = text(media.details, 'siteName');
  const siteRef = text(media.details, 'siteRef');
  // Both, or neither. A name with no reference has nothing to key a row on,
  // and keying on the name would merge two sites that renamed into each
  // other's previous name -- so it is recorded in `details_json` and nowhere
  // else. A scene whose site is unknown is still a scene worth having.
  const siteId = siteName !== null && siteRef !== null
    ? upsertSite(raw, { provider: media.provider, providerRef: siteRef, name: siteName }, now)
    : null;

  raw.prepare(`
    INSERT INTO xxx_scene
      (media_item_id, site_id, duration_seconds, released_on, details_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (media_item_id) DO UPDATE SET
      site_id          = excluded.site_id,
      duration_seconds = excluded.duration_seconds,
      released_on      = excluded.released_on,
      details_json     = excluded.details_json,
      updated_at       = excluded.updated_at
  `).run(
    mediaItemId,
    siteId,
    wholeNumber(media.details, 'durationSeconds'),
    // The detail when the service sends one, else the answer's own release
    // date: one date for a reader rather than a null beside a date the media
    // item already has.
    text(media.details, 'releasedOn') ?? media.releaseDate,
    JSON.stringify(media.details),
    now,
    now,
  );
}
```

- [ ] **Step 6: Write `src/index.ts`**

```ts
import type { MediaPlugin } from '@pickarr/contract';
import type { LookupPluginDeps } from '@pickarr/openmetadata';
import { createLookupPlugin } from '@pickarr/openmetadata';
import { applyXxx } from './apply.ts';
import { XXX_MIGRATIONS } from './migrations.ts';

/** Also the required prefix for every table this plugin declares. */
export const XXX_PLUGIN_ID = 'xxx';

export function createXxxPlugin(deps: LookupPluginDeps): MediaPlugin {
  return createLookupPlugin({
    id: XXX_PLUGIN_ID,
    mediaType: 'xxx',
    category: 'xxx',
    migrations: XXX_MIGRATIONS,
    apply: applyXxx,
  }, deps);
}

export { applyXxx } from './apply.ts';
export { XXX_MIGRATIONS } from './migrations.ts';
```

- [ ] **Step 7: Run the tests and the checks**

Run: `node --import tsx --conditions development --test packages/plugin-xxx/test/apply.test.ts`
Expected: PASS, 7 tests.

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-xxx package.json package-lock.json
git commit -m "Give scenes a site of their own, keyed on the provider's reference so two sites that swapped names cannot merge"
```

---

### Task 12: Run the three in the process

**Files:**
- Modify: `packages/host/src/main.ts`, `packages/host/package.json`, `package.json`
- Test: `packages/host/test/plugins/flow.test.ts`, `packages/host/test/main.test.ts`

**Interfaces:**
- Consumes: `createTvPlugin`, `createMoviePlugin`, `createXxxPlugin` (Tasks 9–11); `createEnvSecretResolver`, `resolveOpenmetadataUrl` (Task 8); `createFakeLookupService` (Task 4).
- Produces: `shippedPlugins(deps: { now: () => number; resolveSecret: ResolveSecret; baseUrl: string }): readonly MediaPlugin[]`.

- [ ] **Step 1: Declare the dependencies**

In `packages/host/package.json`, add to `dependencies`:

```json
    "@pickarr/plugin-movie": "*",
    "@pickarr/plugin-tv": "*",
    "@pickarr/plugin-xxx": "*"
```

In the root `package.json`, the `build` script becomes — dependencies first, host last:

```json
    "build": "npm run build -w @pickarr/contract -w @pickarr/plugin-api -w @pickarr/openmetadata -w @pickarr/plugin-tv -w @pickarr/plugin-movie -w @pickarr/plugin-xxx -w @pickarr/plugin-scenes -w @pickarr/core -w @pickarr/web -w @pickarr/host"
```

Run `npm install` from the repo root.

- [ ] **Step 2: Write the failing flow test**

`packages/host/test/plugins/flow.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { createFakeLookupService, resolvedEnvelope } from '@pickarr/openmetadata/testing';
import type { LookupEnvelope, Media } from '@pickarr/openmetadata';
import { LOOKUP_JOB } from '@pickarr/openmetadata';
import { createMoviePlugin } from '@pickarr/plugin-movie';
import { createTvPlugin } from '@pickarr/plugin-tv';
import { createXxxPlugin } from '@pickarr/plugin-xxx';
import { migrateHost, migratePlugin } from '../../src/db/migrate.ts';
import { openTestDatabase } from '../../src/db/open.ts';

const NOW = 1_700_000_000_000;

function media(fields: Partial<Media> & Pick<Media, 'kind' | 'providerRef'>): Media {
  return {
    id: `id-${fields.providerRef}`,
    title: 'A Title',
    releaseDate: '2026-01-15',
    year: 2026,
    provider: 'tmdb',
    overview: null,
    details: {},
    parents: [],
    people: [],
    ...fields,
  };
}

const SCRIPT = new Map<string, LookupEnvelope>([
  ['episode.mkv', resolvedEnvelope({
    lookupId: 'lookup-tv',
    media: media({
      kind: 'episode',
      providerRef: 'tmdb:episode:1',
      title: 'Tomorrow',
      details: { seasonNumber: 3, episodeNumber: 1 },
      parents: [
        { id: 's', kind: 'season', title: 'Season 3', releaseDate: null, year: 2024, provider: 'tmdb', providerRef: 'tmdb:season:10' },
        { id: 'e', kind: 'series', title: 'The Bear', releaseDate: null, year: 2022, provider: 'tmdb', providerRef: 'tmdb:series:100' },
      ],
      people: [{ providerRef: 'tmdb:person:1', name: 'A Actor', role: 'cast', characterName: 'Carmy', billingOrder: 0 }],
    }),
  })],
  ['film.mkv', resolvedEnvelope({
    lookupId: 'lookup-movie',
    media: media({ kind: 'movie', providerRef: 'tmdb:movie:1', title: 'A Film', details: { runtimeMinutes: 120 } }),
  })],
  ['scene.mp4', resolvedEnvelope({
    lookupId: 'lookup-xxx',
    media: media({
      kind: 'scene',
      provider: 'tpdb',
      providerRef: 'tpdb:scene:1',
      title: 'A Scene',
      details: { siteName: 'A Site', siteRef: 'tpdb:site:7', durationSeconds: 1800 },
    }),
  })],
]);

/** A host database with the three plugins migrated, and one feed and item each. */
function fixture() {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const service = createFakeLookupService({ batch: SCRIPT, polls: new Map() });
  const deps = {
    now: () => NOW,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  };
  const plugins = [createTvPlugin(deps), createMoviePlugin(deps), createXxxPlugin(deps)];
  for (const plugin of plugins) migratePlugin(raw, plugin.id, plugin.migrations);
  return { raw, service, plugins };
}

function seedFeed(raw: DatabaseSync, pluginId: string, filename: string): { feedId: number; rssItemId: number } {
  const feed = raw.prepare(
    `INSERT INTO rss_feed (plugin_id, name, url, poll_interval_s, created_at, updated_at)
     VALUES (?, ?, ?, 900, ?, ?) RETURNING id`,
  ).get(pluginId, `${pluginId} feed`, `https://feed.test/${pluginId}`, NOW, NOW);
  const feedId = Number((feed as { id: unknown }).id);
  const item = raw.prepare(
    `INSERT INTO rss_item (feed_id, filename, link, resolution, download_type, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'torrent', ?, ?) RETURNING id`,
  ).get(feedId, filename, `https://feed.test/${filename}`, NOW, NOW);
  return { feedId, rssItemId: Number((item as { id: unknown }).id) };
}

test('every plugin table carries its own prefix, as migratePlugin demands', () => {
  const { raw, plugins } = fixture();
  const names = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((row) => String((row as { name: unknown }).name));

  for (const plugin of plugins) {
    const mine = names.filter((name) => name.startsWith(`${plugin.id}_`));
    assert.ok(mine.length > 0, `${plugin.id} created no tables`);
  }
  assert.ok(names.includes('tv_release'));
  assert.ok(names.includes('movie_detail'));
  assert.ok(names.includes('xxx_scene'));
});

test('each plugin identifies its own feed item end to end', async () => {
  const { raw, service, plugins } = fixture();
  const seeds = [
    { plugin: plugins[0], ...seedFeed(raw, 'tv', 'episode.mkv') },
    { plugin: plugins[1], ...seedFeed(raw, 'movie', 'film.mkv') },
    { plugin: plugins[2], ...seedFeed(raw, 'xxx', 'scene.mp4') },
  ];

  for (const seed of seeds) {
    const plugin = seed.plugin;
    assert.ok(plugin !== undefined);
    const ctx = contextFor(raw, plugin.id, service.fetch);
    // eslint-disable-next-line no-await-in-loop -- each plugin's items are delivered in turn, as the host delivers them
    await plugin.onNewRssItems([seed.rssItemId], ctx);
    const handler = plugin.jobs[LOOKUP_JOB];
    assert.ok(handler !== undefined);
    // eslint-disable-next-line no-await-in-loop -- see above
    await handler({ id: 1, kind: LOOKUP_JOB, payload: { rssItemIds: [seed.rssItemId] }, attempts: 1 }, ctx);
  }

  const items = raw.prepare('SELECT plugin_id, title, provider_ref FROM media_item ORDER BY plugin_id').all();
  assert.deepEqual(items, [
    { plugin_id: 'movie', title: 'A Film', provider_ref: 'tmdb:movie:1' },
    { plugin_id: 'tv', title: 'Tomorrow', provider_ref: 'tmdb:episode:1' },
    { plugin_id: 'xxx', title: 'A Scene', provider_ref: 'tpdb:scene:1' },
  ]);
  assert.deepEqual(
    raw.prepare('SELECT resolution FROM rss_item ORDER BY id').all(),
    [{ resolution: 'resolved' }, { resolution: 'resolved' }, { resolution: 'resolved' }],
  );
  assert.deepEqual(raw.prepare('SELECT name FROM person').all(), [{ name: 'A Actor' }]);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM role').get()?.['n'], 1);
  assert.equal(raw.prepare('SELECT series_id FROM tv_release').get()?.['series_id'], 1);
  assert.equal(raw.prepare('SELECT site_id FROM xxx_scene').get()?.['site_id'], 1);
});
```

The per-plugin `PluginContext` is built from the host's own wiring rather than a fake, so this test exercises the real writer, reader and migrations. Add these imports and this helper above the tests — and have `fixture()` return `db` from `openTestDatabase()` alongside `raw`, since the writer takes the Drizzle handle and the reader the raw connection:

```ts
import type { HostFetch, JobEnqueue, PluginContext } from '@pickarr/contract';
import type { ArtworkStore } from '../../src/artwork/store.ts';
import type { HostDb } from '../../src/db/open.ts';
import { createMediaReader } from '../../src/media/reader.ts';
import { createMediaWriter } from '../../src/media/writer.ts';

/**
 * Nothing in this test attaches artwork -- the lookup API offers no image
 * urls -- so the store fails loudly rather than writing to a temp directory
 * this test would then have to clean up.
 */
const unusedArtwork: ArtworkStore = {
  put: async () => { throw new Error('artwork.put: this flow attaches no artwork'); },
  remove: async () => { throw new Error('artwork.remove: this flow removes no artwork'); },
};

/** The real writer and reader, the real connection, and one recording job queue per plugin. */
function contextFor(
  raw: DatabaseSync,
  db: HostDb,
  pluginId: string,
  fetch: HostFetch,
): { ctx: PluginContext; enqueued: JobEnqueue[] } {
  const enqueued: JobEnqueue[] = [];
  return {
    ctx: {
      db: raw,
      media: createMediaWriter(db, () => NOW, unusedArtwork),
      read: createMediaReader(raw, pluginId),
      jobs: {
        async enqueue(job: JobEnqueue): Promise<number> {
          enqueued.push(job);
          return enqueued.length;
        },
      },
      fetch,
      downloads: {
        async submit(): Promise<string | null> {
          throw new Error('downloads.submit: this flow submits nothing');
        },
      },
      log: () => {},
    },
    enqueued,
  };
}
```

The test body then reads `const { ctx } = contextFor(raw, db, plugin.id, service.fetch);` in place of the `contextFor(raw, plugin.id, service.fetch)` call shown above.

- [ ] **Step 3: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/host/test/plugins/flow.test.ts`
Expected: FAIL — the plugin packages are not yet dependencies of `@pickarr/host`, or `contextFor` is not defined. Fix the test's own wiring until the failure is about the code under test rather than the harness.

- [ ] **Step 4: Replace `SHIPPED_PLUGINS` in `main.ts`**

Delete the `SHIPPED_PLUGINS` const and its comment, and add:

```ts
/**
 * The plugins the shipped process runs with.
 *
 * A function rather than a const, because each plugin needs `now`, the base
 * url and the secret resolver injected -- and because nothing in this module
 * may run at module scope. `main` calls it; a test passes `deps.plugins`
 * instead and never reaches it.
 *
 * Three plugins, three media types, three wire categories. `createPluginIdForType`
 * in `host.ts` refuses two plugins claiming one media type, so this list
 * cannot grow a duplicate unnoticed.
 */
export function shippedPlugins(deps: {
  now: () => number;
  resolveSecret: ResolveSecret;
  baseUrl: string;
}): readonly MediaPlugin[] {
  return [createTvPlugin(deps), createMoviePlugin(deps), createXxxPlugin(deps)];
}
```

with these imports:

```ts
import { createMoviePlugin } from '@pickarr/plugin-movie';
import { createTvPlugin } from '@pickarr/plugin-tv';
import { createXxxPlugin } from '@pickarr/plugin-xxx';
import type { ResolveSecret } from './secrets.ts';
import { createEnvSecretResolver } from './secrets.ts';
```

Then in `main`, replace `const plugins = deps.plugins ?? SHIPPED_PLUGINS;` with:

```ts
  // Resolved before the database is opened, beside the other variables: a
  // malformed url is a configuration error, and the earliest refusal is the
  // one that touches least on its way out.
  const openmetadataUrl = resolveOpenmetadataUrl(process.env['PICKARR_OPENMETADATA_URL']);
  const plugins = deps.plugins ?? shippedPlugins({
    now: () => Date.now(),
    // The key itself is read per request, by the resolver, and never here:
    // this passes the *means* of getting it, not the credential.
    resolveSecret: createEnvSecretResolver(process.env),
    baseUrl: openmetadataUrl,
  });
```

and add `openmetadataUrl` to the closing `log(...)` line's summary, so a boot log says which service it will ask:

```ts
    + `lookups to ${openmetadataUrl}, `
```

- [ ] **Step 5: Assert the wiring in `main.test.ts`**

Append to `packages/host/test/main.test.ts`:

```ts
test('shippedPlugins builds one plugin per media type, each with its own prefix', () => {
  const plugins = shippedPlugins({
    now: () => 0,
    resolveSecret: async () => 'test-key',
    baseUrl: 'https://openmetadata.test',
  });

  assert.deepEqual(plugins.map((plugin) => plugin.id), ['tv', 'movie', 'xxx']);
  assert.deepEqual(plugins.map((plugin) => plugin.mediaType), ['tv', 'movie', 'xxx']);
  // Migration 1 is the engine's state table; each plugin adds its own at 2.
  for (const plugin of plugins) {
    assert.deepEqual(plugin.migrations.map((migration) => migration.version), [1, 2]);
  }
});
```

and add `shippedPlugins` to that file's import from `../src/main.ts`.

- [ ] **Step 6: Run everything**

Run: `npm run check`
Expected: lint, typecheck, test-hygiene and both test suites clean.

Run: `npm run build`
Expected: every package builds, the four new ones included.

- [ ] **Step 7: Commit**

```bash
git add packages/host package.json package-lock.json
git commit -m "Run the three plugins in the shipped process, so a seeded feed is identified instead of offered to nobody"
```

---

## Notes for the executor

- **Task 1 is the only task that touches the network**, and it needs Chad's key. Tasks 2–8 and 10–12 do not depend on it; Task 9 does, for two constant values. If the probe cannot run, do Tasks 2–8 and 10–12 first, and stop before Task 9 to ask.
- **When a test fails, fix the code, not the test.** The tests here encode the spec's §3.3 branch order and §4's upsert rule; a test edited to pass is a spec requirement deleted.
- **The `no-await-in-loop` disables carry their reason on the same line**, as every existing one in this tree does. Do not add one without a reason that says why the loop cannot be parallel.
- **If the host's real `PluginContext` wiring in Task 12 turns out to need more than the spec anticipated** (an `ArtworkStore`, a `HostDb`, a `Timers`), assemble it from the host's own modules — that test is inside `packages/host/test`, so it may import them freely. Only the four new packages are forbidden from doing so.
