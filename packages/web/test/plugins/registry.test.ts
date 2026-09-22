/**
 * `src/plugins/registry.ts` is the one place `packages/web` names a plugin,
 * and these tests are what make that a fact rather than an intention.
 *
 * A `.ts` file, so it runs under `npm run test:server`'s glob alongside
 * `bundle.test.ts` -- neither needs a DOM, and `npm run test:web`'s glob
 * only takes `.test.tsx`. Both are reached by `npm run check`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BROWSER_PLUGINS, pluginFor } from '../../src/plugins/registry.ts';

const SRC = join(import.meta.dirname, '../../src');

/** Every `.ts`/`.tsx` file under `dir`, recursively. Absolute paths. */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [path] : [];
    }),
  );
  return nested.flat();
}

/** Each source file under `src`, paired with its text. */
async function sources(): Promise<readonly (readonly [string, string])[]> {
  const files = await sourceFiles(SRC);
  return Promise.all(files.map(async (file) => [file, await readFile(file, 'utf8')] as const));
}

test('no plugin id is spelled in packages/web/src outside the registry', async () => {
  // The registry is the seam's whole point. A second place naming `tv`
  // makes adding a plugin two edits again, silently.
  //
  // **The ids come from the registry, so a fourth plugin is scanned
  // without editing this test.** That makes this one weak against a
  // registry mutated to hold nothing -- which is why the test below
  // spells all three out, and why the two belong together.
  //
  // **Comments count.** A docblock naming `tv` goes stale exactly the way
  // code does, and this repo's own hazard list is about prose that stopped
  // being true. Two comments were reworded rather than exempted when this
  // landed: `store/rows.ts`'s measured `listByTablePlugin` example, and
  // `settings/AddFeed.tsx`'s default-plugin fallback.
  //
  // **There is no exemption list, and adding one is a decision, not a
  // fix.** If a literal id ever becomes genuinely unavoidable -- a route
  // path that cannot be derived, say -- name the file and the reason here
  // rather than loosening the match; a substring match would pass on the
  // very drift this exists to catch.
  const ids = BROWSER_PLUGINS.map((plugin) => plugin.id);
  assert.ok(ids.length > 0, 'the registry is empty, so this test would scan for nothing');

  const offenders: string[] = [];
  for (const [file, text] of await sources()) {
    if (file.endsWith(join('plugins', 'registry.ts'))) continue;
    for (const id of ids) {
      if (new RegExp(`['"\`]${id}['"\`]`).test(text)) offenders.push(`${file}: ${id}`);
    }
  }
  assert.deepEqual(offenders, [], 'a plugin id is spelled outside the registry');
});

test("web's src imports each plugin's /browser subpath, never its package root", async () => {
  // Design spec acceptance 6, and the one failure on this branch that
  // breaks the production build while every unit test passes: a root
  // import reaches `node:sqlite` through `@pickarr/openmetadata` ->
  // `drizzle-orm`, and `npm run build` fails with `"DatabaseSync" is not
  // exported by "__vite-browser-external"`. `npm run typecheck` does not
  // see it.
  //
  // `bundle.test.ts` is the other half and asserts over the built artifact,
  // which is stronger -- it catches a root import arriving through any
  // path, not only a literal specifier. It also skips when nothing has been
  // built, and `npm run check` never builds. This half needs no build.
  //
  // **`@pickarr/plugin-ui` is exempt, by name and deliberately.** It is the
  // seam package itself: it has no `index.ts` reaching a lookup service, no
  // `node:` import anywhere in its graph, and no `/browser` subpath to
  // prefer -- `packages/plugin-ui/package.json` exports its root and
  // nothing else. Task 1 pinned that its root import bundles clean.
  const ROOT_IMPORT = /from\s+'(@pickarr\/plugin-[a-z0-9-]+)'/g;
  const offenders: string[] = [];
  for (const [file, text] of await sources()) {
    for (const [, specifier] of text.matchAll(ROOT_IMPORT)) {
      if (specifier !== '@pickarr/plugin-ui') offenders.push(`${file}: ${specifier ?? ''}`);
    }
  }
  assert.deepEqual(offenders, [], "import the plugin's /browser subpath, not its package root");
});

test('the registry holds the three shipped plugins, with the ids and labels the nav and the settings rows show', () => {
  // **Spelled out, not derived.** `CLAUDE.md`: an expectation computed by
  // the code under test cannot detect that code changing. This replaces
  // what `test/pluginLabels.test.tsx` used to pin -- that file held web's
  // own copy of these three display names and was deleted when the
  // registry made the plugin's own `label` the only copy. Without this,
  // every label in the app could read `x` and nothing would redden:
  // `Shell.test.tsx` finds the nav link by `/Movies/`, but the string it
  // looks for and the string it renders would both come from the registry.
  assert.deepEqual(
    BROWSER_PLUGINS.map((plugin) => [plugin.id, plugin.label]),
    [
      ['tv', 'TV'],
      ['movie', 'Movies'],
      ['xxx', 'XXX'],
    ],
    'in display order: this is the nav, the route table and the count list, in one array',
  );
});

test('each plugin declares the replica tables its card reads, and no others', () => {
  // `tables` is what `Shell.tsx` hands `Category`, and what
  // `pluginRowsByMediaItems` fetches per page. A plugin that declared none
  // would render its collapsed headline from an empty `rows` for ever --
  // which is precisely what the movie and xxx cards *do* want, so the
  // empty lists are pinned too rather than left as "not yet filled in".
  assert.deepEqual(
    BROWSER_PLUGINS.map((plugin) => [plugin.id, [...plugin.tables]]),
    [
      ['tv', ['tv_release']],
      ['movie', []],
      ['xxx', []],
    ],
  );
});

test('an id no plugin claims answers undefined, including one off Object.prototype', () => {
  // The hazard `src/pluginLabels.ts` carried an `Object.hasOwn` guard for,
  // proved gone rather than assumed gone. That module was an object literal
  // keyed by plugin id, so `pluginLabel('constructor')` indexed straight
  // through to the `Object` function -- not `undefined`, so a `??` fallback
  // never fired, and React throws on a function child. `api/server.ts`'s
  // plugin-id pattern is `/^[a-z][a-z0-9_]{0,31}$/`, which `constructor`
  // matches, so the id could genuinely arrive. `.find` over an array cannot
  // reach a prototype key at all, which is why the guard retired with the
  // file instead of moving into this one.
  assert.equal(pluginFor('constructor'), undefined);
  assert.equal(pluginFor('toString'), undefined);
  assert.equal(pluginFor('hasOwnProperty'), undefined);
  assert.equal(pluginFor('book'), undefined, 'and an ordinary id this build has no card for');
});

test('pluginFor returns the registry entry itself, not a copy', () => {
  // `MediaItemCard` renders `plugin.Card` and `Shell` passes `plugin.tables`
  // straight into `usePluginRows`' dependency array. A `pluginFor` that
  // rebuilt its answer would hand back a fresh `tables` array per call and
  // refetch the page on every render (`usePluginRows.ts`'s own doc).
  const first = BROWSER_PLUGINS[0];
  assert.ok(first !== undefined);
  assert.equal(pluginFor(first.id), first);
  assert.equal(pluginFor(first.id)?.tables, first.tables);
});
