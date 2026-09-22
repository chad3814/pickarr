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
 * must add its name here rather than assume `redactText` already knows every
 * shape a credential can take.
 */
/**
 * What a redacted secret reads as, everywhere in this module.
 *
 * One spelling, because two would be a distinction without a difference:
 * a reader meeting `***` beside `*****` has to work out whether the
 * length means something. It does not.
 */
const MASK = '*****';

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
/**
 * Free text on its way to a log line or a stored column, with anything
 * credential-shaped masked.
 *
 * **It was called `redactUrl`, and that name was wrong for most of its
 * callers.** Ten of its fifteen call sites pass an error message, not a
 * url -- `clients/reconcile.ts`'s `failMessage`, `jobs/run-job.ts`'s
 * caught error, `api/server.ts`'s two log lines. A name that describes one
 * caller in three is the false-name problem this codebase keeps paying
 * for, so the url-shaped work moved to a real {@link redactUrl} and this
 * kept the job it was actually doing.
 *
 * Two passes: the `?apikey=` **name** rule, which catches a short value no
 * shape rule could, and {@link redactSecrets}, which catches a
 * credential-shaped run wherever it sits -- including a path segment,
 * which has no name to match on.
 */
export function redactText(text: string): string {
  return redactSecrets(text.replace(CREDENTIAL_QUERY_PARAM_PATTERN, `$1${MASK}`));
}


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
 * **Why a shape rather than a list of names (issue #78).** {@link redactText}
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
  return schemeEnd === -1 ? MASK : `${value.slice(0, schemeEnd)} ${MASK}`;
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
  return body.replace(CREDENTIAL_FORM_FIELD_PATTERN, `$1${MASK}`);
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

/**
 * A query parameter whose **name** suggests it carries a credential.
 *
 * Substrings rather than exact names, matched case-insensitively, so
 * `apikey`, `API_KEY`, `passkey`, `x-auth-token` and `private_key` are all
 * caught by four short words. A name list is what {@link redactText}
 * carried and what issue #78 found too narrow; this is the same idea with
 * a far wider net, and it runs *alongside* the shape rules rather than
 * instead of them -- a name match catches a short value no shape rule can.
 */
const CREDENTIAL_PARAM_HINTS = ['api', 'token', 'key', 'pass'];

function namesACredential(parameter: string): boolean {
  const lowered = parameter.toLowerCase();
  return CREDENTIAL_PARAM_HINTS.some((hint) => lowered.includes(hint));
}

/**
 * A url with its credentials masked, parsed as a url rather than matched as
 * text.
 *
 * Three passes, each reaching something the others cannot:
 *
 * 1. **`password`** -- the userinfo credential in
 *    `http://user:hunter2@qbit:8080`, which is an ordinary way to run a
 *    download client behind basic auth. No shape rule reaches `hunter2`:
 *    it is seven characters with no case mixture.
 * 2. **Any query parameter whose name hints at a credential**
 *    ({@link CREDENTIAL_PARAM_HINTS}), whatever its value looks like.
 * 3. **{@link redactSecrets} over the result**, which catches a
 *    credential-shaped run anywhere else -- most importantly a path
 *    segment, `/announce/<secret>/`, which has no name to match on.
 *
 * **The password is set only when there is one.** Assigning it
 * unconditionally *invents* userinfo: `new URL('https://tr.example/rss')`
 * with `password = '*****'` serialises as
 * `https://:*****@tr.example/rss`, which would rewrite every clean feed
 * url in the sync projection into something that is not the url the
 * operator entered. Measured, not assumed.
 *
 * **A string that is not a url falls back to {@link redactText}.**
 * `new URL` throws on one, and callers include `sync/tables.ts` projecting
 * a column a human typed. Throwing inside a log line or a sync projection
 * would turn a redaction miss into an outage, so the unparseable case gets
 * the text treatment instead of an exception.
 */
export function redactUrl(url: string | URL): string {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : new URL(url.href);
  } catch {
    return redactText(typeof url === 'string' ? url : String(url));
  }

  if (parsed.password !== '') parsed.password = MASK;

  // Two passes, because `URLSearchParams` is live: collecting the names
  // first means the second loop is not mutating the thing the first is
  // walking. Only existing keys are `set`, so today's single pass would
  // survive -- but "it happens to be safe for the mutation we do now" is
  // the kind of premise that breaks when someone adds a `delete`.
  const credentialNames: string[] = [];
  for (const name of parsed.searchParams.keys()) {
    if (namesACredential(name)) credentialNames.push(name);
  }
  for (const name of credentialNames) parsed.searchParams.set(name, MASK);

  return redactSecrets(parsed.href);
}
