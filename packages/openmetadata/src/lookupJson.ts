/**
 * Turning a `LookupEnvelope` into the string `rss_item.lookup_json` holds.
 *
 * **Serialised from the validated shape, never from the response bytes.**
 * `validate.ts` has already parsed the service's answer into a
 * `LookupEnvelope` by the time this runs, so what reaches a client's
 * replica is a re-serialisation of a shape `types.ts` declares -- not
 * arbitrary text from a third party. The one exception is `parsed`, which
 * its own type documents as "carried through unvalidated beyond object or
 * null"; it is stored because it is the single most useful field for
 * diagnosing why a name was not recognised, and this sentence is the
 * record that it is the part of this column that is not shape-checked.
 *
 * **Not passed through `redactSecrets`** (`packages/host/src/clients/redact.ts`).
 * That function scans free text for runs that merely look machine-generated
 * -- a long run of same-case hex, or of mixed-case alphanumerics -- because
 * that heuristic is the only signal available when redacting an arbitrary
 * log line or url. `lookupId` is exactly the kind of opaque, generated
 * token that heuristic exists to catch, and running it here risks masking
 * the one field that correlates a card on screen with the service's own
 * logs, for no benefit: the envelope is an answer *about a filename*, and
 * that filename is already in the replica unredacted.
 *
 * **`LOOKUP_JSON_CAP_BYTES` and `LOOKUP_JSON_TOO_LARGE` are imported, not
 * declared here.** Both live in `@pickarr/contract` because the column
 * they describe is read by `packages/web` as well as written by this
 * package, and `packages/web` must never depend on `@pickarr/openmetadata`
 * -- it reaches `node:sqlite` through drizzle, which has no browser build.
 * `@pickarr/contract` is the one package both already depend on; see the
 * doc comment on `LOOKUP_JSON_CAP_BYTES` in `packages/contract/src/sync.ts`
 * for the full reasoning.
 */
import { LOOKUP_JSON_CAP_BYTES, LOOKUP_JSON_TOO_LARGE } from '@pickarr/contract';
import type { LookupEnvelope } from './types.ts';

/**
 * The lookup service's answer, as the string `rss_item.lookup_json` stores.
 *
 * `media` is dropped, `lookupId` through `suggestions` are kept, and the
 * result is capped at {@link LOOKUP_JSON_CAP_BYTES} bytes -- see the module
 * doc comment above for why each of those is safe to do here.
 */
export function lookupJsonFor(envelope: LookupEnvelope): string {
  // Destructured rather than deleted from a copy: `media` is excluded by
  // not being named, which is a rule the reader can check by reading, and
  // a field added to `LookupEnvelope` later is excluded by default rather
  // than included by accident.
  const { lookupId, state, partial, cached, confidence, refusal, parsed, suggestions } = envelope;
  const json = JSON.stringify({ lookupId, state, partial, cached, confidence, refusal, parsed, suggestions });
  // `Buffer.byteLength`, not `.length`: a multi-byte character counts once
  // as a character and up to four times in the replica.
  return Buffer.byteLength(json, 'utf8') > LOOKUP_JSON_CAP_BYTES ? LOOKUP_JSON_TOO_LARGE : json;
}
