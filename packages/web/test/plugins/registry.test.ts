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

/**
 * Files exempted from the plugin-id scan, by name, with the reason. Empty,
 * and that is the finding rather than the default: fix round 1's review
 * found **seven** id sites in `src/` that the first version of this test
 * could not see, and all seven were reworded rather than exempted. The
 * entry shape is kept so that adding one is a visible, reviewable decision
 * and not a regex tweak.
 *
 * An entry must name the file, the id, and the **exact** number of
 * occurrences expected, so that a new one in an exempted file still fails.
 * A whole-file exemption is not available on purpose: `Destinations.tsx`
 * was the near-miss, and it needed one line of prose changed, not a licence
 * for its code.
 */
const EXEMPT: readonly { readonly file: string; readonly id: string; readonly occurrences: number }[] = [];

test('no plugin id is spelled in packages/web/src outside the registry', async () => {
  // The registry is the seam's whole point. A second place naming a plugin
  // makes adding one two edits again, silently.
  //
  // **Matched on word boundaries, which is the whole of what this test is
  // worth.** The first version required a quote adjacent on *both* sides
  // (`/['"`]tv['"`]/`), and fix round 1's review showed that let `'/tv'`,
  // `'category-tv'` and `` `/api/feeds/tv` `` all through -- seven real
  // sites survived undetected, and `Shell.tsx`'s own former
  // `<Navigate to="/tv">` would have passed too. Acceptance 7 was
  // decorative. `\b` catches an id wherever it appears, in a path segment,
  // a template, a package specifier or prose.
  //
  // Case-sensitive, and that is not an oversight: the ids are lowercase and
  // the *labels* are not (`TV`, `XXX`), so a case-insensitive scan would
  // flag every legitimate mention of a display name.
  //
  // **The ids come from the registry**, so a fourth plugin is scanned with
  // no edit here. That alone would be weak against a registry mutated to
  // hold nothing, which is why `ids.length > 0` is asserted and why the
  // literal id/label test below sits beside it.
  //
  // **Comments count.** A docblock naming a plugin goes stale exactly the
  // way code does, and this repo's own hazard list is about prose that
  // stopped being true. Seven comments were reworded to clear this scan,
  // one of them by citing a test's leading clause instead of its full name
  // (`settings/Destinations.tsx`); none was exempted.
  const ids = BROWSER_PLUGINS.map((plugin) => plugin.id);
  assert.ok(ids.length > 0, 'the registry is empty, so this test would scan for nothing');

  const offenders: string[] = [];
  for (const [file, text] of await sources()) {
    if (file.endsWith(join('plugins', 'registry.ts'))) continue;
    for (const id of ids) {
      const hits = text.match(new RegExp(`\\b${id}\\b`, 'g'))?.length ?? 0;
      if (hits === 0) continue;
      const allowed = EXEMPT.find((entry) => file.endsWith(entry.file) && entry.id === id);
      if (allowed !== undefined && allowed.occurrences === hits) continue;
      offenders.push(`${file}: ${id} x${String(hits)}`);
    }
  }
  assert.deepEqual(offenders, [], 'a plugin id is spelled outside the registry');
});

test('every exemption names a file that exists and still has exactly the occurrences it claims', async () => {
  // An exemption that outlives the line it was written for is a hole
  // nobody can see. This is what makes the list above self-cleaning: a
  // reworded or deleted file reddens here rather than quietly widening the
  // scan. Vacuously true while `EXEMPT` is empty, and that is the state it
  // is meant to stay in.
  const byPath = new Map(await sources());
  const wrong: string[] = [];
  for (const entry of EXEMPT) {
    const found = [...byPath].find(([file]) => file.endsWith(entry.file));
    if (found === undefined) {
      wrong.push(`${entry.file}: no such file under src/`);
      continue;
    }
    const hits = found[1].match(new RegExp(`\\b${entry.id}\\b`, 'g'))?.length ?? 0;
    if (hits !== entry.occurrences) {
      wrong.push(`${entry.file}: ${entry.id} claims ${String(entry.occurrences)}, found ${String(hits)}`);
    }
  }
  assert.deepEqual(wrong, [], 'an exemption no longer describes the file it exempts');
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
