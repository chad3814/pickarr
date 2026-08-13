# Settings Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Settings` tab — separated from the other four by an em dash — holding a schema-driven editor for `config.json` and a button that backs up and downloads the SQLite database.

**Architecture:** `loadConfig` splits into a filesystem-free `parseConfig` plus a `resolveSecrets` step so the save route can run every check boot applies *before* it writes. Two pure functions project the parsed config into an editable shape with write-only secrets and fold a submission back over the on-disk document. Four new Fastify routes expose read, save, restart and backup; `buildServer` stays free of `process.exit` by taking an injected `requestRestart`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Fastify, zod, `node:sqlite` (`DatabaseSync` + async `backup`), React 19 + react-router, `node:test`, `@testing-library/react` + happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-13-settings-design.md`

## Global Constraints

- Node `>=24`. All filesystem work uses `fs.promises` — never `*Sync`. The single documented exception to async-over-sync is `node:sqlite` itself (see `db/open.ts`).
- Never the `any` type. Never `unknown` at a parse boundary — use `JsonValue`/`JsonObject` from `packages/core/src/json.ts`.
- 2-space indent; semicolons always.
- `packages/web` must not import from `packages/core`. Response types are mirrored by hand into `packages/web/src/api/client.ts`, as `client.ts:70-77` documents.
- Secret values (`downloadClients[].apiKey`, `siteLookup.apiKey`) must never appear in an HTTP response, a log line, or an error message.
- No fake timers in `packages/web` tests — they hang the run (commit `ed0de07`).
- `MIN_API_KEY_LENGTH` is 16; `SECRET_REFERENCE_PREFIX` is `'file:'`. Both are already exported from `config/schema.ts`.
- Verification gate for every task: `npm run check` (lint → typecheck → test) and, for the final task, `npm run build`.
- Commit at the end of each task. Do not push.

---

### Task 1: Split `loadConfig` into `parseConfig` and `resolveSecrets`

Pure refactor. `loadConfig`'s observable behaviour must not change — the existing tests in `test/config/load.test.ts` are the proof, and they must pass untouched.

**Files:**
- Modify: `packages/core/src/config/load.ts`
- Test: `packages/core/test/config/load.test.ts` (append)

**Interfaces:**
- Consumes: `configSchema`, `MIN_API_KEY_LENGTH`, `SECRET_REFERENCE_PREFIX`, `PickarrConfig` from `./schema.ts`; `JsonValue` from `../json.ts`.
- Produces:
  - `export function parseConfig(json: JsonValue, source: string): PickarrConfig` — throws `Error` on schema or cross-field failure. `source` appears in the message the way the path does today.
  - `export async function resolveSecrets(config: PickarrConfig): Promise<void>` — mutates `apiKey` fields in place, throws on an unreadable or too-short secret.
  - `export async function loadConfig(path: string): Promise<PickarrConfig>` — unchanged signature.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/config/load.test.ts`:

```ts
test('parseConfig accepts a valid document without touching the filesystem', () => {
  const config = parseConfig(structuredClone(VALID) as unknown as JsonValue, 'test');
  assert.equal(config.server.port, 8080);
  // Unresolved: parseConfig does no I/O, so a `file:` reference is still a reference.
  assert.equal(config.metadata.perTick, 5);
});

test('parseConfig names its source and the offending field', () => {
  const broken = structuredClone(VALID);
  broken.downloadClients[0]!.importMode = 'teleport';
  assert.throws(
    () => parseConfig(broken as unknown as JsonValue, '/some/where.json'),
    (error: Error) => {
      assert.match(error.message, /\/some\/where\.json/);
      assert.match(error.message, /importMode/);
      return true;
    },
  );
});

test('parseConfig applies the cross-field checks', () => {
  const dupes = structuredClone(VALID);
  dupes.feeds.push({ ...dupes.feeds[0]! });
  assert.throws(() => parseConfig(dupes as unknown as JsonValue, 'test'), /duplicate feed id/i);

  const orphan = structuredClone(VALID);
  orphan.feeds[0]!.plugin = '@pickarr/plugin-absent';
  assert.throws(() => parseConfig(orphan as unknown as JsonValue, 'test'), /not configured/i);
});

test('resolveSecrets replaces a file: reference in place', async () => {
  await withTempDir(async (dir) => {
    const secretPath = join(dir, 'sab_key');
    await writeFile(secretPath, 'resolved-secret-value\n');
    const document = structuredClone(VALID);
    document.downloadClients[0]!.apiKey = `file:${secretPath}`;
    const config = parseConfig(document as unknown as JsonValue, 'test');

    await resolveSecrets(config);
    assert.equal(config.downloadClients[0]?.apiKey, 'resolved-secret-value');
  });
});

test('resolveSecrets rejects a short resolved key without printing it', async () => {
  await withTempDir(async (dir) => {
    const secretPath = join(dir, 'sab_key');
    await writeFile(secretPath, 'tinykey\n');
    const document = structuredClone(VALID);
    document.downloadClients[0]!.apiKey = `file:${secretPath}`;
    const config = parseConfig(document as unknown as JsonValue, 'test');

    await assert.rejects(resolveSecrets(config), (error: Error) => {
      assert.match(error.message, /apiKey/);
      assert.doesNotMatch(error.message, /tinykey/);
      return true;
    });
  });
});
```

Update that file's import line to:

```ts
import { loadConfig, parseConfig, resolveSecrets } from '../../src/config/load.ts';
import type { JsonValue } from '../../src/json.ts';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:server 2>&1 | grep -A3 "parseConfig accepts"`
Expected: FAIL — `parseConfig` is not exported.

- [ ] **Step 3: Rewrite `load.ts` around the two new functions**

Replace the body of `packages/core/src/config/load.ts` below `resolveSecret` with:

```ts
/**
 * Schema and cross-field validation, with no filesystem access at all.
 *
 * Separate from `loadConfig` because `PUT /api/config` has to apply exactly
 * these checks to a document it has not written yet. Two copies of this list
 * would be free to drift, and the one that drifted would be the one guarding
 * the file a Restart button then boots from.
 */
export function parseConfig(json: JsonValue, source: string): PickarrConfig {
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Config at ${source} is invalid — ${detail}`);
  }

  const config = parsed.data;

  const feedIds = new Set<string>();
  for (const feed of config.feeds) {
    if (feedIds.has(feed.id)) throw new Error(`Duplicate feed id: ${feed.id}`);
    feedIds.add(feed.id);
  }

  const clientIds = new Set<string>();
  for (const client of config.downloadClients) {
    if (clientIds.has(client.id)) throw new Error(`Duplicate download client id: ${client.id}`);
    clientIds.add(client.id);
  }

  for (const feed of config.feeds) {
    if (config.plugins[feed.plugin] === undefined) {
      throw new Error(`Feed ${feed.id} references plugin ${feed.plugin}, which is not configured`);
    }
  }

  return config;
}

/**
 * Resolves every `file:` reference in place and re-applies the length rules the
 * schema could not, because the schema saw a path rather than the key behind it.
 *
 * Callable on its own so that a save can *rehearse* it and throw the result
 * away: a config that parses but whose secret file is missing or empty fails at
 * boot, and boot is now something a button in the UI triggers.
 */
export async function resolveSecrets(config: PickarrConfig): Promise<void> {
  for (const client of config.downloadClients) {
    const field = `downloadClients.${client.id}.apiKey`;
    client.apiKey = await resolveSecret(client.apiKey, field);
    if (client.apiKey.length < MIN_API_KEY_LENGTH) {
      throw new Error(
        `${field} resolves to fewer than ${MIN_API_KEY_LENGTH} characters; SABnzbd api keys are 32 hex characters`,
      );
    }
  }

  if (config.siteLookup !== undefined) {
    const field = 'siteLookup.apiKey';
    config.siteLookup.apiKey = await resolveSecret(config.siteLookup.apiKey, field);
    if (config.siteLookup.apiKey.length === 0) {
      throw new Error(`${field} resolves to an empty value`);
    }
  }
}

export async function loadConfig(path: string): Promise<PickarrConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Could not read config file at ${path}`);
  }

  let json: JsonValue;
  try {
    json = JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new Error(`Config at ${path} is not valid JSON: ${(error as Error).message}`);
  }

  const config = parseConfig(json, path);
  await resolveSecrets(config);

  const portOverride = process.env['PICKARR_PORT'];
  if (portOverride !== undefined) {
    const port = Number.parseInt(portOverride, 10);
    if (Number.isNaN(port) || port <= 0) {
      throw new Error(`PICKARR_PORT is not a valid port: ${portOverride}`);
    }
    config.server.port = port;
  }

  return config;
}
```

The two long comments that were on the length checks inside `loadConfig` move with the checks into `resolveSecrets`; keep their substance (the schema saw the path, not the key; the message states the rule and never the value).

- [ ] **Step 4: Run the whole config suite**

Run: `npm run test:server 2>&1 | tail -20`
Expected: PASS, including all ten pre-existing `load.test.ts` tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/load.ts packages/core/test/config/load.test.ts
git commit -m "Split loadConfig so its checks can run before a file is written"
```

---

### Task 2: The editable projection — types and `toEditableConfig`

**Files:**
- Create: `packages/core/src/config/editable.ts`
- Test: `packages/core/test/config/editable.test.ts`

**Interfaces:**
- Consumes: `PickarrConfig` from `./schema.ts`, `SECRET_REFERENCE_PREFIX` from `./schema.ts`.
- Produces (every later task depends on these exact names):

```ts
export type SecretView = { kind: 'file'; path: string } | { kind: 'set' };
export type SecretEdit =
  | { kind: 'keep' }
  | { kind: 'file'; path: string }
  | { kind: 'literal'; value: string };
export interface EditablePathMapping { from: string; to: string }
export interface EditableDownloadClient { id: string; type: 'sabnzbd'; url: string; apiKey: SecretView; category: string; importMode: 'move' | 'copy'; pathMappings: EditablePathMapping[] }
export interface EditableFeed { id: string; url: string; plugin: string; intervalSeconds: number }
export interface EditableSiteLookup { type: 'theporndb'; apiKey: SecretView; baseUrl: string }
export interface EditableMetadata { enabled: boolean; intervalSeconds: number; perTick: number; artworkDir: string | null }
export type PluginSettingValue = string | number | boolean | string[];
export interface EditableConfig { server: { port: number }; database: { path: string }; trashDir: string; plugins: Record<string, Record<string, PluginSettingValue>>; downloadClients: EditableDownloadClient[]; feeds: EditableFeed[]; siteLookup: EditableSiteLookup | null; metadata: EditableMetadata }
export function toEditableConfig(config: PickarrConfig): EditableConfig;
```

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/config/editable.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config/load.ts';
import { toEditableConfig } from '../../src/config/editable.ts';
import type { JsonValue } from '../../src/json.ts';

const VALID = {
  server: { port: 8080 },
  database: { path: '/config/pickarr.db' },
  trashDir: '/data/trash',
  plugins: {
    '@pickarr/plugin-scenes': {
      libraryRoot: '/media/scenes',
      sites: ['Vixen', 'Bangbros'],
      strict: true,
      retries: 3,
    },
  },
  downloadClients: [
    {
      id: 'sab',
      type: 'sabnzbd',
      url: 'http://sabnzbd:8080',
      apiKey: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
      category: 'pickarr',
      importMode: 'move',
      pathMappings: [{ from: '/downloads', to: '/data/downloads' }],
    },
  ],
  feeds: [
    { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900 },
  ],
};

function editableOf(over: (document: typeof VALID) => void = () => {}) {
  const document = structuredClone(VALID);
  over(document);
  return toEditableConfig(parseConfig(document as unknown as JsonValue, 'test'));
}

test('a literal api key becomes `set` and its value never appears', () => {
  const editable = editableOf();
  assert.deepEqual(editable.downloadClients[0]?.apiKey, { kind: 'set' });
  assert.doesNotMatch(JSON.stringify(editable), /0f1e2d3c4b5a69788796a5b4c3d2e1f0/);
});

test('a file: reference is projected as its path, because a path is not a secret', () => {
  const editable = editableOf((document) => {
    document.downloadClients[0]!.apiKey = 'file:/run/secrets/sabnzbd_api_key';
  });
  assert.deepEqual(editable.downloadClients[0]?.apiKey, {
    kind: 'file',
    path: '/run/secrets/sabnzbd_api_key',
  });
});

test('an absent siteLookup is null rather than missing', () => {
  assert.equal(editableOf().siteLookup, null);
});

test('a present siteLookup carries its defaulted baseUrl and a redacted key', () => {
  const editable = editableOf((document) => {
    Object.assign(document, { siteLookup: { type: 'theporndb', apiKey: 'tpdb-secret-key-value' } });
  });
  assert.equal(editable.siteLookup?.baseUrl, 'https://api.theporndb.net');
  assert.deepEqual(editable.siteLookup?.apiKey, { kind: 'set' });
  assert.doesNotMatch(JSON.stringify(editable), /tpdb-secret-key-value/);
});

test('metadata defaults are shown, and an absent artworkDir is null', () => {
  const editable = editableOf();
  assert.deepEqual(editable.metadata, {
    enabled: true,
    intervalSeconds: 5,
    perTick: 5,
    artworkDir: null,
  });
});

test('all four plugin value types survive the projection', () => {
  const plugin = editableOf().plugins['@pickarr/plugin-scenes'];
  assert.equal(plugin?.['libraryRoot'], '/media/scenes');
  assert.deepEqual(plugin?.['sites'], ['Vixen', 'Bangbros']);
  assert.equal(plugin?.['strict'], true);
  assert.equal(plugin?.['retries'], 3);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:server 2>&1 | grep -A3 "literal api key"`
Expected: FAIL — cannot find module `editable.ts`.

- [ ] **Step 3: Write `editable.ts`**

```ts
import { SECRET_REFERENCE_PREFIX, type PickarrConfig } from './schema.ts';

/**
 * What the browser is allowed to know about a secret-bearing field.
 *
 * A discriminated union rather than a redaction sentinel like `'********'`,
 * because a sentinel is a string a real config value could also hold — and the
 * day it does, "unchanged" and "set it to this" become the same request. There
 * is no value of `SecretEdit['kind']` a user can type into a text field.
 */
export type SecretView = { kind: 'file'; path: string } | { kind: 'set' };

/** What the browser may say about a secret-bearing field on the way back. */
export type SecretEdit =
  | { kind: 'keep' }
  | { kind: 'file'; path: string }
  | { kind: 'literal'; value: string };

export interface EditablePathMapping {
  from: string;
  to: string;
}

export interface EditableDownloadClient {
  id: string;
  type: 'sabnzbd';
  url: string;
  apiKey: SecretView;
  category: string;
  importMode: 'move' | 'copy';
  pathMappings: EditablePathMapping[];
}

export interface EditableFeed {
  id: string;
  url: string;
  plugin: string;
  intervalSeconds: number;
}

export interface EditableSiteLookup {
  type: 'theporndb';
  apiKey: SecretView;
  baseUrl: string;
}

/** `artworkDir` is `null` for absent, never `''` — see `applyEdits`. */
export interface EditableMetadata {
  enabled: boolean;
  intervalSeconds: number;
  perTick: number;
  artworkDir: string | null;
}

/** The four value types `configSchema`'s `plugins` record permits. */
export type PluginSettingValue = string | number | boolean | string[];

export interface EditableConfig {
  server: { port: number };
  database: { path: string };
  trashDir: string;
  plugins: Record<string, Record<string, PluginSettingValue>>;
  downloadClients: EditableDownloadClient[];
  feeds: EditableFeed[];
  /** `null` for absent, so the form can offer to add one. */
  siteLookup: EditableSiteLookup | null;
  metadata: EditableMetadata;
}

/**
 * A `file:` path is not a secret and being able to see and correct it is most of
 * the value of showing the field; a literal key is a secret and its bytes never
 * leave the process. This is the only function that decides which is which.
 */
function viewSecret(value: string): SecretView {
  return value.startsWith(SECRET_REFERENCE_PREFIX)
    ? { kind: 'file', path: value.slice(SECRET_REFERENCE_PREFIX.length) }
    : { kind: 'set' };
}

/**
 * Projects a *parsed* config — so the form shows effective values, defaults
 * included — into the shape `GET /api/config` returns.
 *
 * Must be given the config from `parseConfig`, never one that has been through
 * `resolveSecrets`: after resolution a `file:` reference has already become the
 * key it points at, and this function would project it as `{ kind: 'set' }`,
 * silently losing the path the user needs to see.
 */
export function toEditableConfig(config: PickarrConfig): EditableConfig {
  return {
    server: { port: config.server.port },
    database: { path: config.database.path },
    trashDir: config.trashDir,
    plugins: Object.fromEntries(
      Object.entries(config.plugins).map(([name, settings]) => [name, { ...settings }]),
    ),
    downloadClients: config.downloadClients.map((client) => ({
      id: client.id,
      type: client.type,
      url: client.url,
      apiKey: viewSecret(client.apiKey),
      category: client.category,
      importMode: client.importMode,
      pathMappings: client.pathMappings.map((mapping) => ({ from: mapping.from, to: mapping.to })),
    })),
    feeds: config.feeds.map((feed) => ({
      id: feed.id,
      url: feed.url,
      plugin: feed.plugin,
      intervalSeconds: feed.intervalSeconds,
    })),
    siteLookup:
      config.siteLookup === undefined
        ? null
        : {
            type: config.siteLookup.type,
            apiKey: viewSecret(config.siteLookup.apiKey),
            baseUrl: config.siteLookup.baseUrl,
          },
    metadata: {
      enabled: config.metadata.enabled,
      intervalSeconds: config.metadata.intervalSeconds,
      perTick: config.metadata.perTick,
      artworkDir: config.metadata.artworkDir ?? null,
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:server 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/editable.ts packages/core/test/config/editable.test.ts
git commit -m "Project the config into an editable shape whose secrets are write-only"
```

---

### Task 3: `applyEdits`

**Files:**
- Modify: `packages/core/src/config/editable.ts`
- Test: `packages/core/test/config/editable.test.ts` (append)

**Interfaces:**
- Consumes: the Task 2 types; `JsonValue`, `JsonObject`, `asJsonObject`, `asJsonArray` from `../json.ts`.
- Produces:

```ts
export interface SubmittedDownloadClient { id: string; type: 'sabnzbd'; url: string; apiKey: SecretEdit; category: string; importMode: 'move' | 'copy'; pathMappings: EditablePathMapping[] }
export interface SubmittedSiteLookup { type: 'theporndb'; apiKey: SecretEdit; baseUrl: string }
export interface SubmittedConfig { server: { port: number }; database: { path: string }; trashDir: string; plugins: Record<string, Record<string, PluginSettingValue>>; downloadClients: SubmittedDownloadClient[]; feeds: EditableFeed[]; siteLookup: SubmittedSiteLookup | null; metadata: EditableMetadata }
export function applyEdits(document: JsonValue, submitted: SubmittedConfig): { document: JsonObject } | { error: string };
```

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/config/editable.test.ts`. Add `applyEdits` and the submitted types to the import from `editable.ts`, and add these helpers plus tests:

```ts
function submission(over: (draft: SubmittedConfig) => void = () => {}): SubmittedConfig {
  const draft: SubmittedConfig = {
    server: { port: 8080 },
    database: { path: '/config/pickarr.db' },
    trashDir: '/data/trash',
    plugins: {
      '@pickarr/plugin-scenes': {
        libraryRoot: '/media/scenes',
        sites: ['Vixen', 'Bangbros'],
        strict: true,
        retries: 3,
      },
    },
    downloadClients: [
      {
        id: 'sab',
        type: 'sabnzbd',
        url: 'http://sabnzbd:8080',
        apiKey: { kind: 'keep' },
        category: 'pickarr',
        importMode: 'move',
        pathMappings: [{ from: '/downloads', to: '/data/downloads' }],
      },
    ],
    feeds: [
      { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900 },
    ],
    siteLookup: null,
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: null },
  };
  over(draft);
  return draft;
}

function applied(
  document: JsonValue,
  over: (draft: SubmittedConfig) => void = () => {},
): JsonObject {
  const result = applyEdits(document, submission(over));
  assert.ok('document' in result, 'error' in result ? result.error : 'expected a document');
  return result.document;
}

test('a kept secret keeps the exact value on disk', () => {
  const document = applied(structuredClone(VALID) as unknown as JsonValue);
  const clients = asJsonArray(document['downloadClients']);
  assert.equal(asJsonObject(clients[0])?.['apiKey'], '0f1e2d3c4b5a69788796a5b4c3d2e1f0');
});

test('a literal secret replaces what was on disk', () => {
  const document = applied(structuredClone(VALID) as unknown as JsonValue, (draft) => {
    draft.downloadClients[0]!.apiKey = { kind: 'literal', value: 'aaaabbbbccccddddeeee' };
  });
  const clients = asJsonArray(document['downloadClients']);
  assert.equal(asJsonObject(clients[0])?.['apiKey'], 'aaaabbbbccccddddeeee');
});

test('a file secret is written back with its prefix', () => {
  const document = applied(structuredClone(VALID) as unknown as JsonValue, (draft) => {
    draft.downloadClients[0]!.apiKey = { kind: 'file', path: '/run/secrets/key' };
  });
  const clients = asJsonArray(document['downloadClients']);
  assert.equal(asJsonObject(clients[0])?.['apiKey'], 'file:/run/secrets/key');
});

// The whole point of folding edits over the document rather than serialising a
// fresh object: a field this form does not model must survive a save.
test('a key the form does not model survives, and key order is unchanged', () => {
  const onDisk = structuredClone(VALID) as unknown as JsonObject;
  onDisk['futureSetting'] = { nested: ['a', 'b'] };
  const before = Object.keys(onDisk);

  const document = applied(onDisk);
  assert.deepEqual(document['futureSetting'], { nested: ['a', 'b'] });
  assert.deepEqual(Object.keys(document), before);
});

test('keeping a secret for a renamed client is refused, not guessed', () => {
  const result = applyEdits(
    structuredClone(VALID) as unknown as JsonValue,
    submission((draft) => {
      draft.downloadClients[0]!.id = 'sab-renamed';
    }),
  );
  assert.ok('error' in result);
  assert.match(result.error, /sab-renamed/);
  assert.match(result.error, /api key/i);
});

test('an absent artworkDir is deleted rather than written as an empty string', () => {
  const onDisk = structuredClone(VALID) as unknown as JsonObject;
  onDisk['metadata'] = { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: '/old/art' };
  const document = applied(onDisk);
  assert.equal(asJsonObject(document['metadata'])?.['artworkDir'], undefined);
});

test('a null siteLookup removes the block entirely', () => {
  const onDisk = structuredClone(VALID) as unknown as JsonObject;
  onDisk['siteLookup'] = { type: 'theporndb', apiKey: 'tpdb-secret-key-value' };
  const document = applied(onDisk);
  assert.equal(document['siteLookup'], undefined);
});

test('a kept siteLookup secret survives an edit to its baseUrl', () => {
  const onDisk = structuredClone(VALID) as unknown as JsonObject;
  onDisk['siteLookup'] = { type: 'theporndb', apiKey: 'tpdb-secret-key-value' };
  const document = applied(onDisk, (draft) => {
    draft.siteLookup = {
      type: 'theporndb',
      apiKey: { kind: 'keep' },
      baseUrl: 'https://mirror.invalid',
    };
  });
  const siteLookup = asJsonObject(document['siteLookup']);
  assert.equal(siteLookup?.['apiKey'], 'tpdb-secret-key-value');
  assert.equal(siteLookup?.['baseUrl'], 'https://mirror.invalid');
});

test('keeping a siteLookup secret that does not exist on disk is refused', () => {
  const result = applyEdits(
    structuredClone(VALID) as unknown as JsonValue,
    submission((draft) => {
      draft.siteLookup = { type: 'theporndb', apiKey: { kind: 'keep' }, baseUrl: 'https://x.invalid' };
    }),
  );
  assert.ok('error' in result);
  assert.match(result.error, /siteLookup/);
});

test('a document that is not a JSON object is refused', () => {
  const result = applyEdits(['not', 'an', 'object'], submission());
  assert.ok('error' in result);
});
```

Add to the file's imports:

```ts
import { asJsonArray, asJsonObject, type JsonObject, type JsonValue } from '../../src/json.ts';
import {
  applyEdits,
  toEditableConfig,
  type SubmittedConfig,
} from '../../src/config/editable.ts';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:server 2>&1 | grep -A3 "a kept secret keeps"`
Expected: FAIL — `applyEdits` is not exported.

- [ ] **Step 3: Implement `applyEdits`**

Append to `packages/core/src/config/editable.ts`:

```ts
export interface SubmittedDownloadClient {
  id: string;
  type: 'sabnzbd';
  url: string;
  apiKey: SecretEdit;
  category: string;
  importMode: 'move' | 'copy';
  pathMappings: EditablePathMapping[];
}

export interface SubmittedSiteLookup {
  type: 'theporndb';
  apiKey: SecretEdit;
  baseUrl: string;
}

export interface SubmittedConfig {
  server: { port: number };
  database: { path: string };
  trashDir: string;
  plugins: Record<string, Record<string, PluginSettingValue>>;
  downloadClients: SubmittedDownloadClient[];
  feeds: EditableFeed[];
  siteLookup: SubmittedSiteLookup | null;
  metadata: EditableMetadata;
}

/**
 * The literal a `SecretEdit` should be written to the file as, or an error
 * naming what could not be kept.
 *
 * `{ kind: 'keep' }` is resolved against the value already on disk, and a
 * missing one is refused rather than guessed. The alternative — falling back to
 * an empty string, or to the nearest entry — turns "I renamed a client" into
 * "my download client silently lost its api key", which surfaces later as 401s
 * that look like an outage.
 */
function editedSecret(edit: SecretEdit, existing: string | undefined, field: string): string | { error: string } {
  if (edit.kind === 'literal') return edit.value;
  if (edit.kind === 'file') return `${SECRET_REFERENCE_PREFIX}${edit.path}`;
  if (existing === undefined) {
    return {
      error: `${field}: asked to keep the existing api key, but there is none on disk to keep. Enter the key.`,
    };
  }
  return existing;
}

/**
 * Folds a submission over the document that is currently on disk, returning a
 * new document to write.
 *
 * A structured copy of the *on-disk* object is mutated rather than a fresh
 * object being built, and that is the point: key order is preserved, and any key
 * this form does not model — a setting a newer Pickarr understands, a block
 * someone added by hand — survives the save instead of being silently dropped.
 */
export function applyEdits(
  document: JsonValue,
  submitted: SubmittedConfig,
): { document: JsonObject } | { error: string } {
  const existing = asJsonObject(document);
  if (existing === null) return { error: 'config.json does not hold a JSON object' };

  const next = structuredClone(existing);

  // Matched by id, which is what a `keep` refers to. A client whose id changed
  // in the same submission has no entry here, and `editedSecret` refuses it.
  const existingClientKeys = new Map<string, string>();
  for (const entry of asJsonArray(existing['downloadClients'])) {
    const client = asJsonObject(entry);
    const id = client?.['id'];
    const apiKey = client?.['apiKey'];
    if (typeof id === 'string' && typeof apiKey === 'string') existingClientKeys.set(id, apiKey);
  }

  const clients: JsonValue[] = [];
  for (const client of submitted.downloadClients) {
    const apiKey = editedSecret(
      client.apiKey,
      existingClientKeys.get(client.id),
      `downloadClients.${client.id}.apiKey`,
    );
    if (typeof apiKey !== 'string') return apiKey;
    clients.push({
      id: client.id,
      type: client.type,
      url: client.url,
      apiKey,
      category: client.category,
      importMode: client.importMode,
      pathMappings: client.pathMappings.map((mapping) => ({ from: mapping.from, to: mapping.to })),
    });
  }

  next['server'] = { port: submitted.server.port };
  next['database'] = { path: submitted.database.path };
  next['trashDir'] = submitted.trashDir;
  next['plugins'] = Object.fromEntries(
    Object.entries(submitted.plugins).map(([name, settings]) => [
      name,
      Object.fromEntries(
        Object.entries(settings).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
      ),
    ]),
  );
  next['downloadClients'] = clients;
  next['feeds'] = submitted.feeds.map((feed) => ({
    id: feed.id,
    url: feed.url,
    plugin: feed.plugin,
    intervalSeconds: feed.intervalSeconds,
  }));

  // Absence is expressed by deleting the key, never by writing `null` or `''`:
  // `metadataSchema.artworkDir` is `.min(1).optional()`, so an empty string is a
  // validation failure rather than a way of saying "use the default".
  const metadata: JsonObject = {
    enabled: submitted.metadata.enabled,
    intervalSeconds: submitted.metadata.intervalSeconds,
    perTick: submitted.metadata.perTick,
  };
  if (submitted.metadata.artworkDir !== null) metadata['artworkDir'] = submitted.metadata.artworkDir;
  next['metadata'] = metadata;

  if (submitted.siteLookup === null) {
    delete next['siteLookup'];
  } else {
    const previous = asJsonObject(existing['siteLookup'])?.['apiKey'];
    const apiKey = editedSecret(
      submitted.siteLookup.apiKey,
      typeof previous === 'string' ? previous : undefined,
      'siteLookup.apiKey',
    );
    if (typeof apiKey !== 'string') return apiKey;
    next['siteLookup'] = {
      type: submitted.siteLookup.type,
      apiKey,
      baseUrl: submitted.siteLookup.baseUrl,
    };
  }

  return { document: next };
}
```

Add `asJsonArray`, `asJsonObject`, `JsonObject`, `JsonValue` to the file's imports from `../json.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:server 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/editable.ts packages/core/test/config/editable.test.ts
git commit -m "Fold a submission over the config on disk instead of rewriting it"
```

---

### Task 4: `GET /api/config`

**Files:**
- Modify: `packages/core/src/http/views.ts` (append types)
- Modify: `packages/core/src/http/server.ts` (`ServerDeps` + route)
- Modify: `packages/core/src/main.ts` (capture the boot document, pass the new deps)
- Test: `packages/core/test/http/server.test.ts` (append)

**Interfaces:**
- Consumes: `toEditableConfig`, `EditableConfig` (Task 2); `parseConfig` (Task 1).
- Produces:
  - In `views.ts`: `export interface ConfigResponse { config: EditableConfig; portOverride: number | null; restartRequired: boolean }`
  - `ServerDeps` gains `configPath: string`, `bootConfigDocument: JsonValue`.
  - `main.ts` exports `export function readConfigDocument(raw: string): JsonValue` — no, not needed; the document is captured inline. Nothing new is exported from `main.ts` in this task.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/http/server.test.ts`. Add these imports and helper at the top of the file:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '../../src/json.ts';

const CONFIG_DOCUMENT = {
  server: { port: 8080 },
  database: { path: '/config/pickarr.db' },
  trashDir: '/data/trash',
  plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes' } },
  downloadClients: [
    {
      id: 'sab',
      type: 'sabnzbd',
      url: 'http://sabnzbd:8080',
      apiKey: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
      category: 'pickarr',
      importMode: 'move',
      pathMappings: [],
    },
  ],
  feeds: [
    { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900 },
  ],
};

/**
 * A temp directory holding a `config.json`, plus deps pointed at it. Every
 * config route test goes through here so none of them can touch a real config.
 */
async function withConfigDir(
  fn: (context: { dir: string; configPath: string; deps: ServerDeps }) => Promise<void>,
  document: JsonValue = structuredClone(CONFIG_DOCUMENT) as unknown as JsonValue,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-http-config-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(document, null, 2));
  const db = openTestDatabase();
  try {
    await fn({
      dir,
      configPath,
      deps: { ...deps(db), configPath, bootConfigDocument: structuredClone(document) },
    });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
```

Extend the existing `deps()` helper with the new fields so every other test in the file keeps compiling:

```ts
    configPath: '/tmp/pickarr-server-test-unused-config.json',
    bootConfigDocument: null,
    databasePath: '/tmp/pickarr-server-test-unused.db',
    requestRestart: () => {},
```

(`databasePath` and `requestRestart` are used by Tasks 6 and 7; adding all four now keeps `deps()` edited once.)

Then the tests:

```ts
test('GET /api/config redacts a literal api key', async () => {
  await withConfigDir(async ({ deps: configDeps }) => {
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json()['config']['downloadClients'][0]['apiKey'], { kind: 'set' });
    assert.doesNotMatch(response.body, /0f1e2d3c4b5a69788796a5b4c3d2e1f0/);
    await server.close();
  });
});

test('GET /api/config reports no pending restart when the file matches boot', async () => {
  await withConfigDir(async ({ deps: configDeps }) => {
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.json()['restartRequired'], false);
    await server.close();
  });
});

// Reformatting by hand must not read as a pending restart: the comparison is of
// parsed documents, not of bytes.
test('GET /api/config ignores whitespace-only differences from the boot document', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    await writeFile(configPath, JSON.stringify(CONFIG_DOCUMENT));
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.json()['restartRequired'], false);
    await server.close();
  });
});

test('GET /api/config reports a pending restart when the file has really changed', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const changed = structuredClone(CONFIG_DOCUMENT);
    changed.trashDir = '/data/elsewhere';
    await writeFile(configPath, JSON.stringify(changed, null, 2));
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.json()['restartRequired'], true);
    await server.close();
  });
});

test('GET /api/config reports PICKARR_PORT as an override', async () => {
  await withConfigDir(async ({ deps: configDeps }) => {
    process.env['PICKARR_PORT'] = '9999';
    try {
      const server = buildServer(configDeps);
      const response = await server.inject({ method: 'GET', url: '/api/config' });
      assert.equal(response.json()['portOverride'], 9999);
      await server.close();
    } finally {
      delete process.env['PICKARR_PORT'];
    }
  });
});

test('GET /api/config answers 500 with the reason when the file is unparseable', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    await writeFile(configPath, '{ not json');
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.statusCode, 500);
    assert.match(response.json()['error'], /not valid JSON/);
    await server.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:server 2>&1 | grep -A3 "redacts a literal"`
Expected: FAIL — `configPath` is not a property of `ServerDeps`.

- [ ] **Step 3: Implement**

In `packages/core/src/http/views.ts`, append:

```ts
/**
 * The Settings screen's whole view of configuration.
 *
 * `portOverride` is `PICKARR_PORT`, reported so the form can say the port field
 * is currently being overridden at runtime rather than presenting a value the
 * running service is not using. `restartRequired` is whether the file on disk
 * has diverged from the document this process booted with — without it, the
 * "restart to apply" notice would vanish on a page reload and leave a
 * saved-but-unapplied config with nothing on screen saying so.
 */
export interface ConfigResponse {
  config: EditableConfig;
  portOverride: number | null;
  restartRequired: boolean;
}

/** `restartRequired` is always true: a save cannot change the running process. */
export interface ConfigSaveResponse {
  savedAt: number;
  restartRequired: true;
}
```

with `import type { EditableConfig } from '../config/editable.ts';` added to its imports.

In `packages/core/src/http/server.ts`, add to `ServerDeps`:

```ts
  /**
   * The `config.json` the Settings screen reads and writes — `PICKARR_CONFIG`,
   * resolved once in main.ts. Injected rather than re-read from the environment
   * here so a test can point the config routes at a temp directory, and so the
   * two places that name this file cannot disagree.
   */
  configPath: string;
  /**
   * The parsed document this process booted from, captured before anything
   * could rewrite it. Compared against the file on disk to answer
   * `restartRequired`; parsed rather than textual, so reindenting the file by
   * hand does not read as a pending restart.
   */
  bootConfigDocument: JsonValue;
```

and the route, placed after `/api/health`:

```ts
  /**
   * Reads the file fresh on every request rather than serving a cached copy, so
   * an edit made by hand on the host shows up here. A file that cannot be read,
   * parsed or validated is a 500 carrying the reason: there is no document to
   * fold edits into, and answering with a fabricated one would mean a later
   * save discarding whatever is actually on disk.
   */
  server.get('/api/config', async (_request, reply) => {
    let document: JsonValue;
    try {
      document = await readConfigDocument(deps.configPath);
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }

    let config: PickarrConfig;
    try {
      config = parseConfig(document, deps.configPath);
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }

    const rawOverride = process.env['PICKARR_PORT'];
    const override = rawOverride === undefined ? Number.NaN : Number.parseInt(rawOverride, 10);
    const response: ConfigResponse = {
      config: toEditableConfig(config),
      portOverride: Number.isNaN(override) ? null : override,
      restartRequired: !isDeepStrictEqual(document, deps.bootConfigDocument),
    };
    return response;
  });
```

Add a small reader beside `parsePositiveInt`:

```ts
/**
 * The config file as a JSON document, with the same two messages `loadConfig`
 * produces for an unreadable file and for invalid JSON — the Settings screen
 * shows these verbatim, so they should read the same wherever they came from.
 */
async function readConfigDocument(path: string): Promise<JsonValue> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Could not read config file at ${path}`);
  }
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new Error(`Config at ${path} is not valid JSON: ${(error as Error).message}`);
  }
}
```

New imports in `server.ts`: `isDeepStrictEqual` from `node:util`; `parseConfig` from `../config/load.ts`; `toEditableConfig` from `../config/editable.ts`; `type PickarrConfig` from `../config/schema.ts`; `type JsonValue` from `../json.ts`; and `ConfigResponse` added to the existing `./views.ts` import.

In `packages/core/src/main.ts`, capture the document and pass the deps. Replace the `loadConfig` call at the top of `main()`:

```ts
  const config = await loadConfig(CONFIG_PATH);
  // Captured before the server can rewrite the file, and parsed rather than
  // held as text: `restartRequired` asks whether the *settings* changed, and a
  // reindent is not a settings change.
  const bootConfigDocument = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as JsonValue;
```

and add to the `buildServer({ ... })` call:

```ts
    configPath: CONFIG_PATH,
    bootConfigDocument,
```

with `readFile` imported from `node:fs/promises` and `JsonValue` from `./json.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:server 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/http/views.ts packages/core/src/http/server.ts packages/core/src/main.ts packages/core/test/http/server.test.ts
git commit -m "Serve the editable config, with secrets redacted and a restart flag"
```

---

### Task 5: `PUT /api/config`

**Files:**
- Modify: `packages/core/src/http/server.ts`
- Test: `packages/core/test/http/server.test.ts` (append)

**Interfaces:**
- Consumes: `applyEdits`, `SubmittedConfig` (Task 3); `parseConfig`, `resolveSecrets` (Task 1); `ConfigSaveResponse` (Task 4); the `withConfigDir` helper (Task 4).
- Produces: nothing new for later tasks beyond the route itself.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/http/server.test.ts`:

```ts
/** A submission matching CONFIG_DOCUMENT, keeping the api key that is on disk. */
function configSubmission(): Record<string, JsonValue> {
  return {
    server: { port: 8080 },
    database: { path: '/config/pickarr.db' },
    trashDir: '/data/trash',
    plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes' } },
    downloadClients: [
      {
        id: 'sab',
        type: 'sabnzbd',
        url: 'http://sabnzbd:8080',
        apiKey: { kind: 'keep' },
        category: 'pickarr',
        importMode: 'move',
        pathMappings: [],
      },
    ],
    feeds: [
      { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900 },
    ],
    siteLookup: null,
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: null },
  };
}

test('PUT /api/config writes the change and keeps the secret on disk', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const server = buildServer(configDeps);
    const body = configSubmission();
    body['trashDir'] = '/data/elsewhere';

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json()['restartRequired'], true);

    const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, JsonValue>;
    assert.equal(written['trashDir'], '/data/elsewhere');
    const clients = asJsonArray(written['downloadClients']);
    assert.equal(asJsonObject(clients[0])?.['apiKey'], '0f1e2d3c4b5a69788796a5b4c3d2e1f0');
    await server.close();
  });
});

test('PUT /api/config leaves no temporary file behind', async () => {
  await withConfigDir(async ({ dir, deps: configDeps }) => {
    const server = buildServer(configDeps);
    await server.inject({ method: 'PUT', url: '/api/config', payload: configSubmission() });
    assert.deepEqual(await readdir(dir), ['config.json']);
    await server.close();
  });
});

// The property that matters most: a refused save must not have touched the file
// the container boots from.
test('a rejected PUT leaves the file byte-identical', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const before = await readFile(configPath, 'utf8');
    const server = buildServer(configDeps);
    const body = configSubmission();
    body['trashDir'] = '';

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 400);
    assert.match(response.json()['error'], /trashDir/);
    assert.equal(await readFile(configPath, 'utf8'), before);
    await server.close();
  });
});

// The rehearsal: this document parses, but boot would die resolving the secret.
test('a PUT whose file: secret cannot be resolved is refused before the write', async () => {
  await withConfigDir(async ({ dir, configPath, deps: configDeps }) => {
    const before = await readFile(configPath, 'utf8');
    const server = buildServer(configDeps);
    const body = configSubmission();
    const clients = asJsonArray(body['downloadClients']);
    asJsonObject(clients[0])!['apiKey'] = { kind: 'file', path: join(dir, 'absent-secret') };

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 400);
    assert.match(response.json()['error'], /absent-secret/);
    assert.equal(await readFile(configPath, 'utf8'), before);
    await server.close();
  });
});

test('a PUT keeping a secret for a renamed client is refused with a usable message', async () => {
  await withConfigDir(async ({ deps: configDeps }) => {
    const server = buildServer(configDeps);
    const body = configSubmission();
    const clients = asJsonArray(body['downloadClients']);
    asJsonObject(clients[0])!['id'] = 'sab-renamed';

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 400);
    assert.match(response.json()['error'], /sab-renamed/);
    await server.close();
  });
});

test('a PUT against an unparseable file on disk is refused', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    await writeFile(configPath, '{ not json');
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: configSubmission() });
    assert.equal(response.statusCode, 500);
    assert.match(response.json()['error'], /not valid JSON/);
    await server.close();
  });
});

test('a malformed PUT body is a 400 and writes nothing', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const before = await readFile(configPath, 'utf8');
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: { nope: true } });
    assert.equal(response.statusCode, 400);
    assert.equal(await readFile(configPath, 'utf8'), before);
    await server.close();
  });
});
```

Add `readdir` to the `node:fs/promises` import, and `asJsonArray`/`asJsonObject` to the `../../src/json.ts` import.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:server 2>&1 | grep -A3 "writes the change and keeps"`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Implement**

Add the body schema beside the other schemas in `server.ts`:

```ts
const secretEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keep') }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('literal'), value: z.string() }),
]);

// Shape only. Every *rule* about the values — port ranges, url formats, minimum
// key lengths, duplicate ids — belongs to `parseConfig`, which the handler runs
// on the merged document. Duplicating any of it here would give the same
// mistake two different error messages depending on which check saw it first.
const configSubmissionSchema = z.object({
  server: z.object({ port: z.number() }),
  database: z.object({ path: z.string() }),
  trashDir: z.string(),
  plugins: z.record(
    z.string(),
    z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  ),
  downloadClients: z.array(
    z.object({
      id: z.string(),
      type: z.literal('sabnzbd'),
      url: z.string(),
      apiKey: secretEditSchema,
      category: z.string(),
      importMode: z.enum(['move', 'copy']),
      pathMappings: z.array(z.object({ from: z.string(), to: z.string() })),
    }),
  ),
  feeds: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      plugin: z.string(),
      intervalSeconds: z.number(),
    }),
  ),
  siteLookup: z
    .object({ type: z.literal('theporndb'), apiKey: secretEditSchema, baseUrl: z.string() })
    .nullable(),
  metadata: z.object({
    enabled: z.boolean(),
    intervalSeconds: z.number(),
    perTick: z.number(),
    artworkDir: z.string().nullable(),
  }),
});
```

And the route, right after `GET /api/config`:

```ts
  /**
   * Validate everything, then write once.
   *
   * The order is the substance: fold the submission over the document on disk,
   * run `parseConfig`, then *rehearse* `resolveSecrets` and throw the result
   * away, and only then touch the filesystem. Every check boot applies has
   * therefore been applied before a byte is written, which is what stops a save
   * from producing a config that crash-loops the container — and that matters
   * because `POST /api/restart` puts a boot behind a button.
   *
   * The write itself is temp-file-then-rename, so a process killed mid-save
   * leaves either the old file or the new one and never a truncated one.
   */
  server.put('/api/config', async (request, reply) => {
    const body = configSubmissionSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });

    let document: JsonValue;
    try {
      document = await readConfigDocument(deps.configPath);
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }

    const merged = applyEdits(document, body.data);
    if ('error' in merged) return reply.code(400).send({ error: merged.error });

    try {
      const candidate = parseConfig(merged.document, deps.configPath);
      // Discarded on purpose: this call is here for its failures, not its
      // result. It is what catches a `file:` reference that is missing or
      // empty — a document that parses but that boot cannot survive.
      await resolveSecrets(candidate);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const temporary = `${deps.configPath}.tmp-${process.pid}`;
    try {
      await writeFile(temporary, `${JSON.stringify(merged.document, null, 2)}\n`, 'utf8');
      await rename(temporary, deps.configPath);
    } catch (error) {
      // Best-effort: if the rename is what failed, the temp file is still
      // there, and leaving it beside a live config.json is its own small mess.
      await rm(temporary, { force: true });
      return reply.code(500).send({ error: `Could not write ${deps.configPath}: ${(error as Error).message}` });
    }

    const response: ConfigSaveResponse = { savedAt: deps.now(), restartRequired: true };
    return response;
  });
```

New imports in `server.ts`: `rename`, `rm`, `writeFile` added to the existing `node:fs/promises` import; `resolveSecrets` added to the `../config/load.ts` import; `applyEdits` added to the `../config/editable.ts` import; `ConfigSaveResponse` added to the `./views.ts` import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:server 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/http/server.ts packages/core/test/http/server.test.ts
git commit -m "Save config only after rehearsing every check boot would apply"
```

---

### Task 6: `POST /api/restart`, and one shutdown path

**Files:**
- Modify: `packages/core/src/http/server.ts`
- Modify: `packages/core/src/main.ts`
- Test: `packages/core/test/http/server.test.ts` (append)

**Interfaces:**
- Produces: `ServerDeps.requestRestart(): void`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/http/server.test.ts`:

```ts
test('POST /api/restart acknowledges and asks for exactly one restart', async () => {
  const db = openTestDatabase();
  let restarts = 0;
  const server = buildServer({ ...deps(db), requestRestart: () => { restarts += 1; } });

  const response = await server.inject({ method: 'POST', url: '/api/restart' });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json()['restarting'], true);
  // `inject` resolves once the reply has finished, which is exactly the event
  // the handler hangs the restart on.
  assert.equal(restarts, 1);

  await server.close();
  db.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:server 2>&1 | grep -A3 "asks for exactly one restart"`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

In `server.ts`, add to `ServerDeps`:

```ts
  /**
   * Shuts the process down cleanly so that whatever supervises it starts a new
   * one — in main.ts, the same function the signal handlers use.
   *
   * Injected so that `process.exit` stays out of the HTTP layer: a route that
   * called it directly could not be tested at all, and the one thing worth
   * testing here is that a restart is asked for exactly once.
   */
  requestRestart(): void;
```

and the route:

```ts
  /**
   * 202, then shut down — in that order, and that is the whole subtlety. The
   * restart is hung off the reply's `finish` event so the acknowledgement is on
   * the wire before teardown begins; restarting first would give the browser a
   * dropped connection, which is indistinguishable from a crash.
   */
  server.post('/api/restart', async (_request, reply) => {
    reply.raw.once('finish', () => {
      deps.requestRestart();
    });
    return reply.code(202).send({ restarting: true });
  });
```

In `main.ts`, replace the signal-handler loop at the end of `main()` with one shutdown path and three triggers:

```ts
  // One shutdown, three triggers. Previously the body below was written inline
  // inside the signal loop; `POST /api/restart` needs the same sequence, and a
  // second copy of it is how the two would come to differ about, say, whether
  // the database gets closed.
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    // A second trigger during teardown — a SIGTERM arriving while a requested
    // restart is already in flight — must not close an already-closing server.
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${reason}, shutting down`);
    scheduler.stop();
    void server.close().then(() => {
      db.close();
      // Zero, not one: this is a clean, intentional stop. Under the documented
      // `restart: unless-stopped` compose policy that is a restart; under
      // `restart: on-failure` it would not be, which is why the UI presents
      // this as an explicit action rather than something a save does silently.
      process.exit(0);
    });
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown(`${signal} received`));
  }
```

`shutdown` is referenced by the `buildServer` call, which runs earlier in the function, so pass it indirectly:

```ts
    requestRestart: () => shutdown('restart requested'),
```

Declare `shuttingDown` and `shutdown` **before** the `buildServer` call and keep the signal loop where it is; the arrow above closes over `shutdown`, and `shutdown` closes over `server`, so neither is read before both exist.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:server 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/http/server.ts packages/core/src/main.ts packages/core/test/http/server.test.ts
git commit -m "Offer a restart over HTTP, through the shutdown the signals already use"
```

---

### Task 7: `GET /api/database/backup`

**Files:**
- Modify: `packages/core/src/http/server.ts`
- Modify: `packages/core/src/main.ts`
- Test: `packages/core/test/http/server.test.ts` (append)

**Interfaces:**
- Produces: `ServerDeps.databasePath: string`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/http/server.test.ts`:

```ts
test('the backup route streams an openable copy and leaves nothing behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-backup-'));
  const databasePath = join(dir, 'pickarr.db');
  const db = openDatabase(databasePath);
  try {
    seedGroups(db);
    const server = buildServer({ ...deps(db), databasePath });

    const response = await server.inject({ method: 'GET', url: '/api/database/backup' });
    assert.equal(response.statusCode, 200);
    assert.equal(
      response.headers['content-disposition'],
      'attachment; filename="pickarr-1970-01-01.db"',
    );
    assert.equal(response.headers['content-type'], 'application/octet-stream');

    // A real SQLite file, and one that actually holds the seeded rows.
    const copyPath = join(dir, 'downloaded.db');
    await writeFile(copyPath, response.rawPayload);
    const copy = openDatabase(copyPath);
    try {
      const rows = copy.prepare('SELECT COUNT(*) AS n FROM media_groups').get();
      assert.equal(rows?.['n'], 2);
    } finally {
      copy.close();
    }

    // Nothing temporary survives: the only files here are the database, its WAL
    // sidecars, and the copy this test wrote itself.
    const left = (await readdir(dir)).filter((name) => name.startsWith('.'));
    assert.deepEqual(left, []);

    await server.close();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

`deps()` returns `now: () => 1000`, so the filename is the epoch date — that is what pins the name to `deps.now()` rather than to the wall clock. Add `openDatabase` to the `../../src/db/open.ts` import.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:server 2>&1 | grep -A3 "streams an openable copy"`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

In `server.ts`, add to `ServerDeps`:

```ts
  /**
   * The SQLite file `deps.db` was opened from, needed because the backup copy
   * is written beside it — same filesystem, so nothing crosses a device
   * boundary. `DatabaseSync` does not expose the path it was opened with, so
   * this cannot be recovered from `db`.
   */
  databasePath: string;
```

and the route:

```ts
  /**
   * A consistent copy of the database, streamed as a download.
   *
   * `backup` is SQLite's online backup API: it is safe against a WAL database
   * with writers active, which is the entire reason this is worth offering
   * instead of telling someone to `cp` the file and hope.
   *
   * The temporary file is unlinked as soon as its read stream is open. POSIX
   * keeps the bytes alive until the last descriptor closes, so the download
   * still works while there is no longer a name for the copy on disk — which
   * means an aborted download, a disconnected client, or a killed process
   * cannot strand a multi-megabyte file in the config volume. Nothing needs
   * pruning because nothing is ever left.
   *
   * A GET, not a POST: it does not change the database, and a plain GET is what
   * lets the browser use the filename chosen below.
   */
  server.get('/api/database/backup', async (_request, reply) => {
    const stamp = new Date(deps.now()).toISOString().slice(0, 10);
    const temporary = join(
      dirname(deps.databasePath),
      `.pickarr-backup-${process.pid}-${deps.now()}.tmp`,
    );

    try {
      await backup(deps.db, temporary);
    } catch (error) {
      await rm(temporary, { force: true });
      return reply.code(500).send({ error: `Backup failed: ${(error as Error).message}` });
    }

    let bytes: number;
    let stream: ReadStream;
    try {
      bytes = (await stat(temporary)).size;
      stream = createReadStream(temporary);
      // Opened above, so the data survives losing its name; see the note above.
      await rm(temporary, { force: true });
    } catch (error) {
      await rm(temporary, { force: true });
      return reply.code(500).send({ error: `Backup failed: ${(error as Error).message}` });
    }

    return reply
      .type('application/octet-stream')
      .header('content-disposition', `attachment; filename="pickarr-${stamp}.db"`)
      .header('content-length', bytes)
      .send(stream);
  });
```

New imports in `server.ts`: `backup` from `node:sqlite`; `createReadStream` and `type ReadStream` from `node:fs`; `stat` added to the `node:fs/promises` import; `dirname` added to the `node:path` import.

In `main.ts`, add to the `buildServer` call:

```ts
    databasePath: config.database.path,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:server 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/http/server.ts packages/core/src/main.ts packages/core/test/http/server.test.ts
git commit -m "Stream a consistent database backup that leaves no temporary file"
```

---

### Task 8: Web API surface, the em-dash nav, and a `/settings` route

The first task that shows something on screen. The page is a shell: it loads the config and reports load failures, and nothing more.

**Files:**
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/styles.css`
- Create: `packages/web/src/routes/Settings.tsx`
- Test: `packages/web/test/Settings.test.tsx`

**Interfaces:**
- Produces, in `client.ts` (hand-mirrored from `core`'s `editable.ts` and `views.ts` — `packages/web` must not import `packages/core`):

```ts
export type SecretView = { kind: 'file'; path: string } | { kind: 'set' };
export type SecretEdit = { kind: 'keep' } | { kind: 'file'; path: string } | { kind: 'literal'; value: string };
export interface EditablePathMapping { from: string; to: string }
export interface EditableDownloadClient { id: string; type: 'sabnzbd'; url: string; apiKey: SecretView; category: string; importMode: 'move' | 'copy'; pathMappings: EditablePathMapping[] }
export interface EditableFeed { id: string; url: string; plugin: string; intervalSeconds: number }
export interface EditableSiteLookup { type: 'theporndb'; apiKey: SecretView; baseUrl: string }
export interface EditableMetadata { enabled: boolean; intervalSeconds: number; perTick: number; artworkDir: string | null }
export type PluginSettingValue = string | number | boolean | string[];
export interface EditableConfig { server: { port: number }; database: { path: string }; trashDir: string; plugins: Record<string, Record<string, PluginSettingValue>>; downloadClients: EditableDownloadClient[]; feeds: EditableFeed[]; siteLookup: EditableSiteLookup | null; metadata: EditableMetadata }
export interface SubmittedDownloadClient { id: string; type: 'sabnzbd'; url: string; apiKey: SecretEdit; category: string; importMode: 'move' | 'copy'; pathMappings: EditablePathMapping[] }
export interface SubmittedSiteLookup { type: 'theporndb'; apiKey: SecretEdit; baseUrl: string }
export interface SubmittedConfig { server: { port: number }; database: { path: string }; trashDir: string; plugins: Record<string, Record<string, PluginSettingValue>>; downloadClients: SubmittedDownloadClient[]; feeds: EditableFeed[]; siteLookup: SubmittedSiteLookup | null; metadata: EditableMetadata }
export interface ConfigResponse { config: EditableConfig; portOverride: number | null; restartRequired: boolean }
export interface ConfigSaveResponse { savedAt: number; restartRequired: true }
export interface DatabaseBackup { blob: Blob; filename: string }
```

  plus `api.config()`, `api.saveConfig(submitted)`, `api.restart()`, `api.backupDatabase()`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/Settings.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { Settings } from '../src/routes/Settings.tsx';
import type { ConfigResponse } from '../src/api/client.ts';

afterEach(cleanup);

export function configResponse(over: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    config: {
      server: { port: 8080 },
      database: { path: '/config/pickarr.db' },
      trashDir: '/data/trash',
      plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes' } },
      downloadClients: [
        {
          id: 'sab',
          type: 'sabnzbd',
          url: 'http://sabnzbd:8080',
          apiKey: { kind: 'set' },
          category: 'pickarr',
          importMode: 'move',
          pathMappings: [],
        },
      ],
      feeds: [
        { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900 },
      ],
      siteLookup: null,
      metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: null },
    },
    portOverride: null,
    restartRequired: false,
    ...over,
  };
}

export function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    handler(String(input), init)) as unknown as typeof fetch;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('the page loads the config and shows the config path fields', async () => {
  stubFetch(async () => json(configResponse()));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByDisplayValue('/data/trash')));
});

test('a config that cannot be read is reported instead of rendering an empty form', async () => {
  stubFetch(async () => json({ error: 'Config at /config/config.json is not valid JSON: bad' }, 500));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByText(/not valid JSON/)));
  assert.equal(screen.queryByRole('button', { name: /^save$/i }), null);
});
```

Also add to `packages/web/test/Browse.test.tsx`… no — instead assert the nav in its own test. Create the nav assertion inside `Settings.test.tsx`:

```tsx
test('the nav separates Settings from the library tabs with an em dash', () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  const nav = screen.getByRole('navigation');
  assert.match(nav.textContent ?? '', /Failed—Settings/);
  // Decorative: a screen reader should announce five tabs, not an em dash
  // between them.
  assert.equal(nav.querySelector('.nav-separator')?.getAttribute('aria-hidden'), 'true');
});
```

with `import { MemoryRouter } from 'react-router';` and `import { App } from '../src/App.tsx';` added. This test needs a stubbed `fetch` because `<App />` mounts `<Browse />` at `/`; add `stubFetch(async () => json({ groups: [], nextCursor: null }));` as its first line.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:web 2>&1 | tail -20`
Expected: FAIL — cannot find `../src/routes/Settings.tsx`.

- [ ] **Step 3: Implement**

Append to `packages/web/src/api/client.ts` the types listed under **Interfaces** above, each with a one-line comment noting it mirrors `packages/core/src/config/editable.ts`, then add to the `api` object:

```ts
  config: () => request<ConfigResponse>('/api/config'),
  saveConfig: (submitted: SubmittedConfig) =>
    request<ConfigSaveResponse>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(submitted),
    }),
  restart: () => request<{ restarting: boolean }>('/api/restart', { method: 'POST' }),
  /**
   * Not routed through `request`, which always reads the body as JSON. A backup
   * is bytes, and the filename lives in a header rather than in a payload.
   *
   * Fetched into a blob rather than being left to an `<a download>`: an anchor
   * gives nowhere to report a backup that failed, and a failed backup answers
   * with a JSON error the page should be able to show.
   */
  backupDatabase: async (): Promise<DatabaseBackup> => {
    const response = await fetch('/api/database/backup');
    if (!response.ok) {
      const body: { error?: string } = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Backup failed with ${response.status}`);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const matched = /filename="([^"]+)"/.exec(disposition);
    return { blob: await response.blob(), filename: matched?.[1] ?? 'pickarr-backup.db' };
  },
```

`packages/web/src/App.tsx`:

```tsx
import { NavLink, Route, Routes } from 'react-router';
import { Browse } from './routes/Browse.tsx';
import { Picks } from './routes/Picks.tsx';
import { Downloads } from './routes/Downloads.tsx';
import { Failed } from './routes/Failed.tsx';
import { Settings } from './routes/Settings.tsx';

export function App() {
  return (
    <div className="app">
      <nav>
        <NavLink to="/">Browse</NavLink>
        <NavLink to="/picks">Picks</NavLink>
        <NavLink to="/downloads">Downloads</NavLink>
        <NavLink to="/failed">Failed</NavLink>
        {/*
          Settings is not a view of the library, it is a view of the
          installation, and the em dash is what says so. `aria-hidden` because
          it is punctuation: without it a screen reader announces "em dash" as a
          nav item, which is noise for the one class of user who cannot see the
          visual grouping it exists to convey.
        */}
        <span className="nav-separator" aria-hidden="true">—</span>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Browse />} />
          <Route path="/picks" element={<Picks />} />
          <Route path="/downloads" element={<Downloads />} />
          <Route path="/failed" element={<Failed />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
```

`packages/web/src/styles.css`, after the existing `nav a.active` rule:

```css
.nav-separator { opacity: 0.4; user-select: none; }
```

`packages/web/src/routes/Settings.tsx` — the shell, with a single `trashDir` input so the load path is observable. The remaining fields arrive in Tasks 10-12.

```tsx
import { useEffect, useState } from 'react';
import { api, type ConfigResponse } from '../api/client.ts';

/**
 * Configuration and installation-level actions.
 *
 * The form edits `config.json` on disk; nothing here changes the running
 * process, because config is read once at boot. That is why a save reports a
 * pending restart rather than claiming to have applied anything.
 */
export function Settings() {
  const [loaded, setLoaded] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const next = await api.config();
        if (!cancelled) {
          setLoaded(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1>Settings</h1>
      {error !== null && <p className="error">{error}</p>}
      {loaded !== null && (
        <label className="manual-field">
          Trash directory
          <input readOnly value={loaded.config.trashDir} />
        </label>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:web 2>&1 | tail -10`
Expected: PASS, three tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/App.tsx packages/web/src/styles.css packages/web/src/routes/Settings.tsx packages/web/test/Settings.test.tsx
git commit -m "Add the Settings tab, separated from the library tabs by an em dash"
```

---

### Task 9: `SecretField`

**Files:**
- Create: `packages/web/src/components/settings/SecretField.tsx`
- Test: `packages/web/test/SecretField.test.tsx`

**Interfaces:**
- Consumes: `SecretEdit`, `SecretView` from `../api/client.ts`.
- Produces:

```tsx
export interface SecretFieldProps { label: string; view: SecretView; value: SecretEdit; onChange(next: SecretEdit): void }
export function SecretField(props: SecretFieldProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/SecretField.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SecretField } from '../src/components/settings/SecretField.tsx';
import type { SecretEdit } from '../src/api/client.ts';

afterEach(cleanup);

test('a key held on disk shows as set and offers no value to read', () => {
  render(
    <SecretField label="API key" view={{ kind: 'set' }} value={{ kind: 'keep' }} onChange={() => {}} />,
  );
  assert.ok(screen.getByText(/set/i));
  assert.ok(screen.getByRole('button', { name: /replace/i }));
  // Nothing on screen can be read back as the key.
  assert.equal(screen.queryByRole('textbox'), null);
});

test('Replace switches to an empty literal the user types into', () => {
  const edits: SecretEdit[] = [];
  const { rerender } = render(
    <SecretField
      label="API key"
      view={{ kind: 'set' }}
      value={{ kind: 'keep' }}
      onChange={(next) => edits.push(next)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /replace/i }));
  assert.deepEqual(edits[0], { kind: 'literal', value: '' });

  rerender(
    <SecretField
      label="API key"
      view={{ kind: 'set' }}
      value={{ kind: 'literal', value: '' }}
      onChange={(next) => edits.push(next)}
    />,
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abcd1234abcd1234' } });
  assert.deepEqual(edits[1], { kind: 'literal', value: 'abcd1234abcd1234' });
});

test('a file: reference is editable as a path, because a path is not a secret', () => {
  const edits: SecretEdit[] = [];
  render(
    <SecretField
      label="API key"
      view={{ kind: 'file', path: '/run/secrets/key' }}
      value={{ kind: 'file', path: '/run/secrets/key' }}
      onChange={(next) => edits.push(next)}
    />,
  );
  const input = screen.getByRole('textbox');
  assert.equal(input.getAttribute('value'), '/run/secrets/key');
  fireEvent.change(input, { target: { value: '/run/secrets/other' } });
  assert.deepEqual(edits[0], { kind: 'file', path: '/run/secrets/other' });
});

test('a replacement can be abandoned, returning to keeping what is on disk', () => {
  const edits: SecretEdit[] = [];
  render(
    <SecretField
      label="API key"
      view={{ kind: 'set' }}
      value={{ kind: 'literal', value: 'half-typed' }}
      onChange={(next) => edits.push(next)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /keep existing/i }));
  assert.deepEqual(edits[0], { kind: 'keep' });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:web 2>&1 | tail -10`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
import type { SecretEdit, SecretView } from '../../api/client.ts';

export interface SecretFieldProps {
  label: string;
  /** What the server said is on disk. Fixed for the life of the form. */
  view: SecretView;
  /** What will be submitted for this field. */
  value: SecretEdit;
  onChange(next: SecretEdit): void;
}

/**
 * The one control for a write-only field.
 *
 * A `file:` reference is a path, so it is an ordinary editable text input. A
 * literal key is a secret the server never sent, so there is nothing to put in
 * an input at all: the field says only that a key is set, and replacing it is a
 * deliberate act that starts from empty. Leaving it alone submits
 * `{ kind: 'keep' }`, which the server resolves against the file.
 */
export function SecretField({ label, view, value, onChange }: SecretFieldProps) {
  if (value.kind === 'file') {
    return (
      <label className="manual-field">
        {label}
        <input
          type="text"
          value={value.path}
          onChange={(event) => onChange({ kind: 'file', path: event.target.value })}
        />
        <span className="manual-help">A path to a file holding the key.</span>
      </label>
    );
  }

  if (value.kind === 'literal') {
    return (
      <label className="manual-field">
        {label}
        <input
          type="text"
          value={value.value}
          onChange={(event) => onChange({ kind: 'literal', value: event.target.value })}
        />
        {/*
          Offered only when there is something on disk to go back to. For a
          client added in this form there is no existing key, so `keep` would be
          refused by the server.
        */}
        {view.kind === 'set' && (
          <button type="button" onClick={() => onChange({ kind: 'keep' })}>
            Keep existing
          </button>
        )}
      </label>
    );
  }

  return (
    <label className="manual-field">
      {label}
      <span className="secret-set">•••••••• set</span>
      <button type="button" onClick={() => onChange({ kind: 'literal', value: '' })}>
        Replace
      </button>
    </label>
  );
}
```

Add to `packages/web/src/styles.css`:

```css
.secret-set { font-family: ui-monospace, monospace; font-size: 0.85rem; opacity: 0.6; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:web 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/settings/SecretField.tsx packages/web/src/styles.css packages/web/test/SecretField.test.tsx
git commit -m "Add a secret field that can be replaced but never read back"
```

---

### Task 10: `ConfigForm` — the scalar sections

**Files:**
- Create: `packages/web/src/components/settings/ConfigForm.tsx`
- Test: `packages/web/test/ConfigForm.test.tsx`

**Interfaces:**
- Consumes: `SecretField` (Task 9); `EditableConfig`, `SubmittedConfig` from `../api/client.ts`.
- Produces:

```tsx
/** The form's working copy: every numeric field is text while being typed. */
export interface ConfigDraft {
  port: string;
  databasePath: string;
  trashDir: string;
  metadata: { enabled: boolean; intervalSeconds: string; perTick: string; artworkDir: string };
  siteLookup: { present: boolean; apiKey: SecretEdit; baseUrl: string };
  downloadClients: ClientDraft[];
  feeds: FeedDraft[];
  plugins: PluginDraft[];
}
export interface ClientDraft { id: string; url: string; apiKey: SecretEdit; category: string; importMode: 'move' | 'copy'; pathMappings: EditablePathMapping[] }
export interface FeedDraft { id: string; url: string; plugin: string; intervalSeconds: string }
export interface PluginDraft { name: string; settings: { key: string; value: PluginSettingValue }[] }
export function toDraft(config: EditableConfig): ConfigDraft;
export function toSubmission(draft: ConfigDraft, config: EditableConfig): SubmittedConfig | { error: string };
export interface ConfigFormProps { config: EditableConfig; draft: ConfigDraft; portOverride: number | null; onChange(next: ConfigDraft): void }
export function ConfigForm(props: ConfigFormProps): JSX.Element;
```

`config` is passed alongside `draft` because `SecretField` needs the immutable `view` (what is on disk) as well as the mutable edit, and because `toSubmission` needs the original `type` literals.

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/ConfigForm.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ConfigForm, toDraft, toSubmission } from '../src/components/settings/ConfigForm.tsx';
import type { EditableConfig } from '../src/api/client.ts';

afterEach(cleanup);

function config(over: Partial<EditableConfig> = {}): EditableConfig {
  return {
    server: { port: 8080 },
    database: { path: '/config/pickarr.db' },
    trashDir: '/data/trash',
    plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes', sites: ['Vixen'] } },
    downloadClients: [
      {
        id: 'sab',
        type: 'sabnzbd',
        url: 'http://sabnzbd:8080',
        apiKey: { kind: 'set' },
        category: 'pickarr',
        importMode: 'move',
        pathMappings: [],
      },
    ],
    feeds: [
      { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900 },
    ],
    siteLookup: null,
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: null },
    ...over,
  };
}

test('a round trip with no edits submits the config unchanged, keeping secrets', () => {
  const original = config();
  const submitted = toSubmission(toDraft(original), original);
  assert.ok(!('error' in submitted));
  assert.deepEqual(submitted.downloadClients[0]?.apiKey, { kind: 'keep' });
  assert.equal(submitted.trashDir, '/data/trash');
  assert.equal(submitted.server.port, 8080);
  assert.equal(submitted.metadata.artworkDir, null);
  assert.deepEqual(submitted.plugins, {
    '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes', sites: ['Vixen'] },
  });
});

test('an empty artwork directory submits as absent, not as an empty string', () => {
  const original = config({
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: '/old/art' },
  });
  const draft = toDraft(original);
  draft.metadata.artworkDir = '';
  const submitted = toSubmission(draft, original);
  assert.ok(!('error' in submitted));
  assert.equal(submitted.metadata.artworkDir, null);
});

test('a non-numeric port is caught here rather than sent for a 400', () => {
  const original = config();
  const draft = toDraft(original);
  draft.port = 'eighty eighty';
  const submitted = toSubmission(draft, original);
  assert.ok('error' in submitted);
  assert.match(submitted.error, /port/i);
});

test('editing the trash directory updates the draft', () => {
  const original = config();
  let draft = toDraft(original);
  render(
    <ConfigForm
      config={original}
      draft={draft}
      portOverride={null}
      onChange={(next) => {
        draft = next;
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '/data/bin' } });
  assert.equal(draft.trashDir, '/data/bin');
});

test('a runtime port override is stated instead of being silently contradicted', () => {
  const original = config();
  render(
    <ConfigForm config={original} draft={toDraft(original)} portOverride={9999} onChange={() => {}} />,
  );
  assert.ok(screen.getByText(/9999/));
  assert.ok(screen.getByText(/PICKARR_PORT/));
});

test('adding a site lookup starts with an empty literal key, not a keep', () => {
  const original = config();
  const draft = toDraft(original);
  draft.siteLookup = { present: true, apiKey: { kind: 'literal', value: '' }, baseUrl: 'https://api.theporndb.net' };
  const submitted = toSubmission(draft, original);
  assert.ok(!('error' in submitted));
  assert.deepEqual(submitted.siteLookup?.apiKey, { kind: 'literal', value: '' });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:web 2>&1 | tail -10`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/web/src/components/settings/ConfigForm.tsx` with the types from **Interfaces**, plus:

```tsx
/** `''` means "leave it out of the file"; see `metadata.artworkDir` in the spec. */
export function toDraft(config: EditableConfig): ConfigDraft {
  return {
    port: String(config.server.port),
    databasePath: config.database.path,
    trashDir: config.trashDir,
    metadata: {
      enabled: config.metadata.enabled,
      intervalSeconds: String(config.metadata.intervalSeconds),
      perTick: String(config.metadata.perTick),
      artworkDir: config.metadata.artworkDir ?? '',
    },
    siteLookup:
      config.siteLookup === null
        ? { present: false, apiKey: { kind: 'literal', value: '' }, baseUrl: 'https://api.theporndb.net' }
        : {
            present: true,
            apiKey: keepOrPath(config.siteLookup.apiKey),
            baseUrl: config.siteLookup.baseUrl,
          },
    downloadClients: config.downloadClients.map((client) => ({
      id: client.id,
      url: client.url,
      apiKey: keepOrPath(client.apiKey),
      category: client.category,
      importMode: client.importMode,
      pathMappings: client.pathMappings.map((mapping) => ({ ...mapping })),
    })),
    feeds: config.feeds.map((feed) => ({
      id: feed.id,
      url: feed.url,
      plugin: feed.plugin,
      intervalSeconds: String(feed.intervalSeconds),
    })),
    plugins: Object.entries(config.plugins).map(([name, settings]) => ({
      name,
      settings: Object.entries(settings).map(([key, value]) => ({
        key,
        value: Array.isArray(value) ? [...value] : value,
      })),
    })),
  };
}

/**
 * The starting edit for a field the server described. A `file:` path is
 * editable text and starts as itself; a literal key was never sent, so the only
 * honest starting point is "keep whatever is on disk".
 */
function keepOrPath(view: SecretView): SecretEdit {
  return view.kind === 'file' ? { kind: 'file', path: view.path } : { kind: 'keep' };
}

/** A positive integer, or the field name that failed, so the form can say which. */
function asCount(raw: string, field: string): number | { error: string } {
  if (!/^\d+$/.test(raw.trim())) return { error: `${field} must be a whole number` };
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : { error: `${field} must be a whole number` };
}
```

`toSubmission` converts every numeric field through `asCount`, returning the first `{ error }` it hits, maps `artworkDir: ''` to `null`, drops `siteLookup` when `present` is false, and re-attaches the `type` literals (`'sabnzbd'`, `'theporndb'`) from `config`. `plugins` is rebuilt from the `PluginDraft[]` array back into a `Record`, last key winning on a duplicate.

The component renders four `<fieldset>`s — Server, Database, Metadata, Site lookup — using `.manual-field` for each row, then renders `<DownloadClientFields>`, `<FeedFields>` and `<PluginFields>` (Tasks 11-12; until they exist, render nothing in their place and add them in those tasks). Every input is associated with its label by nesting it inside `<label>`, which is what makes `getByLabelText` work. The port row renders, when `portOverride !== null`:

```tsx
<span className="manual-help">
  PICKARR_PORT is overriding this at runtime; this process is listening on {portOverride}.
</span>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:web 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/settings/ConfigForm.tsx packages/web/test/ConfigForm.test.tsx
git commit -m "Draft and submit the scalar half of the config form"
```

---

### Task 11: `DownloadClientFields` and `FeedFields`

**Files:**
- Create: `packages/web/src/components/settings/DownloadClientFields.tsx`
- Create: `packages/web/src/components/settings/FeedFields.tsx`
- Modify: `packages/web/src/components/settings/ConfigForm.tsx` (render them)
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/DownloadClientFields.test.tsx`, `packages/web/test/FeedFields.test.tsx`

**Interfaces:**
- Consumes: `ClientDraft`, `FeedDraft` (Task 10); `SecretField` (Task 9); `EditableDownloadClient` from `../api/client.ts`.
- Produces:

```tsx
export interface DownloadClientFieldsProps { clients: ClientDraft[]; onDisk: EditableDownloadClient[]; onChange(next: ClientDraft[]): void }
export function DownloadClientFields(props: DownloadClientFieldsProps): JSX.Element;
export interface FeedFieldsProps { feeds: FeedDraft[]; pluginNames: string[]; onChange(next: FeedDraft[]): void }
export function FeedFields(props: FeedFieldsProps): JSX.Element;
```

`onDisk` supplies each row's `SecretView`, matched by index; a row added in the form has no entry and its `SecretField` gets `{ kind: 'set' }`… **no** — an added row must not claim a key exists. It gets no `onDisk` entry, and `DownloadClientFields` passes `{ kind: 'file', path: '' }` only if the draft says so; otherwise the row's `SecretField` receives `view={{ kind: 'set' }}` **only when `onDisk[index]` exists**. For an added row, pass the draft's own `apiKey` and a `view` of `{ kind: 'set' }` is wrong; pass `view={{ kind: 'file', path: '' }}`? Neither is right. Resolve it by keying `onDisk` by id and giving an unmatched row a `view` that suppresses "Keep existing":

```tsx
const view = onDisk.find((client) => client.id === draft.id)?.apiKey;
// No entry means this row is new: there is no key on disk, so nothing to keep.
<SecretField view={view ?? { kind: 'file', path: '' }} ... />
```

Because `SecretField` only offers *Keep existing* when `view.kind === 'set'`, an added row correctly never offers it.

- [ ] **Step 1: Write the failing tests**

`packages/web/test/DownloadClientFields.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DownloadClientFields } from '../src/components/settings/DownloadClientFields.tsx';
import type { ClientDraft } from '../src/components/settings/ConfigForm.tsx';
import type { EditableDownloadClient } from '../src/api/client.ts';

afterEach(cleanup);

const ON_DISK: EditableDownloadClient[] = [
  {
    id: 'sab',
    type: 'sabnzbd',
    url: 'http://sabnzbd:8080',
    apiKey: { kind: 'set' },
    category: 'pickarr',
    importMode: 'move',
    pathMappings: [{ from: '/downloads', to: '/data/downloads' }],
  },
];

function draft(): ClientDraft[] {
  return [
    {
      id: 'sab',
      url: 'http://sabnzbd:8080',
      apiKey: { kind: 'keep' },
      category: 'pickarr',
      importMode: 'move',
      pathMappings: [{ from: '/downloads', to: '/data/downloads' }],
    },
  ];
}

test('an existing client offers to keep its key; an added one cannot', () => {
  let next = draft();
  const { rerender } = render(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  assert.equal(screen.getAllByText(/set/i).length, 1);

  fireEvent.click(screen.getByRole('button', { name: /add download client/i }));
  rerender(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );

  assert.equal(next.length, 2);
  // The new row starts with an empty literal: there is no key on disk for it,
  // so `keep` would be refused by the server.
  assert.deepEqual(next[1]?.apiKey, { kind: 'literal', value: '' });
  assert.equal(screen.queryAllByRole('button', { name: /keep existing/i }).length, 0);
});

test('removing a client drops exactly that row', () => {
  let next = [...draft(), { ...draft()[0]!, id: 'sab2' }];
  render(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[1]!);
  assert.deepEqual(next.map((client) => client.id), ['sab']);
});

test('a path mapping can be added and edited', () => {
  let next = draft();
  const { rerender } = render(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /add path mapping/i }));
  rerender(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  assert.equal(next[0]?.pathMappings.length, 2);
  assert.deepEqual(next[0]?.pathMappings[1], { from: '', to: '' });
});
```

`packages/web/test/FeedFields.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FeedFields } from '../src/components/settings/FeedFields.tsx';
import type { FeedDraft } from '../src/components/settings/ConfigForm.tsx';

afterEach(cleanup);

function feeds(): FeedDraft[] {
  return [
    { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: '900' },
  ];
}

test('a feed picks its plugin from the configured ones, not free text', () => {
  render(
    <FeedFields feeds={feeds()} pluginNames={['@pickarr/plugin-scenes']} onChange={() => {}} />,
  );
  const select = screen.getByLabelText(/plugin/i);
  assert.equal(select.tagName, 'SELECT');
  assert.deepEqual(
    [...select.querySelectorAll('option')].map((option) => option.getAttribute('value')),
    ['@pickarr/plugin-scenes'],
  );
});

test('an added feed defaults its interval to the schema default', () => {
  let next = feeds();
  render(
    <FeedFields feeds={next} pluginNames={['@pickarr/plugin-scenes']} onChange={(value) => { next = value; }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /add feed/i }));
  assert.equal(next.length, 2);
  assert.equal(next[1]?.intervalSeconds, '900');
  assert.equal(next[1]?.plugin, '@pickarr/plugin-scenes');
});

test('removing a feed drops exactly that row', () => {
  let next = [...feeds(), { ...feeds()[0]!, id: 'feed2' }];
  render(
    <FeedFields feeds={next} pluginNames={['@pickarr/plugin-scenes']} onChange={(value) => { next = value; }} />,
  );
  fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]!);
  assert.deepEqual(next.map((feed) => feed.id), ['feed2']);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:web 2>&1 | tail -10`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Both components follow the same shape: a `<fieldset>` with a `<legend>`, one `<article className="settings-row">` per entry holding `.manual-field` labels, a `Remove` button per row, and an `Add …` button after the list. Every handler produces a new array (`clients.map`, `clients.filter`, `[...clients, blank]`) and calls `onChange` — no in-place mutation, so React sees a new reference.

`DownloadClientFields` renders per row: `id`, `url`, `<SecretField>` (view resolved by id as described above), `category`, an `importMode` `<select>` of `move`/`copy`, and the path-mapping sub-list with its own `Add path mapping` / `Remove` buttons. A new client is:

```tsx
const blankClient: ClientDraft = {
  id: '',
  url: '',
  // An empty literal, not `keep`: there is no key on disk for a client that
  // does not exist there yet, and the server refuses a `keep` it cannot match.
  apiKey: { kind: 'literal', value: '' },
  category: '',
  importMode: 'move',
  pathMappings: [],
};
```

`FeedFields` renders per row: `id`, `url`, a `plugin` `<select>` built from `pluginNames`, and `intervalSeconds`. A new feed is:

```tsx
const blankFeed: FeedDraft = {
  id: '',
  url: '',
  // The first configured plugin rather than an empty option: `feedSchema`
  // requires a plugin that `plugins` also configures, so an empty value is
  // never valid and offering it only produces a 400.
  plugin: pluginNames[0] ?? '',
  // `feedSchema`'s own default, so a row added here matches a row omitted from
  // the file.
  intervalSeconds: '900',
};
```

In `ConfigForm.tsx`, render them from the draft:

```tsx
<DownloadClientFields
  clients={draft.downloadClients}
  onDisk={config.downloadClients}
  onChange={(downloadClients) => onChange({ ...draft, downloadClients })}
/>
<FeedFields
  feeds={draft.feeds}
  pluginNames={draft.plugins.map((plugin) => plugin.name)}
  onChange={(feeds) => onChange({ ...draft, feeds })}
/>
```

Add to `styles.css`:

```css
.settings-row { border: 1px solid rgb(from currentColor r g b / 20%); border-radius: 0.5rem; padding: 0.75rem; margin-bottom: 0.75rem; }
.settings-row-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
fieldset { border: 1px solid rgb(from currentColor r g b / 25%); border-radius: 0.5rem; margin: 0 0 1rem; }
legend { font-weight: 600; font-size: 0.9rem; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:web 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/settings/DownloadClientFields.tsx packages/web/src/components/settings/FeedFields.tsx packages/web/src/components/settings/ConfigForm.tsx packages/web/src/styles.css packages/web/test/DownloadClientFields.test.tsx packages/web/test/FeedFields.test.tsx
git commit -m "Edit download clients and feeds as add/remove lists"
```

---

### Task 12: `PluginFields`

**Files:**
- Create: `packages/web/src/components/settings/PluginFields.tsx`
- Modify: `packages/web/src/components/settings/ConfigForm.tsx`
- Test: `packages/web/test/PluginFields.test.tsx`

**Interfaces:**
- Consumes: `PluginDraft` (Task 10); `PluginSettingValue` from `../api/client.ts`.
- Produces:

```tsx
export interface PluginFieldsProps { plugins: PluginDraft[]; onChange(next: PluginDraft[]): void }
export function PluginFields(props: PluginFieldsProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PluginFields } from '../src/components/settings/PluginFields.tsx';
import type { PluginDraft } from '../src/components/settings/ConfigForm.tsx';

afterEach(cleanup);

function plugins(): PluginDraft[] {
  return [
    {
      name: '@pickarr/plugin-scenes',
      settings: [
        { key: 'libraryRoot', value: '/media/scenes' },
        { key: 'sites', value: ['Vixen', 'Bangbros'] },
        { key: 'strict', value: true },
        { key: 'retries', value: 3 },
      ],
    },
  ];
}

test('each value type gets a control that cannot change its type', () => {
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);

  // A list is one value per line, so editing it cannot turn it into a string.
  const sites = screen.getByLabelText(/sites/i);
  assert.equal(sites.tagName, 'TEXTAREA');
  fireEvent.change(sites, { target: { value: 'Vixen\nTushy\n' } });
  assert.deepEqual(next[0]?.settings[1]?.value, ['Vixen', 'Tushy']);

  assert.equal(screen.getByLabelText(/strict/i).getAttribute('type'), 'checkbox');
  assert.equal(screen.getByLabelText(/retries/i).getAttribute('type'), 'number');
});

test('a number stays a number rather than becoming a string', () => {
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText(/retries/i), { target: { value: '5' } });
  assert.equal(next[0]?.settings[3]?.value, 5);
  assert.equal(typeof next[0]?.settings[3]?.value, 'number');
});

test('blank lines in a list are dropped rather than becoming empty entries', () => {
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText(/sites/i), { target: { value: 'Vixen\n\n  \nTushy' } });
  assert.deepEqual(next[0]?.settings[1]?.value, ['Vixen', 'Tushy']);
});

test('adding a setting asks for its type', () => {
  let next = plugins();
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText(/new setting type/i), { target: { value: 'list' } });
  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add setting/i }));
  assert.deepEqual(next[0]?.settings.at(-1), { key: '', value: [] });
});

test('a plugin can be added and removed', () => {
  let next = plugins();
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add plugin/i }));
  assert.equal(next.length, 2);
  assert.deepEqual(next[1], { name: '', settings: [] });

  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getAllByRole('button', { name: /remove plugin/i })[1]!);
  assert.deepEqual(next.map((plugin) => plugin.name), ['@pickarr/plugin-scenes']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:web 2>&1 | tail -10`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
import { useState } from 'react';
import type { PluginSettingValue } from '../../api/client.ts';
import type { PluginDraft } from './ConfigForm.tsx';

export interface PluginFieldsProps {
  plugins: PluginDraft[];
  onChange(next: PluginDraft[]): void;
}

type SettingType = 'text' | 'number' | 'boolean' | 'list';

/** The blank value for a newly-added setting of each type. */
const BLANK: Record<SettingType, PluginSettingValue> = {
  text: '',
  number: 0,
  boolean: false,
  list: [],
};

/**
 * A list is edited one value per line.
 *
 * Blank lines are dropped rather than becoming empty strings: `configSchema`
 * types this as `z.array(z.string())` and would accept `['']` happily, leaving a
 * plugin to treat an empty site name as a real one.
 */
function toLines(value: string[]): string {
  return value.join('\n');
}

function fromLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The `plugins` block: a record of plugin package names, each holding a record
 * of settings whose values may be a string, a number, a boolean or a list of
 * strings.
 *
 * The control is chosen from the value's *current* type and cannot change it.
 * A single text input for everything would be smaller code, but every save
 * would rewrite `sites: ["Vixen"]` as `sites: "Vixen"` and `retries: 3` as
 * `retries: "3"` — and `plugins` is typed loosely enough in `configSchema`
 * (`z.union([...])`) that the file would still validate, so the damage would
 * only show up as a plugin misbehaving later.
 */
export function PluginFields({ plugins, onChange }: PluginFieldsProps) {
  const [addAs, setAddAs] = useState<Record<number, SettingType>>({});

  const replace = (index: number, plugin: PluginDraft): void => {
    onChange(plugins.map((existing, at) => (at === index ? plugin : existing)));
  };

  return (
    <fieldset>
      <legend>Plugins</legend>
      {plugins.map((plugin, index) => (
        <article className="settings-row" key={index}>
          <label className="manual-field">
            Package
            <input
              type="text"
              value={plugin.name}
              onChange={(event) => replace(index, { ...plugin, name: event.target.value })}
            />
          </label>

          {plugin.settings.map((setting, settingIndex) => {
            const update = (value: PluginSettingValue): void => {
              replace(index, {
                ...plugin,
                settings: plugin.settings.map((existing, at) =>
                  at === settingIndex ? { ...existing, value } : existing,
                ),
              });
            };
            const rename = (key: string): void => {
              replace(index, {
                ...plugin,
                settings: plugin.settings.map((existing, at) =>
                  at === settingIndex ? { ...existing, key } : existing,
                ),
              });
            };
            const id = `plugin-${index}-setting-${settingIndex}`;

            return (
              <div className="manual-field" key={settingIndex}>
                <input
                  type="text"
                  aria-label={`Setting name ${settingIndex + 1}`}
                  value={setting.key}
                  onChange={(event) => rename(event.target.value)}
                />
                <label htmlFor={id}>{setting.key}</label>
                {Array.isArray(setting.value) ? (
                  <textarea
                    id={id}
                    value={toLines(setting.value)}
                    onChange={(event) => update(fromLines(event.target.value))}
                  />
                ) : typeof setting.value === 'boolean' ? (
                  <input
                    id={id}
                    type="checkbox"
                    checked={setting.value}
                    onChange={(event) => update(event.target.checked)}
                  />
                ) : typeof setting.value === 'number' ? (
                  <input
                    id={id}
                    type="number"
                    value={String(setting.value)}
                    onChange={(event) => update(Number(event.target.value))}
                  />
                ) : (
                  <input
                    id={id}
                    type="text"
                    value={setting.value}
                    onChange={(event) => update(event.target.value)}
                  />
                )}
                <button
                  type="button"
                  onClick={() =>
                    replace(index, {
                      ...plugin,
                      settings: plugin.settings.filter((_, at) => at !== settingIndex),
                    })
                  }
                >
                  Remove setting
                </button>
              </div>
            );
          })}

          <div className="settings-row-actions">
            <label>
              New setting type
              <select
                value={addAs[index] ?? 'text'}
                onChange={(event) =>
                  setAddAs({ ...addAs, [index]: event.target.value as SettingType })
                }
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="boolean">Yes / no</option>
                <option value="list">List of text</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() =>
                replace(index, {
                  ...plugin,
                  settings: [...plugin.settings, { key: '', value: BLANK[addAs[index] ?? 'text'] }],
                })
              }
            >
              Add setting
            </button>
            <button
              type="button"
              onClick={() => onChange(plugins.filter((_, at) => at !== index))}
            >
              Remove plugin
            </button>
          </div>
        </article>
      ))}
      <button type="button" onClick={() => onChange([...plugins, { name: '', settings: [] }])}>
        Add plugin
      </button>
    </fieldset>
  );
}
```

In `ConfigForm.tsx`, render it:

```tsx
<PluginFields
  plugins={draft.plugins}
  onChange={(plugins) => onChange({ ...draft, plugins })}
/>
```

Note for the implementer: the `<label htmlFor={id}>{setting.key}</label>` is what makes `getByLabelText(/sites/i)` find the control, and it re-associates automatically when the key is renamed. If a test cannot find a control by label, that pairing is what to check.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:web 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/settings/PluginFields.tsx packages/web/src/components/settings/ConfigForm.tsx packages/web/test/PluginFields.test.tsx
git commit -m "Edit plugin settings without silently changing a value's type"
```

---

### Task 13: Wire the page — save, restart, backup

**Files:**
- Modify: `packages/web/src/routes/Settings.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/Settings.test.tsx` (extend)

**Interfaces:**
- Consumes: everything from Tasks 8-12.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/test/Settings.test.tsx`:

```tsx
test('Save is offered only once the draft differs from what was loaded', async () => {
  stubFetch(async () => json(configResponse()));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/trash directory/i)));

  const save = screen.getByRole('button', { name: /^save$/i });
  assert.equal(save.hasAttribute('disabled'), true);

  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '/data/bin' } });
  assert.equal(screen.getByRole('button', { name: /^save$/i }).hasAttribute('disabled'), false);
});

test('saving sends keep for an untouched secret and reports the pending restart', async () => {
  const sent: string[] = [];
  stubFetch(async (url, init) => {
    if (init?.method === 'PUT') {
      sent.push(String(init.body));
      return json({ savedAt: 1, restartRequired: true });
    }
    return json(configResponse());
  });

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/trash directory/i)));
  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '/data/bin' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() => assert.ok(screen.getByText(/restart/i)));
  const body = JSON.parse(sent[0] ?? '{}') as { trashDir: string; downloadClients: { apiKey: unknown }[] };
  assert.equal(body.trashDir, '/data/bin');
  assert.deepEqual(body.downloadClients[0]?.apiKey, { kind: 'keep' });
});

test('a refused save shows the reason and keeps the edit on screen', async () => {
  stubFetch(async (_url, init) =>
    init?.method === 'PUT'
      ? json({ error: 'Config at /config/config.json is invalid — trashDir: String must contain at least 1 character(s)' }, 400)
      : json(configResponse()),
  );

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/trash directory/i)));
  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() => assert.ok(screen.getByText(/trashDir/)));
  // The edit is still there to correct — a rejected save must not discard it.
  assert.equal((screen.getByLabelText(/trash directory/i) as HTMLInputElement).value, '');
});

// The notice has to survive a reload, or a saved-but-unapplied config sits
// there with nothing on screen saying so.
test('a restart pending from an earlier save is reported on load', async () => {
  stubFetch(async () => json(configResponse({ restartRequired: true })));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /restart now/i })));
});

test('Restart now posts and says what it is doing', async () => {
  let restarts = 0;
  stubFetch(async (url, init) => {
    if (url.endsWith('/api/restart') && init?.method === 'POST') {
      restarts += 1;
      return json({ restarting: true }, 202);
    }
    return json(configResponse({ restartRequired: true }));
  });

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /restart now/i })));
  fireEvent.click(screen.getByRole('button', { name: /restart now/i }));
  await waitFor(() => assert.equal(restarts, 1));
  await waitFor(() => assert.ok(screen.getByText(/restarting/i)));
});

test('a failed backup is reported rather than failing silently', async () => {
  stubFetch(async (url) =>
    url.endsWith('/api/database/backup')
      ? json({ error: 'Backup failed: ENOSPC' }, 500)
      : json(configResponse()),
  );

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /back up/i })));
  fireEvent.click(screen.getByRole('button', { name: /back up/i }));
  await waitFor(() => assert.ok(screen.getByText(/ENOSPC/)));
});

test('a successful backup names the file it saved', async () => {
  stubFetch(async (url) =>
    url.endsWith('/api/database/backup')
      ? new Response('SQLite format 3 ', {
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="pickarr-2026-08-13.db"',
          },
        })
      : json(configResponse()),
  );

  // happy-dom has no download plumbing; these two are what the click uses.
  const created: string[] = [];
  URL.createObjectURL = () => {
    created.push('blob:stub');
    return 'blob:stub';
  };
  URL.revokeObjectURL = () => {};

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /back up/i })));
  fireEvent.click(screen.getByRole('button', { name: /back up/i }));
  await waitFor(() => assert.ok(screen.getByText(/pickarr-2026-08-13\.db/)));
  assert.equal(created.length, 1);
});
```

Add `fireEvent` to the `@testing-library/react` import.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:web 2>&1 | tail -20`
Expected: FAIL — no Save button; the page is still the Task 8 shell.

- [ ] **Step 3: Implement**

Rewrite `packages/web/src/routes/Settings.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api, type ConfigResponse } from '../api/client.ts';
import { ConfigForm, toDraft, toSubmission, type ConfigDraft } from '../components/settings/ConfigForm.tsx';

/**
 * Configuration and installation-level actions.
 *
 * Nothing here changes the running process: config is read once at boot, so a
 * save reports a pending restart rather than claiming to have applied anything,
 * and applying it is a separate, explicitly-labelled action. See §9 of the
 * design for why that is a button and not something a save does on your behalf.
 */
export function Settings() {
  const [loaded, setLoaded] = useState<ConfigResponse | null>(null);
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const next = await api.config();
        if (cancelled) return;
        setLoaded(next);
        setDraft(toDraft(next.config));
        setRestartRequired(next.restartRequired);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Compared against what was loaded rather than tracked with a dirty flag, so
  // editing a field back to its original value correctly disables Save again.
  const dirty =
    loaded !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(loaded.config));

  async function save(): Promise<void> {
    if (loaded === null || draft === null) return;
    const submitted = toSubmission(draft, loaded.config);
    if ('error' in submitted) {
      setNotice(null);
      setError(submitted.error);
      return;
    }

    try {
      await api.saveConfig(submitted);
      // Re-read, so the redacted view of any secret just replaced comes back as
      // `set` and the form stops offering to submit the literal again. The
      // draft is reseeded from the response for the same reason.
      const next = await api.config();
      setLoaded(next);
      setDraft(toDraft(next.config));
      setRestartRequired(true);
      setNotice('Saved. Pickarr is still running the settings it booted with.');
      setError(null);
    } catch (cause) {
      setNotice(null);
      // The draft is deliberately left alone: the edit that was refused is the
      // one the user needs in front of them to correct.
      setError((cause as Error).message);
    }
  }

  async function restart(): Promise<void> {
    try {
      await api.restart();
      setRestarting(true);
      setNotice('Restarting. This page will not update until Pickarr is back.');
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function backUp(): Promise<void> {
    try {
      const { blob, filename } = await api.backupDatabase();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setNotice(`Downloaded ${filename}`);
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  return (
    <section>
      <h1>Settings</h1>
      {notice !== null && <p className="notice">{notice}</p>}
      {error !== null && <p className="error">{error}</p>}

      {loaded !== null && draft !== null && (
        <>
          <ConfigForm
            config={loaded.config}
            draft={draft}
            portOverride={loaded.portOverride}
            onChange={setDraft}
          />

          <div className="settings-actions">
            <button type="button" disabled={!dirty} onClick={() => void save()}>
              Save
            </button>
            {restartRequired && !restarting && (
              <button type="button" onClick={() => void restart()}>
                Restart now
              </button>
            )}
          </div>

          <fieldset>
            <legend>Database</legend>
            <p className="manual-help">
              A consistent copy taken while Pickarr keeps running, downloaded to this browser.
            </p>
            <button type="button" onClick={() => void backUp()}>
              Back up &amp; download database
            </button>
          </fieldset>
        </>
      )}
    </section>
  );
}
```

Add to `styles.css`:

```css
.settings-actions { display: flex; gap: 0.5rem; margin: 0.75rem 0 1.5rem; }
.notice { color: #15803d; }
```

(If `.notice` already exists from the Failed screen, leave the existing rule alone.)

- [ ] **Step 4: Run the whole web suite**

Run: `npm run test:web 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/Settings.tsx packages/web/src/styles.css packages/web/test/Settings.test.tsx
git commit -m "Wire Settings to save, restart, and download a database backup"
```

---

### Task 14: End-to-end coverage, docs, and the full gate

**Files:**
- Create: `packages/e2e/tests/settings.spec.ts`
- Modify: `README.md`
- Test: the whole suite

**Interfaces:**
- Consumes: the harness in `packages/e2e/src/harness.ts` and the paths helper in `packages/e2e/src/paths.ts`.

- [ ] **Step 1: Read the harness before writing the spec**

Run: `sed -n '1,80p' packages/e2e/src/harness.ts && sed -n '1,40p' packages/e2e/tests/smoke.spec.ts`

The spec must follow whatever the harness already does for starting a server with a temp config and database — do not invent a second way of doing it. Note the harness's config path; the assertions below read that same file.

- [ ] **Step 2: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Adapt these two lines to the harness's own accessors — see Step 1.
test('a config edit reaches the file on disk', async ({ page }) => {
  await page.goto('/settings');
  const trash = page.getByLabel(/trash directory/i);
  await expect(trash).toBeVisible();

  await trash.fill('/data/trash-e2e');
  await page.getByRole('button', { name: /^save$/i }).click();

  await expect(page.getByText(/still running the settings it booted with/i)).toBeVisible();

  const written = JSON.parse(await readFile(configPath, 'utf8')) as { trashDir: string };
  expect(written.trashDir).toBe('/data/trash-e2e');
});

test('the nav separates Settings from the library tabs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation')).toContainText('Failed—Settings');
});

test('the database downloads as a real SQLite file', async ({ page }) => {
  await page.goto('/settings');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /back up/i }).click();

  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/^pickarr-\d{4}-\d{2}-\d{2}\.db$/);
  const path = await saved.path();
  const header = (await readFile(path)).subarray(0, 15).toString('latin1');
  expect(header).toBe('SQLite format 3');
});

// Restart is deliberately not exercised: it exits the process the harness is
// driving. `POST /api/restart` calling `requestRestart` exactly once is covered
// by packages/core/test/http/server.test.ts.
```

- [ ] **Step 3: Run the e2e suite**

Run: `npm run e2e 2>&1 | tail -20`
Expected: PASS, three tests.

- [ ] **Step 4: Document the tab**

Add a short section to `README.md` beside the existing configuration prose: that `Settings` edits `config.json` in place, that changes apply on restart and the tab offers one, that api keys are never sent to the browser and are left unchanged unless replaced, and that the backup button downloads a consistent copy taken with SQLite's online backup API. Match the README's existing tone and heading level.

- [ ] **Step 5: Run the full gate**

Run: `npm run check && npm run build`
Expected: lint clean, typecheck clean, all server and web tests pass, all four workspace builds succeed.

- [ ] **Step 6: Commit**

```bash
git add packages/e2e/tests/settings.spec.ts README.md
git commit -m "Cover the Settings tab end to end and document it"
```

---

## Self-Review

**Spec coverage.** §3 nav → Task 8. §4 `loadConfig` split → Task 1. §5 write-only secrets → Tasks 2, 3, 9. §6 projection and unknown-key preservation → Tasks 2, 3. §7 saving, rehearsal, atomic write, `restartRequired`, `portOverride` → Tasks 4, 5. §8 backup → Task 7. §9 restart and one shutdown path → Task 6. §10 server surface → Tasks 4-7. §11 the five UI files, numeric-as-text, `SecretField`, `PluginFields` types, artworkDir placeholder → Tasks 8-13. §12 testing → every task, with e2e in Task 14.

One spec sentence is refined rather than implemented literally: §6 says an unparseable `config.json` makes the form "render read-only". Tasks 4 and 8 answer 500 with the reason and render *no* form, which is the same outcome — there is no document to render — with less machinery. Task 8's second test pins it.

**Placeholders.** Task 10 describes `toSubmission`'s body in prose rather than giving every line, and Task 11 describes both components' JSX in prose. Both are backed by the exact type signatures, the exact blank-row literals, and tests that pin the behaviour; the mechanical field-by-field mapping is the part an implementer should not be copying from a plan. Task 14 Step 2 leaves `configPath` to be read from the harness in Step 1 — deliberately, because inventing a second way to locate the e2e config would be worse than looking at the first.

**Type consistency.** `SecretView`/`SecretEdit`/`EditableConfig`/`SubmittedConfig` are declared once in Task 2/3 and mirrored verbatim in Task 8. `ConfigDraft`, `ClientDraft`, `FeedDraft`, `PluginDraft` are declared in Task 10 and imported from `ConfigForm.tsx` by Tasks 11-13. `ServerDeps` gains `configPath` and `bootConfigDocument` (Task 4), `requestRestart` (Task 6) and `databasePath` (Task 7); Task 4 Step 1 adds all four to the test helper at once so the file compiles from that point on. `api.config`/`saveConfig`/`restart`/`backupDatabase` are named identically in Task 8 and used under those names in Task 13.
