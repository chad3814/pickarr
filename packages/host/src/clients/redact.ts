/**
 * Keeps a download client's credential out of anything this process writes
 * down -- an error message, a log line, a rethrown cause. A credential
 * reaches a client through three different channels, and each needs its own
 * rule for what "the value" even means:
 *
 * - a **query parameter** (SABnzbd's `apikey`) -- the value is delimited by
 *   `=` and `&`/end-of-string, and the parameter's *name* is exactly what a
 *   maintainer needs to see to know a key was even sent.
 * - a **header** (qBittorrent's `Authorization: Bearer <token>`) -- the
 *   value is everything after the auth scheme, and the scheme itself is the
 *   diagnostic part: it says *how* the request authenticated, not what with.
 * - a **form body field** (qBittorrent's legacy `password`) -- shaped like a
 *   query string but never prefixed with `?`.
 *
 * One regex does not cover all three, which is why 1.x's `redactApiKeyParam`
 * (`packages/core/src/clients/sabnzbd.ts`) -- covering only the first,
 * because that is all SABnzbd needed -- is not reused here. Every function
 * below keeps the credential's name and drops only its value: stripping the
 * parameter entirely would tell a maintainer nothing and look exactly like
 * the credential was never sent at all.
 */

/**
 * Query parameter names known to carry a client's credential in the url
 * itself. SABnzbd's `apikey` is the only one anything in this codebase
 * sends; a future client with another credential-bearing query parameter
 * must add its name here rather than assume `redactUrl` already knows every
 * shape a credential can take.
 */
const CREDENTIAL_QUERY_PARAM_NAMES = ['apikey'];

/**
 * Matches `?apikey=<value>` or `&apikey=<value>` anywhere in a string,
 * keying off the structural delimiters (`?`/`&` before, `&`/whitespace/
 * end-of-string after) rather than the value itself, so it fires regardless
 * of how that value is encoded. Case-insensitive because a query parameter
 * name is not case-sensitive to the server reading it, so `ApiKey` and
 * `APIKEY` must be redacted exactly as `apikey` is.
 */
const CREDENTIAL_QUERY_PARAM_PATTERN = new RegExp(
  `([?&](?:${CREDENTIAL_QUERY_PARAM_NAMES.join('|')})=)[^&\\s]*`,
  'gi',
);

/** Replaces the value of any credential-bearing query parameter with ***. */
export function redactUrl(url: string): string {
  return redactSecrets(url.replace(CREDENTIAL_QUERY_PARAM_PATTERN, '$1***'));
}

/** What a redacted secret reads as, wherever one is found. */
const MASK = '*****';

/**
 * A run of 8 or more hexadecimal characters in a single case.
 *
 * **`0-9` is in the class, so an all-digit run matches**, and that is a
 * chosen trade rather than an oversight: an eight-digit byte count and a
 * thirteen-digit epoch both become {@link MASK}. It was taken over sparing
 * them because a credential is the thing that must not escape, and a caller
 * with a large number to log can call `.toLocaleString()` -- whose commas
 * break the run into pieces shorter than eight. A trailing unit does not
 * help: `1700000000000ms` still holds a thirteen-character run, so the
 * separator has to be inside the number.
 *
 * Single case, not mixed: a mixed-case run is the second rule's business,
 * and it applies a filter this one does not need.
 */
const HEX_RUN = /[A-F0-9]{8,}|[a-f0-9]{8,}/g;

/** A run of 8 or more alphanumerics, before {@link hasTwoOfEachClass} filters it. */
const ALNUM_RUN = /[A-Za-z0-9]{8,}/g;

/**
 * Whether a run carries at least two uppercase, two lowercase and two
 * digits -- the filter that makes {@link ALNUM_RUN} usable.
 *
 * Without it the rule would redact most of every log line, `Downloading`
 * and `qbittorrent` included. With it, the runs that survive are the ones
 * that look generated rather than written: an api key, a session token, a
 * base62 id.
 */
function hasTwoOfEachClass(run: string): boolean {
  let upper = 0;
  let lower = 0;
  let digits = 0;
  for (const character of run) {
    if (character >= 'A' && character <= 'Z') upper += 1;
    else if (character >= 'a' && character <= 'z') lower += 1;
    else if (character >= '0' && character <= '9') digits += 1;
  }
  return upper >= 2 && lower >= 2 && digits >= 2;
}

/**
 * Replaces anything shaped like a credential with {@link MASK}.
 *
 * **Why a shape rather than a list of names (issue #78).** {@link redactUrl}
 * knew one parameter name. A private tracker's credential is conventionally
 * `passkey=`, and often has no parameter at all --
 * `/announce/<secret>/file.torrent` -- which #78 records as the reason
 * adding names is not a fix: a path-embedded secret has nothing to strip.
 * A rule about what a credential looks like reaches the path case; no list
 * of names can.
 *
 * **Every match becomes the same five stars**, never a run of stars as long
 * as the match. A length-preserving mask leaks how long the credential was,
 * and makes two different secrets distinguishable from each other in a log.
 *
 * **What it does not catch, recorded rather than left to be discovered.** A
 * credential shorter than eight characters, and one with no digits and no
 * case mixture -- `hunter2` is seven and trips neither rule. Short secrets
 * are not what trackers issue, but this is a filter on shape and a shape
 * can be wrong. It is defence in depth behind the rules that redact by
 * name and position, not a replacement for them.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(HEX_RUN, MASK)
    .replace(ALNUM_RUN, (run) => (hasTwoOfEachClass(run) ? MASK : run));
}


/**
 * Header names known to carry a client's credential. Matched
 * case-insensitively because HTTP header names are themselves
 * case-insensitive -- `Authorization` and `authorization` name the same
 * header.
 */
const CREDENTIAL_HEADER_NAMES = new Set(['authorization']);

/**
 * Keeps an auth header's scheme (`Bearer`, `Basic`, ...) visible -- it says
 * which auth *method* a request used, which is diagnostic, not secret -- and
 * replaces everything after it. A value with no scheme (no space at all) has
 * nothing safe left to keep, so the whole value is replaced.
 */
function redactHeaderValue(value: string): string {
  const schemeEnd = value.indexOf(' ');
  return schemeEnd === -1 ? '***' : `${value.slice(0, schemeEnd)} ***`;
}

/** Replaces the value of a credential-bearing header with ***. */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = CREDENTIAL_HEADER_NAMES.has(name.toLowerCase()) ? redactHeaderValue(value) : value;
  }
  return redacted;
}

/**
 * Form field names known to carry a client's credential. qBittorrent's
 * legacy login endpoint is the one sender of a `password` field in this
 * codebase; a future field name joins this list rather than being assumed
 * already covered.
 */
const CREDENTIAL_FORM_FIELD_NAMES = ['password'];

/**
 * Matches a credential field within an `application/x-www-form-urlencoded`
 * body: shaped like a query string's parameter list but never prefixed with
 * `?`, so the delimiter before a match is the start of the string or `&`,
 * never `?`.
 */
const CREDENTIAL_FORM_FIELD_PATTERN = new RegExp(
  `((?:^|&)(?:${CREDENTIAL_FORM_FIELD_NAMES.join('|')})=)[^&\\s]*`,
  'gi',
);

/** Replaces the value of a credential-bearing form field with ***. */
export function redactFormBody(body: string): string {
  return body.replace(CREDENTIAL_FORM_FIELD_PATTERN, '$1***');
}

/**
 * {@link redactSecrets} over a log line's detail object.
 *
 * **Only string values.** A number cannot carry a tracker passkey, and
 * walking them would mean deciding whether a thirteen-digit `updatedAt` is
 * a secret -- it is not, and `redactSecrets` has no way to know that. The
 * rule against putting a path, url or credential in a log line still binds
 * the caller; this is the net under it, not a licence.
 *
 * A fresh object, never a mutation: two of the three sinks hand their
 * `detail` straight to `console.log`, and the caller's object is not this
 * function's to alter.
 */
export function redactDetail(
  detail: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    redacted[key] = typeof value === 'string' ? redactSecrets(value) : value;
  }
  return redacted;
}
