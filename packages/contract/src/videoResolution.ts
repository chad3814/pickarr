/**
 * The one definition of a video resolution Pickarr will store.
 *
 * **Here, in the contract, because two packages must agree on it and
 * neither may depend on the other**: the host's `MediaWriter` refuses
 * anything else, and `@pickarr/openmetadata` narrows the lookup service's
 * `parsed.quality.resolution` through it. The host migration that backfills
 * the column restates it in SQL, because a migration is frozen once applied
 * and must not call a helper that could change; `host/test/db/migrate.test.ts`
 * runs that SQL over the same cases this module's test does.
 *
 * **Why so strict.** The value is interpolated into library paths as
 * `{resolution}`, and it arrives as text from a third party whose `parsed`
 * object the OpenAPI document gives no shape at all. A scan height and a scan
 * letter is everything the token needs and nothing a path can be hurt by.
 */
const VIDEO_RESOLUTION = /^[0-9]{3,4}[pi]$/;

/** `value` lowercased if it is a scan height and a scan letter (`1080p`, `720i`), otherwise `null`. */
export function normalizeVideoResolution(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  return VIDEO_RESOLUTION.test(lowered) ? lowered : null;
}
