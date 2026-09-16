/**
 * The whole client: `SignIn` until a session exists, `Shell` once one does
 * (this task's brief; design spec §4).
 *
 * Starts unauthenticated. There is no probe endpoint to ask "am I already
 * signed in" (spec §4: "No probe, no new endpoint"), so the first thing this
 * app can honestly show is the one form that can establish a session.
 *
 * `Shell` hands back the same callback whether the reason is an explicit
 * "Sign out" click or a sync read discovering the session is already dead --
 * a 401, `session.ts`'s `isUnauthenticated`, spec §4's "any read can answer
 * it". Either way, `App`'s only job in response is the same: show `SignIn`
 * again.
 */
import { useCallback, useState, type ReactElement } from 'react';
import { SignIn } from './auth/SignIn.tsx';
import { Shell } from './shell/Shell.tsx';

type Phase = 'authenticated' | 'unauthenticated';

export function App(): ReactElement {
  const [phase, setPhase] = useState<Phase>('unauthenticated');

  const handleSignedIn = useCallback((): void => {
    setPhase('authenticated');
  }, []);

  const handleUnauthenticated = useCallback((): void => {
    setPhase('unauthenticated');
  }, []);

  return phase === 'authenticated' ? (
    <Shell onUnauthenticated={handleUnauthenticated} />
  ) : (
    <SignIn onSignedIn={handleSignedIn} />
  );
}
