import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { DESTINATION_REFUSALS } from '@pickarr/contract';
import { TV_PLUGIN_ID, TV_TOKENS } from '@pickarr/plugin-tv';
import { MOVIE_PLUGIN_ID, MOVIE_TOKENS } from '@pickarr/plugin-movie';
import { XXX_PLUGIN_ID, XXX_TOKENS } from '@pickarr/plugin-xxx';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribe, subscribeInserts } from '../../src/store/notify.ts';
import { Destinations, type PluginTokens } from '../../src/settings/Destinations.tsx';
import type { DestinationsSource } from '../../src/settings/useDestinations.ts';
import { pluginFor } from '../../src/plugins/registry.ts';
import {
  DESTINATION_REFUSAL_MESSAGES,
  type DestinationSubmit,
  type SaveDestinationRequest,
  type SaveDestinationOutcome,
} from '../../src/settings/postDestination.ts';
import { gone } from '../dom.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave a `Destinations` mounted and
 * still subscribed through `notify.ts`'s module-level registry -- once to
 * the table and once per saved row.
 */
afterEach(cleanup);

/**
 * **The three plugins' own declarations, imported rather than retyped.**
 * This is the whole point of the section and of this file: `MediaPlugin.tokens`
 * is declared once, by the plugin that resolves them, against the names
 * `@pickarr/contract` spells; the host's validator and this screen both
 * read from that declaration. A list spelled again in
 * `packages/web` would pass every other test here and drift silently the
 * moment a plugin changed -- the same copy-inheritance defect an earlier
 * slice found in the refusal codes and had to fix.
 *
 * `packages/plugin-*` are **devDependencies** of `packages/web`, never
 * dependencies: node's resolver reaches them under `npm run test:web`, and
 * they must never reach the browser bundle. Measured, not assumed: adding
 * `@pickarr/plugin-tv` to `dependencies` and importing `TV_TOKENS` from a
 * module `src/main.tsx` reaches fails `npm run build` outright, on
 * `import { DatabaseSync } from "node:sqlite"` -- `@pickarr/plugin-tv`
 * imports `@pickarr/openmetadata`, which depends on `drizzle-orm`, which
 * reaches node's SQLite driver. `Settings.tsx` therefore builds its list
 * from `@pickarr/contract`'s `TOKEN_NAMES_BY_PLUGIN`, which carries no node
 * import. The plugin *ids* in that map are the one pair the compiler cannot
 * lock -- `host/test/plugins/tokens.test.ts` compares them against the
 * plugins `main` actually builds, which is why the ids below still come
 * from the plugin packages rather than being retyped.
 *
 * `Object.keys`, not a name array: `MediaPlugin.tokens` is a
 * `TokensFor<Name>` record of resolvers, so its keys *are* the declaration,
 * and a token a plugin stopped resolving vanishes here rather than being
 * offered to an operator who would get `unknown-token` on save.
 */
const PLUGINS: readonly PluginTokens[] = [
  { pluginId: TV_PLUGIN_ID, tokens: Object.keys(TV_TOKENS) },
  { pluginId: MOVIE_PLUGIN_ID, tokens: Object.keys(MOVIE_TOKENS) },
  { pluginId: XXX_PLUGIN_ID, tokens: Object.keys(XXX_TOKENS) },
];

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/** One `upsert` carrying the projected `plugin_destination` shape, which is the whole row (`sync/tables.ts`). */
function destinationOp({
  id,
  pluginId,
  root,
  shape,
  unmatchedDir = '_unmatched',
}: {
  id: number;
  pluginId: string;
  root: string;
  shape: string;
  unmatchedDir?: string;
}): SyncOp {
  return {
    op: 'upsert',
    table: 'plugin_destination',
    id,
    value: { id, pluginId, root, shape, unmatchedDir, createdAt: id, updatedAt: id },
  };
}

function sourceFor(db: IDBDatabase): DestinationsSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribe,
    subscribeInserts,
  };
}

/**
 * A `submit` that fails the test, with whichever behaviour a test actually
 * drives supplied instead. A failure rather than a no-op so that a test
 * cannot silently exercise a path it did not mean to.
 */
function neverSubmit(): Promise<SaveDestinationOutcome> {
  return assert.fail('this test must not save a destination');
}

/**
 * A promise a test resolves by hand, so it can assert on the state a
 * control is in *while* its submit is still in flight. The executor runs
 * synchronously, so `capture` is always set by the time it is read; the
 * throw is there because nothing but a future change to that guarantee
 * could reach it.
 */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let capture: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    capture = resolve;
  });
  const settle = capture;
  if (settle === undefined) throw new Error('the promise executor did not run synchronously');
  return { promise, settle };
}

/** Renders the section and waits for the first replica read to resolve, so every test starts from a rendered list. */
async function renderDestinations(db: IDBDatabase, submit: DestinationSubmit): Promise<void> {
  render(<Destinations source={sourceFor(db)} plugins={PLUGINS} submit={submit} />);
  await waitFor(() => {
    assert.ok(screen.getByRole('listitem', { name: rowHeading(TV_PLUGIN_ID) }), 'the first read resolved');
  });
}

/**
 * The heading text `Destinations.tsx` gives a row: the registry's label
 * where this build carries the plugin, its own id where it does not.
 * Mirrors the component's own expression rather than importing one, because
 * there is no shared helper left to import -- `pluginLabels.ts` held one and
 * was deleted with the registry's arrival. That makes this a computed
 * expectation, which `CLAUDE.md` warns about; the literal spelling of all
 * three labels lives in `test/plugins/registry.test.ts`, and the literal
 * spelling of the fallback lives in this file's own `'book'` test below.
 */
function rowHeading(pluginId: string): string {
  return pluginFor(pluginId)?.label ?? pluginId;
}

/**
 * One plugin's row, found by the accessible name its own visible heading
 * gives it -- which is {@link rowHeading}, not `pluginId` itself. Every call
 * site below still addresses a row by plugin id; only these two functions
 * have to know the id and the heading text are no longer the same string.
 */
function row(pluginId: string): HTMLElement {
  return screen.getByRole('listitem', { name: rowHeading(pluginId) });
}

function saveButton(pluginId: string): HTMLButtonElement {
  const button = within(row(pluginId)).getByRole('button', { name: `Save ${rowHeading(pluginId)}` });
  assert.ok(button instanceof HTMLButtonElement, 'the save control is a button');
  return button;
}

function field(pluginId: string, label: string): HTMLInputElement {
  const input = within(row(pluginId)).getByLabelText(label);
  assert.ok(input instanceof HTMLInputElement, `${label} is a text input`);
  return input;
}

/** Every `{token}` the row offers, in the order it offers them. */
function tokensOffered(pluginId: string): string[] {
  return within(row(pluginId))
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');
}

function save(pluginId: string): void {
  fireEvent.click(saveButton(pluginId));
}

test('one row per plugin, each showing the root, shape and unmatched folder the replica holds', async () => {
  const db = await freshDb();
  await seed(db, [
    destinationOp({ id: 1, pluginId: 'tv', root: '/media/tv', shape: '{series}/Season {season}/{title}.{ext}' }),
    destinationOp({ id: 2, pluginId: 'movie', root: '/media/films', shape: '{title} ({year}).{ext}', unmatchedDir: '_pickarr/unmatched' }),
  ]);

  await renderDestinations(db, neverSubmit);

  assert.equal(field('tv', 'Library folder').value, '/media/tv');
  assert.equal(field('tv', 'Path shape').value, '{series}/Season {season}/{title}.{ext}');
  assert.equal(field('movie', 'Library folder').value, '/media/films');
  assert.equal(field('movie', 'Unmatched folder').value, '_pickarr/unmatched');
  // The third plugin has no row in the replica at all, which is what a
  // fresh install looks like: migration 20 creates the table empty.
  assert.equal(field('xxx', 'Library folder').value, '');
  assert.deepEqual(
    screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? ''),
    ['TV', 'Movies', 'XXX'],
    'one row per plugin, in the order the declarations were given, each named through the registry label',
  );
});

/**
 * **The test this section exists for.**
 *
 * `{season}` is television's and nothing else's -- design spec §3 and the
 * `unknown-token` refusal's own docblock both turn on exactly this pair.
 * A token list hard-coded in `packages/web` would have to be either the
 * union (and then the film row offers `{season}`) or a per-plugin copy
 * (and then it drifts the first time a plugin changes). Reading the
 * plugin's own `tokens` array is the only arrangement under which both
 * halves of this assertion hold for a reason rather than by coincidence.
 */
test('the tokens a row offers are the ones that plugin declared: the tv row lists {season} and the movie row does not', async () => {
  const db = await freshDb();
  await renderDestinations(db, neverSubmit);

  assert.ok(within(row('tv')).getByText('{season}'),
    'television resolves a season number, so its shape may name one');
  assert.ok(!within(row('movie')).queryByText('{season}'),
    'a film has no season, and a film shape naming one is `unknown-token`');
  assert.ok(!within(row('xxx')).queryByText('{season}'),
    'nor has a scene');
});

/**
 * The same claim made exhaustively rather than on one token. The expected
 * value comes from the plugin package -- an authority independent of the
 * code under test, which is `packages/web` -- so this cannot be satisfied
 * by anything in this package agreeing with itself.
 */
test('every token a plugin declared is offered on its row, and no token it did not', async () => {
  const db = await freshDb();
  await renderDestinations(db, neverSubmit);

  for (const plugin of PLUGINS) {
    assert.deepEqual(
      tokensOffered(plugin.pluginId),
      plugin.tokens.map((token) => `{${token}}`),
      `the ${plugin.pluginId} row offers exactly what the ${plugin.pluginId} plugin declared`,
    );
  }

  // The union is what a single hard-coded list would offer everywhere, and
  // no row may be it.
  const union = new Set(PLUGINS.flatMap((plugin) => plugin.tokens));
  for (const plugin of PLUGINS) {
    assert.ok(plugin.tokens.length < union.size,
      `no plugin declares every token, so the ${plugin.pluginId} row cannot be showing the union by accident`);
  }
});

test('an unmatched folder nobody has set shows the default, and says that is what it is', async () => {
  const db = await freshDb();
  await renderDestinations(db, neverSubmit);

  const input = field('tv', 'Unmatched folder');
  assert.equal(input.value, '', 'nothing is stored, so nothing is claimed to be stored');
  assert.equal(input.getAttribute('placeholder'), '_unmatched');
  assert.ok(within(row('tv')).getByText('Leave this blank and Pickarr uses _unmatched.'),
    'the default is named in rendered text, and named as a default');
});

test('the form tells the operator that a shape cannot contain a literal brace', async () => {
  // Carried from the resolver: `media/shape.ts` has no escape syntax, so
  // there is no way to write a folder whose name contains `{` or `}`. Its
  // review judged that an acceptable trade and flagged that nothing told
  // the operator. This is the only screen that could.
  const db = await freshDb();
  await renderDestinations(db, neverSubmit);

  assert.ok(screen.getByText('A brace always opens a token, so a folder or file name cannot contain { or } itself.'));
});

test('a save sends this row\'s own values, addressed to this row\'s own plugin', async () => {
  const db = await freshDb();
  const calls: { pluginId: string; input: SaveDestinationRequest }[] = [];
  await renderDestinations(db, (pluginId, input) => {
    calls.push({ pluginId, input });
    return Promise.resolve({ id: 1 });
  });

  fireEvent.change(field('movie', 'Library folder'), { target: { value: '/media/films' } });
  fireEvent.change(field('movie', 'Path shape'), { target: { value: '{title} ({year}).{ext}' } });
  fireEvent.change(field('movie', 'Unmatched folder'), { target: { value: '_stray' } });
  save('movie');

  await waitFor(() => {
    assert.equal(calls.length, 1);
  });
  assert.deepEqual(calls[0], {
    pluginId: 'movie',
    input: { root: '/media/films', shape: '{title} ({year}).{ext}', unmatchedDir: '_stray' },
  });
});

test('a blank unmatched folder is sent as no field at all, so the host applies its own default', async () => {
  // `api/server.ts`'s `destinationBodyFrom` reads an absent `unmatchedDir`
  // as design spec §6's `_unmatched` and an empty string as `empty-path`.
  // Sending `''` would turn the default this row advertises into a
  // refusal.
  const db = await freshDb();
  const calls: SaveDestinationRequest[] = [];
  await renderDestinations(db, (_pluginId, input) => {
    calls.push(input);
    return Promise.resolve({ id: 1 });
  });

  fireEvent.change(field('tv', 'Library folder'), { target: { value: '/media/tv' } });
  fireEvent.change(field('tv', 'Path shape'), { target: { value: '{title}.{ext}' } });
  save('tv');

  await waitFor(() => {
    assert.equal(calls.length, 1);
  });
  assert.deepEqual(calls[0], { root: '/media/tv', shape: '{title}.{ext}' });
  assert.ok(calls[0] !== undefined && !('unmatchedDir' in calls[0]),
    'the key is absent, not present and empty');
});

test('a plugin this package has no label for is headed by its own id', async () => {
  // `Destinations.tsx`'s `?? plugin.pluginId` fallback, driven through the
  // one call site that can reach it. `Settings.tsx` builds its rows from
  // `@pickarr/contract`'s `TOKEN_NAMES_BY_PLUGIN` -- which plugins have
  // path tokens -- while `plugins/registry.ts` says which have a browse
  // card, and nothing holds the two lists in step. So a plugin in the first
  // and not the second gets a row here with no edit anywhere, and
  // `CLAUDE.md`'s lesson is that pinning a pure function does not pin that
  // anyone calls it. `Shell.tsx`'s nav cannot reach the
  // fallback: it walks the registry itself, so every entry has a label.
  //
  // `'book'` written out, not `rowHeading('book')`: the whole claim is about
  // what the fallback returns, so computing the expectation from it would
  // hold under every change to it.
  const db = await freshDb();
  render(
    <Destinations
      source={sourceFor(db)}
      plugins={[...PLUGINS, { pluginId: 'book', tokens: ['title', 'ext'] }]}
      submit={neverSubmit}
    />,
  );

  await waitFor(() => {
    assert.ok(screen.getByRole('listitem', { name: 'book' }),
      'the fourth row has no accessible name, so its heading rendered nothing');
  });
  assert.ok(within(screen.getByRole('listitem', { name: 'book' })).getByRole('heading', { name: 'book' }),
    'the id has to be visible text, not only an accessible name');
});

test('a refused save shows that refusal in rendered text, not only in an accessible name', async () => {
  // `CLAUDE.md`'s longest testing hazard: `getByRole`'s `name` is satisfied
  // by an `aria-label` on an element with nothing in it, and exactly that
  // shipped here once. `getByText` reads the rendered string.
  const db = await freshDb();
  await renderDestinations(db, () => Promise.resolve({ refusal: 'unknown-token', token: null }));

  save('tv');

  await waitFor(() => {
    assert.ok(within(row('tv')).getByText(DESTINATION_REFUSAL_MESSAGES['unknown-token']));
  });
  const alert = within(row('tv')).getByRole('alert');
  assert.ok((alert.textContent ?? '').includes('Check each {token}'),
    'the announced element is the one carrying the words, so the two cannot drift apart');
});

test('the token the host refused is named on the row, not left for the operator to find', async () => {
  // Design spec §3: refused "naming it". The host answers
  // `{ refusal: 'unknown-token', token: 'seasn' }` and did so for a whole
  // slice while this screen discarded the name and told the operator
  // Pickarr could not say which one. The tv row lists seven tokens, so a
  // code alone leaves them comparing strings by eye.
  const db = await freshDb();
  await renderDestinations(db, () => Promise.resolve({ refusal: 'unknown-token', token: 'seasn' }));

  fireEvent.change(field('tv', 'Path shape'), { target: { value: '{seasn}/{title}.{ext}' } });
  save('tv');

  await waitFor(() => {
    assert.ok(within(row('tv')).getByRole('alert'));
  });
  const alert = within(row('tv')).getByRole('alert');
  assert.ok((alert.textContent ?? '').includes('{seasn}'),
    'the row does not say which token the host refused, so the field the host sent was dropped');
  assert.ok(!(alert.textContent ?? '').includes('does not say which'),
    'and it no longer claims Pickarr cannot name one');
});

test('an unknown-token the host declined to name still sends the operator to the list on screen', async () => {
  // `token: null` is a real answer: `ECHOABLE_TOKEN` refuses to repeat a
  // name outside the class a declared token is in. The client must not
  // guess by parsing the shape -- that would be a second token vocabulary
  // in `packages/web`, the very drift the token list above is read from the
  // declaration to prevent.
  const db = await freshDb();
  await renderDestinations(db, () => Promise.resolve({ refusal: 'unknown-token', token: null }));

  fireEvent.change(field('tv', 'Path shape'), { target: { value: '{seasn}/{title}.{ext}' } });
  save('tv');

  await waitFor(() => {
    assert.ok(within(row('tv')).getByText(DESTINATION_REFUSAL_MESSAGES['unknown-token']));
  });
  assert.ok(gone('{seasn}'), 'the token the operator typed is quoted back as though Pickarr had identified it');
});

test('each of the twelve outcomes reads as its own sentence', async () => {
  // Ten contract codes plus this client's `offline` and `unrecognised`. A
  // test covering three of them would pass against a component that
  // rendered one fixed string for every refusal.
  const outcomes = [
    ...DESTINATION_REFUSALS.map((refusal) => ({ refusal, token: null }) as const),
    { refusal: 'offline', token: null } as const,
    { refusal: 'unrecognised', token: null } as const,
  ];
  const seen = new Set<string>();

  for (const outcome of outcomes) {
    // eslint-disable-next-line no-await-in-loop -- one shared `screen`: each pass renders, asserts and unmounts, so two of them at once would read each other's DOM.
    const db = await freshDb();
    // eslint-disable-next-line no-await-in-loop -- see above
    await renderDestinations(db, () => Promise.resolve(outcome));
    save('tv');

    const expected = DESTINATION_REFUSAL_MESSAGES[outcome.refusal];
    // eslint-disable-next-line no-await-in-loop -- see above
    await waitFor(() => {
      assert.ok(within(row('tv')).getByText(expected), `${outcome.refusal} reads as its own sentence`);
    });
    seen.add(expected);
    cleanup();
  }

  assert.equal(seen.size, 12, 'twelve outcomes, twelve different things on screen');
});

test('a submit that rejects outright reads as offline rather than wedging the row', async () => {
  const db = await freshDb();
  await renderDestinations(db, () => Promise.reject(new Error('boom')));

  save('tv');

  await waitFor(() => {
    assert.ok(within(row('tv')).getByText(DESTINATION_REFUSAL_MESSAGES.offline));
  });
});

test('every control re-enables after every outcome, a rejecting submit included', async () => {
  // The `finally` is the only thing that makes "the button always comes
  // back" true, and the feeds slice shipped without one and wedged its form
  // on five of six real host answers.
  const outcomes: (SaveDestinationOutcome | 'reject')[] = [
    { id: 7 },
    ...DESTINATION_REFUSALS.map((refusal) => ({ refusal, token: null })),
    { refusal: 'offline' as const, token: null },
    { refusal: 'unrecognised' as const, token: null },
    'reject',
  ];

  for (const outcome of outcomes) {
    // eslint-disable-next-line no-await-in-loop -- one shared `screen`; see the refusal walk above.
    const db = await freshDb();
    // eslint-disable-next-line no-await-in-loop -- see above
    await renderDestinations(db, () =>
      outcome === 'reject' ? Promise.reject(new Error('boom')) : Promise.resolve(outcome));

    save('tv');

    // eslint-disable-next-line no-await-in-loop -- see above
    await waitFor(() => {
      assert.equal(saveButton('tv').disabled, false, `the save button came back after ${JSON.stringify(outcome)}`);
    });
    assert.equal(field('tv', 'Library folder').disabled, false);
    assert.equal(field('tv', 'Path shape').disabled, false);
    assert.equal(field('tv', 'Unmatched folder').disabled, false);
    cleanup();
  }
});

test('a control is disabled while its own save is in flight, which is what makes re-enabling worth asserting', async () => {
  const db = await freshDb();
  const { promise, settle } = deferred<SaveDestinationOutcome>();
  await renderDestinations(db, () => promise);

  save('tv');

  await waitFor(() => {
    assert.equal(saveButton('tv').disabled, true);
  });
  assert.equal(field('tv', 'Library folder').disabled, true);

  settle({ id: 1 });
  await waitFor(() => {
    assert.equal(saveButton('tv').disabled, false);
  });
});

test('saving one plugin\'s row leaves the other rows alone', async () => {
  // A single pending flag shared by the section would pass almost every
  // other test in this file -- with one row on screen there is nothing for
  // it to spill onto.
  const db = await freshDb();
  const { promise, settle } = deferred<SaveDestinationOutcome>();
  await renderDestinations(db, (pluginId) => {
    assert.equal(pluginId, 'tv', 'only the tv row was saved');
    return promise;
  });

  fireEvent.change(field('movie', 'Library folder'), { target: { value: '/media/films' } });
  save('tv');

  await waitFor(() => {
    assert.equal(saveButton('tv').disabled, true, 'the row being saved is busy');
  });
  assert.equal(saveButton('movie').disabled, false, 'the other rows are not');
  assert.equal(saveButton('xxx').disabled, false);
  assert.equal(field('movie', 'Library folder').disabled, false, 'and are still editable');
  assert.equal(field('movie', 'Library folder').value, '/media/films', 'with what was typed into them intact');

  settle({ refusal: 'not-absolute-root', token: null });
  await waitFor(() => {
    assert.ok(within(row('tv')).getByText(DESTINATION_REFUSAL_MESSAGES['not-absolute-root']));
  });
  assert.ok(!within(row('movie')).queryByRole('alert'), 'one row\'s refusal is not another row\'s');
  assert.ok(!within(row('xxx')).queryByRole('alert'));
});

test('a row follows the replica again once its own save is accepted', async () => {
  // Nothing is refetched after a write (Global Constraint): the accepted
  // values reach the screen when the replica says so. Until then the row
  // keeps showing what was typed, and afterwards it shows the row.
  const db = await freshDb();
  await renderDestinations(db, () => Promise.resolve({ id: 1 }));

  fireEvent.change(field('tv', 'Library folder'), { target: { value: '/media/tv' } });
  fireEvent.change(field('tv', 'Path shape'), { target: { value: '{title}.{ext}' } });
  save('tv');
  await waitFor(() => {
    assert.equal(saveButton('tv').disabled, false);
  });

  await seed(db, [destinationOp({ id: 1, pluginId: 'tv', root: '/srv/tv', shape: '{series}/{title}.{ext}' })]);

  await waitFor(() => {
    assert.equal(field('tv', 'Library folder').value, '/srv/tv');
  });
  assert.equal(field('tv', 'Path shape').value, '{series}/{title}.{ext}');
});

test('a replica row arriving mid-edit does not overwrite what is being typed', async () => {
  const db = await freshDb();
  await renderDestinations(db, neverSubmit);

  fireEvent.change(field('tv', 'Library folder'), { target: { value: '/media/tv-in-progress' } });
  await seed(db, [destinationOp({ id: 1, pluginId: 'tv', root: '/srv/tv', shape: '{title}.{ext}' })]);

  await waitFor(() => {
    // The shape field was never touched, so it takes the arriving row's value.
    assert.equal(field('tv', 'Path shape').value, '{title}.{ext}');
  });
  assert.equal(field('tv', 'Library folder').value, '/media/tv-in-progress',
    'the field the operator is in the middle of is theirs until they save');
});

test('nothing on this screen reaches the network on its own', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => assert.fail('a list comes from the replica, never a refetch');
  try {
    const db = await freshDb();
    await seed(db, [destinationOp({ id: 1, pluginId: 'tv', root: '/media/tv', shape: '{title}.{ext}' })]);
    await renderDestinations(db, neverSubmit);
    assert.equal(field('tv', 'Library folder').value, '/media/tv');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
