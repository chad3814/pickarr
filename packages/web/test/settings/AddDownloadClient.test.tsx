import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ADD_DOWNLOAD_CLIENT_REFUSALS, type AddDownloadClientInput } from '@pickarr/contract';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  AddDownloadClient,
  postDownloadClient,
  REFUSAL_MESSAGES,
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
    .filter((key) => key !== 'offline' && key !== 'expired' && key !== 'unrecognised')
    .toSorted();

  assert.deepEqual(spoken, [...ADD_DOWNLOAD_CLIENT_REFUSALS].toSorted(),
    'every code the host can send has a sentence here, and this form claims no code the host cannot send');

  assert.deepEqual(spoken, ['bad-auth-shape', 'bad-url', 'duplicate-name', 'unknown-implementation']);
});

test('no refusal code borrows another one\'s sentence', () => {
  const sentences = Object.values(REFUSAL_MESSAGES);
  assert.equal(new Set(sentences).size, sentences.length,
    'each outcome gets words of its own, so a refusal is legible without reading a code');
  assert.equal(sentences.length, 7, 'the contract\'s four, plus offline, expired and unrecognised');
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

test('an unparseable body reads as offline, not as an unrecognised answer', async () => {
  // A gateway's HTML 502 -- the realistic producer, and the case that
  // decides which of the two catch-all outcomes an unparseable body gets.
  // `offline` is right *because* Pickarr cannot have sent this:
  // `static-route.ts` refuses every `/api` path before the filesystem so a
  // mistyped endpoint cannot answer HTML, and `server.ts`'s catch-all is
  // `json(404, { error: 'unknown route' })`. Every answer the route layer
  // can produce parses. So these bytes came from in front of the host, the
  // submit never reached it, and "could not reach Pickarr" is the true
  // sentence -- where `unrecognised`'s "the host may be a different
  // version" would be a diagnosis of the one cause ruled out, since
  // version skew answers parseable JSON and lands on the other branch.
  //
  // Asserted here rather than left to the docblock because the two
  // outcomes are one `await` apart inside the same `try`, so moving
  // `response.json()` out of it is a one-line edit that silently switches
  // this to `unrecognised`.
  globalThis.fetch = fetchStub(() =>
    Promise.resolve(new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })),
  );
  assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'offline' });
  assert.ok(/could not reach/i.test(REFUSAL_MESSAGES.offline),
    'and that outcome is the sentence about reachability, not the one about versions');
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
 * A 401 is an expired session -- the most ordinary failure a real submit
 * meets -- and has its own outcome (issue #94), rather than sharing the
 * version-skew catch-all it used to.
 */
test('postDownloadClient reports "expired" for a 401, not "unrecognised", and never throws', async () => {
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)));
  assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'expired' });
});

/**
 * The route's own 400 `{ error }`, a 500, and a refusal code this build
 * has never heard of all resolve rather than throw. A client is routinely
 * older than its host, so an unknown code is a normal outcome.
 */
test('postDownloadClient reports "unrecognised" for a body carrying no refusal, never a throw', async () => {
  for (const [body, status] of [
    [{ error: 'invalid download client' }, 400],
    [{ error: 'internal' }, 500],
  ] as const) {
    globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse(body, status)));
    // eslint-disable-next-line no-await-in-loop -- each iteration installs its own `fetch` stub; running them concurrently would race over the one global.
    assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'unrecognised' }, `status ${String(status)}`);
  }
});

/**
 * The two envelope codes, named here by the same strings
 * `server.test.ts`'s `both download client 400s carry a code` names on the
 * host side.
 *
 * They used to be an invented `credential-rejected`. The behaviour pinned
 * was right and both sides were green, but neither test named a string the
 * other did: the route could have been renamed to answer
 * `unparseable-body` and the host's test would have moved with it while
 * this one went on passing about a code no route has ever sent. Two halves
 * of one seam have to meet on a literal somewhere, and this is the half
 * that was floating.
 *
 * Literals rather than an import, deliberately. These are *not* in
 * `@pickarr/contract` and must not be -- `contract/src/download-clients.ts`
 * and `feeds.ts` both record why the envelope codes stay in the route --
 * and the production client is required not to enumerate them, which is
 * what makes them arrive here as "unknown". Importing them would make the
 * browser know them and delete the thing under test. The assertion below
 * closes the gap a literal leaves.
 */
const ENVELOPE_REFUSAL_CODES = ['invalid-shape', 'malformed-body'] as const;

/**
 * The contract's codes as a set of plain strings, so the check below can
 * ask about a string the tuple's own member type does not include.
 *
 * An *annotation*, never `ADD_DOWNLOAD_CLIENT_REFUSALS as readonly
 * string[]`. The tuple is `as const`, so `.includes` accepts only its own
 * four members and passing an envelope code is a type error -- and the
 * reflex fix is a widening assertion, which this slice's diff does not
 * contain and which would be a cast written to silence a checker that is
 * right. Assigning the tuple to a widened type is an ordinary assignment
 * the compiler verifies. `AddDownloadClient.tsx` reaches the same place
 * twice, with its own `REFUSAL_CODES: ReadonlySet<string>` and with
 * `Object.hasOwn` in place of `IMPLEMENTATIONS.includes`.
 */
const CONTRACT_REFUSAL_CODES: ReadonlySet<string> = new Set(ADD_DOWNLOAD_CLIENT_REFUSALS);

test('postDownloadClient reports "unrecognised" for a refusal code this build does not know', async () => {
  // Derived from the shared constant, not restated: these two are unknown
  // to this build *because* the contract does not list them, and if a
  // later slice moved either into `ADD_DOWNLOAD_CLIENT_REFUSALS` the loop
  // below would silently stop testing the unknown-code path -- it would be
  // asserting that a code the client fully understands renders as
  // `unrecognised`, which is the opposite of the contract. This reds
  // instead.
  for (const code of ENVELOPE_REFUSAL_CODES) {
    assert.ok(
      !CONTRACT_REFUSAL_CODES.has(code),
      `${code} is an envelope refusal and must stay out of the contract's list for this test to mean anything`,
    );
  }

  for (const code of ENVELOPE_REFUSAL_CODES) {
    globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: code }, 400)));
    // eslint-disable-next-line no-await-in-loop -- each iteration installs its own `fetch` stub; running them concurrently would race over the one global.
    assert.deepEqual(await postDownloadClient(SAMPLE_INPUT), { refusal: 'unrecognised' }, code);
  }

  // And a code that is neither a contract refusal nor an envelope one --
  // the genuinely-newer-host case, which is why `unrecognised` exists at
  // all. The two above are today's unknown codes; this is tomorrow's.
  globalThis.fetch = fetchStub(() => Promise.resolve(jsonResponse({ refusal: 'a-code-no-build-has-shipped' }, 422)));
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
