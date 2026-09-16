import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SignIn } from '../../src/auth/SignIn.tsx';
import { fetchStub, jsonResponse } from '../fetchStub.ts';
import { gone } from '../dom.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would skip it and hang the file. Restoring
 * `globalThis.fetch` here too, unconditionally, for the same reason.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** One recorded call: the url the stubbed `fetch` was given, and its init. */
type Call = [url: string, init: RequestInit | undefined];

function stubFetchCalls(handler: (url: string, init?: RequestInit) => Promise<Response>): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = fetchStub((url, init) => {
    calls.push([url, init]);
    return handler(url, init);
  });
  return { calls };
}

/**
 * Every console method that prints values a caller hands it, captured rather
 * than printed.
 *
 * **The list is the point.** This test's whole job is to catch a response
 * body reaching the console, and it used to intercept `error` and `log`
 * only. A review proved the gap by adding `console.warn('sign-in refused',
 * await response.clone().text())` to the refusal path: the secret printed to
 * the terminal and all five tests still passed. Adding `warn` alone would
 * have left `info`, `debug`, `trace` and `dir` open to the same one-line
 * debug statement, so the fix is the surface, not the one method that got
 * caught.
 *
 * The four left out -- `assert`, `table`, `count` and the `group*` family --
 * are caught anyway, but not by this list and not for any reason of mine. A
 * re-review measured it: leaking through each of them still fails this test,
 * because Node's `Console` delegates them internally to `log` and `warn`,
 * which are on the list. My first version of this comment claimed they were
 * excluded because "their signatures are not arbitrary values", which was
 * reasoning invented after the fact and is simply wrong.
 *
 * Worth knowing rather than glossing, because the delegation is a property of
 * the runtime these tests use and not a guarantee: a browser's
 * `console.table` does not funnel through `console.log`. The net holds where
 * it is deployed -- `node --test` -- and anything added to the seven above
 * would hold everywhere.
 */
const CAPTURED_CONSOLE = ['debug', 'error', 'info', 'log', 'trace', 'warn', 'dir'] as const;

function captureConsole(): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = [];
  const originals = new Map<(typeof CAPTURED_CONSOLE)[number], (...args: unknown[]) => void>();
  for (const name of CAPTURED_CONSOLE) {
    originals.set(name, console[name]);
    console[name] = (...args: unknown[]) => {
      calls.push(args);
    };
  }
  return {
    calls,
    restore: () => {
      for (const [name, original] of originals) console[name] = original;
    },
  };
}

function fillCredentials(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

test('the form posts sign-in by default', async () => {
  const { calls } = stubFetchCalls(async () => jsonResponse({}, 200));
  let signedIn = 0;
  render(<SignIn onSignedIn={() => { signedIn += 1; }} />);

  fillCredentials('owner@example.invalid', 'correct horse');
  submit();

  await waitFor(() => {
    assert.equal(calls.length, 1);
  });
  const [url, init] = calls[0] ?? ['', undefined];
  assert.equal(url, '/api/auth/sign-in/email');
  assert.deepEqual(JSON.parse(String(init?.body)), { email: 'owner@example.invalid', password: 'correct horse' });
  await waitFor(() => {
    assert.equal(signedIn, 1, 'a successful sign-in calls onSignedIn');
  });
});

test('the claim affordance reveals a token field and posts sign-up instead', async () => {
  const { calls } = stubFetchCalls(async () => jsonResponse({}, 200));
  render(<SignIn />);

  assert.equal(gone(/claim token/i), true, 'no claim-token field before the affordance is used');

  fireEvent.click(screen.getByRole('button', { name: /first time here\? claim this install/i }));

  const claimField = screen.getByLabelText('Claim token');
  assert.ok(claimField, 'the claim-token field is revealed');

  fillCredentials('owner@example.invalid', 'correct horse');
  fireEvent.change(claimField, { target: { value: 'the-claim-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Claim this install' }));

  await waitFor(() => {
    assert.equal(calls.length, 1);
  });
  const [url, init] = calls[0] ?? ['', undefined];
  assert.equal(url, '/api/auth/sign-up/email');
  const body: unknown = JSON.parse(String(init?.body));
  const record = body as Record<string, unknown>;
  assert.equal(record.email, 'owner@example.invalid');
  assert.equal(record.password, 'correct horse');
  assert.equal(record.claimToken, 'the-claim-token');
});

test('a refused sign-in shows why, and the form stays usable', async () => {
  stubFetchCalls(async () => jsonResponse({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }, 401));
  render(<SignIn />);

  fillCredentials('owner@example.invalid', 'wrong password');
  submit();

  const heading = await screen.findByRole('heading', { name: 'That email and password did not work. Check them and try again.' });
  assert.ok(heading, 'the form explains the refusal in its own words');

  const emailField = screen.getByLabelText<HTMLInputElement>('Email');
  const passwordField = screen.getByLabelText<HTMLInputElement>('Password');
  const submitButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' });
  assert.equal(emailField.disabled, false, 'the email field stays usable after a refusal');
  assert.equal(passwordField.disabled, false, 'the password field stays usable after a refusal');
  assert.equal(submitButton.disabled, false, 'the submit button is not stuck disabled after a refusal');
  assert.equal(emailField.value, 'owner@example.invalid', 'the typed email is not cleared by a refusal');
});

test('the error is announced, and it is a heading a sighted reader can see', async () => {
  stubFetchCalls(async () => jsonResponse({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }, 401));
  render(<SignIn />);

  fillCredentials('owner@example.invalid', 'wrong password');
  submit();

  // A real heading, found by its own visible text -- not an aria-label
  // standing in for one (CLAUDE.md's longest entry). The text asserted here
  // is the literal string the heading renders, not a value read back off
  // `groupAnchor`-style helper, so a future edit to the wording cannot keep
  // this test green while silently breaking legibility.
  const heading = await screen.findByRole('heading', { level: 2 });
  assert.equal(heading.textContent, 'That email and password did not work. Check them and try again.');

  // Announced too: the same heading lives inside the one live region the
  // form renders, found independently by its own role rather than by
  // walking up from the heading.
  const alertRegion = screen.getByRole('alert');
  assert.ok(alertRegion.contains(heading), 'the visible heading is inside the announced region');
});

test('a request that never gets an answer says so, rather than looking like nothing happened', async () => {
  // Distinct from a refusal, which is an answer. `fetch` rejects for transport
  // reasons, and before this the form had a `finally` and no `catch`: the
  // rejection escaped as an unhandled promise rejection, `pending` cleared,
  // and the visitor got a normal-looking button and no message at all.
  const { calls: consoleCalls, restore } = captureConsole();
  const rejection = 'Failed to fetch https://pickarr.invalid/api/auth/sign-in/email';
  stubFetchCalls(() => Promise.reject(new TypeError(rejection)));
  try {
    render(<SignIn />);
    fillCredentials('owner@example.invalid', 'correct password');
    submit();

    const alert = await screen.findByRole('alert');
    assert.ok(
      alert.textContent?.includes('Could not reach Pickarr') === true,
      'the visitor is told the request did not get through',
    );

    // The rejection's own message carries a url, which is exactly what the
    // Global Constraint forbids putting in front of a user or in a log.
    assert.equal(gone(rejection), true, "the rejection's message never reaches the DOM");
    const logged = consoleCalls.some((call) => call.some((value) => String(value).includes(rejection)));
    assert.equal(logged, false, "the rejection's message never reaches the console");

    const submitButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' });
    assert.equal(submitButton.disabled, false, 'and the form is usable again, not stuck pending');
  } finally {
    restore();
  }
});

test('no response body reaches the DOM or the console', async () => {
  const secret = 'server-authored-detail-should-never-render-9f3c';
  stubFetchCalls(async () => jsonResponse({ code: 'REFUSED', message: secret }, 401));

  const { calls: consoleCalls, restore } = captureConsole();
  try {
    render(<SignIn />);
    fillCredentials('owner@example.invalid', 'wrong password');
    submit();

    await screen.findByRole('alert');

    assert.equal(gone(secret), true, 'the server-authored message never reaches the DOM');
    const loggedSecret = consoleCalls.some((call) => call.some((value) => String(value).includes(secret)));
    assert.equal(loggedSecret, false, 'the server-authored message never reaches the console');
  } finally {
    restore();
  }
});
