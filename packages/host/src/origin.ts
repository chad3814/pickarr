/**
 * Refuses anything that is not a bare origin, for every caller that supplies
 * one.
 *
 * There are two: `PICKARR_PUBLIC_URL` and the config file's
 * `server.publicUrl`. They share this function rather than a copy of it,
 * because of what the auth slice measured when only one of them checked: a
 * value carrying a path is accepted, becomes Better Auth's `baseURL`, and
 * every `/api/auth/*` route then answers 404 with an empty body -- nobody can
 * sign in, sign up or sign out, cookies issued earlier keep working, and
 * `/api/health` still answers 200, so a container health check reports the
 * host healthy. Nothing is logged. A query string and a fragment do the same
 * thing, which is why all three are refused.
 *
 * `label` names the source so the message says which of the two was wrong.
 * The value itself is never in the message: it is a url, and no log line in
 * this repo may carry one.
 */
export function assertOriginOnly(value: string, label: string): void {
  if (!URL.canParse(value)) {
    throw new Error(`${label} is not a url`);
  }
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} is not an http or https url`);
  }
  if (url.pathname !== '/') {
    throw new Error(`${label} must have no path: its pathname must be /`);
  }
  if (url.search !== '') {
    throw new Error(`${label} must have no query string`);
  }
  if (url.hash !== '') {
    throw new Error(`${label} must have no fragment`);
  }
}
