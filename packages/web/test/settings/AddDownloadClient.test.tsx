import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ADD_DOWNLOAD_CLIENT_REFUSALS } from '@pickarr/contract';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  AddDownloadClient,
  postDownloadClient,
  REFUSAL_MESSAGES,
  type AddDownloadClientInput,
  type AddDownloadClientOutcome,
} from '../../src/settings/AddDownloadClient.tsx';
import { fetchStub, jsonResponse } from '../fetchStub.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`), and
 * `globalThis.fetch` restored unconditionally too -- `postDownloadClient`'s
 * own tests below replace it. Matches `AddFeed.test.tsx`'s own hook.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * A credential no other string in this suite contains, so a search for it
 * anywhere in the DOM cannot match something incidental. It is a test
 * fixture and not a real secret; what the tests below prove is that this
 * form puts it nowhere except the object handed to `submit`.
 */
const CREDENTIAL = 'test-api-key-c4f2a1';

function fillRequired({ name = 'Seedbox', url = 'http://qbit.example:8080' } = {}): void {
  fireEvent.change(screen.getByLabelText('Client name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: url } });
  fireEvent.change(screen.getByLabelText('Api key'), { target: { value: CREDENTIAL } });
}

function submitForm(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Add download client' }));
}

function chooseImplementation(implementation: string): void {
  fireEvent.change(screen.getByLabelText('Implementation'), { target: { value: implementation } });
}

function chooseStrategy(strategy: string): void {
  fireEvent.change(screen.getByLabelText('Sign-in method'), { target: { value: strategy } });
}

/**
 * The two **refusal codes** tests below are `AddFeed.test.tsx`'s pair,
 * applied to this form before the drift they exist to catch can happen
 * rather than after: the feeds slice shipped the codes spelled twice, and
 * the final review measured a host-side rename reddening two host tests and
 * leaving all 100 web tests green.
 *
 * **The expected list is spelled out rather than derived.** `CLAUDE.md`: an
 * expectation computed by the code under test cannot detect that code
 * changing. Deriving this from `ADD_DOWNLOAD_CLIENT_REFUSALS` would make it
 * true under every rename, which is the one thing it exists to see.
 */
test('the refusal codes this form has sentences for are exactly the codes the contract declares', () => {
  const spoken = Object.keys(REFUSAL_MESSAGES)
    .filter((key) => key !== 'offline' && key !== 'unrecognised')
    .toSorted();

  assert.deepEqual(spoken, [...ADD_DOWNLOAD_CLIENT_REFUSALS].toSorted(),
    'every code the host can send has a sentence here, and this form claims no code the host cannot send');

  assert.deepEqual(spoken, ['bad-auth-shape', 'bad-url', 'duplicate-name', 'unknown-implementation']);
});

test('no refusal code borrows another one\'s sentence', () => {
  const sentences = Object.values(REFUSAL_MESSAGES);
  assert.equal(new Set(sentences).size, sentences.length,
    'each outcome gets words of its own, so a refusal is legible without reading a code');
  assert.equal(sentences.length, 6, 'the contract\'s four, plus offline and unrecognised');
});

test('the implementation select offers both products, and defaults to one the host can drive', () => {
  render(<AddDownloadClient submit={() => Promise.resolve({ id: 1 })} />);
  const select = screen.getByLabelText<HTMLSelectElement>('Implementation');
  const options = Array.from(select.options).map((option) => option.value);
  assert.deepEqual(options, ['qbittorrent', 'sabnzbd'], 'the two `clients/config.ts` resolves');
  assert.equal(select.value, 'qbittorrent', 'a real implementation, not an empty default');
});

test('SABnzbd asks for an api key and never for a sign-in method', () => {
  // Design spec §4: SABnzbd has one strategy and is not asked. A chooser
  // offering a choice that does not exist would produce `bad-auth-shape`
  // for a form the operator filled in exactly as shown.
  render(<AddDownloadClient submit={() => Promise.resolve({ id: 1 })} />);
  chooseImplementation('sabnzbd');

  assert.ok(screen.getByLabelText('Api key'), 'the one credential sabnzbd uses');
  assert.ok(!screen.queryByLabelText('Sign-in method'), 'no choice is offered where there is none');
  assert.ok(!screen.queryByLabelText('Username'), 'sabnzbd sends no username');
  assert.ok(!screen.queryByLabelText('Password'), 'sabnzbd sends no password');
});

test('qBittorrent offers both strategies, and the unselected one\'s fields are not rendered', () => {
  render(<AddDownloadClient submit={() => Promise.resolve({ id: 1 })} />);

  const chooser = screen.getByLabelText<HTMLSelectElement>('Sign-in method');
  assert.deepEqual(Array.from(chooser.options).map((option) => option.value), ['api-key', 'login']);

  assert.ok(screen.getByLabelText('Api key'), 'the bearer strategy asks for an api key');
  assert.ok(!screen.queryByLabelText('Username'), 'and not for a username');
  assert.ok(!screen.queryByLabelText('Password'), 'and not for a password');

  chooseStrategy('login');
  assert.ok(screen.getByLabelText('Username'), 'the login strategy asks for a username');
  assert.ok(screen.getByLabelText('Password'), 'and a password');
  assert.ok(!screen.queryByLabelText('Api key'), 'and the api key field is gone, not merely ignored');
});

test('every credential field is a password field, so no credential is ever shown as text', () => {
  render(<AddDownloadClient submit={() => Promise.resolve({ id: 1 })} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>('Api key').type, 'password');

  chooseStrategy('login');
  assert.equal(screen.getByLabelText<HTMLInputElement>('Password').type, 'password');
  assert.equal(screen.getByLabelText<HTMLInputElement>('Username').type, 'text',
    'a username is not a credential (`db/schema.ts`), and hiding it would only make it harder to check');
});

test('submitting sends the shape the host expects, with the unused credentials blank', async () => {
  let captured: AddDownloadClientInput | undefined;
  render(
    <AddDownloadClient
      submit={(input) => {
        captured = input;
        return Promise.resolve({ id: 1 });
      }}
    />,
  );
  fillRequired();
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'movies' } });
  submitForm();

  await waitFor(() => {
    assert.ok(captured !== undefined);
  });
  assert.equal(captured?.name, 'Seedbox');
  assert.equal(captured?.implementation, 'qbittorrent');
  assert.equal(captured?.url, 'http://qbit.example:8080');
  assert.equal(captured?.category, 'movies');
  assert.equal(captured?.apiKey, CREDENTIAL);
  assert.equal(captured?.username, '', 'an unsupplied credential is the empty string, never absent');
  assert.equal(captured?.password, '', 'an unsupplied credential is the empty string, never absent');
  assert.ok(!('type' in (captured ?? {})), 'the host derives `type` from `implementation` (design spec §4)');
});

test('switching strategy after typing sends only the strategy chosen, never both', async () => {
  // `clients/add.ts`'s `planCredential` refuses a qBittorrent client
  // carrying both an api key and a login, on purpose -- so a form that kept
  // the api key it had already collected would turn a strategy change into
  // `bad-auth-shape` with nothing on screen explaining it.
  let captured: AddDownloadClientInput | undefined;
  render(
    <AddDownloadClient
      submit={(input) => {
        captured = input;
        return Promise.resolve({ id: 1 });
      }}
    />,
  );
  fillRequired();
  chooseStrategy('login');
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: CREDENTIAL } });
  submitForm();

  await waitFor(() => {
    assert.ok(captured !== undefined);
  });
  assert.equal(captured?.apiKey, '', 'the api key typed before the switch is not sent');
  assert.equal(captured?.username, 'admin');
  assert.equal(captured?.password, CREDENTIAL);
});

test('a successful add clears the credential, and it is nowhere in the document afterwards', async () => {
  render(<AddDownloadClient submit={() => Promise.resolve({ id: 1 })} />);
  fillRequired();
  submitForm();

  await waitFor(() => {
    assert.equal(screen.getByLabelText<HTMLInputElement>('Client name').value, '');
  });
  assert.equal(screen.getByLabelText<HTMLInputElement>('Api key').value, '',
    'the credential is not held for a second submit');
  assert.ok(!document.body.innerHTML.includes(CREDENTIAL),
    'no attribute, no text node, nothing: the credential crossed the wire once and is gone');
});

test('a refusal leaves what was typed in place and never repeats the credential back', async () => {
  render(<AddDownloadClient submit={() => Promise.resolve({ refusal: 'duplicate-name' })} />);
  fillRequired();
  submitForm();

  const alert = await screen.findByRole('alert');
  assert.ok(!(alert.textContent ?? '').includes(CREDENTIAL), 'a refusal names no value, only a rule');
  assert.equal(screen.getByLabelText<HTMLInputElement>('Client name').value, 'Seedbox',
    'a refusal does not clear the form');
});

/**
 * The button re-enables after **every** outcome, a rejected `submit`
 * included. `handleSubmit`'s `finally` is the only thing that makes this
 * true, and the feeds slice shipped without one: five of six real host
 * answers left the button permanently disabled with nothing on screen.
 */
test('the submit button is usable again after every outcome, including a rejected submit', async () => {
  const outcomes: readonly (() => Promise<AddDownloadClientOutcome>)[] = [
    () => Promise.resolve({ id: 1 }),
    () => Promise.resolve({ refusal: 'duplicate-name' }),
    () => Promise.resolve({ refusal: 'bad-url' }),
    () => Promise.resolve({ refusal: 'offline' }),
    () => Promise.resolve({ refusal: 'unrecognised' }),
    () => Promise.reject(new Error('boom')),
  ];

  for (const submit of outcomes) {
    render(<AddDownloadClient submit={submit} />);
    fillRequired();
    submitForm();
    // eslint-disable-next-line no-await-in-loop -- each iteration renders, asserts and cleans up before the next; the six outcomes cannot run concurrently against the one shared `screen` (`Feeds.test.tsx`'s own refusal walk takes the identical exception).
    await waitFor(() => {
      assert.equal(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Add download client' }).disabled,
        false,
        'the form is usable again, not stuck pending',
      );
    });
    cleanup();
  }
});

test('a submit that rejects outright reads as offline, not as a refusal', async () => {
  render(<AddDownloadClient submit={() => Promise.reject(new Error('boom'))} />);
  fillRequired();
  submitForm();

  const alert = await screen.findByRole('alert');
  assert.ok(/could not reach/i.test(alert.textContent ?? ''), 'a rejected submit reads the same as offline');
});

/**
 * `postDownloadClient` -- the real `submit` `Shell.tsx` wires in --
 * exercised directly with a stubbed `fetch`, the way `AddFeed.test.tsx`
 * exercises `postFeed`. No component test reaches this function.
 */
const SAMPLE_INPUT: AddDownloadClientInput = {
  name: 'Seedbox',
  implementation: 'qbittorrent',
  url: 'http://qbit.example:8080',
  category: '',
  apiKey: CREDENTIAL,
  username: '',
  password: '',
};

test('postDownloadClient reports an accepted client by its id', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ id: 42 }, 201)));
  assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { id: 42 });
});

test('postDownloadClient branches on the refusal field, not the HTTP status', async () => {
  // A 409 carrying `duplicate-name` and a 422 carrying `bad-url` both answer
  // through the same field -- proven by driving both statuses and reading
  // back the same `refusal` key each time, never `response.status`.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'duplicate-name' }, 409)));
  assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'duplicate-name' });

  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'bad-url' }, 422)));
  assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'bad-url' });
});

test('postDownloadClient treats a status it has never seen as no evidence at all', async () => {
  // The same body, answered with a 200 -- the status the route never sends
  // for a refusal. A client reading the status would call this accepted.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'bad-auth-shape' }, 200)));
  assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'bad-auth-shape' });
});

test('postDownloadClient reports offline for a rejected fetch, never a server answer', async () => {
  globalThis.fetch = fetchStub(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'offline' });
});

test('postDownloadClient sends the session cookie, never a token it read itself', async () => {
  let seenUrl: string | undefined;
  let seenInit: RequestInit | undefined;
  globalThis.fetch = fetchStub((url, init) => {
    seenUrl = url;
    seenInit = init;
    return Promise.resolve(jsonResponse({ id: 1 }, 201));
  });
  await postDownloadClient(SAMPLE_INPUT);
  assert.equal(seenUrl, '/api/download-clients');
  assert.equal(seenInit?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(seenInit?.body)), SAMPLE_INPUT,
    'the credential crosses here, in the body, and this is the only place it does');
});

test('postDownloadClient never reads a server-authored message off the body', async () => {
  const authored = 'server-authored-detail-should-never-render-7b1d';
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'bad-url', message: authored }, 422)));
  assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'bad-url' },
    'only the refusal code crosses, never any other field');
});

/**
 * A 401 (an expired session -- the most ordinary failure a real submit
 * meets), the route's own 400 `{ error }`, a 500, and a refusal code this
 * build has never heard of all resolve rather than throw. A client is
 * routinely older than its host, so an unknown code is a normal outcome.
 */
test('postDownloadClient reports "unrecognised" for a body carrying no refusal, never a throw', async () => {
  for (const [body, status] of [
    [{ error: 'unauthorized' }, 401],
    [{ error: 'invalid download client' }, 400],
    [{ error: 'internal' }, 500],
  ] as const) {
    globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse(body, status)));
    // eslint-disable-next-line no-await-in-loop -- each iteration installs its own `fetch` stub; running them concurrently would race over the one global.
    assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'unrecognised' }, `status ${String(status)}`);
  }
});

test('postDownloadClient reports "unrecognised" for a refusal code this build does not know', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'credential-rejected' }, 422)));
  assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'unrecognised' });
});

test('an unrecognised answer shows its own sentence, and the button is usable again', async () => {
  render(<AddDownloadClient submit={() => Promise.resolve({ refusal: 'unrecognised' })} />);
  fillRequired();
  submitForm();

  const alert = await screen.findByRole('alert');
  assert.ok(!/already on file|http|credentials|cannot drive/i.test(alert.textContent ?? ''),
    'its own words, distinct from every other outcome');
  assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: 'Add download client' }).disabled, false);
});
