/**
 * The shape of anything that came out of JSON.parse or response.json().
 *
 * This exists so the codebase never has to write `unknown` at a parse
 * boundary: `JSON.parse` returns `any`, which assigns freely to this union,
 * and from there every access is checked.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

export function asJsonArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** Coerces a scalar to a string; anything else becomes the empty string. */
export function asText(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
