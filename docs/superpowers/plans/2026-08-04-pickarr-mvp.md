# Pickarr MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Pickarr's MVP — follow RSS feeds, collate releases into pickable media groups, send picks to SABnzbd, and import completed downloads into a library.

**Architecture:** npm workspaces monorepo. `@pickarr/plugin-api` defines a three-method plugin contract and depends on nothing; `@pickarr/core` is a Fastify server over `node:sqlite` driving two timers (ingest and reconcile) whose state machine lives entirely in the database; `@pickarr/plugin-scenes` implements the contract for adult scene releases; `@pickarr/web` is a React SPA served as static assets. Crash safety comes from the DB being the queue — reconciliation is idempotent and boot recovery is two statements.

**Tech Stack:** Node 24, TypeScript 7 (`tsgo`, typecheck only), Fastify 5, React 19 + Vite, `node:sqlite`, zod, fast-xml-parser, esbuild, oxlint, `node:test` + `tsx` + happy-dom.

**Spec:** `docs/superpowers/specs/2026-08-04-pickarr-design.md`

## Global Constraints

- Node 24. The repo does not support older majors — `node:sqlite` and unflagged type stripping both assume it.
- TypeScript 7 via `@typescript/native-preview`, invoked as `tsgo --noEmit`. Never used for emit. Fallback if it breaks: `tsc --noEmit`, no other change.
- esbuild does all transpilation. Nothing is ever emitted by a TypeScript compiler.
- oxlint is the linter. ESLint is not used — it does not work with TypeScript 7.
- `node:test` is the only test runner, for both server and web.
- **Never use the `any` or `unknown` TypeScript types.** Model unions explicitly. Where a library hands back an untyped value — `node:sqlite` rows, `response.json()` — narrow it once at the boundary through a named helper (`src/db/row.ts`, the `JsonValue` guards in `sabnzbd.ts`) rather than casting at each use site.
- 2-space indentation. Always terminate statements with semicolons.
- Prefer async APIs over synchronous twins — `fs.promises`, never `fs.*Sync`. The single documented exception is `node:sqlite`, which has no async form.
- `@pickarr/core` and any plugin may both depend on `@pickarr/plugin-api`. They must never depend on each other.
- Secret values are read from files at boot, held in memory, and never logged, never returned by an API route, and never written to the database.
- **Never commit without Chad's explicit approval; never push to a remote.** The commit steps in this plan are pre-approved for their own task's changes only.
- Every task ends green: `npm run check` (lint + typecheck + test) must pass before the commit step.

## Prerequisite

This machine has Node v22. Install and select Node 24 before Task 1:

```bash
fnm install 24 && fnm use 24   # or: nvm install 24 && nvm use 24
node --version                 # must print v24.x
```

---

## File Structure

```
package.json                     workspaces root + scripts
tsconfig.base.json               shared compiler options
.oxlintrc.json
.nvmrc                           24
Dockerfile
docker-compose.example.yml

packages/plugin-api/
  src/types.ts                   the plugin contract — types only
  src/scoring.ts                 scoreStandardQuality
  src/index.ts                   re-exports

packages/plugin-scenes/
  src/parse.ts                   release name -> ParsedRelease
  src/score.ts                   scenes quality scoring
  src/plan-import.ts             file selection + destination
  src/index.ts                   factory

packages/core/
  src/config/schema.ts           zod schema for config.json
  src/config/load.ts             read, validate, resolve file: secrets
  src/db/open.ts                 DatabaseSync + pragmas
  src/db/migrate.ts              migration runner
  src/db/migrations.ts           the migration list
  src/db/feed-items.ts           per-table query helpers
  src/db/groups.ts
  src/db/releases.ts
  src/db/downloads.ts
  src/db/imported-files.ts
  src/feeds/parse-rss.ts         xml -> FeedEntry[]
  src/feeds/fetch-feed.ts        http + parse
  src/plugins/registry.ts        load plugins by package name
  src/ingest/ingest.ts           collation + bump rules
  src/clients/types.ts           DownloadClient interface
  src/clients/sabnzbd.ts         SABnzbd implementation
  src/pipeline/mutex.ts          async mutex
  src/pipeline/pick.ts           pick flow
  src/pipeline/reconcile.ts      state machine
  src/pipeline/import.ts         file transfer
  src/pipeline/upgrade.ts        trash-then-replace
  src/pipeline/recover.ts        boot recovery
  src/pipeline/scheduler.ts      the two timers
  src/http/server.ts             fastify assembly
  src/http/routes/*.ts           one file per route group
  src/main.ts                    boot sequence

packages/web/
  src/api/client.ts              typed fetch wrapper
  src/components/MediaCard.tsx
  src/components/ReleaseRow.tsx
  src/components/DownloadRow.tsx
  src/routes/Browse.tsx
  src/routes/Picks.tsx
  src/routes/Downloads.tsx
  src/App.tsx
  src/main.tsx
```

---

## Phase 1 — Foundations

### Task 1: Workspace scaffold and toolchain

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.oxlintrc.json`, `.nvmrc`, `.gitignore`
- Create: `packages/plugin-api/package.json`, `packages/plugin-api/tsconfig.json`, `packages/plugin-api/src/index.ts`
- Test: `packages/plugin-api/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `npm run check` script (lint + typecheck + test), and the `--conditions development` test convention every later task relies on.

The `development` export condition is the mechanism that lets tests import workspace packages from `src/*.ts` while production imports the esbuild-built `dist/*.js`. Node's type stripping skips `node_modules`, and workspace packages are symlinked there, so without this every test run would need a build first.

- [ ] **Step 1: Create the root manifest**

`package.json`:

```json
{
  "name": "pickarr",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "workspaces": ["packages/*"],
  "scripts": {
    "lint": "oxlint",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "node --import tsx --conditions development --test \"packages/*/test/**/*.test.ts\"",
    "check": "npm run lint && npm run typecheck && npm run test"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@typescript/native-preview": "latest",
    "esbuild": "^0.25.0",
    "oxlint": "^1.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

`typescript` is present only as the documented `tsc --noEmit` fallback.

- [ ] **Step 2: Create the shared compiler config**

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true
  }
}
```

Two of these are load-bearing rather than stylistic:

- `erasableSyntaxOnly` bans enums, namespaces, and parameter properties — exactly the constructs Node's type stripping cannot handle. Better to fail at typecheck than at runtime.
- `allowImportingTsExtensions` permits `import './types.ts'`. Node's ESM resolver requires the real extension, and esbuild resolves it the same way, so every relative import in this repo ends in `.ts` or `.tsx`.

There is no root `tsconfig.json`. Each package typechecks itself, because `web` needs DOM libs and JSX while `core` must not have them — a single root project cannot express that, and project references would force `tsgo --build`, which is the least-proven part of a preview compiler.

- [ ] **Step 3: Create lint config, .nvmrc, and .gitignore**

`.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "categories": { "correctness": "error", "suspicious": "warn", "perf": "warn" },
  "rules": {
    "typescript/no-explicit-any": "error",
    "eslint/no-console": "off"
  },
  "ignorePatterns": ["**/dist/**", "**/node_modules/**"]
}
```

`.nvmrc` contains `24`. `.gitignore` contains `node_modules/`, `dist/`, `*.db`, `*.db-wal`, `*.db-shm`, `.env`.

- [ ] **Step 4: Create the plugin-api package**

`packages/plugin-api/package.json`:

```json
{
  "name": "@pickarr/plugin-api",
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
  }
}
```

`packages/plugin-api/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

Every package repeats that same `typecheck` script; the root's
`npm run typecheck --workspaces --if-present` fans out across them.

`packages/plugin-api/src/index.ts`:

```ts
export const PLUGIN_API_VERSION = 1;
```

- [ ] **Step 5: Write the failing smoke test**

`packages/plugin-api/test/smoke.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_API_VERSION } from '@pickarr/plugin-api';

test('plugin-api resolves through the development condition', () => {
  assert.equal(PLUGIN_API_VERSION, 1);
});
```

- [ ] **Step 6: Install and run the full check**

```bash
npm install
npm run check
```

Expected: lint clean, typecheck clean, one passing test.

Two failure modes worth recognizing before debugging further:

- The test cannot resolve `@pickarr/plugin-api` at all → `npm install` did not link the workspace. Confirm `node_modules/@pickarr/plugin-api` is a symlink.
- It resolves but loads `dist/index.js` (which does not exist yet) → the `development` condition is not reaching the resolver. Confirm `--conditions development` is in the `test` script. If `tsx` turns out not to honor it, the fallback is to run `npm run build -w @pickarr/plugin-api` before tests and drop the `development` condition from the package's `exports`; everything else in the plan is unaffected.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold workspace, toolchain, and plugin-api package"
```

---

### Task 2: Plugin contract types and shared scoring

**Files:**
- Create: `packages/plugin-api/src/types.ts`, `packages/plugin-api/src/scoring.ts`
- Modify: `packages/plugin-api/src/index.ts`
- Test: `packages/plugin-api/test/scoring.test.ts`

**Interfaces:**
- Consumes: Task 1's package.
- Produces: `DisplayFields`, `QualityTokens`, `ParsedRelease`, `DownloadedFile`, `ImportPlan`, `MediaTypePlugin`, `PluginFactory`, and `scoreStandardQuality(tokens: QualityTokens): number`. Every later task in core and plugin-scenes imports from here.

- [ ] **Step 1: Write the contract types**

`packages/plugin-api/src/types.ts`:

```ts
export interface DisplayField {
  label: string;
  value: string;
}

export interface DisplayFields {
  title: string;
  subtitle?: string;
  date?: string;
  fields: DisplayField[];
}

export type QualityExtra = string | number | boolean;

export interface QualityTokens {
  resolution?: number;
  source?: string;
  videoCodec?: string;
  audioCodec?: string;
  bitrateKbps?: number;
  sizeBytes?: number;
  releaseGroup?: string;
  extras?: Record<string, QualityExtra>;
}

export interface ParsedRelease {
  identityKey: string;
  display: DisplayFields;
  quality: QualityTokens;
}

export interface DownloadedFile {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
}

export interface ImportFile {
  source: string;
  destination: string;
}

export interface ImportPlan {
  files: ImportFile[];
}

export interface MediaTypePlugin {
  readonly id: string;
  readonly displayName: string;
  parse(releaseName: string): ParsedRelease | null;
  score(quality: QualityTokens): number;
  planImport(media: ParsedRelease, files: DownloadedFile[]): ImportPlan | null;
}

export type PluginConfig = Record<string, string | number | boolean>;

export type PluginFactory = (config: PluginConfig) => MediaTypePlugin;
```

- [ ] **Step 2: Write the failing scoring test**

`packages/plugin-api/test/scoring.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStandardQuality } from '@pickarr/plugin-api';

test('higher resolution always outranks lower', () => {
  assert.ok(
    scoreStandardQuality({ resolution: 2160 }) > scoreStandardQuality({ resolution: 1080 }),
  );
  assert.ok(
    scoreStandardQuality({ resolution: 1080 }) > scoreStandardQuality({ resolution: 720 }),
  );
});

test('resolution dominates codec and source', () => {
  const lowResBestEverythingElse = scoreStandardQuality({
    resolution: 720,
    source: 'BluRay',
    videoCodec: 'x265',
  });
  const highResWorstEverythingElse = scoreStandardQuality({ resolution: 1080 });
  assert.ok(highResWorstEverythingElse > lowResBestEverythingElse);
});

test('at equal resolution, better source and codec win', () => {
  const base = scoreStandardQuality({ resolution: 1080 });
  assert.ok(scoreStandardQuality({ resolution: 1080, source: 'BluRay' }) > base);
  assert.ok(scoreStandardQuality({ resolution: 1080, videoCodec: 'x265' }) > base);
});

test('size breaks ties without ever overtaking a quality tier', () => {
  const small = scoreStandardQuality({ resolution: 1080, sizeBytes: 1_000_000_000 });
  const huge = scoreStandardQuality({ resolution: 1080, sizeBytes: 900_000_000_000 });
  assert.ok(huge > small);
  assert.ok(huge < scoreStandardQuality({ resolution: 2160 }));
});

test('unknown tokens score without throwing', () => {
  assert.equal(typeof scoreStandardQuality({}), 'number');
  assert.equal(typeof scoreStandardQuality({ source: 'NotARealSource' }), 'number');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `scoreStandardQuality` is not exported.

- [ ] **Step 4: Implement the shared ranker**

`packages/plugin-api/src/scoring.ts`:

```ts
import type { QualityTokens } from './types.ts';

const RESOLUTION_WEIGHT = 1_000_000;
const SOURCE_WEIGHT = 10_000;
const CODEC_WEIGHT = 1_000;

const SOURCE_RANK: Record<string, number> = {
  cam: 0,
  webrip: 2,
  web: 3,
  'web-dl': 4,
  siterip: 4,
  hdtv: 3,
  bluray: 6,
  remux: 7,
};

const VIDEO_CODEC_RANK: Record<string, number> = {
  divx: 0,
  xvid: 0,
  h264: 2,
  x264: 2,
  avc: 2,
  h265: 4,
  x265: 4,
  hevc: 4,
  av1: 5,
};

function rank(table: Record<string, number>, token: string | undefined): number {
  if (token === undefined) return 1;
  return table[token.toLowerCase().replace(/[\s._]/g, '')] ?? 1;
}

/**
 * Ranks a release on the dimensions every media type shares. Scores are only
 * ever compared between releases in the same group, so the absolute value
 * carries no meaning across plugins.
 *
 * The weights are deliberately ordered by magnitude so a lower tier can never
 * overtake a higher one: resolution beats source, source beats codec, and size
 * only ever breaks ties.
 */
export function scoreStandardQuality(quality: QualityTokens): number {
  const resolution = quality.resolution ?? 0;
  const sizeTiebreak = Math.min(quality.sizeBytes ?? 0, 500_000_000_000) / 500_000_000_000;

  return (
    resolution * RESOLUTION_WEIGHT +
    rank(SOURCE_RANK, quality.source) * SOURCE_WEIGHT +
    rank(VIDEO_CODEC_RANK, quality.videoCodec) * CODEC_WEIGHT +
    sizeTiebreak
  );
}
```

- [ ] **Step 5: Re-export from the package entry**

`packages/plugin-api/src/index.ts`:

```ts
export const PLUGIN_API_VERSION = 1;

export * from './types.ts';
export { scoreStandardQuality } from './scoring.ts';
```

- [ ] **Step 6: Run the check**

Run: `npm run check`
Expected: all scoring tests PASS, lint and typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(plugin-api): add plugin contract types and shared quality ranker"
```

---

### Task 3: Configuration schema and loader

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/config/schema.ts`, `packages/core/src/config/load.ts`
- Test: `packages/core/test/config/load.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `loadConfig(path: string): Promise<PickarrConfig>` and the `PickarrConfig`, `DownloadClientConfig`, `FeedConfig` types. Every later core task takes config as a parameter rather than importing a singleton.

- [ ] **Step 1: Create the core package**

`packages/core/package.json`:

```json
{
  "name": "@pickarr/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "development": "./src/main.ts", "default": "./dist/main.js" } },
  "scripts": {
    "build": "esbuild src/main.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/main.js",
    "typecheck": "tsgo --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@fastify/static": "^8.0.0",
    "@pickarr/plugin-api": "*",
    "fast-xml-parser": "^4.5.0",
    "fastify": "^5.0.0",
    "zod": "^3.24.0"
  }
}
```

`packages/core/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

- [ ] **Step 2: Write the failing loader test**

`packages/core/test/config/load.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/load.ts';

const VALID = {
  server: { port: 8080 },
  database: { path: '/config/pickarr.db' },
  trashDir: '/data/trash',
  plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes' } },
  downloadClients: [
    {
      id: 'sab',
      type: 'sabnzbd',
      url: 'http://sabnzbd:8080',
      apiKey: 'literal-key',
      category: 'pickarr',
      importMode: 'move',
      pathMappings: [{ from: '/downloads', to: '/data/downloads' }],
    },
  ],
  feeds: [
    {
      id: 'feed1',
      url: 'https://example.invalid/rss',
      plugin: '@pickarr/plugin-scenes',
      intervalSeconds: 900,
    },
  ],
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-config-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loads a valid config', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(VALID));
    const config = await loadConfig(path);
    assert.equal(config.server.port, 8080);
    assert.equal(config.downloadClients[0]?.apiKey, 'literal-key');
    assert.equal(config.feeds[0]?.intervalSeconds, 900);
  });
});

test('resolves a file: secret and trims its trailing newline', async () => {
  await withTempDir(async (dir) => {
    const secretPath = join(dir, 'sab_key');
    await writeFile(secretPath, 'super-secret-value\n');
    const path = join(dir, 'config.json');
    const withSecret = structuredClone(VALID);
    withSecret.downloadClients[0]!.apiKey = `file:${secretPath}`;
    await writeFile(path, JSON.stringify(withSecret));

    const config = await loadConfig(path);
    assert.equal(config.downloadClients[0]?.apiKey, 'super-secret-value');
  });
});

test('a missing secret file is fatal and names the path but not the contents', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    const withSecret = structuredClone(VALID);
    withSecret.downloadClients[0]!.apiKey = `file:${join(dir, 'absent')}`;
    await writeFile(path, JSON.stringify(withSecret));

    await assert.rejects(loadConfig(path), (error: Error) => {
      assert.match(error.message, /absent/);
      return true;
    });
  });
});

test('an invalid config names the offending field', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    const broken = structuredClone(VALID);
    broken.downloadClients[0]!.importMode = 'teleport';
    await writeFile(path, JSON.stringify(broken));

    await assert.rejects(loadConfig(path), (error: Error) => {
      assert.match(error.message, /importMode/);
      return true;
    });
  });
});

test('PICKARR_PORT overrides the configured port', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(VALID));
    process.env['PICKARR_PORT'] = '9999';
    try {
      const config = await loadConfig(path);
      assert.equal(config.server.port, 9999);
    } finally {
      delete process.env['PICKARR_PORT'];
    }
  });
});

test('two feeds sharing an id is rejected', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    const dupes = structuredClone(VALID);
    dupes.feeds.push({ ...dupes.feeds[0]! });
    await writeFile(path, JSON.stringify(dupes));
    await assert.rejects(loadConfig(path), /duplicate feed id/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/config/load.ts`.

- [ ] **Step 4: Write the zod schema**

`packages/core/src/config/schema.ts`:

```ts
import { z } from 'zod';

export const pathMappingSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export const downloadClientSchema = z.object({
  id: z.string().min(1),
  type: z.literal('sabnzbd'),
  url: z.string().url(),
  apiKey: z.string().min(1),
  category: z.string().min(1),
  importMode: z.enum(['move', 'copy']),
  pathMappings: z.array(pathMappingSchema).default([]),
});

export const feedSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  plugin: z.string().min(1),
  intervalSeconds: z.number().int().positive().default(900),
});

export const configSchema = z.object({
  server: z.object({ port: z.number().int().positive().default(8080) }).default({ port: 8080 }),
  database: z.object({ path: z.string().min(1) }),
  trashDir: z.string().min(1),
  plugins: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))),
  downloadClients: z.array(downloadClientSchema).min(1),
  feeds: z.array(feedSchema).min(1),
});

export type PickarrConfig = z.infer<typeof configSchema>;
export type DownloadClientConfig = z.infer<typeof downloadClientSchema>;
export type FeedConfig = z.infer<typeof feedSchema>;
export type PathMapping = z.infer<typeof pathMappingSchema>;
```

- [ ] **Step 5: Write the loader**

`packages/core/src/config/load.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { configSchema, type PickarrConfig } from './schema.ts';

const SECRET_PREFIX = 'file:';

/**
 * Resolves a `file:` indirection to the contents of that file, so secrets can
 * be supplied as Docker Compose secrets rather than environment variables.
 * The trailing newline is trimmed because compose secrets almost always have
 * one. The value is never logged.
 */
async function resolveSecret(value: string, field: string): Promise<string> {
  if (!value.startsWith(SECRET_PREFIX)) return value;
  const path = value.slice(SECRET_PREFIX.length);
  try {
    const contents = await readFile(path, 'utf8');
    return contents.replace(/\r?\n$/, '');
  } catch {
    throw new Error(`Could not read secret for ${field} from ${path}`);
  }
}

export async function loadConfig(path: string): Promise<PickarrConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Could not read config file at ${path}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Config at ${path} is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Config at ${path} is invalid — ${detail}`);
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

  for (const client of config.downloadClients) {
    client.apiKey = await resolveSecret(client.apiKey, `downloadClients.${client.id}.apiKey`);
  }

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

Note the deliberate ordering: schema validation runs before secret resolution, so a typo in `importMode` fails without ever touching the filesystem.

- [ ] **Step 6: Run the check**

Run: `npm run check`
Expected: all six config tests PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): add config schema and loader with file-based secrets"
```

---

### Task 4: Database, migrations, and schema

**Files:**
- Create: `packages/core/src/db/open.ts`, `packages/core/src/db/migrate.ts`, `packages/core/src/db/migrations.ts`
- Test: `packages/core/test/db/migrate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `openDatabase(path: string): DatabaseSync`, `migrate(db: DatabaseSync): void`, and `openTestDatabase(): DatabaseSync` — the in-memory helper every later core test uses.

- [ ] **Step 1: Write the failing migration test**

`packages/core/test/db/migrate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrate } from '../../src/db/migrate.ts';

test('migrate creates every table', () => {
  const db = openTestDatabase();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row['name']));

  for (const expected of [
    'downloads',
    'feed_items',
    'imported_files',
    'media_groups',
    'releases',
    'schema_migrations',
  ]) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  db.close();
});

test('migrate is idempotent', () => {
  const db = openTestDatabase();
  migrate(db);
  migrate(db);
  const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
  assert.equal(Number(row?.['n']), 1);
  db.close();
});

test('feed_items rejects a duplicate guid within a feed', () => {
  const db = openTestDatabase();
  const insert = db.prepare(
    `INSERT INTO feed_items (feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run('feed1', 'guid-1', 'Title', 'http://example.invalid/1', 1);
  assert.throws(() => insert.run('feed1', 'guid-1', 'Title', 'http://example.invalid/1', 2));
  db.close();
});

test('feed_items allows the same guid in a different feed', () => {
  const db = openTestDatabase();
  const insert = db.prepare(
    `INSERT INTO feed_items (feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run('feed1', 'guid-1', 'Title', 'http://example.invalid/1', 1);
  insert.run('feed2', 'guid-1', 'Title', 'http://example.invalid/1', 1);
  db.close();
});

test('media_groups rejects a duplicate identity within a plugin', () => {
  const db = openTestDatabase();
  const insert = db.prepare(
    `INSERT INTO media_groups (plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run('scenes', 'key-1', '{}', 'text', 1, 1);
  assert.throws(() => insert.run('scenes', 'key-1', '{}', 'text', 1, 1));
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/db/open.ts`.

- [ ] **Step 3: Write the migration list**

`packages/core/src/db/migrations.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}

const INITIAL = `
CREATE TABLE feed_items (
  id            INTEGER PRIMARY KEY,
  feed_id       TEXT    NOT NULL,
  guid          TEXT    NOT NULL,
  raw_title     TEXT    NOT NULL,
  link          TEXT    NOT NULL,
  published_at  INTEGER,
  first_seen_at INTEGER NOT NULL,
  parse_error   TEXT,
  UNIQUE (feed_id, guid)
);

CREATE TABLE media_groups (
  id                 INTEGER PRIMARY KEY,
  plugin             TEXT    NOT NULL,
  identity_key       TEXT    NOT NULL,
  display            TEXT    NOT NULL,
  search_text        TEXT    NOT NULL,
  state              TEXT    NOT NULL DEFAULT 'new',
  picked_release_id  INTEGER,
  upgrade_release_id INTEGER,
  created_at         INTEGER NOT NULL,
  list_rank_at       INTEGER NOT NULL,
  UNIQUE (plugin, identity_key)
);
CREATE INDEX media_groups_browse ON media_groups (list_rank_at DESC);

CREATE TABLE releases (
  id           INTEGER PRIMARY KEY,
  group_id     INTEGER NOT NULL REFERENCES media_groups (id),
  feed_item_id INTEGER NOT NULL UNIQUE REFERENCES feed_items (id),
  quality      TEXT    NOT NULL,
  score        REAL    NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX releases_group ON releases (group_id, score DESC);

CREATE TABLE downloads (
  id            INTEGER PRIMARY KEY,
  release_id    INTEGER NOT NULL REFERENCES releases (id),
  group_id      INTEGER NOT NULL REFERENCES media_groups (id),
  client_id     TEXT    NOT NULL,
  client_ref    TEXT,
  kind          TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  storage_path  TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  missing_polls INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX downloads_client_ref
  ON downloads (client_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX downloads_group ON downloads (group_id);

CREATE TABLE imported_files (
  id          INTEGER PRIMARY KEY,
  download_id INTEGER NOT NULL REFERENCES downloads (id),
  group_id    INTEGER NOT NULL REFERENCES media_groups (id),
  source_path TEXT    NOT NULL,
  dest_path   TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  trashed_at  INTEGER,
  trash_path  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX imported_files_live ON imported_files (group_id) WHERE trashed_at IS NULL;
`;

export const migrations: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(INITIAL);
    },
  },
];
```

`media_groups.picked_release_id` and `upgrade_release_id` carry no `REFERENCES` clause on purpose: `releases` is created after `media_groups`, and SQLite checks foreign keys immediately. The application maintains the relationship, and the columns are only ever set to ids the same transaction just wrote.

- [ ] **Step 4: Write the runner and the database opener**

`packages/core/src/db/migrate.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations.ts';

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number(row['version'])),
  );

  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      record.run(migration.version, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
```

`packages/core/src/db/open.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.ts';

/**
 * node:sqlite is synchronous and has no async counterpart. This is the single
 * documented exception to the async-over-sync rule: queries here are point
 * lookups against indexed columns at single-user scale.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function openTestDatabase(): DatabaseSync {
  return openDatabase(':memory:');
}
```

- [ ] **Step 5: Run the check**

Run: `npm run check`
Expected: all five migration tests PASS. If `node:sqlite` throws that it requires a flag, the Node version is below 24 — re-check the prerequisite.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add sqlite database, migration runner, and initial schema"
```

---

## Phase 2 — Ingest

### Task 5: RSS fetching and parsing

**Files:**
- Create: `packages/core/src/feeds/parse-rss.ts`, `packages/core/src/feeds/fetch-feed.ts`
- Test: `packages/core/test/feeds/parse-rss.test.ts`

**Interfaces:**
- Consumes: `FeedConfig` from Task 3.
- Produces: `interface FeedEntry { guid: string; title: string; link: string; publishedAt: number | null }`, `parseRss(xml: string): FeedEntry[]`, and `fetchFeed(feed: FeedConfig): Promise<FeedEntry[]>`.

- [ ] **Step 1: Write the failing parser test**

`packages/core/test/feeds/parse-rss.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRss } from '../../src/feeds/parse-rss.ts';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <item>
    <title>Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB</title>
    <guid isPermaLink="false">abc123</guid>
    <link>https://indexer.invalid/getnzb/abc123.nzb</link>
    <pubDate>Sat, 15 Apr 2023 12:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Second.Release.XXX.2160p.MP4-GRP</title>
    <guid isPermaLink="false">def456</guid>
    <link>https://indexer.invalid/details/def456</link>
    <enclosure url="https://indexer.invalid/getnzb/def456.nzb" type="application/x-nzb" />
    <pubDate>Sun, 16 Apr 2023 12:00:00 +0000</pubDate>
  </item>
</channel></rss>`;

test('parses items into feed entries', () => {
  const entries = parseRss(FEED);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.guid, 'abc123');
  assert.equal(entries[0]?.title, 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  assert.equal(entries[0]?.link, 'https://indexer.invalid/getnzb/abc123.nzb');
  assert.equal(entries[0]?.publishedAt, Date.parse('Sat, 15 Apr 2023 12:00:00 +0000'));
});

test('prefers the enclosure url over the link', () => {
  const entries = parseRss(FEED);
  assert.equal(entries[1]?.link, 'https://indexer.invalid/getnzb/def456.nzb');
});

test('falls back to the link when there is no guid', () => {
  const xml = `<rss version="2.0"><channel><item>
    <title>No Guid Here</title><link>https://indexer.invalid/x.nzb</link>
  </item></channel></rss>`;
  assert.equal(parseRss(xml)[0]?.guid, 'https://indexer.invalid/x.nzb');
});

test('a single item is not mistaken for a non-array', () => {
  const xml = `<rss version="2.0"><channel><item>
    <title>Only One</title><guid>solo</guid><link>https://indexer.invalid/1.nzb</link>
  </item></channel></rss>`;
  assert.equal(parseRss(xml).length, 1);
});

test('an empty channel yields no entries', () => {
  assert.deepEqual(parseRss('<rss version="2.0"><channel></channel></rss>'), []);
});

test('an unparseable pubDate becomes null rather than NaN', () => {
  const xml = `<rss version="2.0"><channel><item>
    <title>Bad Date</title><guid>g</guid><link>https://indexer.invalid/1.nzb</link>
    <pubDate>not a date</pubDate>
  </item></channel></rss>`;
  assert.equal(parseRss(xml)[0]?.publishedAt, null);
});

test('a non-rss document throws', () => {
  assert.throws(() => parseRss('<html><body>nope</body></html>'), /not an RSS/i);
});

test('items missing a title or link are skipped', () => {
  const xml = `<rss version="2.0"><channel>
    <item><guid>g1</guid><link>https://indexer.invalid/1.nzb</link></item>
    <item><title>Fine</title><guid>g2</guid><link>https://indexer.invalid/2.nzb</link></item>
  </channel></rss>`;
  const entries = parseRss(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.title, 'Fine');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/feeds/parse-rss.ts`.

- [ ] **Step 3: Implement the parser**

`packages/core/src/feeds/parse-rss.ts`:

```ts
import { XMLParser } from 'fast-xml-parser';

export interface FeedEntry {
  guid: string;
  title: string;
  link: string;
  publishedAt: number | null;
}

type XmlValue = string | number | boolean | XmlNode | XmlNode[];
interface XmlNode {
  [key: string]: XmlValue | undefined;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
});

/** fast-xml-parser collapses a single repeated element to a bare object. */
function asArray(value: XmlValue | undefined): XmlNode[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return [value];
  return [];
}

/** A tag may be a bare string or an object carrying attributes plus #text. */
function textOf(value: XmlValue | undefined): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value !== undefined && !Array.isArray(value) && typeof value === 'object') {
    const inner = value['#text'];
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return null;
}

function enclosureUrl(item: XmlNode): string | null {
  const enclosures = asArray(item['enclosure']);
  for (const enclosure of enclosures) {
    const url = enclosure['@_url'];
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}

export function parseRss(xml: string): FeedEntry[] {
  const document = parser.parse(xml) as XmlNode;
  const rss = document['rss'];
  if (rss === undefined || typeof rss !== 'object' || Array.isArray(rss)) {
    throw new Error('Document is not an RSS 2.0 feed: no <rss> root element');
  }

  const channel = rss['channel'];
  if (channel === undefined || typeof channel !== 'object' || Array.isArray(channel)) {
    throw new Error('Document is not an RSS 2.0 feed: no <channel> element');
  }

  const entries: FeedEntry[] = [];
  for (const item of asArray(channel['item'])) {
    const title = textOf(item['title']);
    const link = enclosureUrl(item) ?? textOf(item['link']);
    if (title === null || link === null) continue;

    const guid = textOf(item['guid']) ?? link;
    const pubDate = textOf(item['pubDate']);
    const parsedDate = pubDate === null ? Number.NaN : Date.parse(pubDate);

    entries.push({
      guid,
      title,
      link,
      publishedAt: Number.isNaN(parsedDate) ? null : parsedDate,
    });
  }

  return entries;
}
```

- [ ] **Step 4: Implement the fetcher**

`packages/core/src/feeds/fetch-feed.ts`:

```ts
import type { FeedConfig } from '../config/schema.ts';
import { parseRss, type FeedEntry } from './parse-rss.ts';

const FETCH_TIMEOUT_MS = 30_000;

export async function fetchFeed(feed: FeedConfig): Promise<FeedEntry[]> {
  const response = await fetch(feed.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/rss+xml, application/xml, text/xml' },
  });

  if (!response.ok) {
    throw new Error(`Feed ${feed.id} returned HTTP ${response.status}`);
  }

  return parseRss(await response.text());
}
```

`fetchFeed` has no unit test of its own — it is three lines of glue over `fetch` and `parseRss`, both covered elsewhere. Mocking `fetch` here would test the mock.

- [ ] **Step 5: Run the check**

Run: `npm run check`
Expected: all eight parser tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add RSS parsing and feed fetching"
```

---

### Task 6: Plugin registry

**Files:**
- Create: `packages/core/src/plugins/registry.ts`
- Test: `packages/core/test/plugins/registry.test.ts`

**Interfaces:**
- Consumes: `MediaTypePlugin` and `PluginFactory` from Task 2, `PickarrConfig` from Task 3.
- Produces: `interface PluginRegistry { byPackage(name: string): MediaTypePlugin; byId(id: string): MediaTypePlugin | undefined; libraryRoot(packageName: string): string; all(): MediaTypePlugin[] }` and `loadPlugins(config, importer?): Promise<PluginRegistry>`.

The optional `importer` parameter exists so tests can inject fake plugin modules without publishing packages. Production passes nothing and gets a real dynamic `import()`.

- [ ] **Step 1: Write the failing registry test**

`packages/core/test/plugins/registry.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaTypePlugin, PluginFactory } from '@pickarr/plugin-api';
import { loadPlugins, type PluginModule } from '../../src/plugins/registry.ts';
import type { PickarrConfig } from '../../src/config/schema.ts';

function fakePlugin(id: string): MediaTypePlugin {
  return {
    id,
    displayName: id,
    parse: () => null,
    score: () => 0,
    planImport: () => null,
  };
}

function fakeModule(id: string): PluginModule {
  const factory: PluginFactory = () => fakePlugin(id);
  return { default: factory };
}

function configWith(plugins: Record<string, Record<string, string>>): PickarrConfig {
  return {
    server: { port: 8080 },
    database: { path: ':memory:' },
    trashDir: '/trash',
    plugins,
    downloadClients: [],
    feeds: [],
  } as PickarrConfig;
}

test('loads a plugin and indexes it by package name and id', async () => {
  const config = configWith({ 'pkg-a': { libraryRoot: '/media/a' } });
  const registry = await loadPlugins(config, async () => fakeModule('alpha'));

  assert.equal(registry.byPackage('pkg-a').id, 'alpha');
  assert.equal(registry.byId('alpha')?.id, 'alpha');
  assert.equal(registry.libraryRoot('pkg-a'), '/media/a');
  assert.equal(registry.all().length, 1);
});

test('two packages claiming the same id is fatal', async () => {
  const config = configWith({
    'pkg-a': { libraryRoot: '/media/a' },
    'pkg-b': { libraryRoot: '/media/b' },
  });
  await assert.rejects(
    loadPlugins(config, async () => fakeModule('same')),
    /same/,
  );
});

test('a plugin config without a libraryRoot is fatal', async () => {
  const config = configWith({ 'pkg-a': {} });
  await assert.rejects(loadPlugins(config, async () => fakeModule('alpha')), /libraryRoot/);
});

test('a module without a default export is fatal and names the package', async () => {
  const config = configWith({ 'pkg-a': { libraryRoot: '/media/a' } });
  await assert.rejects(
    loadPlugins(config, async () => ({}) as PluginModule),
    /pkg-a/,
  );
});

test('an import failure is fatal and names the package', async () => {
  const config = configWith({ 'pkg-missing': { libraryRoot: '/media/a' } });
  await assert.rejects(
    loadPlugins(config, async () => {
      throw new Error('not installed');
    }),
    /pkg-missing/,
  );
});

test('byPackage throws for an unregistered package', async () => {
  const config = configWith({ 'pkg-a': { libraryRoot: '/media/a' } });
  const registry = await loadPlugins(config, async () => fakeModule('alpha'));
  assert.throws(() => registry.byPackage('pkg-nope'), /pkg-nope/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/plugins/registry.ts`.

- [ ] **Step 3: Implement the registry**

`packages/core/src/plugins/registry.ts`:

```ts
import type { MediaTypePlugin, PluginConfig, PluginFactory } from '@pickarr/plugin-api';
import type { PickarrConfig } from '../config/schema.ts';

export interface PluginModule {
  default?: PluginFactory;
}

export type PluginImporter = (packageName: string) => Promise<PluginModule>;

export interface PluginRegistry {
  byPackage(packageName: string): MediaTypePlugin;
  byId(id: string): MediaTypePlugin | undefined;
  libraryRoot(packageName: string): string;
  all(): MediaTypePlugin[];
}

const defaultImporter: PluginImporter = (packageName) =>
  import(packageName) as Promise<PluginModule>;

/**
 * Two identifiers are in play. Config keys and feeds[].plugin use the *package
 * name*, because that is what import() needs. Stored rows use the plugin's
 * *id*, because that survives a package rename and identity must not break if
 * a package is republished under a different name.
 */
export async function loadPlugins(
  config: PickarrConfig,
  importer: PluginImporter = defaultImporter,
): Promise<PluginRegistry> {
  const byPackage = new Map<string, MediaTypePlugin>();
  const byId = new Map<string, MediaTypePlugin>();
  const roots = new Map<string, string>();

  for (const [packageName, pluginConfig] of Object.entries(config.plugins)) {
    const libraryRoot = pluginConfig['libraryRoot'];
    if (typeof libraryRoot !== 'string' || libraryRoot.length === 0) {
      throw new Error(`Plugin ${packageName} is missing a libraryRoot in its config`);
    }

    let module: PluginModule;
    try {
      module = await importer(packageName);
    } catch (error) {
      throw new Error(`Could not import plugin ${packageName}: ${(error as Error).message}`);
    }

    const factory = module.default;
    if (typeof factory !== 'function') {
      throw new Error(`Plugin ${packageName} does not default-export a factory function`);
    }

    const plugin = factory(pluginConfig as PluginConfig);

    const existing = byId.get(plugin.id);
    if (existing !== undefined) {
      throw new Error(
        `Two plugin packages claim the id "${plugin.id}"; ids must be unique across packages`,
      );
    }

    byPackage.set(packageName, plugin);
    byId.set(plugin.id, plugin);
    roots.set(packageName, libraryRoot);
  }

  return {
    byPackage(packageName) {
      const plugin = byPackage.get(packageName);
      if (plugin === undefined) throw new Error(`No plugin registered for package ${packageName}`);
      return plugin;
    },
    byId: (id) => byId.get(id),
    libraryRoot(packageName) {
      const root = roots.get(packageName);
      if (root === undefined) throw new Error(`No library root for package ${packageName}`);
      return root;
    },
    all: () => [...byPackage.values()],
  };
}
```

- [ ] **Step 4: Run the check**

Run: `npm run check`
Expected: all six registry tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add plugin registry with package-name to id mapping"
```

---

### Task 7: Scenes release-name parser

**Files:**
- Create: `packages/plugin-scenes/package.json`, `packages/plugin-scenes/tsconfig.json`
- Create: `packages/plugin-scenes/src/parse.ts`
- Test: `packages/plugin-scenes/test/parse.test.ts`

**Interfaces:**
- Consumes: `ParsedRelease`, `QualityTokens`, `DisplayFields` from Task 2.
- Produces: `parseSceneRelease(releaseName: string): ParsedRelease | null`.

This is the highest-value test surface in the repo. Collation quality is entirely determined here.

**Identity strategy.** Scene releases follow `Site.YY.MM.DD.Performers.And.Title.XXX.<quality>-<GROUP>`. Everything before the `XXX` marker is stable across re-releases of the same scene; everything after varies by encode. So identity is the slug of the pre-`XXX` portion, and quality tokens come from the post-`XXX` portion. This under-collates when a site changes its naming, which is the safe direction to fail — you see two cards instead of one, rather than picking a version of the wrong scene.

- [ ] **Step 1: Create the package**

`packages/plugin-scenes/package.json`:

```json
{
  "name": "@pickarr/plugin-scenes",
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
  "dependencies": { "@pickarr/plugin-api": "*" }
}
```

`packages/plugin-scenes/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

- [ ] **Step 2: Write the failing parser fixtures**

`packages/plugin-scenes/test/parse.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneRelease } from '../src/parse.ts';

test('parses the canonical Site.YY.MM.DD.Names.XXX.quality-GROUP form', () => {
  const parsed = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  assert.ok(parsed);
  assert.equal(parsed.identityKey, 'brazzers:2023-04-15:alex-coal');
  assert.equal(parsed.display.title, 'Alex Coal');
  assert.equal(parsed.display.subtitle, 'Brazzers');
  assert.equal(parsed.display.date, '2023-04-15');
  assert.equal(parsed.quality.resolution, 1080);
  assert.equal(parsed.quality.releaseGroup, 'WRB');
  assert.equal(parsed.quality.extras?.['container'], 'mp4');
});

test('two encodes of the same scene share an identity key', () => {
  const a = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const b = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP');
  assert.ok(a && b);
  assert.equal(a.identityKey, b.identityKey);
  assert.notEqual(a.quality.resolution, b.quality.resolution);
});

test('different scenes on the same site and day do not collate', () => {
  const a = parseSceneRelease('TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX');
  const b = parseSceneRelease('TeamSkeet.24.01.02.John.Smith.XXX.1080p.MP4-XXX');
  assert.ok(a && b);
  assert.notEqual(a.identityKey, b.identityKey);
});

test('separator and case differences do not split a group', () => {
  const a = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const b = parseSceneRelease('brazzers 23 04 15 alex coal XXX 1080p MP4-WRB');
  assert.ok(a && b);
  assert.equal(a.identityKey, b.identityKey);
});

test('extracts resolution from every common token', () => {
  const cases: [string, number][] = [
    ['Site.23.01.01.Name.XXX.480p.MP4-G', 480],
    ['Site.23.01.01.Name.XXX.720p.MP4-G', 720],
    ['Site.23.01.01.Name.XXX.1080p.MP4-G', 1080],
    ['Site.23.01.01.Name.XXX.2160p.MP4-G', 2160],
    ['Site.23.01.01.Name.XXX.4K.MP4-G', 2160],
  ];
  for (const [name, expected] of cases) {
    assert.equal(parseSceneRelease(name)?.quality.resolution, expected, name);
  }
});

test('extracts video codec and source', () => {
  const parsed = parseSceneRelease('Site.23.01.01.Name.XXX.1080p.WEB-DL.H265.MP4-G');
  assert.equal(parsed?.quality.videoCodec, 'h265');
  assert.equal(parsed?.quality.source, 'web-dl');
});

test('a two-digit year maps into the 2000s', () => {
  assert.equal(parseSceneRelease('Site.99.12.31.Name.XXX.1080p.MP4-G')?.display.date, '2099-12-31');
});

test('a four-digit year is accepted', () => {
  assert.equal(
    parseSceneRelease('Site.2023.04.15.Name.XXX.1080p.MP4-G')?.display.date,
    '2023-04-15',
  );
});

test('a release with no XXX marker still parses using the first quality token', () => {
  const parsed = parseSceneRelease('Site.23.04.15.Alex.Coal.1080p.MP4-WRB');
  assert.ok(parsed);
  assert.equal(parsed.identityKey, 'site:2023-04-15:alex-coal');
  assert.equal(parsed.quality.resolution, 1080);
});

test('a name with no date returns null', () => {
  assert.equal(parseSceneRelease('Some.Random.Movie.2023.1080p.BluRay-GRP'), null);
});

test('an empty name returns null', () => {
  assert.equal(parseSceneRelease(''), null);
});

test('a name with a date but no site returns null', () => {
  assert.equal(parseSceneRelease('23.04.15.Alex.Coal.XXX.1080p.MP4-G'), null);
});

test('an invalid calendar date returns null', () => {
  assert.equal(parseSceneRelease('Site.23.13.45.Name.XXX.1080p.MP4-G'), null);
});

test('display fields carry site and performers', () => {
  const parsed = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const labels = parsed?.display.fields.map((field) => field.label);
  assert.deepEqual(labels, ['Site', 'Date', 'Scene']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/parse.ts`.

- [ ] **Step 4: Implement the parser**

`packages/plugin-scenes/src/parse.ts`:

```ts
import type { ParsedRelease, QualityExtra, QualityTokens } from '@pickarr/plugin-api';

const DATE_PATTERN = /(?:^|[.\s_-])((?:19|20)?\d{2})[.\s_-](\d{2})[.\s_-](\d{2})(?:[.\s_-]|$)/;
const XXX_MARKER = /[.\s_-]XXX(?:[.\s_-]|$)/i;
const QUALITY_START = /[.\s_-](?:\d{3,4}p|4K|8K|XXX|WEB-?DL|WEBRip|BluRay|SiteRip|HDTV)(?:[.\s_-]|$)/i;

const RESOLUTIONS: [RegExp, number][] = [
  [/\b8K\b/i, 4320],
  [/\b4K\b|\b2160p\b|\bUHD\b/i, 2160],
  [/\b1440p\b/i, 1440],
  [/\b1080p\b/i, 1080],
  [/\b720p\b/i, 720],
  [/\b540p\b/i, 540],
  [/\b480p\b/i, 480],
];

const SOURCES: [RegExp, string][] = [
  [/\bWEB[.\s_-]?DL\b/i, 'web-dl'],
  [/\bWEBRip\b/i, 'webrip'],
  [/\bSiteRip\b/i, 'siterip'],
  [/\bBluRay\b|\bBDRip\b/i, 'bluray'],
  [/\bHDTV\b/i, 'hdtv'],
  [/\bWEB\b/i, 'web'],
];

const VIDEO_CODECS: [RegExp, string][] = [
  [/\bx265\b/i, 'x265'],
  [/\bH[.\s_-]?265\b|\bHEVC\b/i, 'h265'],
  [/\bx264\b/i, 'x264'],
  [/\bH[.\s_-]?264\b|\bAVC\b/i, 'h264'],
  [/\bAV1\b/i, 'av1'],
  [/\bXviD\b/i, 'xvid'],
];

const CONTAINERS: [RegExp, string][] = [
  [/\bMP4\b/i, 'mp4'],
  [/\bMKV\b/i, 'mkv'],
  [/\bWMV\b/i, 'wmv'],
  [/\bAVI\b/i, 'avi'],
];

function firstMatch<T>(table: [RegExp, T][], haystack: string): T | undefined {
  for (const [pattern, value] of table) {
    if (pattern.test(haystack)) return value;
  }
  return undefined;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function prettify(value: string): string {
  return value.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function toIsoDate(rawYear: string, rawMonth: string, rawDay: string): string | null {
  const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;

  return `${String(year).padStart(4, '0')}-${rawMonth}-${rawDay}`;
}

function extractQuality(tail: string): QualityTokens {
  const extras: Record<string, QualityExtra> = {};
  const container = firstMatch(CONTAINERS, tail);
  if (container !== undefined) extras['container'] = container;

  const groupMatch = /-([A-Za-z0-9]+)$/.exec(tail.trim());

  const quality: QualityTokens = { extras };
  const resolution = firstMatch(RESOLUTIONS, tail);
  if (resolution !== undefined) quality.resolution = resolution;
  const source = firstMatch(SOURCES, tail);
  if (source !== undefined) quality.source = source;
  const videoCodec = firstMatch(VIDEO_CODECS, tail);
  if (videoCodec !== undefined) quality.videoCodec = videoCodec;
  if (groupMatch?.[1] !== undefined) quality.releaseGroup = groupMatch[1];

  return quality;
}

/**
 * Splits a scene release name at the boundary between identity and encode.
 * Everything before the XXX marker is stable across re-releases of the same
 * scene; everything after varies. When there is no XXX marker, the first
 * quality token serves as the boundary.
 */
function splitAtQualityBoundary(name: string): { head: string; tail: string } | null {
  const xxx = XXX_MARKER.exec(name);
  if (xxx !== null && xxx.index > 0) {
    return { head: name.slice(0, xxx.index), tail: name.slice(xxx.index) };
  }

  const quality = QUALITY_START.exec(name);
  if (quality !== null && quality.index > 0) {
    return { head: name.slice(0, quality.index), tail: name.slice(quality.index) };
  }

  return null;
}

export function parseSceneRelease(releaseName: string): ParsedRelease | null {
  const name = releaseName.trim();
  if (name.length === 0) return null;

  const split = splitAtQualityBoundary(name);
  if (split === null) return null;

  const dateMatch = DATE_PATTERN.exec(split.head);
  if (dateMatch?.[1] === undefined || dateMatch[2] === undefined || dateMatch[3] === undefined) {
    return null;
  }

  const date = toIsoDate(dateMatch[1], dateMatch[2], dateMatch[3]);
  if (date === null) return null;

  const site = prettify(split.head.slice(0, dateMatch.index));
  if (site.length === 0) return null;

  const scene = prettify(split.head.slice(dateMatch.index + dateMatch[0].length));
  if (scene.length === 0) return null;

  return {
    identityKey: `${slug(site)}:${date}:${slug(scene)}`,
    display: {
      title: scene,
      subtitle: site,
      date,
      fields: [
        { label: 'Site', value: site },
        { label: 'Date', value: date },
        { label: 'Scene', value: scene },
      ],
    },
    quality: extractQuality(split.tail),
  };
}
```

- [ ] **Step 5: Run the check**

Run: `npm run check`
Expected: all fourteen parser tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(plugin-scenes): add release-name parser with identity extraction"
```

---

### Task 8: Scenes scoring, import planning, and plugin factory

**Files:**
- Create: `packages/plugin-scenes/src/score.ts`, `packages/plugin-scenes/src/plan-import.ts`, `packages/plugin-scenes/src/index.ts`
- Test: `packages/plugin-scenes/test/score.test.ts`, `packages/plugin-scenes/test/plan-import.test.ts`

**Interfaces:**
- Consumes: `parseSceneRelease` from Task 7; `scoreStandardQuality`, `MediaTypePlugin`, `PluginFactory`, `DownloadedFile`, `ImportPlan` from Task 2.
- Produces: the package's default export — a `PluginFactory` returning a `MediaTypePlugin` with `id: 'scenes'`. This is the package name `@pickarr/plugin-scenes` that Task 6's registry loads and Task 18's config references.

- [ ] **Step 1: Write the failing scoring test**

`packages/plugin-scenes/test/score.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStandardQuality } from '@pickarr/plugin-api';
import { scoreScene } from '../src/score.ts';

test('a release with no stated source is treated as an original site rip', () => {
  assert.equal(
    scoreScene({ resolution: 1080 }),
    scoreStandardQuality({ resolution: 1080, source: 'siterip' }),
  );
});

test('an explicit re-encode source ranks below an unstated one', () => {
  assert.ok(scoreScene({ resolution: 1080, source: 'webrip' }) < scoreScene({ resolution: 1080 }));
});

test('an explicit source is never overridden', () => {
  assert.equal(
    scoreScene({ resolution: 1080, source: 'bluray' }),
    scoreStandardQuality({ resolution: 1080, source: 'bluray' }),
  );
});

test('resolution still dominates the source adjustment', () => {
  assert.ok(scoreScene({ resolution: 2160, source: 'webrip' }) > scoreScene({ resolution: 1080 }));
});
```

- [ ] **Step 2: Write the failing import-planning test**

`packages/plugin-scenes/test/plan-import.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadedFile } from '@pickarr/plugin-api';
import { parseSceneRelease } from '../src/parse.ts';
import { planSceneImport } from '../src/plan-import.ts';

const MEDIA = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB')!;

function file(relativePath: string, sizeBytes: number): DownloadedFile {
  return { absolutePath: `/downloads/release/${relativePath}`, relativePath, sizeBytes };
}

test('picks the largest video file and names it from the parsed media', () => {
  const plan = planSceneImport(MEDIA, [
    file('scene.mp4', 4_000_000_000),
    file('scene.nfo', 2_000),
    file('poster.jpg', 500_000),
  ]);
  assert.deepEqual(plan, {
    files: [
      {
        source: '/downloads/release/scene.mp4',
        destination: 'Brazzers/2023-04-15 - Alex Coal.mp4',
      },
    ],
  });
});

test('skips sample, proof, and screens files even when they are large', () => {
  const plan = planSceneImport(MEDIA, [
    file('sample/sample.mp4', 9_000_000_000),
    file('proof.mkv', 8_000_000_000),
    file('screens.mp4', 7_000_000_000),
    file('scene.mp4', 1_000_000_000),
  ]);
  assert.equal(plan?.files[0]?.source, '/downloads/release/scene.mp4');
});

test('preserves the source extension', () => {
  const plan = planSceneImport(MEDIA, [file('scene.mkv', 4_000_000_000)]);
  assert.match(plan?.files[0]?.destination ?? '', /\.mkv$/);
});

test('returns null when there is no video file', () => {
  assert.equal(planSceneImport(MEDIA, [file('readme.txt', 100)]), null);
});

test('returns null for an empty listing', () => {
  assert.equal(planSceneImport(MEDIA, []), null);
});

test('sanitizes path separators and reserved characters out of the destination', () => {
  const media = parseSceneRelease('Bad/Site:Name.23.04.15.A*B?C.XXX.1080p.MP4-G')!;
  const plan = planSceneImport(media, [file('scene.mp4', 1_000)]);
  const destination = plan?.files[0]?.destination ?? '';
  assert.doesNotMatch(destination.replace(/\//g, ''), /[/\\:*?"<>|]/);
  assert.equal(destination.split('/').length, 2);
});

test('a destination can never escape the library root', () => {
  const media = parseSceneRelease('...23.04.15.....XXX.1080p.MP4-G');
  if (media === null) return;
  const plan = planSceneImport(media, [file('scene.mp4', 1_000)]);
  assert.doesNotMatch(plan?.files[0]?.destination ?? '', /\.\./);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/score.ts` or `../src/plan-import.ts`.

- [ ] **Step 4: Implement scoring**

`packages/plugin-scenes/src/score.ts`:

```ts
import { scoreStandardQuality, type QualityTokens } from '@pickarr/plugin-api';

/**
 * Scene releases usually omit a source token when they are the original rip
 * straight from the site, and state one explicitly when they are a re-encode.
 * Treating a missing source as a site rip therefore ranks originals above
 * re-encodes, which is the opposite of the generic default.
 */
export function scoreScene(quality: QualityTokens): number {
  if (quality.source !== undefined) return scoreStandardQuality(quality);
  return scoreStandardQuality({ ...quality, source: 'siterip' });
}
```

- [ ] **Step 5: Implement import planning**

`packages/plugin-scenes/src/plan-import.ts`:

```ts
import type { DownloadedFile, ImportPlan, ParsedRelease } from '@pickarr/plugin-api';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.wmv', '.m4v', '.mov', '.mpg']);
const JUNK_PATTERN = /(^|[^a-z])(sample|proof|screens?|trailer)([^a-z]|$)/i;

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index).toLowerCase();
}

/** Strips characters that are invalid or hazardous in a path segment. */
function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned : 'Unknown';
}

export function planSceneImport(
  media: ParsedRelease,
  files: DownloadedFile[],
): ImportPlan | null {
  const candidates = files
    .filter((candidate) => VIDEO_EXTENSIONS.has(extensionOf(candidate.relativePath)))
    .filter((candidate) => !JUNK_PATTERN.test(candidate.relativePath));

  if (candidates.length === 0) return null;

  let chosen = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.sizeBytes > chosen.sizeBytes) chosen = candidate;
  }

  const site = sanitizeSegment(media.display.subtitle ?? 'Unknown');
  const date = sanitizeSegment(media.display.date ?? 'Unknown');
  const scene = sanitizeSegment(media.display.title);

  return {
    files: [
      {
        source: chosen.absolutePath,
        destination: `${site}/${date} - ${scene}${extensionOf(chosen.relativePath)}`,
      },
    ],
  };
}
```

Sanitization runs on each segment independently and strips leading and trailing dots, so a destination can never contain a `..` component. Core validates this again at import time — a plugin is not trusted to police itself.

- [ ] **Step 6: Wire up the factory**

`packages/plugin-scenes/src/index.ts`:

```ts
import type { MediaTypePlugin, PluginFactory } from '@pickarr/plugin-api';
import { parseSceneRelease } from './parse.ts';
import { scoreScene } from './score.ts';
import { planSceneImport } from './plan-import.ts';

const createScenesPlugin: PluginFactory = (): MediaTypePlugin => ({
  id: 'scenes',
  displayName: 'Adult Scenes',
  parse: parseSceneRelease,
  score: scoreScene,
  planImport: planSceneImport,
});

export default createScenesPlugin;
export { parseSceneRelease, scoreScene, planSceneImport };
```

- [ ] **Step 7: Run the check**

Run: `npm run check`
Expected: all eleven scoring and import-planning tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(plugin-scenes): add scoring, import planning, and plugin factory"
```

---

### Task 9: Ingest — collation and the bump rule

**Files:**
- Create: `packages/core/src/db/row.ts`, `packages/core/src/db/feed-items.ts`, `packages/core/src/db/groups.ts`, `packages/core/src/db/releases.ts`
- Create: `packages/core/src/ingest/ingest.ts`
- Test: `packages/core/test/ingest/ingest.test.ts`

**Interfaces:**
- Consumes: `openTestDatabase` (Task 4), `FeedEntry` (Task 5), `MediaTypePlugin` (Task 2), `FeedConfig` (Task 3).
- Produces: `ingestEntries(db, plugin, feed, entries, now): IngestResult`; row types `GroupRow`, `ReleaseRow`; and the db helpers `insertFeedItem`, `setParseError`, `findGroup`, `getGroup`, `insertGroup`, `flagUpgrade`, `insertRelease`, `getRelease`, `releaseScore`. Tasks 11–16 use these same helpers.

This task encodes the two rules the whole product rests on. The tests are the specification.

- [ ] **Step 1: Write the row coercion helpers**

`packages/core/src/db/row.ts`:

```ts
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export function num(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`Column ${key} is not numeric`);
}

export function maybeNum(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return num(row, key);
}

export function str(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  throw new Error(`Column ${key} is not a string`);
}

export function maybeStr(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return str(row, key);
}
```

- [ ] **Step 2: Write the failing ingest test**

`packages/core/test/ingest/ingest.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { ingestEntries } from '../../src/ingest/ingest.ts';
import { findGroup, getGroup } from '../../src/db/groups.ts';
import type { FeedEntry } from '../../src/feeds/parse-rss.ts';
import type { FeedConfig } from '../../src/config/schema.ts';

const FEED: FeedConfig = {
  id: 'feed1',
  url: 'https://example.invalid/rss',
  plugin: 'pkg',
  intervalSeconds: 900,
};

/**
 * A plugin whose identity is the part of the title before "|" and whose score
 * is the number after it. Keeps the ingest tests about ingest rules rather
 * than about parsing.
 */
const PLUGIN: MediaTypePlugin = {
  id: 'test',
  displayName: 'Test',
  parse(name): ParsedRelease | null {
    const [identity, score] = name.split('|');
    if (identity === undefined || score === undefined) return null;
    if (identity === 'THROW') throw new Error('boom');
    return {
      identityKey: identity,
      display: { title: identity, subtitle: 'Sub', fields: [{ label: 'L', value: identity }] },
      quality: { resolution: Number(score) },
    };
  },
  score: (quality) => quality.resolution ?? 0,
  planImport: () => null,
};

function entry(guid: string, title: string): FeedEntry {
  return { guid, title, link: `https://indexer.invalid/${guid}.nzb`, publishedAt: null };
}

function pick(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = ? WHERE id = ?").run(
    releaseId,
    groupId,
  );
}

function latestReleaseId(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM releases').get();
  return Number(row?.['id']);
}

test('re-ingesting the same guid is a no-op', () => {
  const db = openTestDatabase();
  const entries = [entry('g1', 'alpha|1080')];
  const first = ingestEntries(db, PLUGIN, FEED, entries, 1000);
  const second = ingestEntries(db, PLUGIN, FEED, entries, 2000);

  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM releases').get()?.['n']), 1);
  db.close();
});

test('two releases with the same identity collate into one group', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080'), entry('g2', 'alpha|2160')], 1000);

  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM releases').get()?.['n']), 2);
  db.close();
});

test('different identities create separate groups', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080'), entry('g2', 'beta|1080')], 1000);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 2);
  db.close();
});

test('a new release on an unpicked group does not touch list_rank_at', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080')], 1000);
  ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|2160')], 5000);

  const group = findGroup(db, 'test', 'alpha');
  assert.equal(group?.listRankAt, 1000);
  assert.equal(group?.upgradeReleaseId, null);
  db.close();
});

test('a better release on a picked group flags an upgrade and bumps list_rank_at', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080')], 1000);
  const group = findGroup(db, 'test', 'alpha')!;
  pick(db, group.id, latestReleaseId(db));

  const result = ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|2160')], 5000);

  const updated = getGroup(db, group.id)!;
  assert.equal(result.upgradesFlagged, 1);
  assert.equal(updated.listRankAt, 5000);
  assert.equal(updated.createdAt, 1000);
  assert.equal(updated.upgradeReleaseId, latestReleaseId(db));
  db.close();
});

test('a worse release on a picked group changes nothing', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|2160')], 1000);
  const group = findGroup(db, 'test', 'alpha')!;
  pick(db, group.id, latestReleaseId(db));

  const result = ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|720')], 5000);

  const updated = getGroup(db, group.id)!;
  assert.equal(result.upgradesFlagged, 0);
  assert.equal(updated.listRankAt, 1000);
  assert.equal(updated.upgradeReleaseId, null);
  db.close();
});

test('an equal-scoring release on a picked group changes nothing', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080')], 1000);
  const group = findGroup(db, 'test', 'alpha')!;
  pick(db, group.id, latestReleaseId(db));

  ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|1080')], 5000);
  assert.equal(getGroup(db, group.id)?.upgradeReleaseId, null);
  db.close();
});

test('a release better than the pick but not the flagged upgrade is ignored', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|720')], 1000);
  const group = findGroup(db, 'test', 'alpha')!;
  pick(db, group.id, latestReleaseId(db));

  ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|2160')], 5000);
  const flagged = getGroup(db, group.id)!.upgradeReleaseId;

  ingestEntries(db, PLUGIN, FEED, [entry('g3', 'alpha|1080')], 9000);
  const after = getGroup(db, group.id)!;
  assert.equal(after.upgradeReleaseId, flagged);
  assert.equal(after.listRankAt, 5000);
  db.close();
});

test('a release better than the flagged upgrade replaces it and bumps again', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|720')], 1000);
  const group = findGroup(db, 'test', 'alpha')!;
  pick(db, group.id, latestReleaseId(db));

  ingestEntries(db, PLUGIN, FEED, [entry('g2', 'alpha|1080')], 5000);
  ingestEntries(db, PLUGIN, FEED, [entry('g3', 'alpha|2160')], 9000);

  const after = getGroup(db, group.id)!;
  assert.equal(after.upgradeReleaseId, latestReleaseId(db));
  assert.equal(after.listRankAt, 9000);
  db.close();
});

test('an unparseable name records a parse_error and creates no group', () => {
  const db = openTestDatabase();
  const result = ingestEntries(db, PLUGIN, FEED, [entry('g1', 'no-separator')], 1000);

  assert.equal(result.parseErrors, 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 0);
  assert.equal(
    db.prepare('SELECT parse_error FROM feed_items WHERE guid = ?').get('g1')?.['parse_error'],
    'unrecognized',
  );
  db.close();
});

test('a plugin that throws does not stop the batch', () => {
  const db = openTestDatabase();
  const result = ingestEntries(
    db,
    PLUGIN,
    FEED,
    [entry('g1', 'THROW|1080'), entry('g2', 'alpha|1080')],
    1000,
  );

  assert.equal(result.parseErrors, 1);
  assert.equal(result.releasesAdded, 1);
  assert.match(
    String(db.prepare('SELECT parse_error FROM feed_items WHERE guid = ?').get('g1')?.[
      'parse_error'
    ]),
    /boom/,
  );
  db.close();
});

test('groups are keyed by plugin id, not by feed', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'alpha|1080')], 1000);
  ingestEntries(db, PLUGIN, { ...FEED, id: 'feed2' }, [entry('g1', 'alpha|2160')], 2000);

  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']), 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM feed_items').get()?.['n']), 2);
  db.close();
});

test('search_text is lowercased and includes every display value', () => {
  const db = openTestDatabase();
  ingestEntries(db, PLUGIN, FEED, [entry('g1', 'Alpha|1080')], 1000);
  const text = String(db.prepare('SELECT search_text FROM media_groups').get()?.['search_text']);
  assert.match(text, /alpha/);
  assert.match(text, /sub/);
  assert.equal(text, text.toLowerCase());
  db.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/ingest/ingest.ts`.

- [ ] **Step 4: Write the feed_items helpers**

`packages/core/src/db/feed-items.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';

export interface NewFeedItem {
  feedId: string;
  guid: string;
  rawTitle: string;
  link: string;
  publishedAt: number | null;
  firstSeenAt: number;
}

/** Returns the new row id, or null when this guid was already seen. */
export function insertFeedItem(db: DatabaseSync, item: NewFeedItem): number | null {
  const result = db
    .prepare(
      `INSERT INTO feed_items (feed_id, guid, raw_title, link, published_at, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
    )
    .run(item.feedId, item.guid, item.rawTitle, item.link, item.publishedAt, item.firstSeenAt);

  return result.changes === 0 ? null : Number(result.lastInsertRowid);
}

export function setParseError(db: DatabaseSync, feedItemId: number, error: string): void {
  db.prepare('UPDATE feed_items SET parse_error = ? WHERE id = ?').run(error, feedItemId);
}
```

- [ ] **Step 5: Write the groups and releases helpers**

`packages/core/src/db/groups.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { maybeNum, num, str, type SqlRow } from './row.ts';

export type GroupState = 'new' | 'picked';

export interface GroupRow {
  id: number;
  plugin: string;
  identityKey: string;
  display: string;
  searchText: string;
  state: GroupState;
  pickedReleaseId: number | null;
  upgradeReleaseId: number | null;
  createdAt: number;
  listRankAt: number;
}

const SELECT = `
  SELECT id, plugin, identity_key, display, search_text, state,
         picked_release_id, upgrade_release_id, created_at, list_rank_at
  FROM media_groups
`;

export function toGroupRow(row: SqlRow): GroupRow {
  const state = str(row, 'state');
  return {
    id: num(row, 'id'),
    plugin: str(row, 'plugin'),
    identityKey: str(row, 'identity_key'),
    display: str(row, 'display'),
    searchText: str(row, 'search_text'),
    state: state === 'picked' ? 'picked' : 'new',
    pickedReleaseId: maybeNum(row, 'picked_release_id'),
    upgradeReleaseId: maybeNum(row, 'upgrade_release_id'),
    createdAt: num(row, 'created_at'),
    listRankAt: num(row, 'list_rank_at'),
  };
}

export function findGroup(
  db: DatabaseSync,
  plugin: string,
  identityKey: string,
): GroupRow | null {
  const row = db.prepare(`${SELECT} WHERE plugin = ? AND identity_key = ?`).get(plugin, identityKey);
  return row === undefined ? null : toGroupRow(row as SqlRow);
}

export function getGroup(db: DatabaseSync, id: number): GroupRow | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row === undefined ? null : toGroupRow(row as SqlRow);
}

export interface NewGroup {
  plugin: string;
  identityKey: string;
  display: string;
  searchText: string;
  createdAt: number;
}

export function insertGroup(db: DatabaseSync, group: NewGroup): number {
  const result = db
    .prepare(
      `INSERT INTO media_groups (plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      group.plugin,
      group.identityKey,
      group.display,
      group.searchText,
      group.createdAt,
      group.createdAt,
    );
  return Number(result.lastInsertRowid);
}

/** The only write in the system that moves list_rank_at. */
export function flagUpgrade(
  db: DatabaseSync,
  groupId: number,
  releaseId: number,
  now: number,
): void {
  db.prepare('UPDATE media_groups SET upgrade_release_id = ?, list_rank_at = ? WHERE id = ?').run(
    releaseId,
    now,
    groupId,
  );
}

export function markPicked(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = ? WHERE id = ?",
  ).run(releaseId, groupId);
}

export function completeUpgrade(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare(
    'UPDATE media_groups SET picked_release_id = ?, upgrade_release_id = NULL WHERE id = ?',
  ).run(releaseId, groupId);
}
```

`packages/core/src/db/releases.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { num, str, type SqlRow } from './row.ts';

export interface ReleaseRow {
  id: number;
  groupId: number;
  feedItemId: number;
  quality: string;
  score: number;
  createdAt: number;
}

function toReleaseRow(row: SqlRow): ReleaseRow {
  return {
    id: num(row, 'id'),
    groupId: num(row, 'group_id'),
    feedItemId: num(row, 'feed_item_id'),
    quality: str(row, 'quality'),
    score: num(row, 'score'),
    createdAt: num(row, 'created_at'),
  };
}

export interface NewRelease {
  groupId: number;
  feedItemId: number;
  quality: string;
  score: number;
  createdAt: number;
}

export function insertRelease(db: DatabaseSync, release: NewRelease): number {
  const result = db
    .prepare(
      `INSERT INTO releases (group_id, feed_item_id, quality, score, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      release.groupId,
      release.feedItemId,
      release.quality,
      release.score,
      release.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function getRelease(db: DatabaseSync, id: number): ReleaseRow | null {
  const row = db
    .prepare(
      'SELECT id, group_id, feed_item_id, quality, score, created_at FROM releases WHERE id = ?',
    )
    .get(id);
  return row === undefined ? null : toReleaseRow(row as SqlRow);
}

/** Returns null for a null id, so callers can pass an unset pointer directly. */
export function releaseScore(db: DatabaseSync, id: number | null): number | null {
  if (id === null) return null;
  return getRelease(db, id)?.score ?? null;
}

export function releasesForGroup(db: DatabaseSync, groupId: number): ReleaseRow[] {
  return db
    .prepare(
      `SELECT id, group_id, feed_item_id, quality, score, created_at
       FROM releases WHERE group_id = ? ORDER BY score DESC, id DESC`,
    )
    .all(groupId)
    .map((row) => toReleaseRow(row as SqlRow));
}
```

- [ ] **Step 6: Implement ingest**

`packages/core/src/ingest/ingest.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import type { FeedConfig } from '../config/schema.ts';
import type { FeedEntry } from '../feeds/parse-rss.ts';
import { insertFeedItem, setParseError } from '../db/feed-items.ts';
import { findGroup, flagUpgrade, insertGroup } from '../db/groups.ts';
import { insertRelease, releaseScore } from '../db/releases.ts';

export interface IngestResult {
  seen: number;
  inserted: number;
  parseErrors: number;
  groupsCreated: number;
  releasesAdded: number;
  upgradesFlagged: number;
}

function searchTextFor(display: DisplayFields): string {
  const parts = [display.title, display.subtitle ?? '', display.date ?? ''];
  for (const field of display.fields) parts.push(field.value);
  return parts.join(' ').toLowerCase();
}

function parseSafely(
  plugin: MediaTypePlugin,
  title: string,
): { parsed: ParsedRelease } | { error: string } {
  try {
    const parsed = plugin.parse(title);
    return parsed === null ? { error: 'unrecognized' } : { parsed };
  } catch (error) {
    return { error: `parse threw: ${(error as Error).message}` };
  }
}

/**
 * Ingests feed entries under the two rules from the spec.
 *
 * Ledger: a feed item is processed only if its INSERT actually inserted, so a
 * feed re-serving its whole history is a no-op.
 *
 * Bump: list_rank_at moves in exactly one situation — a release arriving that
 * beats both the picked release and any already-flagged upgrade on a group the
 * user has picked. Everything else leaves list position alone.
 */
export function ingestEntries(
  db: DatabaseSync,
  plugin: MediaTypePlugin,
  feed: FeedConfig,
  entries: FeedEntry[],
  now: number,
): IngestResult {
  const result: IngestResult = {
    seen: entries.length,
    inserted: 0,
    parseErrors: 0,
    groupsCreated: 0,
    releasesAdded: 0,
    upgradesFlagged: 0,
  };

  for (const entry of entries) {
    db.exec('BEGIN');
    try {
      const feedItemId = insertFeedItem(db, {
        feedId: feed.id,
        guid: entry.guid,
        rawTitle: entry.title,
        link: entry.link,
        publishedAt: entry.publishedAt,
        firstSeenAt: now,
      });

      if (feedItemId === null) {
        db.exec('COMMIT');
        continue;
      }
      result.inserted += 1;

      const outcome = parseSafely(plugin, entry.title);
      if ('error' in outcome) {
        setParseError(db, feedItemId, outcome.error);
        result.parseErrors += 1;
        db.exec('COMMIT');
        continue;
      }

      const { parsed } = outcome;
      const existing = findGroup(db, plugin.id, parsed.identityKey);
      const groupId =
        existing?.id ??
        insertGroup(db, {
          plugin: plugin.id,
          identityKey: parsed.identityKey,
          display: JSON.stringify(parsed.display),
          searchText: searchTextFor(parsed.display),
          createdAt: now,
        });
      if (existing === null) result.groupsCreated += 1;

      const score = plugin.score(parsed.quality);
      const releaseId = insertRelease(db, {
        groupId,
        feedItemId,
        quality: JSON.stringify(parsed.quality),
        score,
        createdAt: now,
      });
      result.releasesAdded += 1;

      if (existing !== null && existing.state === 'picked') {
        const pickedScore = releaseScore(db, existing.pickedReleaseId) ?? Number.NEGATIVE_INFINITY;
        const flaggedScore =
          releaseScore(db, existing.upgradeReleaseId) ?? Number.NEGATIVE_INFINITY;

        if (score > pickedScore && score > flaggedScore) {
          flagUpgrade(db, groupId, releaseId, now);
          result.upgradesFlagged += 1;
        }
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return result;
}
```

- [ ] **Step 7: Run the check**

Run: `npm run check`
Expected: all thirteen ingest tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): add ingest with collation and upgrade-bump rules"
```

---

## Phase 3 — Acquisition

### Task 10: Download client interface and SABnzbd

**Files:**
- Create: `packages/core/src/clients/types.ts`, `packages/core/src/clients/sabnzbd.ts`
- Test: `packages/core/test/clients/sabnzbd.test.ts`

**Interfaces:**
- Consumes: `DownloadClientConfig` from Task 3.
- Produces: `DownloadClient`, `ClientSnapshot`, `ClientQueueEntry`, `ClientHistoryEntry`, `FetchLike`, and `createSabnzbdClient(config, fetchImpl?): DownloadClient`. Tasks 11–15 depend only on the `DownloadClient` interface, never on SABnzbd directly.

- [ ] **Step 1: Define the client interface**

`packages/core/src/clients/types.ts`:

```ts
export interface ClientQueueEntry {
  ref: string;
  name: string;
  percentage: number;
}

export interface ClientHistoryEntry {
  ref: string;
  name: string;
  outcome: 'completed' | 'failed';
  storagePath: string | null;
  failMessage: string | null;
}

export interface ClientSnapshot {
  queue: ClientQueueEntry[];
  history: ClientHistoryEntry[];
}

export interface DownloadClient {
  readonly id: string;
  readonly importMode: 'move' | 'copy';
  /** Adds a URL and returns the client's reference for it. */
  addUrl(url: string): Promise<string>;
  /** One poll of everything in this client's configured category. */
  snapshot(): Promise<ClientSnapshot>;
  /** Translates a client-reported path into one Pickarr can open. */
  mapPath(clientPath: string): string;
}

export type FetchLike = (url: string) => Promise<Response>;
```

- [ ] **Step 2: Write the failing client test**

`packages/core/test/clients/sabnzbd.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSabnzbdClient } from '../../src/clients/sabnzbd.ts';
import type { DownloadClientConfig } from '../../src/config/schema.ts';

const CONFIG: DownloadClientConfig = {
  id: 'sab',
  type: 'sabnzbd',
  url: 'http://sab.invalid:8080',
  apiKey: 'SECRET_KEY',
  category: 'pickarr',
  importMode: 'move',
  pathMappings: [
    { from: '/downloads/complete', to: '/data/complete' },
    { from: '/downloads', to: '/data/downloads' },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(bodyFor: (url: string) => unknown): {
  fetch: (url: string) => Promise<Response>;
  urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url: string) => {
      urls.push(url);
      return jsonResponse(bodyFor(url));
    },
  };
}

test('addUrl sends the category and returns the nzo id', async () => {
  const recorder = recordingFetch(() => ({ status: true, nzo_ids: ['SABnzbd_nzo_abc'] }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  const ref = await client.addUrl('https://indexer.invalid/x.nzb');

  assert.equal(ref, 'SABnzbd_nzo_abc');
  assert.match(recorder.urls[0] ?? '', /mode=addurl/);
  assert.match(recorder.urls[0] ?? '', /cat=pickarr/);
  assert.match(recorder.urls[0] ?? '', /apikey=SECRET_KEY/);
});

test('addUrl throws when sabnzbd reports failure', async () => {
  const recorder = recordingFetch(() => ({ status: false, error: 'nope' }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), /nope/);
});

test('addUrl throws when no nzo id comes back', async () => {
  const recorder = recordingFetch(() => ({ status: true, nzo_ids: [] }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), /no nzo/i);
});

test('an error never contains the api key', async () => {
  const client = createSabnzbdClient(CONFIG, async () => new Response('nope', { status: 500 }));
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), (error: Error) => {
    assert.doesNotMatch(error.message, /SECRET_KEY/);
    return true;
  });
});

test('snapshot reads queue and history filtered by category', async () => {
  const recorder = recordingFetch((url) =>
    url.includes('mode=queue')
      ? { queue: { slots: [{ nzo_id: 'q1', filename: 'Release.One', percentage: '42' }] } }
      : {
          history: {
            slots: [
              {
                nzo_id: 'h1',
                name: 'Release.Two',
                status: 'Completed',
                storage: '/downloads/complete/Release.Two',
                fail_message: '',
              },
              {
                nzo_id: 'h2',
                name: 'Release.Three',
                status: 'Failed',
                storage: '',
                fail_message: 'Out of retention',
              },
            ],
          },
        },
  );
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  const snapshot = await client.snapshot();

  assert.deepEqual(snapshot.queue, [{ ref: 'q1', name: 'Release.One', percentage: 42 }]);
  assert.equal(snapshot.history[0]?.outcome, 'completed');
  assert.equal(snapshot.history[0]?.storagePath, '/downloads/complete/Release.Two');
  assert.equal(snapshot.history[1]?.outcome, 'failed');
  assert.equal(snapshot.history[1]?.failMessage, 'Out of retention');
  assert.equal(snapshot.history[1]?.storagePath, null);
  assert.ok(recorder.urls.every((url) => url.includes('category=pickarr')));
});

test('snapshot tolerates missing slots', async () => {
  const client = createSabnzbdClient(CONFIG, async () => jsonResponse({}));
  const snapshot = await client.snapshot();
  assert.deepEqual(snapshot, { queue: [], history: [] });
});

test('mapPath applies the longest matching prefix', () => {
  const client = createSabnzbdClient(CONFIG, async () => jsonResponse({}));
  assert.equal(client.mapPath('/downloads/complete/X'), '/data/complete/X');
  assert.equal(client.mapPath('/downloads/incomplete/X'), '/data/downloads/incomplete/X');
});

test('mapPath leaves an unmatched path alone', () => {
  const client = createSabnzbdClient(CONFIG, async () => jsonResponse({}));
  assert.equal(client.mapPath('/elsewhere/X'), '/elsewhere/X');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/clients/sabnzbd.ts`.

- [ ] **Step 4: Implement the SABnzbd client**

`packages/core/src/clients/sabnzbd.ts`:

```ts
import type { DownloadClientConfig } from '../config/schema.ts';
import type {
  ClientHistoryEntry,
  ClientQueueEntry,
  ClientSnapshot,
  DownloadClient,
  FetchLike,
} from './types.ts';

const TIMEOUT_MS = 20_000;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function text(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export function createSabnzbdClient(
  config: DownloadClientConfig,
  fetchImpl: FetchLike = (url) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
): DownloadClient {
  const base = config.url.replace(/\/+$/, '');

  /** Never include the built URL in an error — it carries the api key. */
  function endpoint(params: Record<string, string>): string {
    const query = new URLSearchParams({ ...params, apikey: config.apiKey, output: 'json' });
    return `${base}/api?${query.toString()}`;
  }

  async function call(mode: string, params: Record<string, string>): Promise<JsonValue> {
    const response = await fetchImpl(endpoint({ mode, ...params }));
    if (!response.ok) {
      throw new Error(`SABnzbd ${mode} returned HTTP ${response.status}`);
    }
    return (await response.json()) as JsonValue;
  }

  // Longest prefix first, so a nested mapping wins over its parent.
  const mappings = [...config.pathMappings].sort((a, b) => b.from.length - a.from.length);

  return {
    id: config.id,
    importMode: config.importMode,

    async addUrl(url) {
      const body = asRecord(await call('addurl', { name: url, cat: config.category }));
      if (body === null || body['status'] !== true) {
        const reason = body === null ? 'malformed response' : text(body['error']) || 'unknown error';
        throw new Error(`SABnzbd rejected the download: ${reason}`);
      }

      const ids = asArray(body['nzo_ids']);
      const first = ids[0];
      if (typeof first !== 'string' || first.length === 0) {
        throw new Error('SABnzbd accepted the download but returned no nzo id');
      }
      return first;
    },

    async snapshot(): Promise<ClientSnapshot> {
      const [queueBody, historyBody] = await Promise.all([
        call('queue', { category: config.category }),
        call('history', { category: config.category }),
      ]);

      const queue: ClientQueueEntry[] = [];
      for (const raw of asArray(asRecord(asRecord(queueBody)?.['queue'])?.['slots'])) {
        const slot = asRecord(raw);
        if (slot === null) continue;
        const ref = text(slot['nzo_id']);
        if (ref === '') continue;
        queue.push({
          ref,
          name: text(slot['filename']),
          percentage: Number.parseInt(text(slot['percentage']), 10) || 0,
        });
      }

      const history: ClientHistoryEntry[] = [];
      for (const raw of asArray(asRecord(asRecord(historyBody)?.['history'])?.['slots'])) {
        const slot = asRecord(raw);
        if (slot === null) continue;
        const ref = text(slot['nzo_id']);
        if (ref === '') continue;

        const status = text(slot['status']).toLowerCase();
        // Anything not explicitly completed is a failure; sabnzbd uses several
        // terminal labels and treating an unknown one as success would import
        // a partial download.
        const outcome = status === 'completed' ? 'completed' : 'failed';
        const storage = text(slot['storage']);
        const failMessage = text(slot['fail_message']);

        history.push({
          ref,
          name: text(slot['name']),
          outcome,
          storagePath: outcome === 'completed' && storage !== '' ? storage : null,
          failMessage: failMessage === '' ? null : failMessage,
        });
      }

      return { queue, history };
    },

    mapPath(clientPath) {
      for (const mapping of mappings) {
        if (clientPath === mapping.from || clientPath.startsWith(`${mapping.from}/`)) {
          return mapping.to + clientPath.slice(mapping.from.length);
        }
      }
      return clientPath;
    },
  };
}
```

Note the terminal-status rule: only a literal `Completed` counts as success. SABnzbd also emits `Failed`, `Deleted`, and others, and treating an unrecognized label as success would import a partial download.

- [ ] **Step 5: Run the check**

Run: `npm run check`
Expected: all eight SABnzbd tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add download client interface and SABnzbd implementation"
```

---

### Task 11: Downloads table helpers and the pick flow

**Files:**
- Create: `packages/core/src/db/downloads.ts`, `packages/core/src/pipeline/pick.ts`
- Test: `packages/core/test/pipeline/pick.test.ts`

**Interfaces:**
- Consumes: `DownloadClient` (Task 10), group and release helpers (Task 9).
- Produces: `DownloadRow`, `DownloadStatus`, `DownloadKind`, the helpers `insertDownload`, `getDownload`, `setClientRef`, `setStatus`, `failDownload`, `setStoragePath`, `activeDownloads`, `bumpAttempts`, `bumpMissingPolls`, `resetMissingPolls`, `allDownloads`; and `pickRelease(db, client, { groupId, releaseId, kind }, now): Promise<DownloadRow>`.

- [ ] **Step 1: Write the failing pick test**

`packages/core/test/pipeline/pick.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { pickRelease } from '../../src/pipeline/pick.ts';
import { getGroup } from '../../src/db/groups.ts';
import { getDownload } from '../../src/db/downloads.ts';
import type { DownloadClient, ClientSnapshot } from '../../src/clients/types.ts';

function fakeClient(overrides: Partial<DownloadClient> = {}): DownloadClient {
  return {
    id: 'sab',
    importMode: 'move',
    addUrl: async () => 'nzo_1',
    snapshot: async (): Promise<ClientSnapshot> => ({ queue: [], history: [] }),
    mapPath: (path) => path,
    ...overrides,
  };
}

function seed(db: DatabaseSync): { groupId: number; releaseId: number } {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g', 'Title', 'https://indexer.invalid/1.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{}', 't', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1)`,
  ).run();
  return { groupId: 1, releaseId: 1 };
}

test('picking marks the group picked and starts a download', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);

  const download = await pickRelease(db, fakeClient(), { groupId, releaseId, kind: 'initial' }, 500);

  const group = getGroup(db, groupId)!;
  assert.equal(group.state, 'picked');
  assert.equal(group.pickedReleaseId, releaseId);
  assert.equal(download.status, 'downloading');
  assert.equal(download.clientRef, 'nzo_1');
  assert.equal(download.kind, 'initial');
  db.close();
});

test('picking sets picked_release_id immediately, before any download finishes', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  await pickRelease(db, fakeClient(), { groupId, releaseId, kind: 'initial' }, 500);
  assert.equal(getGroup(db, groupId)?.pickedReleaseId, releaseId);
  db.close();
});

test('an addUrl failure leaves the download queued and the pick intact', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  const client = fakeClient({
    addUrl: async () => {
      throw new Error('sab is down');
    },
  });

  const download = await pickRelease(db, client, { groupId, releaseId, kind: 'initial' }, 500);

  assert.equal(download.status, 'queued');
  assert.equal(download.clientRef, null);
  assert.match(download.error ?? '', /sab is down/);
  assert.equal(getGroup(db, groupId)?.state, 'picked');
  db.close();
});

test('an upgrade pick does not overwrite picked_release_id', async () => {
  const db = openTestDatabase();
  const { groupId } = seed(db);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     SELECT 2, 1, id, '{}', 200, 1 FROM feed_items WHERE id = 1`,
  ).run();
  await pickRelease(db, fakeClient(), { groupId, releaseId: 1, kind: 'initial' }, 500);
  await pickRelease(db, fakeClient(), { groupId, releaseId: 2, kind: 'upgrade' }, 600);

  assert.equal(getGroup(db, groupId)?.pickedReleaseId, 1);
  db.close();
});

test('picking a release that belongs to another group is rejected', async () => {
  const db = openTestDatabase();
  seed(db);
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (2, 'test', 'k2', '{}', 't', 1, 1)`,
  ).run();

  await assert.rejects(
    pickRelease(db, fakeClient(), { groupId: 2, releaseId: 1, kind: 'initial' }, 500),
    /does not belong/,
  );
  db.close();
});

test('picking an unknown release is rejected', async () => {
  const db = openTestDatabase();
  seed(db);
  await assert.rejects(
    pickRelease(db, fakeClient(), { groupId: 1, releaseId: 999, kind: 'initial' }, 500),
    /999/,
  );
  db.close();
});

test('picking the same release twice while in flight is rejected', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  await pickRelease(db, fakeClient(), { groupId, releaseId, kind: 'initial' }, 500);
  await assert.rejects(
    pickRelease(db, fakeClient(), { groupId, releaseId, kind: 'initial' }, 600),
    /already/i,
  );
  db.close();
});

test('the download row records the client id and timestamps', async () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seed(db);
  const download = await pickRelease(db, fakeClient(), { groupId, releaseId, kind: 'initial' }, 500);
  const stored = getDownload(db, download.id)!;
  assert.equal(stored.clientId, 'sab');
  assert.equal(stored.createdAt, 500);
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/db/downloads.ts`.

- [ ] **Step 3: Write the downloads helpers**

`packages/core/src/db/downloads.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { maybeNum, maybeStr, num, str, type SqlRow } from './row.ts';

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'importing'
  | 'imported'
  | 'failed';

export type DownloadKind = 'initial' | 'upgrade';

export const TERMINAL_STATUSES: DownloadStatus[] = ['imported', 'failed'];

export interface DownloadRow {
  id: number;
  releaseId: number;
  groupId: number;
  clientId: string;
  clientRef: string | null;
  kind: DownloadKind;
  status: DownloadStatus;
  storagePath: string | null;
  error: string | null;
  attempts: number;
  missingPolls: number;
  createdAt: number;
  updatedAt: number;
}

const SELECT = `
  SELECT id, release_id, group_id, client_id, client_ref, kind, status,
         storage_path, error, attempts, missing_polls, created_at, updated_at
  FROM downloads
`;

const STATUSES = new Set<string>([
  'queued',
  'downloading',
  'completed',
  'importing',
  'imported',
  'failed',
]);

function toDownloadRow(row: SqlRow): DownloadRow {
  const status = str(row, 'status');
  if (!STATUSES.has(status)) throw new Error(`Unknown download status in database: ${status}`);
  return {
    id: num(row, 'id'),
    releaseId: num(row, 'release_id'),
    groupId: num(row, 'group_id'),
    clientId: str(row, 'client_id'),
    clientRef: maybeStr(row, 'client_ref'),
    kind: str(row, 'kind') === 'upgrade' ? 'upgrade' : 'initial',
    status: status as DownloadStatus,
    storagePath: maybeStr(row, 'storage_path'),
    error: maybeStr(row, 'error'),
    attempts: num(row, 'attempts'),
    missingPolls: num(row, 'missing_polls'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
  };
}

export interface NewDownload {
  releaseId: number;
  groupId: number;
  clientId: string;
  kind: DownloadKind;
  createdAt: number;
}

export function insertDownload(db: DatabaseSync, download: NewDownload): number {
  const result = db
    .prepare(
      `INSERT INTO downloads (release_id, group_id, client_id, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      download.releaseId,
      download.groupId,
      download.clientId,
      download.kind,
      download.createdAt,
      download.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function getDownload(db: DatabaseSync, id: number): DownloadRow | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row === undefined ? null : toDownloadRow(row as SqlRow);
}

export function allDownloads(db: DatabaseSync): DownloadRow[] {
  return db
    .prepare(`${SELECT} ORDER BY created_at DESC, id DESC`)
    .all()
    .map((row) => toDownloadRow(row as SqlRow));
}

export function activeDownloads(db: DatabaseSync, clientId: string): DownloadRow[] {
  return db
    .prepare(`${SELECT} WHERE client_id = ? AND status NOT IN ('imported', 'failed')`)
    .all(clientId)
    .map((row) => toDownloadRow(row as SqlRow));
}

export function inFlightForRelease(db: DatabaseSync, releaseId: number): DownloadRow | null {
  const row = db
    .prepare(`${SELECT} WHERE release_id = ? AND status != 'failed' LIMIT 1`)
    .get(releaseId);
  return row === undefined ? null : toDownloadRow(row as SqlRow);
}

export function setClientRef(
  db: DatabaseSync,
  id: number,
  clientRef: string,
  now: number,
): void {
  db.prepare(
    "UPDATE downloads SET client_ref = ?, status = 'downloading', error = NULL, updated_at = ? WHERE id = ?",
  ).run(clientRef, now, id);
}

export function setStatus(
  db: DatabaseSync,
  id: number,
  status: DownloadStatus,
  now: number,
): void {
  db.prepare('UPDATE downloads SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
}

export function setStoragePath(
  db: DatabaseSync,
  id: number,
  storagePath: string,
  now: number,
): void {
  db.prepare('UPDATE downloads SET storage_path = ?, updated_at = ? WHERE id = ?').run(
    storagePath,
    now,
    id,
  );
}

export function failDownload(db: DatabaseSync, id: number, error: string, now: number): void {
  db.prepare("UPDATE downloads SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
    error,
    now,
    id,
  );
}

export function recordError(db: DatabaseSync, id: number, error: string, now: number): void {
  db.prepare('UPDATE downloads SET error = ?, updated_at = ? WHERE id = ?').run(error, now, id);
}

export function bumpAttempts(db: DatabaseSync, id: number, now: number): number {
  db.prepare('UPDATE downloads SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(
    now,
    id,
  );
  return getDownload(db, id)?.attempts ?? 0;
}

export function bumpMissingPolls(db: DatabaseSync, id: number, now: number): number {
  db.prepare(
    'UPDATE downloads SET missing_polls = missing_polls + 1, updated_at = ? WHERE id = ?',
  ).run(now, id);
  return getDownload(db, id)?.missingPolls ?? 0;
}

export function resetMissingPolls(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE downloads SET missing_polls = 0 WHERE id = ? AND missing_polls != 0').run(id);
}
```

- [ ] **Step 4: Implement the pick flow**

`packages/core/src/pipeline/pick.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClient } from '../clients/types.ts';
import { getGroup, markPicked } from '../db/groups.ts';
import { getRelease } from '../db/releases.ts';
import {
  getDownload,
  inFlightForRelease,
  insertDownload,
  recordError,
  setClientRef,
  type DownloadKind,
  type DownloadRow,
} from '../db/downloads.ts';

export interface PickRequest {
  groupId: number;
  releaseId: number;
  kind: DownloadKind;
}

/**
 * Marks the group picked and starts the download.
 *
 * picked_release_id is written here rather than at import time because the
 * ingest rule compares incoming releases against it, and needs something to
 * compare against while a download is still in flight. An upgrade leaves it
 * alone — the replacement repoints it only once the new file is on disk.
 *
 * An unreachable download client must never block a pick, so an addUrl failure
 * leaves the row queued for the reconcile tick to retry.
 */
export async function pickRelease(
  db: DatabaseSync,
  client: DownloadClient,
  request: PickRequest,
  now: number,
): Promise<DownloadRow> {
  const group = getGroup(db, request.groupId);
  if (group === null) throw new Error(`No such group: ${request.groupId}`);

  const release = getRelease(db, request.releaseId);
  if (release === null) throw new Error(`No such release: ${request.releaseId}`);
  if (release.groupId !== request.groupId) {
    throw new Error(`Release ${request.releaseId} does not belong to group ${request.groupId}`);
  }

  const existing = inFlightForRelease(db, request.releaseId);
  if (existing !== null) {
    throw new Error(`Release ${request.releaseId} already has download ${existing.id}`);
  }

  let downloadId: number;
  db.exec('BEGIN');
  try {
    if (request.kind === 'initial') markPicked(db, request.groupId, request.releaseId);
    downloadId = insertDownload(db, {
      releaseId: request.releaseId,
      groupId: request.groupId,
      clientId: client.id,
      kind: request.kind,
      createdAt: now,
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const feedItem = db
    .prepare('SELECT link FROM feed_items WHERE id = ?')
    .get(release.feedItemId);
  const link = feedItem === undefined ? null : String(feedItem['link']);
  if (link === null) throw new Error(`Release ${request.releaseId} has no feed item link`);

  try {
    const clientRef = await client.addUrl(link);
    setClientRef(db, downloadId, clientRef, now);
  } catch (error) {
    recordError(db, downloadId, (error as Error).message, now);
  }

  const stored = getDownload(db, downloadId);
  if (stored === null) throw new Error(`Download ${downloadId} vanished immediately after insert`);
  return stored;
}
```

- [ ] **Step 5: Run the check**

Run: `npm run check`
Expected: all eight pick tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add downloads table helpers and the pick flow"
```

---

### Task 12: Reconcile loop

**Files:**
- Create: `packages/core/src/pipeline/reconcile.ts`
- Modify: `packages/core/src/db/releases.ts` (add `linkForRelease`), `packages/core/src/pipeline/pick.ts` (use it)
- Test: `packages/core/test/pipeline/reconcile.test.ts`

**Interfaces:**
- Consumes: `DownloadClient`, `ClientSnapshot` (Task 10); downloads helpers (Task 11).
- Produces: `UntrackedEntry`, `ReconcileResult`, `reconcileClient(deps): Promise<ReconcileResult>`, and the constants `MAX_ADDURL_ATTEMPTS = 5`, `MAX_MISSING_POLLS = 3`.

- [ ] **Step 1: Write the failing reconcile test**

`packages/core/test/pipeline/reconcile.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { reconcileClient, MAX_MISSING_POLLS } from '../../src/pipeline/reconcile.ts';
import { getDownload, type DownloadRow } from '../../src/db/downloads.ts';
import type { ClientSnapshot, DownloadClient } from '../../src/clients/types.ts';

const EMPTY: ClientSnapshot = { queue: [], history: [] };

function fakeClient(snapshot: ClientSnapshot, overrides: Partial<DownloadClient> = {}) {
  return {
    id: 'sab',
    importMode: 'move' as const,
    addUrl: async () => 'nzo_new',
    snapshot: async () => snapshot,
    mapPath: (path: string) => path.replace('/sab', '/pickarr'),
    ...overrides,
  } satisfies DownloadClient;
}

function seedDownload(
  db: DatabaseSync,
  fields: { id: number; status: string; clientRef: string | null; missingPolls?: number },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g', 'T', 'https://indexer.invalid/1.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{}', 't', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, client_ref, kind, status,
                            missing_polls, created_at, updated_at)
     VALUES (?, 1, 1, 'sab', ?, 'initial', ?, ?, 1, 1)`,
  ).run(fields.id, fields.clientRef, fields.status, fields.missingPolls ?? 0);
}

function deps(db: DatabaseSync, client: DownloadClient, imported: DownloadRow[] = []) {
  return {
    db,
    client,
    now: () => 1000,
    importDownload: async (download: DownloadRow) => {
      imported.push(download);
    },
  };
}

test('a download in the queue stays downloading and resets missing_polls', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1', missingPolls: 2 });
  const client = fakeClient({
    queue: [{ ref: 'nzo_1', name: 'R', percentage: 50 }],
    history: [],
  });

  await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'downloading');
  assert.equal(download.missingPolls, 0);
  db.close();
});

test('a completed download gets its mapped storage path and is imported', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [],
    history: [
      {
        ref: 'nzo_1',
        name: 'R',
        outcome: 'completed',
        storagePath: '/sab/complete/R',
        failMessage: null,
      },
    ],
  });

  await reconcileClient(deps(db, client, imported));

  assert.equal(getDownload(db, 1)?.storagePath, '/pickarr/complete/R');
  assert.equal(imported.length, 1);
  assert.equal(imported[0]?.storagePath, '/pickarr/complete/R');
  db.close();
});

test('a failed download records the fail message', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient({
    queue: [],
    history: [
      {
        ref: 'nzo_1',
        name: 'R',
        outcome: 'failed',
        storagePath: null,
        failMessage: 'Out of retention',
      },
    ],
  });

  await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  assert.match(download.error ?? '', /Out of retention/);
  db.close();
});

test('a completed download with no storage path fails rather than importing nothing', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [],
    history: [
      { ref: 'nzo_1', name: 'R', outcome: 'completed', storagePath: null, failMessage: null },
    ],
  });

  await reconcileClient(deps(db, client, imported));

  assert.equal(getDownload(db, 1)?.status, 'failed');
  assert.equal(imported.length, 0);
  db.close();
});

test('a download missing from both lists fails only after three consecutive polls', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient(EMPTY);

  for (let poll = 1; poll < MAX_MISSING_POLLS; poll += 1) {
    await reconcileClient(deps(db, client));
    assert.equal(getDownload(db, 1)?.status, 'downloading', `poll ${poll}`);
  }

  await reconcileClient(deps(db, client));
  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  assert.match(download.error ?? '', /disappeared-from-client/);
  db.close();
});

test('reappearing resets the missing counter', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });

  await reconcileClient(deps(db, fakeClient(EMPTY)));
  await reconcileClient(
    deps(db, fakeClient({ queue: [{ ref: 'nzo_1', name: 'R', percentage: 1 }], history: [] })),
  );
  await reconcileClient(deps(db, fakeClient(EMPTY)));
  await reconcileClient(deps(db, fakeClient(EMPTY)));

  assert.equal(getDownload(db, 1)?.status, 'downloading');
  db.close();
});

test('a queued download with no client ref is retried', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'queued', clientRef: null });
  const client = fakeClient(EMPTY, { addUrl: async () => 'nzo_retry' });

  await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'downloading');
  assert.equal(download.clientRef, 'nzo_retry');
  db.close();
});

test('addurl retries stop after the attempt cap', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'queued', clientRef: null });
  const client = fakeClient(EMPTY, {
    addUrl: async () => {
      throw new Error('still down');
    },
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await reconcileClient(deps(db, client));
  }

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  assert.match(download.error ?? '', /addurl-failed/);
  assert.ok(download.attempts <= 5);
  db.close();
});

test('entries with no matching row are reported as untracked and never imported', async () => {
  const db = openTestDatabase();
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [{ ref: 'foreign_1', name: 'Someone Elses', percentage: 12 }],
    history: [
      {
        ref: 'foreign_2',
        name: 'Also Not Ours',
        outcome: 'completed',
        storagePath: '/sab/complete/X',
        failMessage: null,
      },
    ],
  });

  const result = await reconcileClient(deps(db, client, imported));

  assert.equal(imported.length, 0);
  assert.equal(result.untracked.length, 2);
  assert.deepEqual(
    result.untracked.map((entry) => entry.state).sort(),
    ['completed', 'downloading'],
  );
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM downloads').get()?.['n']), 0);
  db.close();
});

test('an already-imported download still in history is not reported as untracked', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'imported', clientRef: 'nzo_1' });
  const client = fakeClient({
    queue: [],
    history: [
      { ref: 'nzo_1', name: 'R', outcome: 'completed', storagePath: '/sab/x', failMessage: null },
    ],
  });

  const result = await reconcileClient(deps(db, client));

  assert.equal(result.untracked.length, 0);
  db.close();
});

test('an import failure fails the download rather than throwing out of the tick', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient({
    queue: [],
    history: [
      { ref: 'nzo_1', name: 'R', outcome: 'completed', storagePath: '/sab/x', failMessage: null },
    ],
  });

  await reconcileClient({
    db,
    client,
    now: () => 1000,
    importDownload: async () => {
      throw new Error('disk full');
    },
  });

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  assert.match(download.error ?? '', /disk full/);
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/pipeline/reconcile.ts`.

- [ ] **Step 3: Add the shared link lookup**

Append to `packages/core/src/db/releases.ts`:

```ts
export function linkForRelease(db: DatabaseSync, releaseId: number): string | null {
  const row = db
    .prepare(
      `SELECT feed_items.link AS link
       FROM releases JOIN feed_items ON feed_items.id = releases.feed_item_id
       WHERE releases.id = ?`,
    )
    .get(releaseId);
  return row === undefined ? null : str(row as SqlRow, 'link');
}
```

In `packages/core/src/pipeline/pick.ts`, replace the inline feed-item query with it:

```ts
  const link = linkForRelease(db, request.releaseId);
  if (link === null) throw new Error(`Release ${request.releaseId} has no feed item link`);
```

and add `linkForRelease` to the existing import from `../db/releases.ts`.

- [ ] **Step 4: Implement reconcile**

`packages/core/src/pipeline/reconcile.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClient } from '../clients/types.ts';
import { linkForRelease } from '../db/releases.ts';
import {
  activeDownloads,
  bumpAttempts,
  bumpMissingPolls,
  failDownload,
  getDownload,
  recordError,
  resetMissingPolls,
  setClientRef,
  setStatus,
  setStoragePath,
  type DownloadRow,
} from '../db/downloads.ts';

export const MAX_ADDURL_ATTEMPTS = 5;
export const MAX_MISSING_POLLS = 3;

export interface UntrackedEntry {
  ref: string;
  name: string;
  state: 'downloading' | 'completed' | 'failed';
  percentage: number | null;
}

export interface ReconcileResult {
  untracked: UntrackedEntry[];
  advanced: number;
  failed: number;
  imported: number;
}

export interface ReconcileDeps {
  db: DatabaseSync;
  client: DownloadClient;
  now(): number;
  importDownload(download: DownloadRow): Promise<void>;
}

/**
 * One poll of a client's category, reconciled against the database.
 *
 * Polling by category rather than per download means a fixed two requests per
 * tick, and gives untracked visibility for free. Untracked entries are never
 * imported and never persisted: SABnzbd prunes history on its own schedule and
 * orphan rows would accumulate forever.
 */
export async function reconcileClient(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { db, client } = deps;
  const now = deps.now();
  const result: ReconcileResult = { untracked: [], advanced: 0, failed: 0, imported: 0 };

  const snapshot = await client.snapshot();
  const queueByRef = new Map(snapshot.queue.map((entry) => [entry.ref, entry]));
  const historyByRef = new Map(snapshot.history.map((entry) => [entry.ref, entry]));

  // Every ref this client has ever been given, terminal or not — an imported
  // download still sitting in history is ours, not a stranger's.
  const knownRefs = new Set<string>(
    db
      .prepare('SELECT client_ref FROM downloads WHERE client_id = ? AND client_ref IS NOT NULL')
      .all(client.id)
      .map((row) => String(row['client_ref'])),
  );

  for (const download of activeDownloads(db, client.id)) {
    if (download.clientRef === null) {
      const attempts = bumpAttempts(db, download.id, now);
      const link = linkForRelease(db, download.releaseId);
      if (link === null) {
        failDownload(db, download.id, 'addurl-failed: release has no link', now);
        result.failed += 1;
        continue;
      }

      try {
        const ref = await client.addUrl(link);
        setClientRef(db, download.id, ref, now);
        knownRefs.add(ref);
        result.advanced += 1;
      } catch (error) {
        const message = (error as Error).message;
        if (attempts >= MAX_ADDURL_ATTEMPTS) {
          failDownload(db, download.id, `addurl-failed after ${attempts} attempts: ${message}`, now);
          result.failed += 1;
        } else {
          recordError(db, download.id, message, now);
        }
      }
      continue;
    }

    const queued = queueByRef.get(download.clientRef);
    if (queued !== undefined) {
      resetMissingPolls(db, download.id);
      if (download.status !== 'downloading') {
        setStatus(db, download.id, 'downloading', now);
        result.advanced += 1;
      }
      continue;
    }

    const historic = historyByRef.get(download.clientRef);
    if (historic !== undefined) {
      resetMissingPolls(db, download.id);

      if (historic.outcome === 'failed') {
        failDownload(db, download.id, historic.failMessage ?? 'download failed at client', now);
        result.failed += 1;
        continue;
      }

      if (historic.storagePath === null) {
        failDownload(db, download.id, 'client reported success with no storage path', now);
        result.failed += 1;
        continue;
      }

      setStoragePath(db, download.id, client.mapPath(historic.storagePath), now);
      setStatus(db, download.id, 'completed', now);
      result.advanced += 1;

      const ready = getDownload(db, download.id);
      if (ready === null) continue;

      try {
        await deps.importDownload(ready);
        result.imported += 1;
      } catch (error) {
        failDownload(db, download.id, (error as Error).message, now);
        result.failed += 1;
      }
      continue;
    }

    const misses = bumpMissingPolls(db, download.id, now);
    if (misses >= MAX_MISSING_POLLS) {
      failDownload(db, download.id, 'disappeared-from-client', now);
      result.failed += 1;
    }
  }

  for (const entry of snapshot.queue) {
    if (knownRefs.has(entry.ref)) continue;
    result.untracked.push({
      ref: entry.ref,
      name: entry.name,
      state: 'downloading',
      percentage: entry.percentage,
    });
  }
  for (const entry of snapshot.history) {
    if (knownRefs.has(entry.ref)) continue;
    result.untracked.push({
      ref: entry.ref,
      name: entry.name,
      state: entry.outcome,
      percentage: null,
    });
  }

  return result;
}
```

- [ ] **Step 5: Run the check**

Run: `npm run check`
Expected: all eleven reconcile tests PASS, and the eight pick tests still pass after the refactor.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add reconcile loop with untracked entry reporting"
```

---

### Task 13: Import

**Files:**
- Create: `packages/core/src/db/imported-files.ts`, `packages/core/src/pipeline/import.ts`
- Modify: `packages/core/src/plugins/registry.ts` (add `libraryRootById`)
- Test: `packages/core/test/pipeline/import.test.ts`

**Interfaces:**
- Consumes: registry (Task 6), group/release helpers (Task 9), downloads helpers (Task 11).
- Produces: `ImportedFileRow`, the helpers `insertImportedFile`, `liveFilesForGroup`, `findLiveByDest`, `markTrashed`; and `importDownload(deps, download): Promise<void>` — the function Task 12's reconciler already calls through its `importDownload` dependency.

- [ ] **Step 1: Add library-root lookup by plugin id**

In `packages/core/src/plugins/registry.ts`, add `libraryRootById(id: string): string` to the `PluginRegistry` interface and implement it by building an id-keyed root map alongside the package-keyed one:

```ts
  const rootsById = new Map<string, string>();
  // inside the loop, after roots.set(packageName, libraryRoot):
  rootsById.set(plugin.id, libraryRoot);

  // in the returned object:
    libraryRootById(id) {
      const root = rootsById.get(id);
      if (root === undefined) throw new Error(`No library root for plugin id ${id}`);
      return root;
    },
```

Stored rows carry the plugin id, so import needs a root lookup keyed the same way.

- [ ] **Step 2: Write the failing import test**

`packages/core/test/pipeline/import.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportPlan, MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { importDownload, type ImportDeps } from '../../src/pipeline/import.ts';
import { getDownload } from '../../src/db/downloads.ts';
import { liveFilesForGroup } from '../../src/db/imported-files.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pickarr-import-'));
}

function plugin(planImport: MediaTypePlugin['planImport']): MediaTypePlugin {
  return { id: 'test', displayName: 'Test', parse: () => null, score: () => 0, planImport };
}

function registryFor(mediaPlugin: MediaTypePlugin, libraryRoot: string): PluginRegistry {
  return {
    byPackage: () => mediaPlugin,
    byId: () => mediaPlugin,
    libraryRoot: () => libraryRoot,
    libraryRootById: () => libraryRoot,
    all: () => [mediaPlugin],
  };
}

function seed(db: DatabaseSync, storagePath: string, kind: 'initial' | 'upgrade' = 'initial'): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g', 'T', 'https://indexer.invalid/1.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{"title":"T","fields":[]}', 't', 'picked', 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, client_ref, kind, status,
                            storage_path, created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'nzo_1', ?, 'completed', ?, 1, 1)`,
  ).run(kind, storagePath);
}

function deps(
  db: DatabaseSync,
  registry: PluginRegistry,
  trashDir: string,
  overrides: Partial<ImportDeps> = {},
): ImportDeps {
  return { db, registry, importMode: 'move', trashDir, now: () => 2000, ...overrides };
}

test('imports the planned file and records it', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete', 'Release');
    await mkdir(downloadDir, { recursive: true });
    await writeFile(join(downloadDir, 'scene.mp4'), 'video-bytes');

    const library = join(root, 'library');
    const db = openTestDatabase();
    seed(db, downloadDir);

    const registry = registryFor(
      plugin((): ImportPlan => ({
        files: [{ source: join(downloadDir, 'scene.mp4'), destination: 'Site/scene.mp4' }],
      })),
      library,
    );

    await importDownload(deps(db, registry, join(root, 'trash')), getDownload(db, 1)!);

    assert.equal(await readFile(join(library, 'Site', 'scene.mp4'), 'utf8'), 'video-bytes');
    assert.equal(getDownload(db, 1)?.status, 'imported');
    const recorded = liveFilesForGroup(db, 1);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.destPath, join(library, 'Site', 'scene.mp4'));
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('move removes the source, copy leaves it', async () => {
  for (const mode of ['move', 'copy'] as const) {
    const root = await tempDir();
    try {
      const downloadDir = join(root, 'complete');
      await mkdir(downloadDir, { recursive: true });
      const source = join(downloadDir, 'scene.mp4');
      await writeFile(source, 'x');

      const library = join(root, 'library');
      const db = openTestDatabase();
      seed(db, downloadDir);
      const registry = registryFor(
        plugin((): ImportPlan => ({ files: [{ source, destination: 'scene.mp4' }] })),
        library,
      );

      await importDownload(
        deps(db, registry, join(root, 'trash'), { importMode: mode }),
        getDownload(db, 1)!,
      );

      const sourceExists = await stat(source).then(
        () => true,
        () => false,
      );
      assert.equal(sourceExists, mode === 'copy', `mode ${mode}`);
      db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('a cross-device rename falls back to copy-then-unlink', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    const source = join(downloadDir, 'scene.mp4');
    await writeFile(source, 'payload');

    const library = join(root, 'library');
    const db = openTestDatabase();
    seed(db, downloadDir);
    const registry = registryFor(
      plugin((): ImportPlan => ({ files: [{ source, destination: 'scene.mp4' }] })),
      library,
    );

    await importDownload(
      deps(db, registry, join(root, 'trash'), {
        rename: async () => {
          const error: NodeJS.ErrnoException = new Error('cross-device link');
          error.code = 'EXDEV';
          throw error;
        },
      }),
      getDownload(db, 1)!,
    );

    assert.equal(await readFile(join(library, 'scene.mp4'), 'utf8'), 'payload');
    assert.equal(
      await stat(source).then(
        () => true,
        () => false,
      ),
      false,
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a destination escaping the library root is rejected', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    const source = join(downloadDir, 'scene.mp4');
    await writeFile(source, 'x');

    const db = openTestDatabase();
    seed(db, downloadDir);
    const registry = registryFor(
      plugin((): ImportPlan => ({ files: [{ source, destination: '../../etc/evil' }] })),
      join(root, 'library'),
    );

    await assert.rejects(
      importDownload(deps(db, registry, join(root, 'trash')), getDownload(db, 1)!),
      /escapes the library root/,
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no importable files fails with a named reason', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    const db = openTestDatabase();
    seed(db, downloadDir);
    const registry = registryFor(plugin(() => null), join(root, 'library'));

    await assert.rejects(
      importDownload(deps(db, registry, join(root, 'trash')), getDownload(db, 1)!),
      /no-importable-files/,
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retry after a partial import skips files already in place', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    await writeFile(join(downloadDir, 'a.mp4'), 'a');
    await writeFile(join(downloadDir, 'b.mp4'), 'b');

    const library = join(root, 'library');
    // Simulate the first attempt having moved a.mp4 and crashed before b.mp4.
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'a.mp4'), 'a');
    await rm(join(downloadDir, 'a.mp4'));

    const db = openTestDatabase();
    seed(db, downloadDir);
    const registry = registryFor(
      plugin((): ImportPlan => ({
        files: [
          { source: join(downloadDir, 'a.mp4'), destination: 'a.mp4' },
          { source: join(downloadDir, 'b.mp4'), destination: 'b.mp4' },
        ],
      })),
      library,
    );

    await importDownload(deps(db, registry, join(root, 'trash')), getDownload(db, 1)!);

    assert.equal(getDownload(db, 1)?.status, 'imported');
    assert.equal(liveFilesForGroup(db, 1).length, 2);
    assert.equal(await readFile(join(library, 'b.mp4'), 'utf8'), 'b');
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the file listing reaches the plugin with sizes and relative paths', async () => {
  const root = await tempDir();
  try {
    const downloadDir = join(root, 'complete');
    await mkdir(join(downloadDir, 'nested'), { recursive: true });
    await writeFile(join(downloadDir, 'nested', 'scene.mp4'), 'abcdef');

    const db = openTestDatabase();
    seed(db, downloadDir);

    let seenRelative = '';
    let seenSize = 0;
    const registry = registryFor(
      plugin((_media, files): ImportPlan | null => {
        seenRelative = files[0]?.relativePath ?? '';
        seenSize = files[0]?.sizeBytes ?? 0;
        return { files: [{ source: files[0]!.absolutePath, destination: 'scene.mp4' }] };
      }),
      join(root, 'library'),
    );

    await importDownload(deps(db, registry, join(root, 'trash')), getDownload(db, 1)!);

    assert.equal(seenRelative, join('nested', 'scene.mp4'));
    assert.equal(seenSize, 6);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/pipeline/import.ts`.

- [ ] **Step 4: Write the imported_files helpers**

`packages/core/src/db/imported-files.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { maybeNum, maybeStr, num, str, type SqlRow } from './row.ts';

export interface ImportedFileRow {
  id: number;
  downloadId: number;
  groupId: number;
  sourcePath: string;
  destPath: string;
  sizeBytes: number;
  trashedAt: number | null;
  trashPath: string | null;
  createdAt: number;
}

const SELECT = `
  SELECT id, download_id, group_id, source_path, dest_path, size_bytes,
         trashed_at, trash_path, created_at
  FROM imported_files
`;

function toRow(row: SqlRow): ImportedFileRow {
  return {
    id: num(row, 'id'),
    downloadId: num(row, 'download_id'),
    groupId: num(row, 'group_id'),
    sourcePath: str(row, 'source_path'),
    destPath: str(row, 'dest_path'),
    sizeBytes: num(row, 'size_bytes'),
    trashedAt: maybeNum(row, 'trashed_at'),
    trashPath: maybeStr(row, 'trash_path'),
    createdAt: num(row, 'created_at'),
  };
}

export interface NewImportedFile {
  downloadId: number;
  groupId: number;
  sourcePath: string;
  destPath: string;
  sizeBytes: number;
  createdAt: number;
}

export function insertImportedFile(db: DatabaseSync, file: NewImportedFile): number {
  const result = db
    .prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      file.downloadId,
      file.groupId,
      file.sourcePath,
      file.destPath,
      file.sizeBytes,
      file.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function liveFilesForGroup(db: DatabaseSync, groupId: number): ImportedFileRow[] {
  return db
    .prepare(`${SELECT} WHERE group_id = ? AND trashed_at IS NULL ORDER BY id`)
    .all(groupId)
    .map((row) => toRow(row as SqlRow));
}

export function findLiveByDest(
  db: DatabaseSync,
  groupId: number,
  destPath: string,
): ImportedFileRow | null {
  const row = db
    .prepare(`${SELECT} WHERE group_id = ? AND dest_path = ? AND trashed_at IS NULL`)
    .get(groupId, destPath);
  return row === undefined ? null : toRow(row as SqlRow);
}

export function markTrashed(
  db: DatabaseSync,
  id: number,
  trashPath: string,
  now: number,
): void {
  db.prepare('UPDATE imported_files SET trashed_at = ?, trash_path = ? WHERE id = ?').run(
    now,
    trashPath,
    id,
  );
}
```

- [ ] **Step 5: Implement import**

`packages/core/src/pipeline/import.ts`:

```ts
import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadedFile, ParsedRelease } from '@pickarr/plugin-api';
import type { PluginRegistry } from '../plugins/registry.ts';
import { getGroup } from '../db/groups.ts';
import { getRelease } from '../db/releases.ts';
import { setStatus, type DownloadRow } from '../db/downloads.ts';
import { findLiveByDest, insertImportedFile } from '../db/imported-files.ts';

export type RenameLike = (source: string, destination: string) => Promise<void>;

export interface ImportDeps {
  db: DatabaseSync;
  registry: PluginRegistry;
  importMode: 'move' | 'copy';
  trashDir: string;
  now(): number;
  rename?: RenameLike;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string): Promise<DownloadedFile[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: DownloadedFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = join(entry.parentPath, entry.name);
    const stats = await stat(absolutePath);
    files.push({
      absolutePath,
      relativePath: relative(root, absolutePath),
      sizeBytes: stats.size,
    });
  }

  return files;
}

/**
 * Resolves a plugin-supplied destination against the library root and refuses
 * anything that escapes it. A plugin is not trusted to police its own paths —
 * a parser bug must not be able to write outside the library.
 */
function resolveDestination(libraryRoot: string, destination: string): string {
  const root = resolve(libraryRoot);
  const target = resolve(root, destination);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Destination ${destination} escapes the library root`);
  }
  return target;
}

async function transfer(
  source: string,
  destination: string,
  mode: 'move' | 'copy',
  renameImpl: RenameLike,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });

  if (mode === 'copy') {
    await copyFile(source, destination);
    return;
  }

  try {
    await renameImpl(source, destination);
  } catch (error) {
    // The downloads volume and the library volume are frequently different
    // filesystems even inside one container.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(source, destination);
    await unlink(source);
  }
}

export async function importDownload(deps: ImportDeps, download: DownloadRow): Promise<void> {
  const { db, registry } = deps;
  const now = deps.now();
  const renameImpl = deps.rename ?? rename;

  if (download.storagePath === null) throw new Error('Download has no storage path');

  const group = getGroup(db, download.groupId);
  if (group === null) throw new Error(`No such group: ${download.groupId}`);
  const release = getRelease(db, download.releaseId);
  if (release === null) throw new Error(`No such release: ${download.releaseId}`);

  const plugin = registry.byId(group.plugin);
  if (plugin === undefined) throw new Error(`No plugin loaded for id ${group.plugin}`);
  const libraryRoot = registry.libraryRootById(group.plugin);

  setStatus(db, download.id, 'importing', now);

  const media: ParsedRelease = {
    identityKey: group.identityKey,
    display: JSON.parse(group.display) as ParsedRelease['display'],
    quality: JSON.parse(release.quality) as ParsedRelease['quality'],
  };

  const files = await listFiles(download.storagePath);
  const plan = plugin.planImport(media, files);
  if (plan === null || plan.files.length === 0) {
    throw new Error('no-importable-files');
  }

  const resolved = plan.files.map((file) => ({
    source: file.source,
    destination: resolveDestination(libraryRoot, file.destination),
  }));

  for (const file of resolved) {
    // Idempotent on retry: a destination that exists with no surviving source
    // was written by an earlier attempt that crashed before recording it.
    const alreadyRecorded = findLiveByDest(db, download.groupId, file.destination);
    const destinationExists = await exists(file.destination);
    const sourceExists = await exists(file.source);

    if (alreadyRecorded !== null && destinationExists) continue;

    if (!destinationExists) {
      if (!sourceExists) throw new Error(`Planned source is missing: ${file.source}`);
      await transfer(file.source, file.destination, deps.importMode, renameImpl);
    }

    const stats = await stat(file.destination);
    insertImportedFile(db, {
      downloadId: download.id,
      groupId: download.groupId,
      sourcePath: file.source,
      destPath: file.destination,
      sizeBytes: stats.size,
      createdAt: now,
    });
  }

  setStatus(db, download.id, 'imported', now);
}
```

- [ ] **Step 6: Run the check**

Run: `npm run check`
Expected: all seven import tests PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): add import with path validation and crash-safe retry"
```

---

### Task 14: Upgrade replacement

**Files:**
- Create: `packages/core/src/pipeline/upgrade.ts`
- Modify: `packages/core/src/pipeline/import.ts` (call it around the transfer loop)
- Test: `packages/core/test/pipeline/upgrade.test.ts`

**Interfaces:**
- Consumes: `liveFilesForGroup`, `markTrashed` (Task 13); `completeUpgrade` (Task 9).
- Produces: `trashLiveFiles(db, groupId, downloadId, trashDir, now): Promise<string | null>` — returns the trash directory used, or null when there was nothing to trash.

- [ ] **Step 1: Write the failing upgrade test**

`packages/core/test/pipeline/upgrade.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportPlan, MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { importDownload, type ImportDeps } from '../../src/pipeline/import.ts';
import { getGroup } from '../../src/db/groups.ts';
import { getDownload } from '../../src/db/downloads.ts';
import { liveFilesForGroup } from '../../src/db/imported-files.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';

function registryFor(planImport: MediaTypePlugin['planImport'], root: string): PluginRegistry {
  const mediaPlugin: MediaTypePlugin = {
    id: 'test',
    displayName: 'Test',
    parse: () => null,
    score: () => 0,
    planImport,
  };
  return {
    byPackage: () => mediaPlugin,
    byId: () => mediaPlugin,
    libraryRoot: () => root,
    libraryRootById: () => root,
    all: () => [mediaPlugin],
  };
}

/** Group already owns release 1; release 2 is the flagged upgrade. */
function seedUpgrade(db: DatabaseSync, storagePath: string): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://indexer.invalid/1.nzb', 1),
            (2, 'f', 'g2', 'T2', 'https://indexer.invalid/2.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, upgrade_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{"title":"T","fields":[]}', 't', 'picked', 1, 2, 1, 9000)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1), (2, 1, 2, '{}', 200, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, client_ref, kind, status,
                            storage_path, created_at, updated_at)
     VALUES (1, 2, 1, 'sab', 'nzo_2', 'upgrade', 'completed', ?, 1, 1)`,
  ).run(storagePath);
}

function deps(
  db: DatabaseSync,
  registry: PluginRegistry,
  trashDir: string,
  overrides: Partial<ImportDeps> = {},
): ImportDeps {
  return { db, registry, importMode: 'move', trashDir, now: () => 2000, ...overrides };
}

test('an upgrade trashes the old file, writes the new one, and repoints the group', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'scene.mp4'), 'old-version');

    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    await writeFile(join(downloadDir, 'scene.mp4'), 'new-version');

    const db = openTestDatabase();
    seedUpgrade(db, downloadDir);
    // The old file is on record as the group's live import.
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (1, 1, '/old/source', ?, 11, 1)`,
    ).run(join(library, 'scene.mp4'));

    const registry = registryFor(
      (): ImportPlan => ({
        files: [{ source: join(downloadDir, 'scene.mp4'), destination: 'scene.mp4' }],
      }),
      library,
    );

    await importDownload(deps(db, registry, trash), getDownload(db, 1)!);

    assert.equal(await readFile(join(library, 'scene.mp4'), 'utf8'), 'new-version');

    const trashedGroupDir = join(trash, '1', '2000');
    assert.deepEqual(await readdir(trashedGroupDir), ['scene.mp4']);
    assert.equal(await readFile(join(trashedGroupDir, 'scene.mp4'), 'utf8'), 'old-version');

    const group = getGroup(db, 1)!;
    assert.equal(group.pickedReleaseId, 2);
    assert.equal(group.upgradeReleaseId, null);
    assert.equal(getDownload(db, 1)?.status, 'imported');

    const live = liveFilesForGroup(db, 1);
    assert.equal(live.length, 1);
    assert.equal(live[0]?.destPath, join(library, 'scene.mp4'));
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trash paths are namespaced so repeated upgrades cannot collide', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(library, { recursive: true });

    const db = openTestDatabase();
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    seedUpgrade(db, downloadDir);

    for (const [stamp, contents] of [
      [2000, 'first'],
      [3000, 'second'],
    ] as const) {
      await writeFile(join(library, 'scene.mp4'), contents);
      await writeFile(join(downloadDir, 'scene.mp4'), 'replacement');
      db.prepare('DELETE FROM imported_files WHERE group_id = 1').run();
      db.prepare(
        `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
         VALUES (1, 1, '/old', ?, 5, 1)`,
      ).run(join(library, 'scene.mp4'));
      db.prepare("UPDATE downloads SET status = 'completed' WHERE id = 1").run();

      const registry = registryFor(
        (): ImportPlan => ({
          files: [{ source: join(downloadDir, 'scene.mp4'), destination: 'scene.mp4' }],
        }),
        library,
      );
      await importDownload(deps(db, registry, trash, { now: () => stamp }), getDownload(db, 1)!);
    }

    assert.equal(await readFile(join(trash, '1', '2000', 'scene.mp4'), 'utf8'), 'first');
    assert.equal(await readFile(join(trash, '1', '3000', 'scene.mp4'), 'utf8'), 'second');
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failure after trashing reports where the old file went', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'scene.mp4'), 'old-version');

    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });

    const db = openTestDatabase();
    seedUpgrade(db, downloadDir);
    db.prepare(
      `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
       VALUES (1, 1, '/old', ?, 11, 1)`,
    ).run(join(library, 'scene.mp4'));

    // Plan a source that does not exist, so the transfer fails after trashing.
    const registry = registryFor(
      (): ImportPlan => ({
        files: [{ source: join(downloadDir, 'absent.mp4'), destination: 'scene.mp4' }],
      }),
      library,
    );

    await assert.rejects(
      importDownload(deps(db, registry, trash), getDownload(db, 1)!),
      (error: Error) => {
        assert.match(error.message, /previous files were moved to/);
        assert.match(error.message, /1[/\\]2000/);
        return true;
      },
    );

    assert.equal(await readFile(join(trash, '1', '2000', 'scene.mp4'), 'utf8'), 'old-version');
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an initial import trashes nothing and leaves the pointer alone', async () => {
  const root = await tempRoot();
  try {
    const library = join(root, 'library');
    const trash = join(root, 'trash');
    const downloadDir = join(root, 'complete');
    await mkdir(downloadDir, { recursive: true });
    await writeFile(join(downloadDir, 'scene.mp4'), 'only-version');

    const db = openTestDatabase();
    seedUpgrade(db, downloadDir);
    db.prepare("UPDATE downloads SET kind = 'initial', release_id = 1 WHERE id = 1").run();

    const registry = registryFor(
      (): ImportPlan => ({
        files: [{ source: join(downloadDir, 'scene.mp4'), destination: 'scene.mp4' }],
      }),
      library,
    );

    await importDownload(deps(db, registry, trash), getDownload(db, 1)!);

    assert.equal(
      await stat(trash).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(getGroup(db, 1)?.pickedReleaseId, 1);
    assert.equal(getGroup(db, 1)?.upgradeReleaseId, 2);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pickarr-upgrade-'));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — the upgrade path is not implemented; old files are not trashed.

- [ ] **Step 3: Implement trashing**

`packages/core/src/pipeline/upgrade.ts`:

```ts
import { mkdir, rename, copyFile, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { liveFilesForGroup, markTrashed } from '../db/imported-files.ts';

/**
 * Moves a group's live imported files into the trash directory.
 *
 * Trash-first ordering is required because the replacement usually wants the
 * same destination path as the file it supersedes. Paths are namespaced by
 * group and timestamp so repeated upgrades of the same group cannot collide.
 *
 * Returns the directory used, or null when the group had nothing on disk.
 */
export async function trashLiveFiles(
  db: DatabaseSync,
  groupId: number,
  trashDir: string,
  now: number,
): Promise<string | null> {
  const live = liveFilesForGroup(db, groupId);
  if (live.length === 0) return null;

  const destinationDir = join(trashDir, String(groupId), String(now));
  await mkdir(destinationDir, { recursive: true });

  for (const file of live) {
    const trashPath = join(destinationDir, basename(file.destPath));
    try {
      await rename(file.destPath, trashPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Already gone from disk; record the intent and move on.
        markTrashed(db, file.id, trashPath, now);
        continue;
      }
      if (code !== 'EXDEV') throw error;
      await copyFile(file.destPath, trashPath);
      await unlink(file.destPath);
    }
    markTrashed(db, file.id, trashPath, now);
  }

  return destinationDir;
}
```

- [ ] **Step 4: Wire it into import**

In `packages/core/src/pipeline/import.ts`, add the imports:

```ts
import { completeUpgrade } from '../db/groups.ts';
import { trashLiveFiles } from './upgrade.ts';
```

Then, in `importDownload`, replace the transfer loop and the final status write with:

```ts
  const trashedTo =
    download.kind === 'upgrade'
      ? await trashLiveFiles(db, download.groupId, deps.trashDir, now)
      : null;

  try {
    for (const file of resolved) {
      const alreadyRecorded = findLiveByDest(db, download.groupId, file.destination);
      const destinationExists = await exists(file.destination);
      const sourceExists = await exists(file.source);

      if (alreadyRecorded !== null && destinationExists) continue;

      if (!destinationExists) {
        if (!sourceExists) throw new Error(`Planned source is missing: ${file.source}`);
        await transfer(file.source, file.destination, deps.importMode, renameImpl);
      }

      const stats = await stat(file.destination);
      insertImportedFile(db, {
        downloadId: download.id,
        groupId: download.groupId,
        sourcePath: file.source,
        destPath: file.destination,
        sizeBytes: stats.size,
        createdAt: now,
      });
    }
  } catch (error) {
    if (trashedTo === null) throw error;
    throw new Error(
      `${(error as Error).message} — previous files were moved to ${trashedTo} and can be restored by hand`,
    );
  }

  if (download.kind === 'upgrade') {
    completeUpgrade(db, download.groupId, download.releaseId);
  }

  setStatus(db, download.id, 'imported', now);
```

- [ ] **Step 5: Run the check**

Run: `npm run check`
Expected: all four upgrade tests PASS and the seven import tests still pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add trash-then-replace upgrade handling"
```

---

### Task 15: Boot recovery, mutex, and scheduler

**Files:**
- Create: `packages/core/src/pipeline/mutex.ts`, `packages/core/src/pipeline/recover.ts`, `packages/core/src/pipeline/scheduler.ts`
- Test: `packages/core/test/pipeline/mutex.test.ts`, `packages/core/test/pipeline/recover.test.ts`, `packages/core/test/pipeline/scheduler.test.ts`

**Interfaces:**
- Consumes: `ingestEntries` (Task 9), `reconcileClient` (Task 12), `importDownload` (Task 13).
- Produces: `createMutex(): Mutex`, `recoverInterruptedWork(db, now): RecoveryResult`, and `createScheduler(deps): Scheduler` with `{ start(): void; stop(): void; ingestNow(feedId): Promise<IngestResult>; reconcileNow(): Promise<void>; untrackedFor(clientId): UntrackedEntry[] }`.

The scheduler owns the in-memory untracked snapshot that Task 16's downloads route merges with DB rows.

- [ ] **Step 1: Write the failing mutex test**

`packages/core/test/pipeline/mutex.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMutex } from '../../src/pipeline/mutex.ts';

test('runs exclusively and in order', async () => {
  const mutex = createMutex();
  const events: string[] = [];

  const slow = mutex.run(async () => {
    events.push('slow:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('slow:end');
  });
  const fast = mutex.run(async () => {
    events.push('fast:start');
    events.push('fast:end');
  });

  await Promise.all([slow, fast]);
  assert.deepEqual(events, ['slow:start', 'slow:end', 'fast:start', 'fast:end']);
});

test('a rejection does not wedge the mutex', async () => {
  const mutex = createMutex();
  await assert.rejects(
    mutex.run(async () => {
      throw new Error('boom');
    }),
  );
  assert.equal(await mutex.run(async () => 'ok'), 'ok');
});

test('tryRun skips instead of queueing when busy', async () => {
  const mutex = createMutex();
  let ran = 0;
  const held = mutex.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const skipped = await mutex.tryRun(async () => {
    ran += 1;
  });

  await held;
  assert.equal(skipped, false);
  assert.equal(ran, 0);
});
```

- [ ] **Step 2: Write the failing recovery test**

`packages/core/test/pipeline/recover.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { recoverInterruptedWork } from '../../src/pipeline/recover.ts';
import { getDownload } from '../../src/db/downloads.ts';

function seed(db: DatabaseSync, rows: [number, string, string | null][]): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g', 'T', 'https://indexer.invalid/1.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{}', 't', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 1, 1)`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, client_ref, kind, status, created_at, updated_at)
     VALUES (?, 1, 1, 'sab', ?, 'initial', ?, 1, 1)`,
  );
  for (const [id, status, clientRef] of rows) insert.run(id, clientRef, status);
}

test('importing resets to completed so the next tick redoes the import', () => {
  const db = openTestDatabase();
  seed(db, [[1, 'importing', 'nzo_1']]);
  const result = recoverInterruptedWork(db, 500);
  assert.equal(getDownload(db, 1)?.status, 'completed');
  assert.equal(result.importsReset, 1);
  db.close();
});

test('queued with no client ref is left queued for retry and counted', () => {
  const db = openTestDatabase();
  seed(db, [[1, 'queued', null]]);
  const result = recoverInterruptedWork(db, 500);
  assert.equal(getDownload(db, 1)?.status, 'queued');
  assert.equal(result.pendingAddUrl, 1);
  db.close();
});

test('terminal and in-flight rows are untouched', () => {
  const db = openTestDatabase();
  seed(db, [
    [1, 'imported', 'nzo_1'],
    [2, 'failed', 'nzo_2'],
    [3, 'downloading', 'nzo_3'],
  ]);
  recoverInterruptedWork(db, 500);
  assert.equal(getDownload(db, 1)?.status, 'imported');
  assert.equal(getDownload(db, 2)?.status, 'failed');
  assert.equal(getDownload(db, 3)?.status, 'downloading');
  db.close();
});
```

- [ ] **Step 3: Write the failing scheduler test**

`packages/core/test/pipeline/scheduler.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../src/pipeline/scheduler.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import type { UntrackedEntry } from '../../src/pipeline/reconcile.ts';

const UNTRACKED: UntrackedEntry[] = [
  { ref: 'foreign', name: 'Not Ours', state: 'downloading', percentage: 10 },
];

test('reconcileNow caches the untracked snapshot for later reads', async () => {
  const db = openTestDatabase();
  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => ({
      seen: 0,
      inserted: 0,
      parseErrors: 0,
      groupsCreated: 0,
      releasesAdded: 0,
      upgradesFlagged: 0,
    }),
    reconcile: async () => ({ untracked: UNTRACKED, advanced: 0, failed: 0, imported: 0 }),
    clientIds: ['sab'],
    log: () => {},
  });

  assert.deepEqual(scheduler.untrackedFor('sab'), []);
  await scheduler.reconcileNow();
  assert.deepEqual(scheduler.untrackedFor('sab'), UNTRACKED);
  db.close();
});

test('a reconcile failure is logged and does not throw out of the tick', async () => {
  const db = openTestDatabase();
  const logged: string[] = [];
  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => {
      throw new Error('sab unreachable');
    },
    clientIds: ['sab'],
    log: (message) => logged.push(message),
  });

  await scheduler.reconcileNow();
  assert.ok(logged.some((line) => line.includes('sab unreachable')));
  db.close();
});

test('an ingest failure on one feed does not stop the others', async () => {
  const db = openTestDatabase();
  const ingested: string[] = [];
  const scheduler = createScheduler({
    db,
    feeds: [
      { id: 'a', url: 'https://a.invalid', plugin: 'p', intervalSeconds: 1 },
      { id: 'b', url: 'https://b.invalid', plugin: 'p', intervalSeconds: 1 },
    ],
    ingestFeed: async (feed) => {
      if (feed.id === 'a') throw new Error('feed a is down');
      ingested.push(feed.id);
      return {
        seen: 0,
        inserted: 0,
        parseErrors: 0,
        groupsCreated: 0,
        releasesAdded: 0,
        upgradesFlagged: 0,
      };
    },
    reconcile: async () => ({ untracked: [], advanced: 0, failed: 0, imported: 0 }),
    clientIds: [],
    log: () => {},
  });

  await scheduler.ingestAllNow();
  assert.deepEqual(ingested, ['b']);
  db.close();
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — none of the three modules resolve.

- [ ] **Step 5: Implement the mutex**

`packages/core/src/pipeline/mutex.ts`:

```ts
export interface Mutex {
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Runs only if the mutex is free; returns false when it was busy. */
  tryRun(work: () => Promise<void>): Promise<boolean>;
}

export function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  let busy = false;

  function run<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      busy = true;
      try {
        return await work();
      } finally {
        busy = false;
      }
    });
    // Swallow rejections on the chain itself so one failure cannot wedge it.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    run,
    async tryRun(work) {
      if (busy) return false;
      await run(work);
      return true;
    },
  };
}
```

- [ ] **Step 6: Implement recovery**

`packages/core/src/pipeline/recover.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';

export interface RecoveryResult {
  importsReset: number;
  pendingAddUrl: number;
}

/**
 * The payoff for keeping the state machine in the database: recovery after a
 * crash is two statements, and everything else resumes on the next tick.
 */
export function recoverInterruptedWork(db: DatabaseSync, now: number): RecoveryResult {
  const reset = db
    .prepare("UPDATE downloads SET status = 'completed', updated_at = ? WHERE status = 'importing'")
    .run(now);

  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM downloads WHERE status = 'queued' AND client_ref IS NULL")
    .get();

  return {
    importsReset: Number(reset.changes),
    pendingAddUrl: Number(pending?.['n'] ?? 0),
  };
}
```

- [ ] **Step 7: Implement the scheduler**

`packages/core/src/pipeline/scheduler.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { FeedConfig } from '../config/schema.ts';
import type { IngestResult } from '../ingest/ingest.ts';
import type { ReconcileResult, UntrackedEntry } from './reconcile.ts';
import { createMutex } from './mutex.ts';

export const RECONCILE_INTERVAL_MS = 10_000;

export interface SchedulerDeps {
  db: DatabaseSync;
  feeds: FeedConfig[];
  clientIds: string[];
  ingestFeed(feed: FeedConfig): Promise<IngestResult>;
  reconcile(clientId: string): Promise<ReconcileResult>;
  log(message: string): void;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  ingestAllNow(): Promise<void>;
  ingestNow(feedId: string): Promise<IngestResult>;
  reconcileNow(): Promise<void>;
  untrackedFor(clientId: string): UntrackedEntry[];
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const ingestMutex = createMutex();
  const reconcileMutex = createMutex();
  const untracked = new Map<string, UntrackedEntry[]>();
  const timers: NodeJS.Timeout[] = [];

  async function ingestOne(feed: FeedConfig): Promise<IngestResult> {
    return ingestMutex.run(() => deps.ingestFeed(feed));
  }

  async function ingestAllNow(): Promise<void> {
    for (const feed of deps.feeds) {
      try {
        const result = await ingestOne(feed);
        deps.log(
          `ingest ${feed.id}: ${result.inserted} new, ${result.groupsCreated} groups, ` +
            `${result.upgradesFlagged} upgrades, ${result.parseErrors} parse errors`,
        );
      } catch (error) {
        // One bad feed must never stop the others.
        deps.log(`ingest ${feed.id} failed: ${(error as Error).message}`);
      }
    }
  }

  async function reconcileNow(): Promise<void> {
    await reconcileMutex.run(async () => {
      for (const clientId of deps.clientIds) {
        try {
          const result = await deps.reconcile(clientId);
          untracked.set(clientId, result.untracked);
        } catch (error) {
          deps.log(`reconcile ${clientId} failed: ${(error as Error).message}`);
        }
      }
    });
  }

  return {
    start() {
      for (const feed of deps.feeds) {
        const timer = setInterval(() => {
          void ingestOne(feed).catch((error: Error) =>
            deps.log(`ingest ${feed.id} failed: ${error.message}`),
          );
        }, feed.intervalSeconds * 1000);
        timer.unref();
        timers.push(timer);
      }

      const reconcileTimer = setInterval(() => {
        void reconcileNow();
      }, RECONCILE_INTERVAL_MS);
      reconcileTimer.unref();
      timers.push(reconcileTimer);
    },

    stop() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    },

    ingestAllNow,
    ingestNow(feedId) {
      const feed = deps.feeds.find((candidate) => candidate.id === feedId);
      if (feed === undefined) throw new Error(`No such feed: ${feedId}`);
      return ingestOne(feed);
    },
    reconcileNow,
    untrackedFor: (clientId) => untracked.get(clientId) ?? [],
  };
}
```

- [ ] **Step 8: Run the check**

Run: `npm run check`
Expected: all nine mutex, recovery, and scheduler tests PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): add mutex, boot recovery, and the ingest and reconcile timers"
```

---

## Phase 4 — Surface

### Task 16: HTTP API and boot sequence

**Files:**
- Create: `packages/core/src/http/views.ts`, `packages/core/src/http/server.ts`, `packages/core/src/main.ts`
- Modify: `packages/core/src/db/groups.ts` (add `browseGroups`, `pickedGroups`), `packages/core/src/db/downloads.ts` (add `resetForRetry`)
- Test: `packages/core/test/http/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–15.
- Produces: `buildServer(deps): FastifyInstance` and the response types `GroupView`, `ReleaseView`, `BrowseResponse`, `DownloadView`, `DownloadsResponse` — which Task 17's SPA client mirrors exactly.

- [ ] **Step 1: Add the browse and picks queries**

Append to `packages/core/src/db/groups.ts`:

```ts
export interface BrowseQuery {
  cursor: { listRankAt: number; id: number } | null;
  limit: number;
  search: string | null;
}

/**
 * One query serves both cases from the spec: unpicked groups, and picked
 * groups with something better available. Keyset pagination on
 * (list_rank_at, id) keeps paging stable while ingest is writing.
 */
export function browseGroups(db: DatabaseSync, query: BrowseQuery): GroupRow[] {
  const conditions = ["(state = 'new' OR upgrade_release_id IS NOT NULL)"];
  const params: (string | number)[] = [];

  if (query.search !== null) {
    conditions.push('search_text LIKE ?');
    params.push(`%${query.search.toLowerCase()}%`);
  }
  if (query.cursor !== null) {
    conditions.push('(list_rank_at < ? OR (list_rank_at = ? AND id < ?))');
    params.push(query.cursor.listRankAt, query.cursor.listRankAt, query.cursor.id);
  }
  params.push(query.limit);

  return db
    .prepare(
      `${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY list_rank_at DESC, id DESC LIMIT ?`,
    )
    .all(...params)
    .map((row) => toGroupRow(row as SqlRow));
}

export function pickedGroups(db: DatabaseSync): GroupRow[] {
  return db
    .prepare(`${SELECT} WHERE state = 'picked' ORDER BY list_rank_at DESC, id DESC`)
    .all()
    .map((row) => toGroupRow(row as SqlRow));
}
```

Append to `packages/core/src/db/downloads.ts`:

```ts
/**
 * Resumes from the furthest point already reached: a row that has a storage
 * path only needs its import redone, everything else restarts from queued.
 */
export function resetForRetry(db: DatabaseSync, id: number, now: number): DownloadRow | null {
  const download = getDownload(db, id);
  if (download === null) return null;

  const status: DownloadStatus = download.storagePath === null ? 'queued' : 'completed';
  db.prepare(
    `UPDATE downloads
     SET status = ?, error = NULL, attempts = 0, missing_polls = 0,
         client_ref = CASE WHEN ? = 'queued' THEN NULL ELSE client_ref END,
         updated_at = ?
     WHERE id = ?`,
  ).run(status, status, now, id);

  return getDownload(db, id);
}
```

- [ ] **Step 2: Write the failing server test**

`packages/core/test/http/server.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { buildServer, type ServerDeps } from '../../src/http/server.ts';
import type { DownloadClient } from '../../src/clients/types.ts';
import type { UntrackedEntry } from '../../src/pipeline/reconcile.ts';

function seedGroups(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'Alpha.1080p', 'https://indexer.invalid/1.nzb', 1),
            (2, 'f', 'g2', 'Alpha.2160p', 'https://indexer.invalid/2.nzb', 1),
            (3, 'f', 'g3', 'Beta.1080p',  'https://indexer.invalid/3.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state, created_at, list_rank_at)
     VALUES (1, 'test', 'alpha', '{"title":"Alpha","fields":[]}', 'alpha', 'new', 100, 100),
            (2, 'test', 'beta',  '{"title":"Beta","fields":[]}',  'beta',  'new', 200, 200)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":1080}', 1080, 1),
            (2, 1, 2, '{"resolution":2160}', 2160, 1),
            (3, 2, 3, '{"resolution":1080}', 1080, 1)`,
  ).run();
}

function fakeClient(): DownloadClient {
  return {
    id: 'sab',
    importMode: 'move',
    addUrl: async () => 'nzo_1',
    snapshot: async () => ({ queue: [], history: [] }),
    mapPath: (path) => path,
  };
}

function deps(db: DatabaseSync, untracked: UntrackedEntry[] = []): ServerDeps {
  return {
    db,
    defaultClient: fakeClient(),
    untrackedFor: () => untracked,
    now: () => 1000,
    webRoot: null,
  };
}

test('health responds ok', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));
  const response = await server.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json()['status'], 'ok');
  await server.close();
  db.close();
});

test('browse returns groups newest-rank first with their releases', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  const response = await server.inject({ method: 'GET', url: '/api/browse' });
  const body = response.json();

  assert.equal(body['groups'].length, 2);
  assert.equal(body['groups'][0]['display']['title'], 'Beta');
  assert.equal(body['groups'][1]['display']['title'], 'Alpha');
  assert.equal(body['groups'][1]['releases'].length, 2);
  assert.equal(body['groups'][1]['releases'][0]['score'], 2160);
  await server.close();
  db.close();
});

test('browse paginates with a stable cursor', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  const first = (await server.inject({ method: 'GET', url: '/api/browse?limit=1' })).json();
  assert.equal(first['groups'].length, 1);
  assert.ok(first['nextCursor']);

  const second = (
    await server.inject({
      method: 'GET',
      url: `/api/browse?limit=1&cursor=${encodeURIComponent(String(first['nextCursor']))}`,
    })
  ).json();
  assert.equal(second['groups'][0]['display']['title'], 'Alpha');
  assert.equal(second['nextCursor'], null);
  await server.close();
  db.close();
});

test('browse filters by q', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  const body = (await server.inject({ method: 'GET', url: '/api/browse?q=ALP' })).json();
  assert.equal(body['groups'].length, 1);
  assert.equal(body['groups'][0]['display']['title'], 'Alpha');
  await server.close();
  db.close();
});

test('a picked group with no upgrade drops out of browse and appears in picks', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  const pick = await server.inject({
    method: 'POST',
    url: '/api/groups/1/pick',
    payload: { releaseId: 2 },
  });
  assert.equal(pick.statusCode, 200);

  const browse = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  assert.deepEqual(
    browse['groups'].map((group: { display: { title: string } }) => group.display.title),
    ['Beta'],
  );

  const picks = (await server.inject({ method: 'GET', url: '/api/picks' })).json();
  assert.equal(picks['groups'].length, 1);
  assert.equal(picks['groups'][0]['pickedReleaseId'], 2);
  await server.close();
  db.close();
});

test('picking a release from the wrong group is a 400', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  const response = await server.inject({
    method: 'POST',
    url: '/api/groups/2/pick',
    payload: { releaseId: 1 },
  });
  assert.equal(response.statusCode, 400);
  await server.close();
  db.close();
});

test('a malformed pick body is a 400', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  const response = await server.inject({
    method: 'POST',
    url: '/api/groups/1/pick',
    payload: { releaseId: 'not-a-number' },
  });
  assert.equal(response.statusCode, 400);
  await server.close();
  db.close();
});

test('downloads merges tracked rows with the untracked snapshot', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const untracked: UntrackedEntry[] = [
    { ref: 'foreign', name: 'Someone Elses', state: 'downloading', percentage: 33 },
  ];
  const server = buildServer(deps(db, untracked));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });

  const body = (await server.inject({ method: 'GET', url: '/api/downloads' })).json();

  assert.equal(body['tracked'].length, 1);
  assert.equal(body['tracked'][0]['title'], 'Alpha');
  assert.equal(body['untracked'].length, 1);
  assert.equal(body['untracked'][0]['name'], 'Someone Elses');
  await server.close();
  db.close();
});

test('retrying a failed import resumes at completed', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  db.prepare(
    "UPDATE downloads SET status = 'failed', error = 'disk full', storage_path = '/x' WHERE id = 1",
  ).run();

  const response = await server.inject({ method: 'POST', url: '/api/downloads/1/retry' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json()['status'], 'completed');
  await server.close();
  db.close();
});

test('retrying an unknown download is a 404', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));
  const response = await server.inject({ method: 'POST', url: '/api/downloads/999/retry' });
  assert.equal(response.statusCode, 404);
  await server.close();
  db.close();
});

test('no route ever returns the client api key', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  for (const url of ['/api/browse', '/api/picks', '/api/downloads', '/api/health']) {
    const body = (await server.inject({ method: 'GET', url })).body;
    assert.doesNotMatch(body, /apiKey|apikey/);
  }
  await server.close();
  db.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/http/server.ts`.

- [ ] **Step 4: Write the view mappers**

`packages/core/src/http/views.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, QualityTokens } from '@pickarr/plugin-api';
import type { GroupRow } from '../db/groups.ts';
import { releasesForGroup } from '../db/releases.ts';
import type { DownloadRow } from '../db/downloads.ts';
import type { UntrackedEntry } from '../pipeline/reconcile.ts';

export interface ReleaseView {
  id: number;
  score: number;
  quality: QualityTokens;
  releaseName: string;
  publishedAt: number | null;
}

export interface GroupView {
  id: number;
  plugin: string;
  display: DisplayFields;
  state: 'new' | 'picked';
  pickedReleaseId: number | null;
  upgradeReleaseId: number | null;
  listRankAt: number;
  releases: ReleaseView[];
}

export interface BrowseResponse {
  groups: GroupView[];
  nextCursor: string | null;
}

export interface DownloadView {
  id: number;
  groupId: number;
  releaseId: number;
  title: string;
  kind: 'initial' | 'upgrade';
  status: string;
  error: string | null;
  attempts: number;
  updatedAt: number;
}

export interface DownloadsResponse {
  tracked: DownloadView[];
  untracked: UntrackedEntry[];
}

export function toGroupView(db: DatabaseSync, group: GroupRow): GroupView {
  const releases = releasesForGroup(db, group.id).map((release) => {
    const feedItem = db
      .prepare('SELECT raw_title, published_at FROM feed_items WHERE id = ?')
      .get(release.feedItemId);
    return {
      id: release.id,
      score: release.score,
      quality: JSON.parse(release.quality) as QualityTokens,
      releaseName: feedItem === undefined ? '' : String(feedItem['raw_title']),
      publishedAt:
        feedItem === undefined || feedItem['published_at'] === null
          ? null
          : Number(feedItem['published_at']),
    };
  });

  return {
    id: group.id,
    plugin: group.plugin,
    display: JSON.parse(group.display) as DisplayFields,
    state: group.state,
    pickedReleaseId: group.pickedReleaseId,
    upgradeReleaseId: group.upgradeReleaseId,
    listRankAt: group.listRankAt,
    releases,
  };
}

export function toDownloadView(db: DatabaseSync, download: DownloadRow): DownloadView {
  const group = db.prepare('SELECT display FROM media_groups WHERE id = ?').get(download.groupId);
  const display =
    group === undefined
      ? { title: `Group ${download.groupId}`, fields: [] }
      : (JSON.parse(String(group['display'])) as DisplayFields);

  return {
    id: download.id,
    groupId: download.groupId,
    releaseId: download.releaseId,
    title: display.title,
    kind: download.kind,
    status: download.status,
    error: download.error,
    attempts: download.attempts,
    updatedAt: download.updatedAt,
  };
}
```

- [ ] **Step 5: Write the server**

`packages/core/src/http/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { DownloadClient } from '../clients/types.ts';
import { browseGroups, getGroup, pickedGroups } from '../db/groups.ts';
import { allDownloads, getDownload, resetForRetry } from '../db/downloads.ts';
import { pickRelease } from '../pipeline/pick.ts';
import type { UntrackedEntry } from '../pipeline/reconcile.ts';
import { toDownloadView, toGroupView, type BrowseResponse } from './views.ts';

export interface ServerDeps {
  db: DatabaseSync;
  defaultClient: DownloadClient;
  untrackedFor(clientId: string): UntrackedEntry[];
  now(): number;
  /** Absolute path to the built SPA, or null to run API-only. */
  webRoot: string | null;
}

const browseQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().min(1).optional(),
});

const pickBodySchema = z.object({ releaseId: z.number().int().positive() });
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

function parseCursor(raw: string | undefined): { listRankAt: number; id: number } | null {
  if (raw === undefined) return null;
  const [rank, id] = raw.split(':');
  const listRankAt = Number(rank);
  const groupId = Number(id);
  if (!Number.isFinite(listRankAt) || !Number.isFinite(groupId)) return null;
  return { listRankAt, id: groupId };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });
  const { db } = deps;

  server.get('/api/health', async () => ({ status: 'ok' }));

  server.get('/api/browse', async (request, reply) => {
    const query = browseQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });

    const groups = browseGroups(db, {
      cursor: parseCursor(query.data.cursor),
      limit: query.data.limit,
      search: query.data.q ?? null,
    });

    const last = groups.at(-1);
    const response: BrowseResponse = {
      groups: groups.map((group) => toGroupView(db, group)),
      nextCursor:
        groups.length === query.data.limit && last !== undefined
          ? `${last.listRankAt}:${last.id}`
          : null,
    };
    return response;
  });

  server.get('/api/picks', async () => ({
    groups: pickedGroups(db).map((group) => toGroupView(db, group)),
  }));

  server.post('/api/groups/:id/pick', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = pickBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const group = getGroup(db, params.data.id);
    if (group === null) return reply.code(404).send({ error: 'No such group' });

    const kind = group.state === 'picked' ? 'upgrade' : 'initial';
    try {
      const download = await pickRelease(
        db,
        deps.defaultClient,
        { groupId: params.data.id, releaseId: body.data.releaseId, kind },
        deps.now(),
      );
      return toDownloadView(db, download);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  server.get('/api/downloads', async () => ({
    tracked: allDownloads(db).map((download) => toDownloadView(db, download)),
    untracked: deps.untrackedFor(deps.defaultClient.id),
  }));

  server.post('/api/downloads/:id/retry', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });
    if (getDownload(db, params.data.id) === null) {
      return reply.code(404).send({ error: 'No such download' });
    }

    const download = resetForRetry(db, params.data.id, deps.now());
    if (download === null) return reply.code(404).send({ error: 'No such download' });
    return toDownloadView(db, download);
  });

  if (deps.webRoot !== null) {
    void server.register(fastifyStatic, { root: deps.webRoot });
    // Any non-API path is a client route; hand back the SPA shell.
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return server;
}
```

- [ ] **Step 6: Write the boot sequence**

`packages/core/src/main.ts`:

```ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/load.ts';
import { openDatabase } from './db/open.ts';
import { loadPlugins } from './plugins/registry.ts';
import { createSabnzbdClient } from './clients/sabnzbd.ts';
import type { DownloadClient } from './clients/types.ts';
import { fetchFeed } from './feeds/fetch-feed.ts';
import { ingestEntries } from './ingest/ingest.ts';
import { reconcileClient } from './pipeline/reconcile.ts';
import { importDownload } from './pipeline/import.ts';
import { recoverInterruptedWork } from './pipeline/recover.ts';
import { createScheduler } from './pipeline/scheduler.ts';
import { buildServer } from './http/server.ts';

const CONFIG_PATH = process.env['PICKARR_CONFIG'] ?? '/config/config.json';

function log(message: string): void {
  console.log(`[pickarr] ${message}`);
}

async function main(): Promise<void> {
  const config = await loadConfig(CONFIG_PATH);
  const db = openDatabase(config.database.path);
  const registry = await loadPlugins(config);

  const clients = new Map<string, DownloadClient>();
  for (const clientConfig of config.downloadClients) {
    clients.set(clientConfig.id, createSabnzbdClient(clientConfig));
  }

  const defaultClient = clients.get(config.downloadClients[0]!.id)!;

  const recovery = recoverInterruptedWork(db, Date.now());
  log(
    `recovery: ${recovery.importsReset} imports reset, ${recovery.pendingAddUrl} awaiting addurl`,
  );

  const scheduler = createScheduler({
    db,
    feeds: config.feeds,
    clientIds: [...clients.keys()],
    log,
    ingestFeed: async (feed) => {
      const plugin = registry.byPackage(feed.plugin);
      return ingestEntries(db, plugin, feed, await fetchFeed(feed), Date.now());
    },
    reconcile: async (clientId) => {
      const client = clients.get(clientId);
      if (client === undefined) throw new Error(`No such client: ${clientId}`);
      return reconcileClient({
        db,
        client,
        now: () => Date.now(),
        importDownload: (download) =>
          importDownload(
            {
              db,
              registry,
              importMode: client.importMode,
              trashDir: config.trashDir,
              now: () => Date.now(),
            },
            download,
          ),
      });
    },
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = process.env['PICKARR_WEB_ROOT'] ?? resolve(join(here, 'web'));

  const server = buildServer({
    db,
    defaultClient,
    untrackedFor: (clientId) => scheduler.untrackedFor(clientId),
    now: () => Date.now(),
    webRoot,
  });

  await server.listen({ port: config.server.port, host: '0.0.0.0' });
  log(`listening on ${config.server.port}`);

  scheduler.start();
  void scheduler.ingestAllNow();
  void scheduler.reconcileNow();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log(`${signal} received, shutting down`);
      scheduler.stop();
      void server.close().then(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}

main().catch((error: Error) => {
  console.error(`[pickarr] fatal: ${error.message}`);
  process.exit(1);
});
```

- [ ] **Step 7: Run the check**

Run: `npm run check`
Expected: all eleven server tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): add HTTP API and application boot sequence"
```

---

### Task 17: Web SPA

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/index.html`
- Create: `packages/web/src/api/client.ts`, `packages/web/src/api/format.ts`, `packages/web/src/components/{MediaCard,ReleaseRow,DownloadRow}.tsx`, `packages/web/src/routes/{Browse,Picks,Downloads}.tsx`, `packages/web/src/App.tsx`, `packages/web/src/main.tsx`, `packages/web/src/styles.css`
- Create: `packages/web/test/setup.ts`
- Modify: root `package.json` (split the test script)
- Test: `packages/web/test/format.test.ts`, `packages/web/test/MediaCard.test.tsx`, `packages/web/test/Downloads.test.tsx`

**Interfaces:**
- Consumes: the response shapes from Task 16 — `GroupView`, `ReleaseView`, `BrowseResponse`, `DownloadView`, `DownloadsResponse`. The client re-declares them structurally rather than importing from `@pickarr/core`, because the SPA must not depend on the server package.
- Produces: the built static bundle that Task 16's `webRoot` serves.

- [ ] **Step 1: Split the test script**

In the root `package.json`, replace `test` with three scripts. The server glob matches `.ts` and the web glob matches `.tsx`, so they partition cleanly:

```json
    "test:server": "node --import tsx --conditions development --test \"packages/*/test/**/*.test.ts\"",
    "test:web": "node --import tsx --import ./packages/web/test/setup.ts --conditions development --test \"packages/web/test/**/*.test.tsx\"",
    "test": "npm run test:server && npm run test:web",
```

Node's built-in type stripping cannot handle `.tsx` — JSX is not TypeScript syntax. The `tsx` loader transpiles both, which is why it is the loader for every test.

- [ ] **Step 2: Create the package and its config**

`packages/web/package.json`:

```json
{
  "name": "@pickarr/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build", "typecheck": "tsgo --noEmit -p tsconfig.json" },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router": "^7.1.0"
  },
  "devDependencies": {
    "@happy-dom/global-registrator": "^16.0.0",
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0"
  }
}
```

`packages/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["es2023", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "types": ["react", "react-dom"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts", "test/**/*.tsx"]
}
```

This is the package that justifies per-package typechecking: `web` needs DOM
libs and JSX, and `core` must not have them — a server file that reaches for
`document` should fail to compile.

`packages/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8080' } },
});
```

`packages/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pickarr</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/web/test/setup.ts`:

```ts
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
```

- [ ] **Step 3: Write the failing formatting test**

`packages/web/test/format.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQuality, formatBytes } from '../src/api/format.ts';

test('formats the tokens that are present, in a stable order', () => {
  assert.equal(
    formatQuality({ resolution: 1080, source: 'web-dl', videoCodec: 'h265', releaseGroup: 'WRB' }),
    '1080p · web-dl · h265 · WRB',
  );
});

test('omits absent tokens without leaving separators', () => {
  assert.equal(formatQuality({ resolution: 2160 }), '2160p');
  assert.equal(formatQuality({ source: 'bluray' }), 'bluray');
});

test('an empty token set reads as unknown', () => {
  assert.equal(formatQuality({}), 'unknown quality');
});

test('formats sizes in binary units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(5_368_709_120), '5.0 GiB');
});
```

- [ ] **Step 4: Write the failing component tests**

`packages/web/test/MediaCard.test.tsx`:

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MediaCard } from '../src/components/MediaCard.tsx';
import type { GroupView } from '../src/api/client.ts';

const GROUP: GroupView = {
  id: 1,
  plugin: 'scenes',
  display: {
    title: 'Alex Coal',
    subtitle: 'Brazzers',
    date: '2023-04-15',
    fields: [{ label: 'Site', value: 'Brazzers' }],
  },
  state: 'new',
  pickedReleaseId: null,
  upgradeReleaseId: null,
  listRankAt: 100,
  releases: [
    { id: 2, score: 2160, quality: { resolution: 2160 }, releaseName: 'R2', publishedAt: null },
    { id: 1, score: 1080, quality: { resolution: 1080 }, releaseName: 'R1', publishedAt: null },
  ],
};

test('renders the display fields', () => {
  render(<MediaCard group={GROUP} onPick={() => {}} />);
  assert.ok(screen.getByText('Alex Coal'));
  assert.ok(screen.getByText('Brazzers'));
  assert.ok(screen.getByText('2023-04-15'));
  cleanup();
});

test('shows one pick control per release, best first', () => {
  render(<MediaCard group={GROUP} onPick={() => {}} />);
  const buttons = screen.getAllByRole('button', { name: /pick/i });
  assert.equal(buttons.length, 2);
  assert.ok(screen.getByText(/2160p/));
  cleanup();
});

test('picking a release reports its id', () => {
  const picked: number[] = [];
  render(<MediaCard group={GROUP} onPick={(releaseId) => picked.push(releaseId)} />);
  fireEvent.click(screen.getAllByRole('button', { name: /pick/i })[0]!);
  assert.deepEqual(picked, [2]);
  cleanup();
});

test('an upgrade-flagged group is badged', () => {
  render(
    <MediaCard
      group={{ ...GROUP, state: 'picked', pickedReleaseId: 1, upgradeReleaseId: 2 }}
      onPick={() => {}}
    />,
  );
  assert.ok(screen.getByText(/upgrade available/i));
  cleanup();
});

test('the release you already own is marked and not offered again', () => {
  render(
    <MediaCard
      group={{ ...GROUP, state: 'picked', pickedReleaseId: 1, upgradeReleaseId: 2 }}
      onPick={() => {}}
    />,
  );
  assert.ok(screen.getByText(/current/i));
  assert.equal(screen.getAllByRole('button', { name: /pick/i }).length, 1);
  cleanup();
});
```

`packages/web/test/Downloads.test.tsx`:

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { DownloadRow } from '../src/components/DownloadRow.tsx';
import { Downloads } from '../src/routes/Downloads.tsx';
import type { DownloadsResponse } from '../src/api/client.ts';

test('a tracked row shows status and offers retry only when failed', () => {
  const { rerender } = render(
    <DownloadRow
      download={{
        id: 1,
        groupId: 1,
        releaseId: 1,
        title: 'Alex Coal',
        kind: 'initial',
        status: 'downloading',
        error: null,
        attempts: 0,
        updatedAt: 1,
      }}
      onRetry={() => {}}
    />,
  );
  assert.equal(screen.queryByRole('button', { name: /retry/i }), null);

  rerender(
    <DownloadRow
      download={{
        id: 1,
        groupId: 1,
        releaseId: 1,
        title: 'Alex Coal',
        kind: 'initial',
        status: 'failed',
        error: 'disk full',
        attempts: 1,
        updatedAt: 1,
      }}
      onRetry={() => {}}
    />,
  );
  assert.ok(screen.getByRole('button', { name: /retry/i }));
  assert.ok(screen.getByText(/disk full/));
  cleanup();
});

test('untracked entries render inert and labelled', async () => {
  const body: DownloadsResponse = {
    tracked: [],
    untracked: [{ ref: 'x', name: 'Someone Elses', state: 'downloading', percentage: 40 }],
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  render(<Downloads />);

  await waitFor(() => assert.ok(screen.getByText('Someone Elses')));
  assert.ok(screen.getByText(/not managed by pickarr/i));
  assert.equal(screen.queryByRole('button', { name: /retry/i }), null);
  cleanup();
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the web modules do not exist.

- [ ] **Step 6: Implement the API client and formatters**

`packages/web/src/api/client.ts`:

```ts
export interface DisplayField {
  label: string;
  value: string;
}

export interface DisplayFields {
  title: string;
  subtitle?: string;
  date?: string;
  fields: DisplayField[];
}

export interface QualityTokens {
  resolution?: number;
  source?: string;
  videoCodec?: string;
  audioCodec?: string;
  bitrateKbps?: number;
  sizeBytes?: number;
  releaseGroup?: string;
}

export interface ReleaseView {
  id: number;
  score: number;
  quality: QualityTokens;
  releaseName: string;
  publishedAt: number | null;
}

export interface GroupView {
  id: number;
  plugin: string;
  display: DisplayFields;
  state: 'new' | 'picked';
  pickedReleaseId: number | null;
  upgradeReleaseId: number | null;
  listRankAt: number;
  releases: ReleaseView[];
}

export interface BrowseResponse {
  groups: GroupView[];
  nextCursor: string | null;
}

export interface PicksResponse {
  groups: GroupView[];
}

export interface DownloadView {
  id: number;
  groupId: number;
  releaseId: number;
  title: string;
  kind: 'initial' | 'upgrade';
  status: string;
  error: string | null;
  attempts: number;
  updatedAt: number;
}

export interface UntrackedEntry {
  ref: string;
  name: string;
  state: 'downloading' | 'completed' | 'failed';
  percentage: number | null;
}

export interface DownloadsResponse {
  tracked: DownloadView[];
  untracked: UntrackedEntry[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body: { error?: string } = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request to ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  browse: (cursor: string | null, search: string) => {
    const params = new URLSearchParams();
    if (cursor !== null) params.set('cursor', cursor);
    if (search.length > 0) params.set('q', search);
    return request<BrowseResponse>(`/api/browse?${params.toString()}`);
  },
  picks: () => request<PicksResponse>('/api/picks'),
  downloads: () => request<DownloadsResponse>('/api/downloads'),
  pick: (groupId: number, releaseId: number) =>
    request<DownloadView>(`/api/groups/${groupId}/pick`, {
      method: 'POST',
      body: JSON.stringify({ releaseId }),
    }),
  retry: (downloadId: number) =>
    request<DownloadView>(`/api/downloads/${downloadId}/retry`, { method: 'POST' }),
};
```

`packages/web/src/api/format.ts`:

```ts
import type { QualityTokens } from './client.ts';

export function formatQuality(quality: QualityTokens): string {
  const parts: string[] = [];
  if (quality.resolution !== undefined) parts.push(`${quality.resolution}p`);
  if (quality.source !== undefined) parts.push(quality.source);
  if (quality.videoCodec !== undefined) parts.push(quality.videoCodec);
  if (quality.releaseGroup !== undefined) parts.push(quality.releaseGroup);
  return parts.length === 0 ? 'unknown quality' : parts.join(' · ');
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
```

- [ ] **Step 7: Implement the components**

`packages/web/src/components/ReleaseRow.tsx`:

```tsx
import type { ReleaseView } from '../api/client.ts';
import { formatQuality, formatBytes } from '../api/format.ts';

interface Props {
  release: ReleaseView;
  isCurrent: boolean;
  onPick(releaseId: number): void;
}

export function ReleaseRow({ release, isCurrent, onPick }: Props) {
  return (
    <li className="release-row">
      <span className="release-quality">{formatQuality(release.quality)}</span>
      {release.quality.sizeBytes !== undefined && (
        <span className="release-size">{formatBytes(release.quality.sizeBytes)}</span>
      )}
      <span className="release-name" title={release.releaseName}>
        {release.releaseName}
      </span>
      {isCurrent ? (
        <span className="release-current">Current</span>
      ) : (
        <button type="button" onClick={() => onPick(release.id)}>
          Pick
        </button>
      )}
    </li>
  );
}
```

`packages/web/src/components/MediaCard.tsx`:

```tsx
import type { GroupView } from '../api/client.ts';
import { ReleaseRow } from './ReleaseRow.tsx';

interface Props {
  group: GroupView;
  onPick(releaseId: number): void;
}

/**
 * One card renders every media type. Plugins supply display fields, never UI.
 */
export function MediaCard({ group, onPick }: Props) {
  const { display } = group;
  return (
    <article className="media-card">
      <header>
        <h2>{display.title}</h2>
        {display.subtitle !== undefined && <p className="subtitle">{display.subtitle}</p>}
        {display.date !== undefined && <p className="date">{display.date}</p>}
        {group.upgradeReleaseId !== null && <span className="badge">Upgrade available</span>}
      </header>

      <dl className="fields">
        {display.fields.map((field) => (
          <div key={field.label}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>

      <ul className="releases">
        {group.releases.map((release) => (
          <ReleaseRow
            key={release.id}
            release={release}
            isCurrent={release.id === group.pickedReleaseId}
            onPick={onPick}
          />
        ))}
      </ul>
    </article>
  );
}
```

`packages/web/src/components/DownloadRow.tsx`:

```tsx
import type { DownloadView } from '../api/client.ts';

interface Props {
  download: DownloadView;
  onRetry(downloadId: number): void;
}

export function DownloadRow({ download, onRetry }: Props) {
  return (
    <li className={`download-row status-${download.status}`}>
      <span className="download-title">{download.title}</span>
      <span className="download-kind">{download.kind}</span>
      <span className="download-status">{download.status}</span>
      {download.error !== null && <span className="download-error">{download.error}</span>}
      {download.status === 'failed' && (
        <button type="button" onClick={() => onRetry(download.id)}>
          Retry
        </button>
      )}
    </li>
  );
}
```

- [ ] **Step 8: Implement the routes and shell**

`packages/web/src/routes/Downloads.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api, type DownloadsResponse } from '../api/client.ts';
import { DownloadRow } from '../components/DownloadRow.tsx';

const POLL_MS = 3000;

/**
 * Polls while mounted. Deliberately not SSE: a useEffect beats a subscription
 * protocol, a reconnect story, and a broadcast bus for one screen.
 */
export function Downloads() {
  const [data, setData] = useState<DownloadsResponse>({ tracked: [], untracked: [] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const next = await api.downloads();
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function retry(downloadId: number): Promise<void> {
    await api.retry(downloadId);
    setData(await api.downloads());
  }

  return (
    <section>
      <h1>Downloads</h1>
      {error !== null && <p className="error">{error}</p>}

      <ul className="downloads">
        {data.tracked.map((download) => (
          <DownloadRow key={download.id} download={download} onRetry={(id) => void retry(id)} />
        ))}
      </ul>

      {data.untracked.length > 0 && (
        <>
          <h2>Not managed by Pickarr</h2>
          <ul className="downloads untracked">
            {data.untracked.map((entry) => (
              <li key={entry.ref} className="download-row untracked">
                <span className="download-title">{entry.name}</span>
                <span className="download-status">{entry.state}</span>
                {entry.percentage !== null && <span>{entry.percentage}%</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
```

`packages/web/src/routes/Browse.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { api, type GroupView } from '../api/client.ts';
import { MediaCard } from '../components/MediaCard.tsx';

export function Browse() {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (from: string | null, term: string, replace: boolean): Promise<void> => {
      try {
        const page = await api.browse(from, term);
        setGroups((previous) => (replace ? page.groups : [...previous, ...page.groups]));
        setCursor(page.nextCursor);
        setDone(page.nextCursor === null);
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [],
  );

  useEffect(() => {
    void loadPage(null, search, true);
  }, [loadPage, search]);

  async function pick(groupId: number, releaseId: number): Promise<void> {
    try {
      await api.pick(groupId, releaseId);
      // Refetch rather than patch: picking can remove the group from this list.
      await loadPage(null, search, true);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return (
    <section>
      <h1>Browse</h1>
      <input
        type="search"
        placeholder="Search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {error !== null && <p className="error">{error}</p>}

      {groups.map((group) => (
        <MediaCard
          key={group.id}
          group={group}
          onPick={(releaseId) => void pick(group.id, releaseId)}
        />
      ))}

      {!done && (
        <button type="button" onClick={() => void loadPage(cursor, search, false)}>
          Load more
        </button>
      )}
    </section>
  );
}
```

`packages/web/src/routes/Picks.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api, type GroupView } from '../api/client.ts';
import { MediaCard } from '../components/MediaCard.tsx';

export function Picks() {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function reload(): Promise<void> {
    try {
      setGroups((await api.picks()).groups);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function pick(groupId: number, releaseId: number): Promise<void> {
    try {
      await api.pick(groupId, releaseId);
      await reload();
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return (
    <section>
      <h1>Picks</h1>
      {error !== null && <p className="error">{error}</p>}
      {groups.map((group) => (
        <MediaCard
          key={group.id}
          group={group}
          onPick={(releaseId) => void pick(group.id, releaseId)}
        />
      ))}
    </section>
  );
}
```

`packages/web/src/App.tsx`:

```tsx
import { NavLink, Route, Routes } from 'react-router';
import { Browse } from './routes/Browse.tsx';
import { Picks } from './routes/Picks.tsx';
import { Downloads } from './routes/Downloads.tsx';

export function App() {
  return (
    <div className="app">
      <nav>
        <NavLink to="/">Browse</NavLink>
        <NavLink to="/picks">Picks</NavLink>
        <NavLink to="/downloads">Downloads</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Browse />} />
          <Route path="/picks" element={<Picks />} />
          <Route path="/downloads" element={<Downloads />} />
        </Routes>
      </main>
    </div>
  );
}
```

`packages/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('No #root element in the document');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

`packages/web/src/styles.css` — enough to make the list readable:

```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; }
.app { max-width: 60rem; margin: 0 auto; padding: 1rem; }
nav { display: flex; gap: 1rem; padding-bottom: 1rem; }
nav a { text-decoration: none; }
nav a.active { font-weight: 600; text-decoration: underline; }
.media-card { border: 1px solid currentColor; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; opacity: 0.95; }
.media-card h2 { margin: 0; font-size: 1.1rem; }
.subtitle, .date { margin: 0.1rem 0; opacity: 0.7; font-size: 0.9rem; }
.badge { display: inline-block; margin-top: 0.4rem; padding: 0.1rem 0.5rem; border-radius: 0.25rem; background: #b45309; color: white; font-size: 0.8rem; }
.fields { display: flex; gap: 1rem; flex-wrap: wrap; margin: 0.5rem 0; font-size: 0.85rem; }
.fields dt { opacity: 0.6; }
.fields dd { margin: 0; }
.releases, .downloads { list-style: none; margin: 0; padding: 0; }
.release-row, .download-row { display: flex; gap: 0.75rem; align-items: center; padding: 0.35rem 0; border-top: 1px solid rgb(from currentColor r g b / 20%); font-size: 0.9rem; }
.release-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.6; }
.release-current { font-weight: 600; }
.download-row.untracked { opacity: 0.5; font-style: italic; }
.download-error, .error { color: #b91c1c; }
```

- [ ] **Step 9: Run the check**

Run: `npm run check`
Expected: all four formatting tests and all seven component tests PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(web): add browse, picks, and downloads UI"
```

---

### Task 18: Docker packaging

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.example.yml`, `config.example.json`
- Modify: root `package.json` (add the `build` script), `README.md`

**Interfaces:**
- Consumes: the `build` script in every package, and `PICKARR_CONFIG` / `PICKARR_WEB_ROOT` from Task 16's `main.ts`.
- Produces: a runnable image. This task's verification is an actual container run, not a unit test.

- [ ] **Step 1: Add the root build script**

In the root `package.json` scripts, add:

```json
    "build": "npm run build -w @pickarr/plugin-api -w @pickarr/plugin-scenes -w @pickarr/core -w @pickarr/web",
```

Build order matters: `core` and `plugin-scenes` resolve `@pickarr/plugin-api` through its `default` export condition, which points at `dist/`. Listing the workspaces in dependency order is what makes that file exist first.

- [ ] **Step 2: Write the example config**

`config.example.json`:

```json
{
  "server": { "port": 8080 },
  "database": { "path": "/config/pickarr.db" },
  "trashDir": "/data/trash",
  "plugins": {
    "@pickarr/plugin-scenes": { "libraryRoot": "/media/scenes" }
  },
  "downloadClients": [
    {
      "id": "sab",
      "type": "sabnzbd",
      "url": "http://sabnzbd:8080",
      "apiKey": "file:/run/secrets/sabnzbd_api_key",
      "category": "pickarr",
      "importMode": "move",
      "pathMappings": [{ "from": "/downloads", "to": "/data/downloads" }]
    }
  ],
  "feeds": [
    {
      "id": "primary",
      "url": "https://your-indexer.example/rss?t=6000&apikey=...",
      "plugin": "@pickarr/plugin-scenes",
      "intervalSeconds": 900
    }
  ]
}
```

- [ ] **Step 3: Write the Dockerfile and .dockerignore**

`.dockerignore`:

```
node_modules
**/node_modules
**/dist
.git
docs
*.db
*.db-wal
*.db-shm
```

`Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app

# Manifests first so dependency installation caches independently of source.
COPY package.json package-lock.json tsconfig.base.json .oxlintrc.json ./
COPY packages/plugin-api/package.json   packages/plugin-api/
COPY packages/plugin-scenes/package.json packages/plugin-scenes/
COPY packages/core/package.json          packages/core/
COPY packages/web/package.json           packages/web/
RUN npm ci

COPY . .
RUN npm run lint && npm run typecheck && npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/plugin-api/package.json    packages/plugin-api/
COPY packages/plugin-scenes/package.json packages/plugin-scenes/
COPY packages/core/package.json          packages/core/

# @pickarr/web is deliberately excluded: it ships as prebuilt static assets, so
# react and vite have no business in the runtime image.
RUN npm ci --omit=dev \
      --include-workspace-root \
      --workspace @pickarr/plugin-api \
      --workspace @pickarr/plugin-scenes \
      --workspace @pickarr/core \
    && npm cache clean --force

COPY --from=build /app/packages/plugin-api/dist    packages/plugin-api/dist
COPY --from=build /app/packages/plugin-scenes/dist packages/plugin-scenes/dist
COPY --from=build /app/packages/core/dist          packages/core/dist
COPY --from=build /app/packages/web/dist           packages/core/dist/web

ENV PICKARR_CONFIG=/config/config.json
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PICKARR_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/core/dist/main.js"]
```

`main.ts` resolves its web root relative to its own location, so `packages/core/dist/web` is exactly where it looks.

- [ ] **Step 4: Write the compose example**

`docker-compose.example.yml`:

```yaml
services:
  pickarr:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./config:/config
      - /srv/downloads:/data/downloads
      - /srv/media/scenes:/media/scenes
      - /srv/trash:/data/trash
    secrets:
      - sabnzbd_api_key
    restart: unless-stopped

secrets:
  sabnzbd_api_key:
    file: ./secrets/sabnzbd_api_key
```

Compose mounts each secret at `/run/secrets/<name>`, which is exactly what the config's `file:` indirection expects. The secret never enters the environment, so it cannot leak through `docker inspect` or a crash dump of `process.env`.

- [ ] **Step 5: Build the image**

```bash
docker build -t pickarr:dev .
```

Expected: the build stage runs lint, typecheck, and every package build, and the final image is produced. A failure here means the build stage caught something `npm run check` did not — most likely a missing file in a package's `build` script.

- [ ] **Step 6: Verify the container actually boots**

```bash
mkdir -p /tmp/pickarr-smoke/config /tmp/pickarr-smoke/secrets
printf 'not-a-real-key' > /tmp/pickarr-smoke/secrets/sabnzbd_api_key
sed 's#/run/secrets/sabnzbd_api_key#/run/secrets/sabnzbd_api_key#' config.example.json \
  > /tmp/pickarr-smoke/config/config.json

docker run --rm -d --name pickarr-smoke \
  -p 8099:8080 \
  -v /tmp/pickarr-smoke/config:/config \
  -v /tmp/pickarr-smoke/secrets:/run/secrets:ro \
  pickarr:dev

sleep 3
curl -fsS http://localhost:8099/api/health
curl -fsS http://localhost:8099/api/browse
curl -fsSI http://localhost:8099/ | head -1
docker logs pickarr-smoke
docker stop pickarr-smoke
```

Expected: `/api/health` returns `{"status":"ok"}`, `/api/browse` returns `{"groups":[],"nextCursor":null}`, and `/` returns `200` with the SPA shell. The logs will show a failed feed fetch against the placeholder indexer URL — that is correct behavior, not a defect: one bad feed logs and waits for the next tick.

- [ ] **Step 7: Clean up the smoke test**

```bash
rm -rf /tmp/pickarr-smoke
```

- [ ] **Step 8: Update the README**

Replace `README.md` with a short operator-facing document covering:

- What Pickarr does and how it differs from the *arr tools.
- Quick start: `cp config.example.json config/config.json`, put the SABnzbd key in `secrets/sabnzbd_api_key`, `docker compose up`.
- A table of config fields, including that `importMode` belongs to the download client.
- **No authentication.** Pickarr belongs behind a reverse proxy or on a LAN.
- **Pickarr never empties `trashDir`.** Superseded files accumulate there until you delete them; reclaiming that space is deliberately a manual operation, since it is the only destructive one in the system.
- A pointer to `docs/superpowers/specs/2026-08-04-pickarr-design.md` for the design rationale.

- [ ] **Step 9: Run the full check one more time**

Run: `npm run check && npm run build`
Expected: everything green.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: add Docker packaging, compose example, and README"
```

---

## Done

At this point Pickarr does the whole MVP loop: it polls a feed, collates releases into pickable groups, shows them newest-rank first, sends a pick to SABnzbd, watches the category, imports the completed file into the library, and flags-and-bumps a group when something better turns up.

Things the spec deliberately left out, for reference when picking up the next piece: authentication, library scanning, retention, torrent clients, and remote metadata lookup. The natural first follow-up is remote metadata resolution in the scenes plugin — `identityKey` was shaped so that can land without a schema migration.
