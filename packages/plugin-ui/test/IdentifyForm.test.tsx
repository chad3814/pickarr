import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { IdentifyRequest } from '@pickarr/contract';
import { IdentifyForm } from '../src/IdentifyForm.tsx';
import {
  IDENTIFY_REFUSAL_MESSAGES,
  SUGGEST_DEBOUNCE_MS,
  SUGGEST_LIMIT,
  type Candidate,
  type IdentifyOutcome,
  type IdentifySubmit,
} from '../src/types.ts';

const realSetTimeout = globalThis.setTimeout;

afterEach(() => {
  cleanup();
  globalThis.setTimeout = realSetTimeout;
});

interface Stub {
  identify: IdentifySubmit;
  requests: { rssItemId: number; request: IdentifyRequest }[];
  suggestCalls: { pluginId: string; term: string }[];
}

/** `suggest` answers through `answer`, which a test may swap for a held promise; `identify` records and answers through `outcome`. */
function stubIdentify(
  answer: (term: string) => Promise<readonly Candidate[]>,
  outcome: () => Promise<IdentifyOutcome> = () => Promise.resolve({ accepted: true }),
): Stub {
  const stub: Stub = {
    requests: [],
    suggestCalls: [],
    identify: {
      identify(rssItemId, request) {
        stub.requests.push({ rssItemId, request });
        return outcome();
      },
      suggest(pluginId, term) {
        stub.suggestCalls.push({ pluginId, term });
        return answer(term);
      },
    },
  };
  return stub;
}

const DUNE: readonly Candidate[] = [
  { mediaItemId: 11, title: 'Dune', year: '2021' },
  { mediaItemId: 12, title: 'Dune: Part Two', year: '2024' },
  { mediaItemId: 13, title: 'Untitled', year: null },
];

function renderForm(
  identify: IdentifySubmit,
  handlers: { onDone?: () => void; onCancel?: () => void } = {},
): void {
  render(
    <IdentifyForm
      pluginId="tv"
      rssItemId={7}
      identify={identify}
      onDone={handlers.onDone ?? (() => {})}
      onCancel={handlers.onCancel ?? (() => {})}
    />,
  );
}

function combobox(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('combobox', { name: 'Title' });
}

/** Types into the combobox and waits for `suggest` to have been asked `calls` times in all. */
async function type(stub: Stub, text: string, calls: number): Promise<void> {
  fireEvent.change(combobox(), { target: { value: text } });
  await waitFor(() => {
    assert.equal(stub.suggestCalls.length, calls);
  });
}

function optionTexts(): (string | null)[] {
  return screen.queryAllByRole('option').map((o) => o.textContent);
}

function save(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
}

test('renders a labelled combobox with the ARIA wiring and an empty, closed list', () => {
  renderForm(stubIdentify(() => Promise.resolve([])).identify);

  const input = combobox();
  assert.equal(input.getAttribute('aria-autocomplete'), 'list');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(input.getAttribute('autocomplete'), 'off');
  assert.ok(!input.hasAttribute('aria-activedescendant'), 'a closed list names no active option');
  const listboxId = input.getAttribute('aria-controls');
  assert.ok(listboxId !== null && listboxId !== '', 'the combobox names a listbox');
  const listbox = document.getElementById(listboxId);
  assert.equal(listbox?.getAttribute('role'), 'listbox');
  assert.ok(listbox?.hidden === true, 'the list is closed');
  assert.equal(listbox?.children.length, 0, 'and empty');
  assert.ok(save().disabled, 'Save needs something typed');
});

test('typing asks suggest after the debounce, for the plugin, and lists up to eight candidates plus the look-up option', async () => {
  const delays: unknown[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
    delays.push(delay);
    return realSetTimeout(handler, delay, ...rest);
  }) as typeof setTimeout;
  const many: Candidate[] = [];
  for (let i = 1; i <= 12; i += 1) many.push({ mediaItemId: i, title: `Dune ${String(i)}`, year: null });
  const first = stubIdentify(() => Promise.resolve(DUNE));
  renderForm(first.identify);

  await type(first, 'dune', 1);
  await waitFor(() => {
    assert.equal(optionTexts().length, 4);
  });

  assert.ok(delays.includes(SUGGEST_DEBOUNCE_MS), 'the lookup waited the debounce');
  assert.deepEqual(first.suggestCalls, [{ pluginId: 'tv', term: 'dune' }]);
  assert.deepEqual(optionTexts(), ['Dune (2021)', 'Dune: Part Two (2024)', 'Untitled', 'Look up as "dune"']);
  assert.equal(combobox().getAttribute('aria-expanded'), 'true');
  cleanup();

  const capped = stubIdentify(() => Promise.resolve(many));
  renderForm(capped.identify);
  await type(capped, 'dune', 1);
  await waitFor(() => {
    assert.equal(optionTexts().length, SUGGEST_LIMIT + 1);
  });
});

test('arrow keys move the highlight with wrapping and aria-activedescendant follows; Enter chooses; Escape closes the list but keeps the form and the input', async () => {
  let cancelled = 0;
  const stub = stubIdentify(() => Promise.resolve(DUNE));
  renderForm(stub.identify, {
    onCancel: () => {
      cancelled += 1;
    },
  });
  await type(stub, 'dune', 1);
  await waitFor(() => {
    assert.equal(optionTexts().length, 4);
  });

  const selected = (): (string | null)[] =>
    screen.queryAllByRole('option').map((o) => o.getAttribute('aria-selected'));
  const activeIsOption = (index: number): boolean =>
    combobox().getAttribute('aria-activedescendant') === screen.queryAllByRole('option')[index]?.id;

  assert.deepEqual(selected(), ['true', 'false', 'false', 'false']);
  assert.ok(activeIsOption(0));

  fireEvent.keyDown(combobox(), { key: 'ArrowUp' });
  assert.deepEqual(selected(), ['false', 'false', 'false', 'true'], 'up from the first wraps to the look-up option');
  assert.ok(activeIsOption(3));

  fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
  assert.deepEqual(selected(), ['true', 'false', 'false', 'false'], 'down from the last wraps to the first');

  fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
  assert.ok(activeIsOption(1));
  fireEvent.keyDown(combobox(), { key: 'Enter' });
  assert.equal(combobox().value, 'Dune: Part Two', 'Enter chose the highlighted title');
  assert.equal(combobox().getAttribute('aria-expanded'), 'false');
  assert.ok(!combobox().hasAttribute('aria-activedescendant'));

  fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
  assert.equal(combobox().getAttribute('aria-expanded'), 'true', 'an arrow reopens a closed list');
  fireEvent.keyDown(combobox(), { key: 'Escape' });
  assert.equal(combobox().getAttribute('aria-expanded'), 'false', 'Escape closes the list');
  assert.equal(combobox().value, 'Dune: Part Two', 'and keeps what was typed');
  assert.equal(cancelled, 0, 'and does not close the form');
});

test('choosing a candidate posts media-item; choosing the look-up option posts name, trimmed', async () => {
  const picked = stubIdentify(() => Promise.resolve(DUNE));
  renderForm(picked.identify);
  await type(picked, 'dune', 1);
  await waitFor(() => {
    assert.equal(optionTexts().length, 4);
  });
  fireEvent.mouseDown(screen.getByRole('option', { name: 'Dune: Part Two (2024)' }));
  fireEvent.click(save());
  await waitFor(() => {
    assert.equal(picked.requests.length, 1);
  });
  assert.deepEqual(picked.requests, [{ rssItemId: 7, request: { mode: 'media-item', mediaItemId: 12 } }]);
  cleanup();

  const named = stubIdentify(() => Promise.resolve(DUNE));
  renderForm(named.identify);
  await type(named, '  Dune   Part Two ', 1);
  await waitFor(() => {
    assert.equal(optionTexts().length, 4);
  });
  const lookUp = screen.getAllByRole('option').at(-1);
  assert.equal(lookUp?.textContent, 'Look up as "Dune   Part Two"', 'the typed text, trimmed, whitespace kept');
  assert.ok(lookUp !== undefined);
  fireEvent.mouseDown(lookUp);
  fireEvent.click(save());
  await waitFor(() => {
    assert.equal(named.requests.length, 1);
  });
  assert.deepEqual(named.requests, [{ rssItemId: 7, request: { mode: 'name', name: 'Dune   Part Two' } }]);
});

test('editing after a choice reverts to name mode', async () => {
  const stub = stubIdentify(() => Promise.resolve(DUNE));
  renderForm(stub.identify);
  await type(stub, 'dune', 1);
  await waitFor(() => {
    assert.equal(optionTexts().length, 4);
  });
  fireEvent.mouseDown(screen.getByRole('option', { name: 'Dune (2021)' }));
  fireEvent.change(combobox(), { target: { value: 'Dune 1984' } });
  fireEvent.click(save());
  await waitFor(() => {
    assert.equal(stub.requests.length, 1);
  });
  assert.deepEqual(stub.requests, [{ rssItemId: 7, request: { mode: 'name', name: 'Dune 1984' } }]);
});

test('a stale suggestion response is ignored', async () => {
  const resolvers = new Map<string, (found: readonly Candidate[]) => void>();
  const stub = stubIdentify(
    (term) =>
      new Promise<readonly Candidate[]>((resolve) => {
        resolvers.set(term, resolve);
      }),
  );
  renderForm(stub.identify);
  await type(stub, 'du', 1);
  await type(stub, 'dune', 2);

  const answerDune = resolvers.get('dune');
  const answerDu = resolvers.get('du');
  assert.ok(answerDune !== undefined && answerDu !== undefined, 'both lookups were issued');
  await act(async () => {
    answerDune([{ mediaItemId: 11, title: 'Dune', year: '2021' }]);
    await Promise.resolve();
  });
  await act(async () => {
    answerDu([{ mediaItemId: 99, title: 'Duel', year: '1971' }]);
    await Promise.resolve();
  });

  assert.deepEqual(optionTexts(), ['Dune (2021)', 'Look up as "dune"']);
});

test('accepted and linked call onDone; a refusal shows its sentence in an alert and keeps the form', async () => {
  for (const outcome of [{ accepted: true }, { outcome: 'linked', mediaItemId: 4 }] as const) {
    let done = 0;
    const stub = stubIdentify(
      () => Promise.resolve([]),
      () => Promise.resolve(outcome),
    );
    renderForm(stub.identify, {
      onDone: () => {
        done += 1;
      },
    });
    fireEvent.change(combobox(), { target: { value: 'x' } });
    fireEvent.click(save());
    await waitFor(() => {
      assert.equal(done, 1);
    });
    cleanup();
  }

  let done = 0;
  const refusing = stubIdentify(
    () => Promise.resolve([]),
    () => Promise.resolve({ refusal: 'already-linked' }),
  );
  renderForm(refusing.identify, {
    onDone: () => {
      done += 1;
    },
  });
  fireEvent.change(combobox(), { target: { value: 'x' } });
  fireEvent.click(save());
  await waitFor(() => {
    assert.equal(screen.getByRole('alert').textContent, IDENTIFY_REFUSAL_MESSAGES['already-linked']);
  });
  assert.equal(done, 0);
  assert.equal(combobox().value, 'x', 'the form keeps what was typed');
  assert.ok(!save().disabled, 'and can be saved again');
});

test('a submit that rejects shows the offline sentence and re-enables Save', async () => {
  const stub = stubIdentify(
    () => Promise.resolve([]),
    () => Promise.reject(new Error('down')),
  );
  renderForm(stub.identify);
  fireEvent.change(combobox(), { target: { value: 'x' } });
  fireEvent.click(save());
  await waitFor(() => {
    assert.equal(screen.getByRole('alert').textContent, IDENTIFY_REFUSAL_MESSAGES.offline);
  });
  assert.ok(!save().disabled);
});

test('Save is disabled while empty and while a request is in flight', async () => {
  const stub = stubIdentify(
    () => Promise.resolve([]),
    () => new Promise<IdentifyOutcome>(() => {}),
  );
  renderForm(stub.identify);
  assert.ok(save().disabled, 'empty');
  fireEvent.change(combobox(), { target: { value: '   ' } });
  assert.ok(save().disabled, 'whitespace is empty');
  fireEvent.change(combobox(), { target: { value: 'x' } });
  assert.ok(!save().disabled);

  fireEvent.click(save());
  await waitFor(() => {
    assert.ok(save().disabled, 'in flight');
  });
  fireEvent.click(save());
  assert.equal(stub.requests.length, 1, 'a second click sends nothing');
});
