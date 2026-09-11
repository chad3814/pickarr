/**
 * `unknown` to wire types, one field at a time, throwing a `TypeError` that
 * names the field that is wrong.
 *
 * Narrowing functions rather than casts, and the reason is the failure a cast
 * produces instead: a service that renames `providerRef` would, behind a cast,
 * write a `media_item` row whose provider reference is the string
 * `"undefined"` -- claimed, unique, and wrong forever. Here it fails a job
 * with the field's name in the message.
 */
import type {
  DetailValue,
  LookupBatchEntry,
  LookupBatchResponse,
  LookupEnvelope,
  LookupState,
  Media,
  MediaKind,
  MediaParent,
  MediaPerson,
  MediaSuggestions,
  SuggestedName,
} from './types.ts';

function fail(field: string, why: string): never {
  throw new TypeError(`openmetadata: ${field} ${why}`);
}

function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(field, 'is not an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field, 'is not a string');
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(value, field);
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field, 'is not a boolean');
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, 'is not a number');
  return value;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(field, 'is not an array');
  return value;
}

const STATES: readonly string[] = ['resolved', 'unresolved', 'pending'];
const KINDS: readonly string[] = ['movie', 'series', 'season', 'episode', 'book', 'scene'];

function state(value: unknown): LookupState {
  const text = string(value, 'state');
  if (!STATES.includes(text)) fail('state', `is not a lookup state: ${text}`);
  return text as LookupState;
}

function kind(value: unknown, field: string): MediaKind {
  const text = string(value, field);
  if (!KINDS.includes(text)) fail(field, `is not a media kind: ${text}`);
  return text as MediaKind;
}

function details(value: unknown): Readonly<Record<string, DetailValue>> {
  const raw = object(value, 'media.details');
  const read: Record<string, DetailValue> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry === 'string') {
      read[key] = entry;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      read[key] = entry;
    } else {
      fail(`media.details.${key}`, 'is not a string, number or null');
    }
  }
  return read;
}

function parent(value: unknown, field: string): MediaParent {
  const raw = object(value, field);
  return {
    id: string(raw['id'], `${field}.id`),
    kind: kind(raw['kind'], `${field}.kind`),
    title: string(raw['title'], `${field}.title`),
    releaseDate: nullableString(raw['releaseDate'], `${field}.releaseDate`),
    year: nullableNumber(raw['year'], `${field}.year`),
    provider: string(raw['provider'], `${field}.provider`),
    providerRef: string(raw['providerRef'], `${field}.providerRef`),
  };
}

function person(value: unknown, field: string): MediaPerson {
  const raw = object(value, field);
  return {
    providerRef: string(raw['providerRef'], `${field}.providerRef`),
    name: string(raw['name'], `${field}.name`),
    role: string(raw['role'], `${field}.role`),
    characterName: nullableString(raw['characterName'], `${field}.characterName`),
    billingOrder: nullableNumber(raw['billingOrder'], `${field}.billingOrder`),
  };
}

function media(value: unknown): Media | null {
  if (value === null) return null;
  const raw = object(value, 'media');
  return {
    ...parent(raw, 'media'),
    overview: nullableString(raw['overview'], 'media.overview'),
    details: details(raw['details']),
    parents: array(raw['parents'], 'media.parents')
      .map((entry, index) => parent(entry, `media.parents[${index}]`)),
    people: array(raw['people'], 'media.people')
      .map((entry, index) => person(entry, `media.people[${index}]`)),
  };
}

function suggestedName(value: unknown, field: string): SuggestedName {
  const raw = object(value, field);
  return {
    name: string(raw['name'], `${field}.name`),
    providerRef: string(raw['providerRef'], `${field}.providerRef`),
  };
}

function suggestions(value: unknown): MediaSuggestions | null {
  if (value === null) return null;
  const raw = object(value, 'suggestions');
  const site = raw['site'];
  return {
    site: site === null ? null : suggestedName(site, 'suggestions.site'),
    performers: array(raw['performers'], 'suggestions.performers')
      .map((entry, index) => suggestedName(entry, `suggestions.performers[${index}]`)),
  };
}

/** One envelope: what a poll answers, and what each batch entry is built on. */
export function readEnvelope(value: unknown): LookupEnvelope {
  const raw = object(value, 'envelope');
  const parsed = raw['parsed'];
  return {
    lookupId: string(raw['lookupId'], 'lookupId'),
    state: state(raw['state']),
    partial: boolean(raw['partial'], 'partial'),
    cached: boolean(raw['cached'], 'cached'),
    confidence: nullableNumber(raw['confidence'], 'confidence'),
    refusal: nullableString(raw['refusal'], 'refusal'),
    // Shape-checked only: nothing reads it, and the document gives it none.
    parsed: parsed === null ? null : object(parsed, 'parsed'),
    media: media(raw['media']),
    suggestions: suggestions(raw['suggestions']),
  };
}

function batchEntry(value: unknown, index: number): LookupBatchEntry {
  const raw = object(value, `results[${index}]`);
  const status = raw['status'];
  if (typeof status !== 'number' || !Number.isInteger(status)) {
    fail(`results[${index}].status`, 'is not an integer');
  }
  return { ...readEnvelope(raw), status };
}

/** A batch answer. Entries stay in the order the service returned them. */
export function readBatchResponse(value: unknown): LookupBatchResponse {
  const raw = object(value, 'batch response');
  return {
    results: array(raw['results'], 'results').map((entry, index) => batchEntry(entry, index)),
  };
}
