import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribe, subscribeInserts } from '../../src/store/notify.ts';
import { ClientMappings } from '../../src/settings/ClientMappings.tsx';
import type { ClientMappingsSource } from '../../src/settings/useClientMappings.ts';
import {
  MAPPING_REFUSAL_MESSAGES,
  type AddMappingInput,
  type AddMappingOutcome,
  type EditMappingInput,
  type EditMappingOutcome,
  type MappingSubmit,
  type RemoveMappingOutcome,
} from '../../src/settings/postMapping.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave a `ClientMappings` still
 * mounted, still subscribed through `notify.ts`'s module-level registry --
 * and this component subscribes once per listed mapping as well as once to
 * the table, so a leak here is several.
 */
afterEach(cleanup);

/** Seeds `ops` into `db` in one batch -- the cursor value has no bearing on these tests. */
async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

/**
 * One `upsert` carrying the **projected** `filepath_mapping` shape --
 * `FilepathMappingSyncRead`, not the raw table row: `import_mode` belongs
 * to the importer and is not replicated (design spec §10). An `upsert`
 * rather than a `create` for `Feeds.test.tsx`'s `feedOp` reason: the live
 * tail only ever emits `upsert`.
 */
function mappingOp({
  id,
  downloadClientId = 1,
  fromPath,
  toPath,
  updatedAt = id,
}: {
  id: number;
  downloadClientId?: number;
  fromPath: string;
  toPath: string;
  updatedAt?: number;
}): SyncOp {
  return {
    op: 'upsert',
    table: 'filepath_mapping',
    id,
    value: { id, downloadClientId, fromPath, toPath, createdAt: id, updatedAt },
  };
}

function sourceFor(db: IDBDatabase): ClientMappingsSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribe,
    subscribeInserts,
  };
}

/**
 * A `MappingSubmit` whose three verbs all fail the test, with whichever of
 * them a test actually drives overridden. The default is a failure rather
 * than a no-op so that a test cannot silently exercise a path it did not
 * mean to -- `Feeds.test.tsx`'s `neverSubmit`, widened to three members.
 */
function submits(overrides: Partial<MappingSubmit> = {}): MappingSubmit {
  return {
    add: (): Promise<AddMappingOutcome> => assert.fail('this test must not add a mapping'),
    edit: (): Promise<EditMappingOutcome> => assert.fail('this test must not edit a mapping'),
    remove: (): Promise<RemoveMappingOutcome> => assert.fail('this test must not remove a mapping'),
    ...overrides,
  };
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

/**
 * The component under test, with a real `<h3>` standing in for the one
 * `DownloadClients` renders -- `clientNameId` points at it, so the
 * expander, the list and each row button are all named from text that is
 * genuinely on screen rather than from a duplicated `aria-label`.
 */
function renderMappings(db: IDBDatabase, submit: MappingSubmit, downloadClientId = 1): void {
  render(
    <>
      <h3 id="client-1-name">Seedbox</h3>
      <ClientMappings
        source={sourceFor(db)}
        downloadClientId={downloadClientId}
        clientNameId="client-1-name"
        submit={submit}
      />
    </>,
  );
}

function expander(): HTMLElement {
  return screen.getByRole('button', { name: 'Path mappings Seedbox' });
}

function expand(): void {
  fireEvent.click(expander());
}

function row(fromPath: string): HTMLElement {
  return screen.getByRole('listitem', { name: fromPath });
}

function fillAddForm({ from = '/downloads', to = '/media' } = {}): void {
  const form = screen.getByRole('form', { name: 'Add a path mapping' });
  fireEvent.change(within(form).getByLabelText('Client path'), { target: { value: from } });
  fireEvent.change(within(form).getByLabelText('Host path'), { target: { value: to } });
}

function submitAddForm(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Add path mapping' }));
}

test('a client\'s row expands to its mappings, read from the replica', async () => {
  const db = await freshDb();
  await seed(db, [mappingOp({ id: 1, fromPath: '/downloads/complete', toPath: '/mnt/media' })]);
  renderMappings(db, submits());

  assert.equal(expander().getAttribute('aria-expanded'), 'false', 'collapsed until asked');
  assert.ok(!screen.queryByText('/downloads/complete'), 'and nothing of the mapping is on screen yet');

  expand();

  assert.equal(expander().getAttribute('aria-expanded'), 'true');
  await waitFor(() => {
    assert.equal(screen.getAllByText('/downloads/complete').length, 1, 'the client path, exactly once');
  });
  assert.ok(screen.getByText('/mnt/media'), 'and the host path it becomes');
  // A list of its own, named from the expander's visible words and the
  // client's own heading -- so two expanded clients do not present two
  // lists with the same name.
  assert.ok(screen.getByRole('list', { name: 'Path mappings Seedbox' }));
});

test('only the expanded client\'s own mappings are listed', async () => {
  const db = await freshDb();
  await seed(db, [
    mappingOp({ id: 1, downloadClientId: 1, fromPath: '/mine', toPath: '/media' }),
    mappingOp({ id: 2, downloadClientId: 2, fromPath: '/theirs', toPath: '/other' }),
  ]);
  renderMappings(db, submits());
  expand();

  await waitFor(() => {
    assert.ok(screen.getByText('/mine'));
  });
  assert.ok(!screen.queryByText('/theirs'), 'a mapping is meaningless away from its client (design spec §8)');
});

test('adding one puts it in the list without a refetch', async () => {
  // The payoff of syncing the table: the POST answers only an id, and the
  // row arrives through the replica's own subscription. `submit` never
  // touches `db`, and nothing here calls `fetch`.
  const db = await freshDb();
  const seen: AddMappingInput[] = [];
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  try {
    renderMappings(db, submits({
      add: (input) => {
        seen.push(input);
        return Promise.resolve({ id: 7 });
      },
    }));
    expand();
    await waitFor(() => {
      assert.ok(screen.getByRole('form', { name: 'Add a path mapping' }));
    });
    fillAddForm({ from: '/downloads', to: '/mnt/media' });
    submitAddForm();

    await waitFor(() => {
      assert.equal(seen.length, 1, 'the click actually invoked the add');
    });
    assert.deepEqual(seen[0], { downloadClientId: 1, fromPath: '/downloads', toPath: '/mnt/media' });
    assert.ok(!screen.queryByText('/downloads'), 'and nothing was put on screen that the replica had not confirmed');

    await seed(db, [mappingOp({ id: 7, fromPath: '/downloads', toPath: '/mnt/media' })]);
    await waitFor(() => {
      assert.equal(screen.getAllByText('/downloads').length, 1,
        'the replicated row rendered, exactly once, not anything submit itself produced');
    });
    assert.equal(fetchCalls, 0, 'no refetch: the list comes from the replica only');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a successful add clears the form, so the next mapping starts blank', async () => {
  const db = await freshDb();
  renderMappings(db, submits({ add: () => Promise.resolve({ id: 7 }) }));
  expand();
  await waitFor(() => {
    assert.ok(screen.getByRole('form', { name: 'Add a path mapping' }));
  });
  fillAddForm({ from: '/downloads', to: '/mnt/media' });
  submitAddForm();

  await waitFor(() => {
    const form = screen.getByRole('form', { name: 'Add a path mapping' });
    assert.equal(within(form).getByLabelText<HTMLInputElement>('Client path').value, '');
  });
  const form = screen.getByRole('form', { name: 'Add a path mapping' });
  assert.equal(within(form).getByLabelText<HTMLInputElement>('Host path').value, '');
});

test('editing one updates it in place', async () => {
  const db = await freshDb();
  await seed(db, [mappingOp({ id: 7, fromPath: '/downloads', toPath: '/media' })]);
  const seen: { id: number; input: EditMappingInput }[] = [];
  renderMappings(db, submits({
    edit: (id, input) => {
      seen.push({ id, input });
      return Promise.resolve({ id });
    },
  }));
  expand();
  await waitFor(() => {
    assert.ok(screen.getByText('/downloads'));
  });

  fireEvent.click(within(row('/downloads')).getByRole('button', { name: 'Edit /downloads' }));
  const editing = within(row('/downloads'));
  assert.equal(editing.getByLabelText<HTMLInputElement>('Host path').value, '/media',
    'the form opens holding what the mapping says today');
  fireEvent.change(editing.getByLabelText('Host path'), { target: { value: '/tank/media' } });
  fireEvent.click(editing.getByRole('button', { name: 'Save /downloads' }));

  await waitFor(() => {
    assert.equal(seen.length, 1);
  });
  assert.deepEqual(seen[0], { id: 7, input: { fromPath: '/downloads', toPath: '/tank/media' } });
  assert.ok(!screen.queryByText('/tank/media'), 'the screen still shows what the replica holds, not what was sent');

  await seed(db, [mappingOp({ id: 7, fromPath: '/downloads', toPath: '/tank/media', updatedAt: 9 })]);
  await waitFor(() => {
    assert.ok(screen.getByText('/tank/media'), 'the edited row updates in place, through the subscription');
  });
  assert.ok(!screen.queryByText('/media'), 'and the value it replaced is gone');
  assert.equal(screen.getAllByRole('listitem').length, 1, 'in place: one row before, one row after');
  assert.ok(!within(row('/downloads')).queryByRole('button', { name: 'Save /downloads' }),
    'and the edit form closed when the edit was accepted');
});

test('removing one takes it out of the list', async () => {
  const db = await freshDb();
  await seed(db, [
    mappingOp({ id: 7, fromPath: '/downloads', toPath: '/media' }),
    mappingOp({ id: 8, fromPath: '/incomplete', toPath: '/staging' }),
  ]);
  const removed: number[] = [];
  renderMappings(db, submits({
    remove: (id) => {
      removed.push(id);
      return Promise.resolve({ removed: true });
    },
  }));
  expand();
  await waitFor(() => {
    assert.equal(screen.getAllByRole('listitem').length, 2);
  });

  fireEvent.click(within(row('/downloads')).getByRole('button', { name: 'Remove /downloads' }));

  await waitFor(() => {
    assert.deepEqual(removed, [7]);
  });
  assert.ok(screen.queryByText('/downloads'), 'still listed: the replica has not said it is gone yet');

  await seed(db, [{ op: 'delete', table: 'filepath_mapping', id: 7 }]);
  await waitFor(() => {
    assert.ok(!screen.queryByText('/downloads'), 'the tombstone is what takes it off the screen');
  });
  assert.ok(screen.getByText('/incomplete'), 'and the client\'s other mapping is untouched');
});

test('a Windows-shaped path renders unchanged, in the list and in the form that edits it', async () => {
  // Design spec §7: these are *foreign* paths, and `clients/paths.ts`
  // refuses `node:path` for exactly that reason. The UI must not be
  // stricter than the consumer -- no normalisation, no slash-flipping, no
  // trimming that changes meaning.
  const db = await freshDb();
  await seed(db, [mappingOp({ id: 7, fromPath: 'D:\\Downloads', toPath: '\\\\nas\\media ' })]);
  const seen: EditMappingInput[] = [];
  renderMappings(db, submits({
    edit: (id, input) => {
      seen.push(input);
      return Promise.resolve({ id });
    },
  }));
  expand();

  await waitFor(() => {
    assert.ok(screen.getByText('D:\\Downloads'));
  });
  const shown = screen.getByText('D:\\Downloads');
  assert.equal(shown.textContent, 'D:\\Downloads', 'byte for byte, backslashes and drive letter intact');
  assert.ok(!screen.queryByText('D:/Downloads'), 'nothing flipped a separator');
  // The trailing space is deliberate: a UI that trims changes which paths
  // this mapping matches, and the host does not trim either. The identity
  // `normalizer` is what lets this see that -- `getByText`'s default one
  // trims and collapses whitespace, so the query itself would hide exactly
  // the character under test.
  assert.equal(
    screen.getByText('\\\\nas\\media ', { normalizer: (text) => text }).textContent,
    '\\\\nas\\media ',
    'the trailing space survived: trimming it would change which paths this mapping matches',
  );

  fireEvent.click(within(row('D:\\Downloads')).getByRole('button', { name: 'Edit D:\\Downloads' }));
  const editing = within(row('D:\\Downloads'));
  assert.equal(editing.getByLabelText<HTMLInputElement>('Client path').value, 'D:\\Downloads',
    'the form is prefilled with the stored string, unaltered');
  assert.equal(editing.getByLabelText<HTMLInputElement>('Host path').value, '\\\\nas\\media ');

  fireEvent.click(editing.getByRole('button', { name: 'Save D:\\Downloads' }));
  await waitFor(() => {
    assert.equal(seen.length, 1);
  });
  assert.deepEqual(seen[0], { fromPath: 'D:\\Downloads', toPath: '\\\\nas\\media ' },
    'and it goes back to the host exactly as it arrived');
});

test('each refusal reads as its own sentence, and offline and unrecognised read differently again', async () => {
  // Six outcomes, six sentences no other outcome produces. A collapsed map
  // -- every refusal answering with one sentence -- is what this catches.
  //
  // All six are driven through the add control because the sentence map is
  // one map shared by all three controls; `unknown-mapping` is not an
  // answer `POST /api/mappings` can really give, and the test below drives
  // that one through the control that can.
  const seen: string[] = [];
  for (const outcome of [
    { refusal: 'unknown-client' },
    { refusal: 'duplicate-from-path' },
    { refusal: 'unknown-mapping' },
    { refusal: 'empty-path' },
    { refusal: 'offline' },
    { refusal: 'unrecognised' },
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- each iteration renders, asserts and cleans up before the next; the six outcomes cannot run concurrently against the one shared `screen` (`DownloadClients.test.tsx`'s own refusal walk takes the identical exception for the identical reason).
    const db = await freshDb();
    renderMappings(db, submits({ add: () => Promise.resolve(outcome) }));
    expand();
    // eslint-disable-next-line no-await-in-loop -- see above
    await waitFor(() => {
      assert.ok(screen.getByRole('form', { name: 'Add a path mapping' }));
    });
    fillAddForm();
    submitAddForm();
    // eslint-disable-next-line no-await-in-loop -- see above
    const alert = await screen.findByRole('alert');
    seen.push(alert.textContent ?? '');
    cleanup();
  }

  assert.equal(new Set(seen).size, 6, 'each of the six outcomes put a sentence of its own on screen');
  // And the sentences are the ones this client wrote, not something derived
  // from a code the server sent.
  assert.deepEqual(seen.toSorted(), Object.values(MAPPING_REFUSAL_MESSAGES).toSorted());
});

test('a refused removal says which rule was broken, in the row it was asked of', async () => {
  const db = await freshDb();
  await seed(db, [mappingOp({ id: 7, fromPath: '/downloads', toPath: '/media' })]);
  renderMappings(db, submits({ remove: () => Promise.resolve({ refusal: 'unknown-mapping' }) }));
  expand();
  await waitFor(() => {
    assert.ok(screen.getByText('/downloads'));
  });

  fireEvent.click(within(row('/downloads')).getByRole('button', { name: 'Remove /downloads' }));

  await waitFor(() => {
    assert.ok(within(row('/downloads')).getByRole('alert'));
  });
  assert.equal(
    within(row('/downloads')).getByRole('alert').textContent,
    MAPPING_REFUSAL_MESSAGES['unknown-mapping'],
  );
});

test('the error is legible: the sentence is rendered text, not only an accessible name', async () => {
  // `CLAUDE.md`'s longest hazard: a component once passed ten tests with
  // `role`, an `aria-label`, no visible heading and no stylesheet rule, and
  // the first human to see it read it as an error.
  //
  // `getByText` matches text nodes, so an `aria-label` on an empty element
  // does not satisfy it -- which `findByRole('alert', { name })` would.
  // That is the whole point of this test and the reason it uses no `name`
  // option anywhere.
  const db = await freshDb();
  renderMappings(db, submits({ add: () => Promise.resolve({ refusal: 'duplicate-from-path' }) }));
  expand();
  await waitFor(() => {
    assert.ok(screen.getByRole('form', { name: 'Add a path mapping' }));
  });
  fillAddForm();
  submitAddForm();

  const sentence = MAPPING_REFUSAL_MESSAGES['duplicate-from-path'];
  const shown = await screen.findByText(sentence);
  assert.equal(shown.textContent, sentence, 'the element carries real visible text, not just an accessible name');
  assert.ok(screen.getByRole('alert').contains(shown), 'the visible sentence is inside the announced region');
});

test('every control re-enables after every outcome, including a submit that rejects outright', async () => {
  // `submit` is an injected async function and any implementation of it may
  // reject. A refusal that left the control disabled with nothing on screen
  // is precisely how the feeds slice wedged its form on five of six real
  // host answers.
  const outcomes: (AddMappingOutcome | 'reject')[] = [
    { id: 7 },
    { refusal: 'duplicate-from-path' },
    { refusal: 'offline' },
    { refusal: 'unrecognised' },
    'reject',
  ];
  for (const outcome of outcomes) {
    // eslint-disable-next-line no-await-in-loop -- one shared `screen`; see the refusal walk above.
    const db = await freshDb();
    renderMappings(db, submits({
      add: () => (outcome === 'reject' ? Promise.reject(new Error('boom')) : Promise.resolve(outcome)),
    }));
    expand();
    // eslint-disable-next-line no-await-in-loop -- see above
    await waitFor(() => {
      assert.ok(screen.getByRole('form', { name: 'Add a path mapping' }));
    });
    fillAddForm();
    submitAddForm();
    // eslint-disable-next-line no-await-in-loop -- see above
    await waitFor(() => {
      assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: 'Add path mapping' }).disabled, false,
        'the add button came back');
    });
    cleanup();
  }

  // And the same for a row's own two controls, against the outcome most
  // likely to be forgotten: a rejection, which no `catch` on the happy path
  // would see.
  const db = await freshDb();
  await seed(db, [mappingOp({ id: 7, fromPath: '/downloads', toPath: '/media' })]);
  renderMappings(db, submits({ remove: () => Promise.reject(new Error('boom')) }));
  expand();
  await waitFor(() => {
    assert.ok(screen.getByText('/downloads'));
  });
  fireEvent.click(within(row('/downloads')).getByRole('button', { name: 'Remove /downloads' }));

  await waitFor(() => {
    assert.equal(
      within(row('/downloads')).getByRole<HTMLButtonElement>('button', { name: 'Remove /downloads' }).disabled,
      false,
      'the remove button came back after a rejection nothing answered',
    );
  });
  assert.equal(
    within(row('/downloads')).getByRole<HTMLButtonElement>('button', { name: 'Edit /downloads' }).disabled,
    false,
    'and so did the edit button beside it',
  );
  assert.equal(within(row('/downloads')).getByRole('alert').textContent, MAPPING_REFUSAL_MESSAGES.offline,
    'a rejection reads as the unreachable sentence, not as silence');
});

test('acting on one mapping leaves the others alone', async () => {
  // A shared pending flag, or a shared editing flag, would pass almost
  // every other test in this file: with one mapping on screen there is
  // nothing for it to spill onto.
  const db = await freshDb();
  await seed(db, [
    mappingOp({ id: 7, fromPath: '/downloads', toPath: '/media' }),
    mappingOp({ id: 8, fromPath: '/incomplete', toPath: '/staging' }),
  ]);
  const held = deferred<RemoveMappingOutcome>();
  renderMappings(db, submits({ remove: () => held.promise }));
  expand();
  await waitFor(() => {
    assert.equal(screen.getAllByRole('listitem').length, 2);
  });

  fireEvent.click(within(row('/downloads')).getByRole('button', { name: 'Remove /downloads' }));

  await waitFor(() => {
    assert.equal(
      within(row('/downloads')).getByRole<HTMLButtonElement>('button', { name: 'Remove /downloads' }).disabled,
      true,
      'the mapping being removed is the one whose controls go quiet',
    );
  });
  assert.equal(
    within(row('/incomplete')).getByRole<HTMLButtonElement>('button', { name: 'Remove /incomplete' }).disabled,
    false,
    'the other mapping is still removable while this one is in flight',
  );
  assert.equal(
    within(row('/incomplete')).getByRole<HTMLButtonElement>('button', { name: 'Edit /incomplete' }).disabled,
    false,
    'and still editable',
  );
  assert.equal(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Add path mapping' }).disabled,
    false,
    'and the add form is not this row\'s to disable either',
  );

  held.settle({ refusal: 'unknown-mapping' });
  await waitFor(() => {
    assert.ok(within(row('/downloads')).getByRole('alert'));
  });
  assert.ok(!within(row('/incomplete')).queryByRole('alert'),
    'one mapping\'s refusal is not announced against another');

  // Editing is per-row for the same reason, and would otherwise open both.
  fireEvent.click(within(row('/incomplete')).getByRole('button', { name: 'Edit /incomplete' }));
  assert.ok(within(row('/incomplete')).getByRole('button', { name: 'Save /incomplete' }));
  assert.ok(!within(row('/downloads')).queryByRole('button', { name: 'Save /downloads' }),
    'the other row did not open a form nobody asked it to');
});

test('a client with no mappings says so', async () => {
  // Zero is an answer, and it must not render as an empty list with no
  // explanation -- the same rule `DownloadClients` keeps for a replica with
  // no clients in it.
  const db = await freshDb();
  renderMappings(db, submits());
  expand();

  await waitFor(() => {
    assert.equal(screen.getByText(/no path mappings/i).tagName, 'P',
      'rendered as its own line of text, not merely present in the tree');
  });
  assert.ok(!screen.queryByRole('list', { name: 'Path mappings Seedbox' }),
    'and there is no empty list sitting beside the sentence');
});

test('cancelling an edit leaves the mapping as it was, and asks the host nothing', async () => {
  const db = await freshDb();
  await seed(db, [mappingOp({ id: 7, fromPath: '/downloads', toPath: '/media' })]);
  renderMappings(db, submits());
  expand();
  await waitFor(() => {
    assert.ok(screen.getByText('/downloads'));
  });

  fireEvent.click(within(row('/downloads')).getByRole('button', { name: 'Edit /downloads' }));
  fireEvent.change(within(row('/downloads')).getByLabelText('Host path'), { target: { value: '/somewhere/else' } });
  fireEvent.click(within(row('/downloads')).getByRole('button', { name: 'Cancel /downloads' }));

  assert.ok(!within(row('/downloads')).queryByRole('button', { name: 'Save /downloads' }), 'the form closed');
  assert.ok(screen.getByText('/media'), 'and the mapping still reads as the replica holds it');

  // Reopening starts from the stored value again, not from the abandoned
  // edit -- otherwise Cancel only hides a change it did not discard.
  fireEvent.click(within(row('/downloads')).getByRole('button', { name: 'Edit /downloads' }));
  assert.equal(within(row('/downloads')).getByLabelText<HTMLInputElement>('Host path').value, '/media');
});

test('the form does not refuse an empty path itself: the host owns that rule', async () => {
  // Design spec §7 -- `empty-path` is the one path-content rule there is,
  // and it lives in the host with every other value-level invariant. A
  // `required` attribute here would make that refusal unreachable from this
  // screen and its sentence dead text.
  const db = await freshDb();
  const seen: AddMappingInput[] = [];
  renderMappings(db, submits({
    add: (input) => {
      seen.push(input);
      return Promise.resolve({ refusal: 'empty-path' });
    },
  }));
  expand();
  await waitFor(() => {
    assert.ok(screen.getByRole('form', { name: 'Add a path mapping' }));
  });
  submitAddForm();

  await waitFor(() => {
    assert.deepEqual(seen, [{ downloadClientId: 1, fromPath: '', toPath: '' }]);
  });
  assert.equal((await screen.findByRole('alert')).textContent, MAPPING_REFUSAL_MESSAGES['empty-path']);
});
