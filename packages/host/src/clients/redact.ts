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
  return url.replace(CREDENTIAL_QUERY_PARAM_PATTERN, '$1***');
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
