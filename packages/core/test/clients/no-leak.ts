import assert from 'node:assert/strict';
import { inspect } from 'node:util';

/**
 * Every reading of `surface` a consumer could arrive at with routine
 * decoding: repeated percent-decoding, `+`-for-space form decoding, and any
 * interleaving of the two. Asserting only literal absence is what let the
 * percent-encoding bypass through an earlier round — `apikey=dXNlcjpwYXNz%3D%3D`
 * contains no literal match yet gives the key up to one decodeURIComponent.
 *
 * Written out here rather than imported from the client on purpose: if the
 * test reused the client's own decoder, a blind spot in that decoder would be
 * a blind spot in the check that is supposed to catch it. Percent runs are
 * decoded individually so a single stray `%` (common in stack traces) cannot
 * switch the whole check off, which a bare decodeURIComponent would allow.
 */
function readings(surface: string): string[] {
  const seen = new Set<string>([surface]);
  let frontier = [surface];
  for (let round = 0; round < 3 && frontier.length > 0; round += 1) {
    const next: string[] = [];
    for (const view of frontier) {
      const percentDecoded = view.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
        try {
          return decodeURIComponent(run);
        } catch {
          return run;
        }
      });
      for (const candidate of [percentDecoded, view.replaceAll('+', ' ')]) {
        if (!seen.has(candidate)) {
          seen.add(candidate);
          next.push(candidate);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/** Asserts the secret is unrecoverable from a single string. */
export function assertNoSecret(surface: string, secret: string): void {
  for (const reading of readings(surface)) {
    assert.ok(
      !reading.includes(secret),
      `the secret is recoverable from this text: ${reading.slice(0, 300)}`,
    );
  }
}

/**
 * Checks the whole error surface a caller might log or inspect — not just
 * `.message`. A fix that only cleaned `.message` while leaving the secret
 * reachable through `.cause`, `.name`, or `util.inspect` would pass a
 * narrower check but still leak in practice.
 *
 * Shared by every client's tests rather than copied per client: this is the
 * standard the whole codebase's "no credential in an error" rule is stated
 * against, and a second copy would be free to weaken without anyone noticing
 * that the two clients were no longer held to the same bar.
 */
export function assertNoLeak(error: Error, secret: string): void {
  const surfaces = [error.message, String(error), inspect(error, { depth: 6 })];
  const cause = error.cause;
  if (cause instanceof Error) {
    surfaces.push(cause.message, cause.name, String(cause));
  }
  for (const surface of surfaces) assertNoSecret(surface, secret);
}
