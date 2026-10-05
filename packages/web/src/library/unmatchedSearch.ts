/**
 * What a search over the unmatched releases matches against.
 *
 * An unmatched release has no media item, so the catalog (design spec
 * 2026-10-02) has nothing for it. What it does have is its filename and,
 * once the lookup service has answered, the envelope the host stored as
 * `lookupJson`: the service's own reading of the name (`parsed`), the
 * candidate it found but would not confirm (`media`, with its people and
 * its parents -- an episode's series), and what it suspected when it found
 * nothing (`suggestions`: a site and performers). Those are the words an
 * operator remembers a release by, so they are what the search reads.
 *
 * **Named fields, not the raw JSON.** `lookupJson` is also full of ids,
 * provider names, states and keys, and a term like `tmdb` or `cached`
 * matching every release would make the search useless. Only the fields
 * below contribute, and `providerRef` and `lookupId` never do.
 *
 * **Shape-tolerant.** The envelope is typed in `@pickarr/openmetadata`,
 * which `packages/web` must not import (it reaches `node:sqlite`); and a
 * replica can hold envelopes written by an older host. So this reads the
 * JSON as `unknown`, takes each field only when it has the expected shape,
 * and treats a body that does not parse -- or the host's "too large"
 * marker -- as a release with a filename and nothing else.
 *
 * Built per row when a walk meets it, not cached: a `JSON.parse` is cheap
 * next to the IndexedDB read that delivered the row, and a walk only
 * builds haystacks while a term is set.
 */
import { LOOKUP_JSON_TOO_LARGE } from '@pickarr/contract';
import { buildHaystack } from '../store/catalog.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `value[field]` when it is a non-empty string, else nothing. */
function text(value: unknown, field: string): string[] {
  if (!isRecord(value)) return [];
  const found = value[field];
  return typeof found === 'string' && found !== '' ? [found] : [];
}

/** `value[field]` as a string when it is a number (a year), else nothing. */
function numberText(value: unknown, field: string): string[] {
  if (!isRecord(value)) return [];
  const found = value[field];
  return typeof found === 'number' ? [String(found)] : [];
}

/** The `field` of every record in `value[list]`, when `value[list]` is an array. */
function textsOfEach(value: unknown, list: string, field: string): string[] {
  if (!isRecord(value)) return [];
  const found = value[list];
  if (!Array.isArray(found)) return [];
  return found.flatMap((entry: unknown) => text(entry, field));
}

/** Every string or number value of the `parsed` record: the parser's reading of the name. */
function parsedValues(parsed: unknown): string[] {
  // A record, not an array: `Object.values(['x'])` is `['x']` too, and an
  // array here is not the parser's reading of anything.
  if (!isRecord(parsed) || Array.isArray(parsed)) return [];
  return Object.values(parsed).flatMap((value) => {
    if (typeof value === 'string' && value !== '') return [value];
    if (typeof value === 'number') return [String(value)];
    return [];
  });
}

/** The parts of an envelope a person would search for, in a stable order; `[]` for a body that is not an envelope. */
export function envelopeSearchParts(lookupJson: string | undefined): string[] {
  if (lookupJson === undefined || lookupJson === LOOKUP_JSON_TOO_LARGE) return [];
  let envelope: unknown;
  try {
    envelope = JSON.parse(lookupJson);
  } catch {
    return [];
  }
  if (!isRecord(envelope)) return [];
  const media: unknown = envelope['media'];
  const suggestions: unknown = envelope['suggestions'];
  return [
    ...text(media, 'title'),
    ...numberText(media, 'year'),
    ...textsOfEach(media, 'people', 'name'),
    ...textsOfEach(media, 'parents', 'title'),
    ...text(isRecord(suggestions) ? suggestions['site'] : undefined, 'name'),
    ...textsOfEach(suggestions, 'performers', 'name'),
    ...parsedValues(envelope['parsed']),
  ];
}

/** The haystack a term is tested against: the filename and the envelope's named parts, normalised and newline-joined like the catalog's. */
export function unmatchedHaystack(filename: string, lookupJson: string | undefined): string {
  return buildHaystack([filename, ...envelopeSearchParts(lookupJson)]);
}
