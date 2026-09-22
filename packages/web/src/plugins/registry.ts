import type { BrowserPlugin } from '@pickarr/plugin-ui';
import { tvBrowser } from '@pickarr/plugin-tv/browser';
import { movieBrowser } from '@pickarr/plugin-movie/browser';
import { xxxBrowser } from '@pickarr/plugin-xxx/browser';

/**
 * Every plugin the browser knows, in display order.
 *
 * **The one place in `packages/web/src` that names a plugin.** The category
 * routes, the nav, the counts and each card's body all derive from this
 * array; `test/plugins/registry.test.ts` fails if an id appears anywhere
 * else under `src/`.
 *
 * **Import the `/browser` subpath, never the package root.** A root import
 * reaches `node:sqlite` through `@pickarr/openmetadata` -> `drizzle-orm`
 * and fails `npm run build` -- not this typecheck, and not any unit test.
 * `test/plugins/bundle.test.ts` is what catches it, and it only catches it
 * once something has built; `test/plugins/registry.test.ts` also refuses a
 * root specifier by reading the source, so the cheap gate fails too.
 *
 * **An array, not an object keyed by id** -- which is the shape
 * `src/pluginLabels.ts` had before this file replaced it. That module needed
 * a documented `Object.hasOwn` guard, because `pluginLabel('constructor')`
 * indexed straight through to `Object` itself and React throws on a function
 * child. `.find` over an array has no prototype-key hazard, so the guard
 * retired with the file. Re-keying this by id brings it back.
 */
export const BROWSER_PLUGINS: readonly BrowserPlugin[] = [tvBrowser, movieBrowser, xxxBrowser];

/**
 * The plugin registered under `id`, or `undefined` for one this build does
 * not carry.
 *
 * `undefined` is a state callers must render rather than assume away, and
 * the two callers reach it differently -- worth separating, because an
 * earlier version of this paragraph gave both of them the replica's
 * argument and only one of them earns it:
 *
 * - `settings/Destinations.tsx` is where `undefined` genuinely arrives. Its
 *   plugin list comes from `@pickarr/contract`'s `TOKEN_NAMES_BY_PLUGIN`, an
 *   independent list in another package that this array does not drive, so
 *   an id absent from here really can turn up and the row is headed by the
 *   raw id.
 * - `MediaItemCard`'s fallback is defensive. Its items are filtered through
 *   a key range scoped to an id that came from this array, so no
 *   unregistered id can reach it on any screen this build has; the branch
 *   exists because a `media_item` row's `pluginId` comes from the replica,
 *   which persists across client builds and was written by whatever plugins
 *   the *host* had registered -- a set this array does not control. That
 *   card's own comment carries the call graph.
 */
export function pluginFor(id: string): BrowserPlugin | undefined {
  return BROWSER_PLUGINS.find((plugin) => plugin.id === id);
}
