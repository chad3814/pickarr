/**
 * The whole client: `Shell` first, `SignIn` once a read answers 401 (design
 * spec §4, §7 item 14).
 *
 * **Starts optimistically, not unconditionally signed out.** Spec §4's full
 * sentence is: "The client discovers it is unauthenticated the ordinary way:
 * a read answers 401, and the app renders the form. No probe, no new
 * endpoint." That names a *mechanism* -- start by reading, let a 401 demote
 * you -- and the clause forbids only *adding an endpoint* to ask the
 * question first, not asking at all. Starting in `SignIn` unconditionally
 * (an earlier version of this file did exactly that) reads the same
 * sentence backwards: a visitor holding a valid session cookie who reloads
 * would be sent back to the sign-in form every time, and spec §7 item 14
 * ("Reload: counts are immediately non-zero, because the replica persisted")
 * could never pass at all, for anyone.
 *
 * `Shell` owns the read that makes the discovery: `withUnauthenticatedCheck`
 * (`shell/Shell.tsx`) routes a 401 from anywhere in its sync loops to
 * `onUnauthenticated`, which is this component's cue to fall back to
 * `SignIn` -- the same callback an explicit "Sign out" click uses, because
 * `App`'s response to either is identical.
 */
import { useCallback, useState, type ReactElement } from 'react';
import { SignIn } from './auth/SignIn.tsx';
import { Shell } from './shell/Shell.tsx';
import type { CreateStoreDeps } from './store/index.ts';

type Phase = 'authenticated' | 'unauthenticated';

export interface AppProps {
  /**
   * Overridable for tests, forwarded straight to `Shell`'s own `deps` prop --
   * see that prop's doc for why a test needs it. `main.tsx` renders `App`
   * with none, which is the real browser adapters.
   */
  shellDeps?: CreateStoreDeps;
}

export function App({ shellDeps }: AppProps): ReactElement {
  const [phase, setPhase] = useState<Phase>('authenticated');

  const handleSignedIn = useCallback((): void => {
    setPhase('authenticated');
  }, []);

  const handleUnauthenticated = useCallback((): void => {
    setPhase('unauthenticated');
  }, []);

  // `deps` is spread only when present rather than always passed (even as
  // `undefined`): `ShellProps.deps` is typed `CreateStoreDeps | undefined`
  // as a prop that may be *omitted*, and `exactOptionalPropertyTypes`
  // distinguishes that from a key explicitly set to `undefined`.
  return phase === 'authenticated' ? (
    <Shell {...(shellDeps === undefined ? {} : { deps: shellDeps })} onUnauthenticated={handleUnauthenticated} />
  ) : (
    <SignIn onSignedIn={handleSignedIn} />
  );
}
