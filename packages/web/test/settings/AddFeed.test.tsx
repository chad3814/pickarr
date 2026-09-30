import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ADD_FEED_REFUSALS, type AddFeedInput } from '@pickarr/contract';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { AddFeed, postFeed, REFUSAL_MESSAGES } from '../../src/settings/AddFeed.tsx';
import { fetchStub, jsonResponse } from '../fetchStub.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`), and
 * `globalThis.fetch` restored unconditionally too -- `postFeed`'s own tests
 * below replace it.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function fillNameAndUrl(name: string, url: string): void {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Feed url'), { target: { value: url } });
}

function submitForm(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));
}

/**
 * The two **refusal codes** tests below are final-review finding I-1's pin.
 *
 * The codes used to be declared twice -- `packages/host/src/feeds/add.ts`'s
 * `AddFeedRefusal` union, and a hand-copied `REFUSAL_CODES` set in
 * `AddFeed.tsx` -- with nothing asserting the two agreed. Measured on that
 * tree: renaming `duplicate-url` to `url-already-on-file` in the host
 * reddened exactly two host tests and left all 100 web tests green, so the
 * rename ships and this form silently swaps "That url is already on file."
 * for its catch-all. `@pickarr/contract`'s `ADD_FEED_REFUSALS` is the one
 * declaration now, and `REFUSAL_MESSAGES`'s key type is built from it, so
 * the rename is a type error -- but `npm run test:web` runs under tsx and
 * does not typecheck, so a type error alone leaves the web suite green.
 * These two are the runtime half.
 *
 * **The expected list is spelled out rather than derived.** `CLAUDE.md`:
 * an expectation computed by the code under test cannot detect that code
 * changing. Deriving this from `ADD_FEED_REFUSALS` would make it true under
 * every rename, which is the one thing it exists to see.
 */
test('the refusal codes this form has sentences for are exactly the codes the contract declares', () => {
  const spoken = Object.keys(REFUSAL_MESSAGES)
    .filter((key) => key !== 'offline' && key !== 'unrecognised')
    .toSorted();

  // The client's set against the contract's: this is the assertion the
  // host-only rename would have reddened.
  assert.deepEqual(spoken, [...ADD_FEED_REFUSALS].toSorted(),
    'every code the host can send has a sentence here, and this form claims no code the host cannot send');

  // And the contract's against four literals, so a rename applied to both
  // sides at once is still a deliberate, visible edit rather than a silent
  // one. `offline` and `unrecognised` are filtered out above because they
  // are this client's own outcomes, never anything a server answered.
  assert.deepEqual(spoken, ['bad-download-type', 'bad-poll-interval', 'duplicate-url', 'unknown-plugin']);
});

test('no refusal code borrows another one\'s sentence', () => {
  // A code added to the contract and then given a copy-pasted sentence --
  // or quietly pointed at the catch-all -- would satisfy the key-set test
  // above while telling an operator the wrong thing. Six outcomes, six
  // distinct sentences.
  const sentences = Object.values(REFUSAL_MESSAGES);
  assert.equal(new Set(sentences).size, sentences.length,
    'each outcome gets words of its own, so a refusal is legible without reading a code');
  assert.equal(sentences.length, 6, 'the contract\'s four, plus offline and unrecognised');
});

test('the plugin select offers CATEGORIES, and defaults to a value the host will accept', () => {
  render(<AddFeed submit={() => Promise.resolve({ id: 1 })} />);
  const select = screen.getByLabelText<HTMLSelectElement>('Plugin');
  const options = Array.from(select.options).map((option) => option.value);
  assert.deepEqual(options, ['tv', 'movie', 'xxx'], 'the same three ids the shell nav uses');
  assert.equal(select.value, 'tv', 'a registered plugin, not an empty default');
});

test('submitting with only name and url filled sends a well-typed default plugin, download type and poll interval', async () => {
  let captured: AddFeedInput | undefined;
  render(
    <AddFeed
      submit={(input) => {
        captured = input;
        return Promise.resolve({ id: 1 });
      }}
    />,
  );
  fillNameAndUrl('Movies HD', 'https://tracker.example/rss');
  submitForm();

  await waitFor(() => {
    assert.ok(captured !== undefined);
  });
  assert.equal(captured?.name, 'Movies HD');
  assert.equal(captured?.url, 'https://tracker.example/rss');
  assert.equal(captured?.pluginId, 'tv');
  assert.equal(captured?.downloadType, 'torrent');
  assert.equal(captured?.pollIntervalS, 300);
  assert.equal(typeof captured?.pollIntervalS, 'number', 'a number, not the input element\'s own string value');
});

test('changing the plugin, download type and poll interval changes what is submitted', async () => {
  let captured: AddFeedInput | undefined;
  render(
    <AddFeed
      submit={(input) => {
        captured = input;
        return Promise.resolve({ id: 1 });
      }}
    />,
  );
  fillNameAndUrl('Movies HD', 'https://tracker.example/rss');
  fireEvent.change(screen.getByLabelText('Plugin'), { target: { value: 'movie' } });
  fireEvent.change(screen.getByLabelText('Download type'), { target: { value: 'nzb' } });
  fireEvent.change(screen.getByLabelText('Poll interval (seconds)'), { target: { value: '120' } });
  submitForm();

  await waitFor(() => {
    assert.ok(captured !== undefined);
  });
  assert.equal(captured?.pluginId, 'movie');
  assert.equal(captured?.downloadType, 'nzb');
  assert.equal(captured?.pollIntervalS, 120);
});

test('a successful add clears the name and url fields', async () => {
  render(<AddFeed submit={() => Promise.resolve({ id: 1 })} />);
  fillNameAndUrl('Movies HD', 'https://tracker.example/rss');
  submitForm();

  await waitFor(() => {
    assert.equal(screen.getByLabelText<HTMLInputElement>('Name').value, '');
  });
  assert.equal(screen.getByLabelText<HTMLInputElement>('Feed url').value, '');
});

test('a refusal leaves what was typed in place', async () => {
  render(<AddFeed submit={() => Promise.resolve({ refusal: 'duplicate-url' })} />);
  fillNameAndUrl('Movies HD', 'https://tracker.example/rss');
  submitForm();

  await screen.findByRole('alert');
  assert.equal(screen.getByLabelText<HTMLInputElement>('Name').value, 'Movies HD', 'a refusal does not clear the form');
});

/**
 * `postFeed` -- the real `submit` `Shell.tsx` wires in -- exercised
 * directly, with a stubbed `fetch`, the way `SignIn.test.tsx` exercises
 * `signIn`/`signUp`. None of `Feeds.test.tsx`'s tests reach this function at
 * all (they inject their own `submit` stubs, by task 5's ruling), so this
 * is the one place its own body is proven.
 */
const SAMPLE_INPUT: AddFeedInput = {
  pluginId: 'tv',
  name: 'Movies HD',
  url: 'https://tracker.example/rss',
  downloadType: 'torrent',
  pollIntervalS: 300,
};

test('postFeed reports an accepted feed by its id', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ id: 42 }, 201)));
  const outcome = await postFeed(SAMPLE_INPUT);
  assert.deepEqual(outcome, { id: 42 });
});

test('postFeed branches on the refusal field, not the HTTP status', async () => {
  // A 409 carrying `duplicate-url` and a 422 carrying `unknown-plugin` both
  // answer through the same field -- proven by driving both statuses and
  // reading back the same `refusal` key each time, never `response.status`.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'duplicate-url' }, 409)));
  assert.deepEqual(await postFeed(SAMPLE_INPUT), { refusal: 'duplicate-url' });

  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'unknown-plugin' }, 422)));
  assert.deepEqual(await postFeed(SAMPLE_INPUT), { refusal: 'unknown-plugin' });
});

test('postFeed reports offline for a rejected fetch, never a server answer', async () => {
  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch https://pickarr.invalid/api/feeds')));
  assert.deepEqual(await postFeed(SAMPLE_INPUT), { refusal: 'offline' });
});

test('postFeed sends the session cookie, never a token it read itself', async () => {
  let seenInit: RequestInit | undefined;
  globalThis.fetch = fetchStub((_url, init) => {
    seenInit = init;
    return Promise.resolve(jsonResponse({ id: 1 }, 201));
  });
  await postFeed(SAMPLE_INPUT);
  assert.equal(seenInit?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(seenInit?.body)), SAMPLE_INPUT);
});

test('postFeed never reads a server-authored message off the body', async () => {
  const secret = 'server-authored-detail-should-never-render-9f3c';
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'duplicate-url', message: secret }, 409)));
  const outcome = await postFeed(SAMPLE_INPUT);
  assert.deepEqual(outcome, { refusal: 'duplicate-url' }, 'only the refusal code crosses, never any other field');
});

/**
 * Fix round 1 (review C1/I4): a 401 (an expired session -- the most
 * ordinary failure a real submit meets), this tree's 400
 * `{ error: 'invalid feed' }`, and a 500 all carry no `refusal` key at all.
 * None of them may throw; each resolves to `{ refusal: 'unrecognised' }'`.
 */
test('postFeed reports "unrecognised" for a 401, never a throw', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));
  assert.deepEqual(await postFeed(SAMPLE_INPUT), { refusal: 'unrecognised' });
});

test('postFeed reports "unrecognised" for a bare { error } body, never a throw', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'invalid feed' }, 400)));
  assert.deepEqual(await postFeed(SAMPLE_INPUT), { refusal: 'unrecognised' });
});

test('postFeed reports "unrecognised" for a 500, never a throw', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'internal' }, 500)));
  assert.deepEqual(await postFeed(SAMPLE_INPUT), { refusal: 'unrecognised' });
});

/**
 * The form-level half of I4: once `submit` resolves to any non-`id`,
 * non-throwing outcome, the button must come back usable and the form must
 * show its own words -- not the wedge C1 found (five of six real host
 * answers left the button permanently disabled with nothing rendered).
 */
test('an unrecognised answer shows its own sentence, and the button is usable again', async () => {
  render(<AddFeed submit={() => Promise.resolve({ refusal: 'unrecognised' })} />);
  fillNameAndUrl('Movies HD', 'https://tracker.example/rss');
  submitForm();

  const alert = await screen.findByRole('alert');
  assert.ok(!/already|plugin|could not reach/i.test(alert.textContent ?? ''), 'its own words, distinct from every other outcome');

  const submitButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Add feed' });
  assert.equal(submitButton.disabled, false, 'the form is usable again, not stuck pending');
});

test('a submit that rejects outright is caught, and the button is usable again', async () => {
  // `submit` is an injected async function; C1's fix does not depend on
  // what `postFeed` itself does, since a caller may inject one that throws.
  render(<AddFeed submit={() => Promise.reject(new Error('boom'))} />);
  fillNameAndUrl('Movies HD', 'https://tracker.example/rss');
  submitForm();

  const alert = await screen.findByRole('alert');
  assert.ok(/could not reach/i.test(alert.textContent ?? ''), 'a rejected submit reads the same as offline');

  const submitButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Add feed' });
  assert.equal(submitButton.disabled, false, 'the form is usable again, not stuck pending');
});
