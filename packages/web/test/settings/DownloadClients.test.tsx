import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribe, subscribeInserts } from '../../src/store/notify.ts';
import { DownloadClients, healthLine, type DownloadClientsListSource } from '../../src/settings/DownloadClients.tsx';
import type { MappingSubmit } from '../../src/settings/postMapping.ts';
import { REFUSAL_MESSAGES, type AddDownloadClientOutcome } from '../../src/settings/AddDownloadClient.tsx';
import type { AddDownloadClientInput } from '@pickarr/contract';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave a `DownloadClients` still
 * mounted, still subscribed through `notify.ts`'s module-level registry.
 */
afterEach(cleanup);

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/**
 * One `upsert` `SyncOp` carrying the **projected** `download_client` shape
 * -- `DownloadClientSyncRead`, not the raw row: no secret name, and a url
 * already reduced to origin and path by the host (design spec §5). An
 * `upsert` rather than a `create` for `Feeds.test.tsx`'s `feedOp` reason:
 * the live tail only ever emits `upsert`.
 */
function clientOp({
  id,
  name,
  implementation = 'qbittorrent',
  type = 'torrent',
  url = 'http://qbit.example:8080',
  username = null,
  category = '',
  consecutiveFailures,
  unreachableSince,
}: {
  id: number;
  name: string;
  implementation?: string;
  type?: string;
  url?: string;
  username?: string | null;
  category?: string;
  consecutiveFailures?: number;
  unreachableSince?: number | null;
}): SyncOp {
  const value: Record<string, unknown> = { id, name, type, implementation, url, username, category, createdAt: id, updatedAt: id };
  // Omit rather than write `undefined`, so a test can build the pre-migration-25 shape a
  // replicated row may still hold: `ADD COLUMN` touches no existing row (docs/database-migrations.md).
  if (consecutiveFailures !== undefined) value.consecutiveFailures = consecutiveFailures;
  if (unreachableSince !== undefined) value.unreachableSince = unreachableSince;
  return {
    op: 'upsert',
    table: 'download_client',
    id,
    value,
  };
}

/** Everything `DownloadClients` needs, bound straight to a raw database -- no `Store`, nothing this suite has to stop afterwards. `subscribe` is here for the nested mappings list, which is the first settings list to need it. */
function sourceFor(db: IDBDatabase): DownloadClientsListSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribe,
    subscribeInserts,
  };
}

/** No test in this file expands a client's mappings, so none of these three may be reached. `ClientMappings.test.tsx` is where they are driven. */
const neverSubmitMapping: MappingSubmit = {
  add: () => assert.fail('this file must not add a path mapping'),
  edit: () => assert.fail('this file must not edit a path mapping'),
  remove: () => assert.fail('this file must not remove a path mapping'),
};

/** A `submit` that fails the test if it is ever called -- a listing test must not be silently exercising the add path (`Feeds.test.tsx`'s own `neverSubmit`). */
function neverSubmit(): Promise<AddDownloadClientOutcome> {
  assert.fail('a listing test must not call submit');
}

function submitFor(outcome: AddDownloadClientOutcome): (input: AddDownloadClientInput) => Promise<AddDownloadClientOutcome> {
  return () => Promise.resolve(outcome);
}

function fillClientForm({ name = 'Seedbox', url = 'http://qbit.example:8080' } = {}): void {
  fireEvent.change(screen.getByLabelText('Client name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: url } });
  fireEvent.change(screen.getByLabelText('Api key'), { target: { value: 'test-api-key-c4f2a1' } });
}

function submitForm(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Add download client' }));
}

test('the list shows a client by name, implementation and address, from the replica', async () => {
  const db = await freshDb();
  await seed(db, [clientOp({ id: 1, name: 'Seedbox', implementation: 'qbittorrent', url: 'http://qbit.example:8080' })]);
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);

  await waitFor(() => {
    // A length check, not `assert.ok(getByRole(...))`: the latter can only
    // ever pass once the query stops throwing, which proves nothing beyond
    // "found at least one" -- this also catches a duplicate render.
    assert.equal(screen.getAllByRole('heading', { name: 'Seedbox' }).length, 1, 'the client is named, exactly once');
  });
  assert.equal(screen.getByText('http://qbit.example:8080').tagName, 'P',
    'the address is shown as the host projected it, as its own line of text');
  // Scoped to the list: the add form's own implementation `<option>`
  // carries the same word, and an unscoped `getByText` would match both and
  // throw -- which would be a test failing on its own query rather than on
  // the component.
  const listed = within(screen.getByRole('list', { name: 'download clients' }));
  assert.ok(listed.getByText('qBittorrent'), 'the implementation reads as this client\'s own word for the product, not the wire code');
});

test('an implementation this build has no word for is still shown, as the host spelled it', async () => {
  // `DownloadClientSyncRead.implementation` is a `string`, not a union: a
  // replica outlives a build, and a host that grows a third adapter must
  // not make this list render a blank line where a name belongs.
  const db = await freshDb();
  await seed(db, [clientOp({ id: 1, name: 'Seedbox', implementation: 'transmission' })]);
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);

  await waitFor(() => {
    assert.ok(screen.getByText('transmission'), 'the unrecognised implementation is shown verbatim');
  });
});

test('a client with a username says so, and one with none says nothing about a credential', async () => {
  // Design spec §5: no secret name is projected, so the only thing this
  // list can honestly say about authentication is the username it was
  // given. It never claims an api key is on file, because nothing in the
  // projection would show it one.
  const db = await freshDb();
  await seed(db, [
    clientOp({ id: 1, name: 'Logs in', username: 'admin' }),
    clientOp({ id: 2, name: 'Bearer', username: null }),
  ]);
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);

  await waitFor(() => {
    assert.ok(screen.getByText('Signs in as admin'));
  });
  const bearer = screen.getByRole('heading', { name: 'Bearer' }).closest('li');
  assert.ok(bearer !== null, 'the client is rendered as a list item');
  assert.ok(!/signs in as/i.test(bearer.textContent ?? ''), 'no username, no claim about one');
});

test('a blank category and a blank address each read as the configuration they are', async () => {
  // `''` is a real answer in both columns and neither may render as an
  // empty line: the category means "file downloads under no category"
  // (`clients/add.ts`), and the address means the stored url was not an
  // http address at all (`DownloadClientSyncRead`'s own doc).
  const db = await freshDb();
  await seed(db, [clientOp({ id: 1, name: 'Seedbox', url: '', category: '' })]);
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);

  await waitFor(() => {
    assert.ok(screen.getByText('No address recorded.'));
  });
  assert.ok(screen.getByText('No category'));
});

test('a category is named where there is one', async () => {
  const db = await freshDb();
  await seed(db, [clientOp({ id: 1, name: 'Seedbox', category: 'movies' })]);
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);

  await waitFor(() => {
    assert.ok(screen.getByText('Category: movies'));
  });
});

test('a client row replicated before migration 25, with no health fields, is still listed', async () => {
  // Review Focus 1: ADD COLUMN touches no existing row, so a replica can hold
  // a download_client row with neither key until that row next changes.
  const db = await freshDb();
  await seed(db, [clientOp({ id: 1, name: 'Old row' })]); // no health keys
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);
  await waitFor(() => {
    assert.ok(screen.queryByRole('heading', { name: 'Old row' }), 'the row is not dropped');
  });
  // Review Focus 1, in full: missing keys must read as no failures, not as
  // an unreachable client or a blank line.
  const row = screen.getByRole('heading', { name: 'Old row' }).closest('li')?.textContent ?? '';
  assert.ok(row.includes('Reachable'), 'a missing consecutiveFailures/unreachableSince reads as no failures');
});

test('a client under the threshold reads Reachable, and one at it reads Unreachable since, as visible text', async () => {
  const db = await freshDb();
  await seed(db, [
    clientOp({ id: 1, name: 'Flaky', consecutiveFailures: 2, unreachableSince: 1_700_000_000_000 }),
    clientOp({ id: 2, name: 'Down', consecutiveFailures: 3, unreachableSince: 1_700_000_000_000 }),
  ]);
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);
  await waitFor(() => {
    assert.ok(screen.queryByRole('heading', { name: 'Down' }));
  });
  const itemText = (name: string): string =>
    screen.getByRole('heading', { name }).closest('li')?.textContent ?? '';
  assert.ok(itemText('Flaky').includes('Reachable'), 'two failures is still reachable');
  assert.match(itemText('Down'), /Unreachable since .+ \(3 failed checks\)/);

  // settings.css keys every download-client rule by structure or by an ARIA
  // attribute, never by a class (that file's own docblock, asserted there
  // with a repo-wide `grep -rn className`), so this line is found and styled
  // the same way -- not through a class this component would be the first
  // to add.
  const line = [...(screen.getByRole('heading', { name: 'Down' }).closest('li')?.querySelectorAll('p') ?? [])]
    .find((p) => (p.textContent ?? '').startsWith('Unreachable'));
  assert.ok(line !== undefined, 'the line is a real element');
  assert.ok(!line.hasAttribute('aria-label'), 'visible text, not an aria-label');
  const selector = "ul[aria-label='download clients'] li h3 + p + p";
  assert.ok(line.matches(selector), 'it is the element the stylesheet styles, right after the implementation line');

  // And that rule exists (`App.test.tsx`'s technique for `base.css`'s
  // session notice, copied here for `settings.css`'s health line).
  const css = await readFile(join(import.meta.dirname, '..', '..', 'src', 'styles', 'settings.css'), 'utf8');
  assert.ok(css.includes(`${selector} {`), 'settings.css styles the health line, so it is not an unstyled line of text');
});

test('healthLine names the failure count and the start of the streak', () => {
  assert.equal(healthLine({ consecutiveFailures: 0, unreachableSince: null }), 'Reachable');
  const text = healthLine({ consecutiveFailures: 4, unreachableSince: 1_700_000_000_000 });
  assert.ok(text.startsWith('Unreachable since '));
  assert.ok(text.endsWith('(4 failed checks)'));
});

test('clicking Add download client calls submit, and the row appears through the replica\'s own subscription, not a refetch', async () => {
  // The payoff of syncing the table: the POST answers only "accepted", and
  // the row arrives through the replica's own subscription -- `submit` does
  // not touch `db` at all. Counting the calls is what proves the click
  // fired the request: without it the seeded row would appear regardless.
  const db = await freshDb();
  let submitCalls = 0;
  render(
    <DownloadClients
      source={sourceFor(db)}
      submit={() => {
        submitCalls += 1;
        return Promise.resolve({ id: 1 });
      }}
      submitMapping={neverSubmitMapping}
    />,
  );
  fillClientForm();
  submitForm();

  await waitFor(() => {
    assert.equal(submitCalls, 1, 'the click actually invoked submit');
  });

  await seed(db, [clientOp({ id: 1, name: 'Seedbox' })]);
  await waitFor(() => {
    assert.equal(
      screen.getAllByRole('heading', { name: 'Seedbox' }).length,
      1,
      'the seeded row rendered, exactly once, not anything submit itself produced',
    );
  });
});

test('each refusal reads as its own sentence, and offline and unrecognised read differently again', async () => {
  // Seven outcomes, seven sentences no other outcome produces. A collapsed map
  // -- every refusal answering with one sentence -- is what this catches.
  const seen: string[] = [];
  for (const outcome of [
    { refusal: 'unknown-implementation' },
    { refusal: 'bad-auth-shape' },
    { refusal: 'duplicate-name' },
    { refusal: 'bad-url' },
    { refusal: 'offline' },
    { refusal: 'expired' },
    { refusal: 'unrecognised' },
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- each iteration renders, asserts and cleans up before the next; the seven outcomes cannot run concurrently against the one shared `screen` (`Feeds.test.tsx`'s own refusal walk takes the identical exception for the identical reason).
    const db = await freshDb();
    render(<DownloadClients source={sourceFor(db)} submit={submitFor(outcome)} submitMapping={neverSubmitMapping} />);
    fillClientForm();
    submitForm();
    // eslint-disable-next-line no-await-in-loop -- see above
    const alert = await screen.findByRole('alert');
    seen.push(alert.textContent ?? '');
    cleanup();
  }

  assert.equal(new Set(seen).size, 7, 'each of the seven outcomes put a sentence of its own on screen');
  // And the sentences are the ones this client wrote, not something derived
  // from a code the server sent.
  assert.deepEqual(seen.toSorted(), Object.values(REFUSAL_MESSAGES).toSorted());
});

test('the error is legible: the sentence is rendered text, not only an accessible name', async () => {
  // `CLAUDE.md`'s longest hazard: a component once passed ten tests with
  // `role`, an `aria-label`, no visible heading and no stylesheet rule, and
  // the first human to see it read it as an error.
  //
  // `getByText` matches text nodes, so an `aria-label` on an empty element
  // does not satisfy it -- which `findByRole('heading', { name })` would.
  // That is the whole point of this test and the reason it does not use
  // `getByRole`'s `name` option anywhere.
  const db = await freshDb();
  render(<DownloadClients source={sourceFor(db)} submit={submitFor({ refusal: 'duplicate-name' })} submitMapping={neverSubmitMapping} />);
  fillClientForm();
  submitForm();

  const shown = await screen.findByText('A download client with that name is already on file.');
  assert.equal(shown.textContent, 'A download client with that name is already on file.',
    'the element carries real visible text, not just an accessible name');
  assert.ok(screen.getByRole('alert').contains(shown), 'the visible sentence is inside the announced region');
});

test('an empty replica reads as "no download clients yet", not as still loading forever', async () => {
  const db = await freshDb();
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);
  await waitFor(() => {
    assert.equal(screen.getByText(/no download clients yet/i).tagName, 'P',
      'rendered as its own line of text, not merely present in the tree');
  });
});

test('the list never falls back to the network when the replica is empty', async () => {
  // Global Constraint: lists come from the replica only.
  const db = await freshDb();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  try {
    render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);
    await waitFor(() => {
      assert.equal(screen.getByText(/no download clients yet/i).tagName, 'P');
    });
    assert.equal(fetchCalls, 0, 'DownloadClients never called fetch: the list comes from the replica only');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a successful add does not refetch the list either', async () => {
  // The row arrives through the subscription or not at all. A `fetch` here
  // would be the remote fallback the Global Constraint forbids, and it
  // would paper over a replication defect rather than expose it.
  const db = await freshDb();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  try {
    render(<DownloadClients source={sourceFor(db)} submit={submitFor({ id: 1 })} submitMapping={neverSubmitMapping} />);
    fillClientForm();
    submitForm();
    await waitFor(() => {
      assert.equal(screen.getByLabelText<HTMLInputElement>('Client name').value, '', 'the add was accepted');
    });
    assert.equal(fetchCalls, 0, 'nothing went to the network but the POST, and that one is injected');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('each listed client offers its own path mappings, named from its own heading', async () => {
  // The wiring `ClientMappings.test.tsx` cannot see: that this section
  // mounts one per client, hands each the right id, and names each from
  // the heading beside it -- so two clients present two distinguishable
  // expanders rather than two buttons both reading `Path mappings`.
  const db = await freshDb();
  await seed(db, [clientOp({ id: 1, name: 'Seedbox' }), clientOp({ id: 2, name: 'Attic NAS' })]);
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);

  await waitFor(() => {
    assert.equal(screen.getAllByRole('button', { name: /^Path mappings/ }).length, 2, 'one per client');
  });
  const seedbox = screen.getByRole('button', { name: 'Path mappings Seedbox' });
  assert.equal(seedbox.getAttribute('aria-expanded'), 'false', 'collapsed until asked');
  assert.ok(screen.getByRole('button', { name: 'Path mappings Attic NAS' }),
    'and the other client\'s expander is a different control with a different name');

  // Expanding one reaches the replica for that client alone. The mapping
  // below belongs to client 2, so client 1's expansion must not show it.
  await seed(db, [{
    op: 'upsert',
    table: 'filepath_mapping',
    id: 1,
    value: { id: 1, downloadClientId: 2, fromPath: '/nas/done', toPath: '/mnt/nas', createdAt: 1, updatedAt: 1 },
  }]);
  fireEvent.click(seedbox);

  await waitFor(() => {
    assert.ok(screen.getByText(/no path mappings/i), 'client 1 has none of its own');
  });
  assert.ok(!screen.queryByText('/nas/done'), 'and client 2\'s mapping stayed in client 2\'s row');
});
