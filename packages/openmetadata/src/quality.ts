/**
 * The video resolution a lookup answer parsed from the release name.
 *
 * **`parsed.quality.resolution`, a path the OpenAPI document does not
 * give.** `parsed` is typed there as an open object and carried through
 * `validate.ts` as one. The path was read off live answers
 * (`docs/superpowers/specs/2026-09-30-video-resolution-design.md`, "What the
 * service actually sends"), so every step of it is narrowed here and a miss
 * anywhere is `null`, never a throw: a lookup must not fail because the
 * parse changed shape.
 *
 * A refused answer's `parsed` is the stored refusal record rather than a
 * parse, per the document, so it has no `quality` and reads as `null`.
 */
import { normalizeVideoResolution } from '@pickarr/contract';
import type { LookupEnvelope } from './types.ts';

export function videoResolutionOf(envelope: LookupEnvelope): string | null {
  const quality = envelope.parsed?.['quality'];
  if (typeof quality !== 'object' || quality === null || !('resolution' in quality)) return null;
  return normalizeVideoResolution(quality.resolution);
}
