/**
 * Whether `value` is a hostname the fetch queue could ever key a request
 * on. The queue keys on `new URL(url).hostname`, which is lowercase and
 * carries no port, path, userinfo, query or fragment -- so a config entry
 * spelled with any of those would match nothing and do nothing, silently.
 * Checked by parsing rather than by a hand-written grammar: whatever the
 * URL parser calls the hostname of `http://<value>` is the only spelling
 * that can match, and the equality check is what refuses every
 * normalisation (case folding, a dropped default port, a stripped path).
 *
 * An IPv6 literal (`[::1]`) is refused too: the parser keeps the brackets
 * in `hostname`, so an entry would have to carry them, and nothing in this
 * host fetches a bracketed address today. Left out rather than
 * special-cased.
 */
export function isHostname(value: string): boolean {
  if (value.length === 0) return false;
  if (/[\s/:@?#[\]]/.test(value)) return false;
  if (value !== value.toLowerCase()) return false;
  try {
    return new URL(`http://${value}`).hostname === value;
  } catch {
    return false;
  }
}
