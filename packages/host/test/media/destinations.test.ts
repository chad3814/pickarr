/**
 * `saveDestination`: the one writer of `plugin_destination`.
 *
 * **Every token list here comes from the plugins `main` actually builds**,
 * through `shippedPlugins`, rather than from a literal array this file
 * invents. The property the whole file is about is that a shape is validated
 * against the *declaring* plugin's list, and a test whose lists were its own
 * could assert that while the host validated against something else
 * entirely. `test/plugins/tokens.test.ts` is what pins the lists themselves;
 * this file pins what is done with them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { DESTINATION_REFUSALS } from '@pickarr/contract';
import type { DestinationRefusalCode } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { SHAPE_PROBE_VALUE, saveDestination } from '../../src/media/destinations.ts';
import type { SaveDestinationInput } from '../../src/media/destinations.ts';
import { shippedPlugins } from '../../src/main.ts';

const CREATED_AT = 1_700_000_000_000;
const EDITED_AT = 1_700_000_999_000;

/**
 * The tokens the three shipped plugins declare, keyed by id -- `tokensFor`
 * exactly as `host.ts` builds it, from the same list `main` registers.
 */
function shippedTokens(): (pluginId: string) => readonly string[] | undefined {
  const plugins = new Map(
    shippedPlugins({
      now: () => CREATED_AT,
      resolveSecret: async () => { throw new Error('resolveSecret: not used by this test'); },
      baseUrl: 'https://lookup.example.test',
    }).map((plugin) => [plugin.id, plugin]),
  );
  // `Object.keys`, exactly as `host.ts` does it: `MediaPlugin.tokens` maps
  // each declared token to its resolver, and this rule wants the names.
  return (pluginId) => {
    const tokens = plugins.get(pluginId)?.tokens;
    return tokens === undefined ? undefined : Object.keys(tokens);
  };
}

interface Harness {
  raw: DatabaseSync;
  save: (pluginId: string, input: Partial<SaveDestinationInput>) => ReturnType<typeof saveDestination>;
  setNow: (at: number) => void;
}

/**
 * A migrated in-memory database and a `saveDestination` bound to it, with a
 * clock a test can move.
 *
 * **The clock moves for the same reason `clients/mappings.test.ts`'s does.**
 * With one fixed `now()`, an upsert that failed to touch `updated_at` would
 * leave the insert's value -- which is the value the update should have
 * written -- and the assertion would pass against a writer that forgot.
 *
 * `input` is partial so each test names only the field it is about; the
 * defaults below are a destination that every plugin accepts, so exactly one
 * thing is wrong in any test that expects a refusal.
 */
function setup(): Harness {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const tokensFor = shippedTokens();
  let at = CREATED_AT;
  return {
    raw,
    setNow: (next) => { at = next; },
    save: (pluginId, input) => saveDestination(
      { raw, now: () => at, tokensFor },
      pluginId,
      { root: '/library', shape: '{title}.{ext}', unmatchedDir: undefined, ...input },
    ),
  };
}

/** The whole row for `pluginId`, or `undefined` when the plugin has none. */
function rowFor(raw: DatabaseSync, pluginId: string): Record<string, unknown> | undefined {
  const row = raw.prepare(`
    SELECT id, plugin_id, root, shape, unmatched_dir, created_at, updated_at
      FROM plugin_destination WHERE plugin_id = ?
  `).get(pluginId);
  // Spread because `node:sqlite` rows have a null prototype and `deepEqual`
  // compares prototypes -- `clients/mappings.test.ts` normalises the same way.
  return row === undefined ? undefined : { ...row };
}

/** How many destinations exist at all, so a refusal can be shown to have written nothing. */
function rowCount(raw: DatabaseSync): number {
  const row = raw.prepare('SELECT COUNT(*) AS n FROM plugin_destination').get();
  if (row === undefined || !('n' in row)) throw new Error('COUNT(*) returned no n');
  return Number(row.n);
}

/** The refusal code a result carries, or a failure naming what it was instead. */
function refusalOf(result: ReturnType<typeof saveDestination>): DestinationRefusalCode {
  assert.ok('refusal' in result, `expected a refusal, got ${JSON.stringify(result)}`);
  return result.refusal;
}

/** The id a result carries, or a failure naming the refusal that came back instead. */
function idOf(result: ReturnType<typeof saveDestination>): number {
  assert.ok(!('refusal' in result), `expected an id, got refusal ${JSON.stringify(result)}`);
  return result.id;
}

// ---------------------------------------------------------------------------
// The matched pair: a token is valid for the plugin that declares it and for
// no other. This is the point of the task.
// ---------------------------------------------------------------------------

test('a television shape may name {season}, and a film shape naming it is refused', () => {
  // **The pair is what makes this a test.** A validator checking against the
  // union of every plugin's tokens accepts both halves, and would pass any
  // test that only ever tried a nonsense token like `{seasn}`. `season` is a
  // real, resolvable token -- for television. Design spec §3 gives each
  // plugin its own list precisely because only the plugin knows.
  const { raw, save } = setup();

  const accepted = save('tv', {
    shape: '{series}/Season {season}/{series} - S{season}E{episode}.{ext}',
  });
  assert.ok(!('refusal' in accepted), 'every token in that shape is one the tv plugin declares');
  assert.equal(
    rowFor(raw, 'tv')?.['shape'],
    '{series}/Season {season}/{series} - S{season}E{episode}.{ext}',
    'and the shape is stored exactly as typed',
  );

  const refused = save('movie', { shape: '{title}/Season {season}/{title}.{ext}' });
  assert.equal(refusalOf(refused), 'unknown-token', '`season` is not a token a film can resolve');
  assert.equal(rowFor(raw, 'movie'), undefined, 'and nothing was written for the film plugin');
});

test('a film shape may name {collection}, and a television shape naming it is refused', () => {
  // The same pair the other way round, so neither direction can be the one
  // that happens to work. `collection` is `plugin-movie`'s own; `plugin-tv`
  // declares no such thing.
  const { raw, save } = setup();

  const accepted = save('movie', { shape: '{collection}/{title} ({year}).{ext}' });
  assert.ok(!('refusal' in accepted), 'every token in that shape is one the movie plugin declares');

  const refused = save('tv', { shape: '{collection}/{series}.{ext}' });
  assert.equal(refusalOf(refused), 'unknown-token');
  assert.equal(rowFor(raw, 'tv'), undefined);
});

test('{site} belongs to the xxx plugin alone, and {year} to the film plugin alone', () => {
  // The third plugin, and a second film-only token -- so the accepted set is
  // not "tv plus movie" either. Both legs of each pair, again.
  const { save } = setup();

  assert.ok(!('refusal' in save('xxx', { shape: '{site}/{title} {releaseDate}.{ext}' })));
  assert.equal(refusalOf(save('movie', { shape: '{site}/{title}.{ext}' })), 'unknown-token');

  assert.ok(!('refusal' in save('movie', { shape: '{title} ({year}).{ext}' })));
  assert.equal(refusalOf(save('xxx', { shape: '{title} ({year}).{ext}' })), 'unknown-token');
});

test('the shared tokens are accepted by every plugin', () => {
  // The other side of the same rule: `title` and `releaseDate` come from
  // the shared `media_item` row and `filename` and `ext` from the source
  // path (design spec §3), so a validator that was somehow *too* narrow --
  // one plugin's own columns only -- would refuse a shape the host can in
  // fact resolve.
  const { save } = setup();
  for (const pluginId of ['tv', 'movie', 'xxx']) {
    const result = save(pluginId, { shape: '{title} {releaseDate}/{filename}.{ext}' });
    assert.ok(!('refusal' in result), `${pluginId} must accept the shared tokens`);
  }
});

test('{resolution} is refused by every plugin, because nothing in 2.0 records one', () => {
  // Issue #98: design spec §3 lists `resolution` and `rss_item.resolution`
  // is the *lookup* state, not a video resolution. It briefly shipped as a
  // declared token resolving to `null`; a shape naming it now fails where
  // it is typed rather than silently dropping a segment at every import.
  const { save } = setup();
  for (const pluginId of ['tv', 'movie', 'xxx']) {
    assert.deepEqual(
      save(pluginId, { shape: '{title} {resolution}.{ext}' }),
      { refusal: 'unknown-token', token: 'resolution' },
      pluginId,
    );
  }
});

test('an unknown token is named, so a shape of eight tokens says which one was wrong', () => {
  // Design spec §3: refused "naming it". The code alone leaves an operator
  // with eight tokens on one line and no way to tell which they mistyped
  // -- measured against the settings screen, not assumed. The name is the
  // caller's own input echoed back to the caller in the same response, the
  // distinction `sync/tables.ts` draws between a *dictated* value and a
  // *discovered* one.
  const { save } = setup();

  assert.deepEqual(
    save('tv', { shape: '{series}/Season {season}/{seasn}.{ext}' }),
    { refusal: 'unknown-token', token: 'seasn' },
    'the mistyped token, not the first token, and not the shape',
  );
  // The matched pair again, through the name: `{collection}` is a real
  // token and the refusal says so by name rather than leaving the operator
  // to guess which of two plausible ones a film does not have.
  assert.deepEqual(
    save('tv', { shape: '{collection}/{series}.{ext}' }),
    { refusal: 'unknown-token', token: 'collection' },
  );
});

test('every refusal that is not about a token carries no token', () => {
  // One field to read, not a switch on the code first -- and, more to the
  // point, nothing from the input on any of the other nine.
  const { save } = setup();
  const probes: [string, Partial<SaveDestinationInput>][] = [
    ['book', {}],
    ['tv', { root: 'relative' }],
    ['tv', { root: '/lib/../..' }],
    ['tv', { shape: '{title.{ext}' }],
    ['tv', { shape: 'a\\b.{ext}' }],
    ['tv', { shape: '/{series}.{ext}' }],
    ['tv', { shape: '{series}/' }],
    ['tv', { unmatchedDir: '' }],
    ['tv', { unmatchedDir: '../out' }],
  ];
  for (const [pluginId, input] of probes) {
    const result = save(pluginId, input);
    assert.ok('refusal' in result, JSON.stringify(input));
    assert.equal(result.token, null, `${result.refusal} must carry no token`);
  }
});

test('a token name this host will not repeat is refused without being repeated', () => {
  // **`api/server.ts`'s `MEDIA_TYPE` precedent, applied to a token.** A
  // name is whatever an operator typed between braces: the parse already
  // refuses `/`, `{`, `}` and a backslash, and what is left can still be a
  // query string. No response body this API composes may carry one, and
  // that rule does not carve out a value because the caller supplied it.
  // So the refusal stands and the name does not travel.
  const { save } = setup();
  for (const name of ['http:host?apikey=k', 'season number', 'etc\u0000passwd', 'a'.repeat(33)]) {
    const result = save('tv', { shape: `{${name}}.{ext}` });
    assert.deepEqual(
      result,
      { refusal: 'unknown-token', token: null },
      `${JSON.stringify(name)} is refused, and not echoed`,
    );
  }

  // And the class is not so narrow that a real typo falls out of it: every
  // token any plugin declares is inside it, so a near-miss of one is too.
  assert.deepEqual(
    save('tv', { shape: '{releaseDat}.{ext}' }),
    { refusal: 'unknown-token', token: 'releaseDat' },
  );
});

test('a token no plugin declares is refused too', () => {
  // The weak case, kept because it is the one an operator actually hits --
  // and kept *beside* the pairs above rather than instead of them, since on
  // its own it cannot tell a per-plugin validator from a union one.
  const { save } = setup();
  assert.equal(refusalOf(save('tv', { shape: '{seasn}/{series}.{ext}' })), 'unknown-token');
});

// ---------------------------------------------------------------------------
// The plugin id
// ---------------------------------------------------------------------------

test('a plugin id nothing registered is refused, and the refusal names no id', () => {
  // Pre-checked against the registry rather than caught from a constraint,
  // unlike `clients/mappings.ts`'s `unknown-client`: there is no plugin
  // table for a foreign key to point at. A plugin is code the host loaded.
  const { raw, save } = setup();
  const result = save('book', {});
  assert.equal(refusalOf(result), 'unknown-plugin');
  assert.deepEqual(result, { refusal: 'unknown-plugin', token: null }, 'the refusal carries nothing from the request');
  assert.equal(rowCount(raw), 0);
});

test('the plugin is checked before anything else, so an unknown one cannot be told what else was wrong', () => {
  // Ordering, asserted rather than assumed: with a root that is also
  // invalid, an unknown plugin still answers `unknown-plugin`. The reverse
  // order would let a caller probe which plugin ids exist by watching the
  // code change.
  const { save } = setup();
  assert.equal(refusalOf(save('book', { root: 'relative', shape: '{nope}', unmatchedDir: '' })), 'unknown-plugin');
});

// ---------------------------------------------------------------------------
// The root
// ---------------------------------------------------------------------------

test('a root that is not absolute is refused, and the refusal names no path', () => {
  const { raw, save } = setup();
  for (const root of ['library', './library', 'C:\\Media', '']) {
    const result = save('tv', { root });
    assert.deepEqual(result, { refusal: 'not-absolute-root', token: null }, `${JSON.stringify(root)} is not an absolute root`);
  }
  assert.equal(rowCount(raw), 0, 'and no refused save wrote a row');
});

test('an absolute root is accepted and stored verbatim', () => {
  const { raw, save } = setup();
  const id = idOf(save('tv', { root: '/srv/media/television' }));
  assert.equal(rowFor(raw, 'tv')?.['root'], '/srv/media/television');
  assert.ok(Number.isSafeInteger(id) && id > 0, 'the row id comes back');
});

// ---------------------------------------------------------------------------
// The shape's own structure
// ---------------------------------------------------------------------------

test('a shape that could never resolve is refused on save, each way named separately', () => {
  // Design spec §3's reason for validating on save at all is that "a typo is
  // caught where it is typed, not months later as a wrong path", and an
  // unknown token is not the only typo with that property. These are
  // `resolveShape`'s own refusals, surfaced under this route's vocabulary --
  // which is what keeps the check that runs on save and the resolution that
  // runs at import from ever disagreeing about what a shape means.
  const { raw, save } = setup();
  const cases: [string, DestinationRefusalCode][] = [
    ['{title.{ext}', 'malformed-shape'],
    ['{title}}.{ext}', 'malformed-shape'],
    ['{}.{ext}', 'malformed-shape'],
    ['Shows\\{title}.{ext}', 'backslash-in-shape'],
    ['/{title}.{ext}', 'escaping-shape'],
    ['../{title}.{ext}', 'escaping-shape'],
    ['{title}/', 'empty-filename'],
    ['', 'empty-filename'],
  ];
  for (const [shape, refusal] of cases) {
    assert.deepEqual(save('tv', { shape }), { refusal, token: null }, `${JSON.stringify(shape)}`);
  }
  assert.equal(rowCount(raw), 0);
});

test('a `..` inside a shape segment is not an escape', () => {
  // `resolveShape` refuses a `..` *segment*, never a `..` substring -- design
  // spec §6 and §7 both say segment, and `Rocky..Balboa` reaches nowhere.
  // Pinned here as well as there because this is the module that decides
  // what an operator may save.
  const { save } = setup();
  assert.ok(!('refusal' in save('movie', { shape: 'Rocky..Balboa/{title}.{ext}' })));
});

test('the probe the shape is validated against carries no path separator', () => {
  // `saveDestination` resolves the shape against a placeholder value for
  // every declared token, so `separator-in-value` -- the one
  // `ShapeRefusalCode` this route has no code for -- is unreachable by
  // construction rather than by argument. This is that construction, pinned:
  // a probe containing `/` or `\` would make an ordinary shape throw a 500.
  assert.ok(!SHAPE_PROBE_VALUE.includes('/'));
  assert.ok(!SHAPE_PROBE_VALUE.includes('\\'));
  assert.notEqual(SHAPE_PROBE_VALUE, '', 'and an empty probe would make every shape an empty filename');
});

// ---------------------------------------------------------------------------
// The unmatched directory (design spec §6)
// ---------------------------------------------------------------------------

test('an absent unmatched directory stores the default', () => {
  const { raw, save } = setup();
  save('tv', { unmatchedDir: undefined });
  assert.equal(rowFor(raw, 'tv')?.['unmatched_dir'], '_unmatched',
    'design spec §6: `<unmatched>` defaults to `_unmatched`');
});

test('a configured unmatched directory is stored as typed, and a nested one is allowed', () => {
  const { raw, save } = setup();
  save('tv', { unmatchedDir: 'Unsorted' });
  assert.equal(rowFor(raw, 'tv')?.['unmatched_dir'], 'Unsorted');

  save('movie', { unmatchedDir: '_pickarr/unmatched' });
  assert.equal(rowFor(raw, 'movie')?.['unmatched_dir'], '_pickarr/unmatched',
    'design spec §6: nested is a legitimate answer');
});

test('an empty unmatched directory is refused', () => {
  // Design spec §6: it would mean "put unmatched files in the library root",
  // which interleaves unnamed releases with organised ones and leaves no way
  // to tell them apart afterwards.
  const { raw, save } = setup();
  assert.deepEqual(save('tv', { unmatchedDir: '' }), { refusal: 'empty-path', token: null });
  assert.equal(rowCount(raw), 0);
});

test('an absolute unmatched directory is refused', () => {
  // Its own test rather than a row in a table with the `..` case, because
  // design spec §8.6b requires each way to be named separately.
  const { raw, save } = setup();
  assert.deepEqual(save('tv', { unmatchedDir: '/tmp/unmatched' }), { refusal: 'escaping-path', token: null });
  assert.equal(rowCount(raw), 0);
});

test('an unmatched directory with a `..` segment is refused', () => {
  const { raw, save } = setup();
  for (const dir of ['..', '../unmatched', 'a/../../b', 'unmatched/..']) {
    assert.deepEqual(save('tv', { unmatchedDir: dir }), { refusal: 'escaping-path', token: null }, dir);
  }
  assert.equal(rowCount(raw), 0);
});

test('an unmatched directory that means the library root is refused, however it is spelled', () => {
  // **`empty-path` has more than one spelling, and this module shipped
  // knowing only the first.** `<root>/.` and `<root>/./` are `<root>`, so
  // each of these is the outcome design spec §6 refuses `''` to prevent --
  // unnamed releases interleaved with organised ones, with no way to tell
  // them apart afterwards. They saved happily until the rule was delegated
  // to `media/shape.ts`'s `unmatchedDirSegments`, which the importer
  // already used and which already dropped a `.`; the save side had its
  // own copy and the copy was missing it.
  const { raw, save } = setup();
  for (const dir of ['', '.', './', './.', './/.', '.\\.']) {
    assert.deepEqual(save('tv', { unmatchedDir: dir }), { refusal: 'empty-path', token: null }, JSON.stringify(dir));
  }
  assert.equal(rowCount(raw), 0);
});

test('a `.` that still leaves a directory behind is accepted', () => {
  // The other side of the drop, and the line it draws: `<root>/a/.` is
  // `<root>/a`, which is a directory under the root and not the root -- so
  // a rule that refused every `.` outright would refuse a value that names
  // somewhere perfectly good. The stored string is the one the operator
  // typed; nothing here rewrites it.
  const { raw, save } = setup();
  save('tv', { unmatchedDir: 'a/.' });
  assert.equal(rowFor(raw, 'tv')?.['unmatched_dir'], 'a/.');

  save('movie', { unmatchedDir: './unsorted' });
  assert.equal(rowFor(raw, 'movie')?.['unmatched_dir'], './unsorted');
});

test('an unmatched directory of nothing but spaces is a directory named with spaces', () => {
  // **A comment is not a check, and this one was only a comment.** The
  // rule is `=== ''`, deliberately not `.trim() === ''`: every filesystem
  // this host writes to permits a directory named with a space, and
  // trimming would store a different name than the operator typed --
  // `clients/mappings.ts`'s `emptyPathRefusal` records the same decision.
  // Nothing pinned it, and a reviewer's `.trim()` mutant passed the whole
  // suite. This is that mutant's test.
  const { raw, save } = setup();
  const result = save('tv', { unmatchedDir: '   ' });
  assert.ok(!('refusal' in result), 'spaces are a name, not an absent value');
  assert.equal(rowFor(raw, 'tv')?.['unmatched_dir'], '   ', 'and the name is stored exactly as typed');

  // The same line, one level down: a *segment* of spaces survives too, so
  // `<root>/   /unsorted` is three levels and not two.
  save('movie', { unmatchedDir: '   /unsorted' });
  assert.equal(rowFor(raw, 'movie')?.['unmatched_dir'], '   /unsorted');
});

test('a trailing space cannot smuggle a `..` segment past the escape check', () => {
  // `media/shape.ts` compares with trailing whitespace stripped, because
  // Win32 trims a trailing space from a path component -- so `'.. '` names
  // the parent there while being an ordinary two-dot-and-a-space name on
  // POSIX. Delegating gave this module that rule; its own copy never had
  // it.
  const { raw, save } = setup();
  assert.deepEqual(save('tv', { unmatchedDir: '.. ' }), { refusal: 'escaping-path', token: null });
  assert.deepEqual(save('tv', { unmatchedDir: 'a/.. /b' }), { refusal: 'escaping-path', token: null });
  assert.equal(rowCount(raw), 0);
});

test('a `..` that is not a segment is allowed in an unmatched directory', () => {
  // The distinction `media/shape.ts` draws and this module has to draw the
  // same way: a `..` *substring* reaches nowhere. `..hidden` is a directory
  // name, not a traversal.
  const { raw, save } = setup();
  save('tv', { unmatchedDir: '..hidden' });
  assert.equal(rowFor(raw, 'tv')?.['unmatched_dir'], '..hidden');

  save('movie', { unmatchedDir: 'Rocky..Balboa' });
  assert.equal(rowFor(raw, 'movie')?.['unmatched_dir'], 'Rocky..Balboa');
});

test('an unmatched directory that escapes only under a backslash separator is refused too', () => {
  // The escape check splits on `\` as well as `/`, so `..\..` cannot be
  // stored as one innocent-looking segment that traverses two levels on a
  // host where `\` separates. That is `media/shape.ts`'s argument for
  // refusing a backslash in a shape, applied to the one value here that is
  // not a shape: one stored configuration must not lay out a library two
  // different ways depending on where pickarr runs.
  //
  // A backslash that is *not* an escape stays legal, which is why this is an
  // escape check over both separators rather than a ban on the character:
  // `AC\DC` is a directory name on every filesystem this host writes to.
  const { raw, save } = setup();
  assert.deepEqual(save('tv', { unmatchedDir: '..\\..' }), { refusal: 'escaping-path', token: null });
  assert.deepEqual(save('tv', { unmatchedDir: 'a\\..\\b' }), { refusal: 'escaping-path', token: null });
  assert.deepEqual(save('tv', { unmatchedDir: '\\tmp' }), { refusal: 'escaping-path', token: null });
  assert.equal(rowCount(raw), 0);

  save('tv', { unmatchedDir: 'AC\\DC' });
  assert.equal(rowFor(raw, 'tv')?.['unmatched_dir'], 'AC\\DC');
});

test('the unmatched directory is never interpolated', () => {
  // Design spec §6: "It is not a token and is not interpolated." A `{title}`
  // in it is a directory literally called `{title}` -- odd, and not this
  // module's business to refuse, since nothing in it resolves and nothing in
  // it can fail to resolve.
  const { raw, save } = setup();
  save('tv', { unmatchedDir: '{title}' });
  assert.equal(rowFor(raw, 'tv')?.['unmatched_dir'], '{title}',
    'stored verbatim -- a validator that ran it through the shape resolver would have refused it');
});

// ---------------------------------------------------------------------------
// The upsert
// ---------------------------------------------------------------------------

test('a second save replaces the row in place, keeping its id and created_at', () => {
  // The whole reason this is one route rather than a create and an update:
  // a plugin either has a destination or it does not. The row keeping its
  // `id` is not cosmetic -- every replica keys its copy by that id, and
  // `docs/database-migrations.md` makes a row's id immutable.
  const { raw, save, setNow } = setup();
  const first = idOf(save('tv', { root: '/library', shape: '{series}.{ext}', unmatchedDir: 'Unsorted' }));

  setNow(EDITED_AT);
  const second = idOf(save('tv', { root: '/srv/tv', shape: '{series}/{episode}.{ext}', unmatchedDir: undefined }));

  assert.equal(second, first, 'the same row');
  assert.deepEqual(rowFor(raw, 'tv'), {
    id: first,
    plugin_id: 'tv',
    root: '/srv/tv',
    shape: '{series}/{episode}.{ext}',
    unmatched_dir: '_unmatched',
    created_at: CREATED_AT,
    updated_at: EDITED_AT,
  }, 'every column but created_at is replaced, and an absent unmatched directory returns to the default');
  assert.equal(rowCount(raw), 1, 'and there is still one row for this plugin');
});

test('a save that changes nothing still moves updated_at', () => {
  // An `UPDATE` that writes the values already there is still a write: it is
  // what tells a replica the operator confirmed the setting, and the sync
  // trigger logs it either way. Nothing here depends on detecting a no-op.
  const { raw, save, setNow } = setup();
  save('tv', {});
  setNow(EDITED_AT);
  save('tv', {});
  assert.equal(rowFor(raw, 'tv')?.['updated_at'], EDITED_AT);
  assert.equal(rowFor(raw, 'tv')?.['created_at'], CREATED_AT);
});

test('a root that is absolute but not the directory it resolves to is refused on save', () => {
  // Measured before the fix: `/`, `//` and `/lib/../..` all saved happily
  // and then answered `escapes-root` at *every* import, for ever, because
  // all three resolve to `/` and the importer's containment check is
  // `target.startsWith(root + '/')` -- `startsWith('//')`, which no target
  // satisfies. `/lib/../..` was the worst of them: the settings screen
  // showed what the operator typed and the importer used `/`.
  //
  // This is the same save/import disagreement §3 validates on save to
  // prevent, and the same one this module already fixed one field over for
  // `unmatched_dir`. `host/src/media/shape.ts`'s `rootRefusal` is the one
  // implementation and `media/import.ts` calls it too --
  // `test/media/import.test.ts` holds the other half of this pair.
  const { raw, save } = setup();

  for (const root of ['/', '//', '/lib/../..']) {
    assert.equal(refusalOf(save('tv', { root })), 'unusable-root', root);
  }
  // And the spellings that merely differ from what they resolve to, which
  // would import fine and store a value that is not the directory written
  // to.
  for (const root of ['/library/', '/library/./tv', '/library//tv']) {
    assert.equal(refusalOf(save('tv', { root })), 'unusable-root', root);
  }
  assert.equal(rowCount(raw), 0, 'a refused root wrote a row');
});

test('an ordinary absolute root is still accepted, spaces and backslashes included', () => {
  // The other side of the rule, because a check that refused everything
  // would pass the test above. A backslash is an ordinary character in a
  // POSIX directory name and a root is a path the operator's filesystem
  // already has -- unlike a shape, which this host lays out itself and so
  // insists on one separator for.
  const { raw, save } = setup();

  for (const root of ['/library', '/mnt/media/tv shows', '/mnt/AC\\DC']) {
    const result = save('tv', { root });
    assert.ok(!('refusal' in result), `"${root}" is a directory a filesystem permits`);
    assert.equal(rowFor(raw, 'tv')?.['root'], root, 'and it is stored exactly as typed');
  }
});

test('a refused save leaves an existing row exactly as it was', () => {
  // Every refusal is taken before the statement runs, so there is no partial
  // write to roll back -- pinned through the row rather than asserted, since
  // a writer that validated after binding would look identical from outside
  // until it did not.
  const { raw, save, setNow } = setup();
  save('tv', { root: '/library', shape: '{series}.{ext}', unmatchedDir: 'Unsorted' });
  const before = rowFor(raw, 'tv');

  setNow(EDITED_AT);
  assert.equal(refusalOf(save('tv', { shape: '{collection}.{ext}' })), 'unknown-token');
  assert.equal(refusalOf(save('tv', { root: 'relative' })), 'not-absolute-root');
  assert.equal(refusalOf(save('tv', { unmatchedDir: '../out' })), 'escaping-path');

  assert.deepEqual(rowFor(raw, 'tv'), before, 'not even updated_at moved');
});

test('two plugins hold two destinations, and saving one does not touch the other', () => {
  const { raw, save } = setup();
  save('tv', { root: '/library/tv' });
  save('movie', { root: '/library/films' });
  assert.equal(rowCount(raw), 2);
  assert.equal(rowFor(raw, 'tv')?.['root'], '/library/tv');
  assert.equal(rowFor(raw, 'movie')?.['root'], '/library/films');
});

// ---------------------------------------------------------------------------
// The contract's list
// ---------------------------------------------------------------------------

test('every code in DESTINATION_REFUSALS is one this module can actually answer', () => {
  // The feeds slice shipped two of its four codes unpinned, so its status
  // mapper could have dropped a case with every test still green. This is
  // that guard, from the other end: a code in the contract that nothing here
  // produces is either dead vocabulary or a rule that was never implemented.
  const { save } = setup();
  const produced = new Set<DestinationRefusalCode>();
  const probes: [string, Partial<SaveDestinationInput>][] = [
    ['book', {}],
    ['tv', { root: 'relative' }],
    ['tv', { root: '/lib/../..' }],
    ['tv', { shape: '{collection}.{ext}' }],
    ['tv', { shape: '{title.{ext}' }],
    ['tv', { shape: 'a\\b.{ext}' }],
    ['tv', { shape: '/{series}.{ext}' }],
    ['tv', { shape: '{series}/' }],
    ['tv', { unmatchedDir: '' }],
    ['tv', { unmatchedDir: '../out' }],
  ];
  for (const [pluginId, input] of probes) produced.add(refusalOf(save(pluginId, input)));

  assert.deepEqual(
    [...produced].toSorted(),
    [...DESTINATION_REFUSALS].toSorted(),
    'the contract`s codes and the ones this writer produces must be the same set',
  );
});
