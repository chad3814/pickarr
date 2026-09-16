import { useState, type FormEvent, type ReactElement } from 'react';
import { signIn, signUp } from './session.ts';

/**
 * The one form a signed-out visitor meets (design spec §4). Sign-in by
 * default; a "first time here? claim this install" affordance reveals a
 * claim-token field and posts sign-up instead.
 *
 * **A refusal shows why in the form's own words, never the server's.**
 * Global Constraint: no response body reaches the DOM or the console. Both
 * of Better Auth's refusal shapes -- a wrong password, and the identical
 * "sign-up is closed" the host answers for a claimed install *and* a wrong
 * token (`packages/host/src/auth/instance.ts`'s `SIGN_UP_REFUSED` doc
 * explains why those two are made to look alike on the wire) -- are read no
 * further than `response.ok`, and the fixed sentence below is what a caller
 * sees instead.
 */

const SIGN_IN_REFUSED = 'That email and password did not work. Check them and try again.';
const SIGN_UP_REFUSED = 'That claim token did not work. Check it and try again.';

/**
 * Shown when the request never got an answer at all, as distinct from the two
 * refusals above, which are answers.
 *
 * Without this the form had a `finally` and no `catch`, so an offline submit
 * cleared `pending` and rendered nothing: the button went back to normal and
 * the visitor was left to conclude the click had not registered. Being
 * offline is an ordinary condition for a browser tab, not an edge case, and a
 * submit that silently does nothing is the worst of the available outcomes.
 *
 * It says nothing about the cause, deliberately. The rejection's own message
 * is the wrong thing to render twice over -- it can name a host or a port
 * (Global Constraint), and it is written for whoever wrote the fetch, not for
 * whoever is trying to sign in.
 */
const REQUEST_FAILED = 'Could not reach Pickarr. Check your connection and try again.';

export interface SignInProps {
  /**
   * Called once a sign-in or sign-up succeeds. Optional so a test exercising
   * only the request shape or the refusal path need not supply one -- task 6
   * is the caller that uses it, to flip `App` from `SignIn` to `Shell`.
   */
  onSignedIn?: () => void;
}

export function SignIn({ onSignedIn }: SignInProps): ReactElement {
  const [claiming, setClaiming] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [claimToken, setClaimToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = claiming ? await signUp(email, password, claimToken) : await signIn(email, password);
      if (response.ok) {
        onSignedIn?.();
        return;
      }
      setError(claiming ? SIGN_UP_REFUSED : SIGN_IN_REFUSED);
    } catch {
      // The rejection is deliberately not inspected. `fetch` rejects for
      // transport reasons -- offline, DNS, a reset connection -- and there is
      // nothing in the error a signing-in human can act on that
      // `REQUEST_FAILED` does not already say.
      setError(REQUEST_FAILED);
    } finally {
      setPending(false);
    }
  }

  function toggleClaiming(): void {
    setClaiming((value) => !value);
    setError(null);
  }

  return (
    <form
      aria-labelledby="signin-heading"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <h1 id="signin-heading">Sign in</h1>
      {error !== null && (
        <div role="alert">
          <h2>{error}</h2>
        </div>
      )}
      <div>
        <label htmlFor="signin-email">Email</label>
        <input
          id="signin-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="signin-password">Password</label>
        <input
          id="signin-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </div>
      {claiming && (
        <div>
          <label htmlFor="signin-claim-token">Claim token</label>
          <input
            id="signin-claim-token"
            type="text"
            required
            value={claimToken}
            onChange={(event) => {
              setClaimToken(event.target.value);
            }}
          />
        </div>
      )}
      <button type="submit" disabled={pending}>
        {claiming ? 'Claim this install' : 'Sign in'}
      </button>
      <button type="button" onClick={toggleClaiming}>
        {claiming ? 'Already claimed? Sign in instead' : 'First time here? Claim this install'}
      </button>
    </form>
  );
}
