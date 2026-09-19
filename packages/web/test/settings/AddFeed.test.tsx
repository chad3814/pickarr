import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { AddFeed, postFeed, type AddFeedInput } from '../../src/settings/AddFeed.tsx';
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
