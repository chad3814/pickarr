/**
 * The one place `packages/web` spells a plugin's *display* name --
 * `'tv' -> 'TV'`, `'movie' -> 'Movies'`, `'xxx' -> 'XXX'`.
 *
 * **Two screens needed this and, until now, had two different answers.**
 * `shell/Shell.tsx`'s nav has read this vocabulary since task 4 (there as
 * a module-private `CATEGORY_LABELS`, keyed on `Category` --
 * `shell/useCounts.ts`'s `'tv' | 'movie' | 'xxx'`); `settings/Destinations.tsx`
 * rendered each row's raw `plugin.pluginId` instead, so the nav read **TV** /
 * **Movies** / **XXX** while the destination heading directly below it, for
 * the same plugin, read **tv** / **movie** / **xxx**. This module is the fix:
 * one map, imported by both, so the two cannot drift apart again.
 *
 * **Keyed by plugin id, not by `Category` or `MediaType`.** `@pickarr/contract`'s
 * `TOKEN_NAMES_BY_PLUGIN` docblock is explicit that plugin id and `MediaType`
 * are different keys that merely coincide for the three shipped plugins --
 * `Destinations.tsx`'s rows are addressed by `PluginTokens.pluginId`, which is
 * `MediaPlugin.id`, not by a `Category`. Keying this map on `Category` would
 * make `Destinations.tsx` either import a shell-only type it has no other
 * reason to depend on, or convert; keying on plugin id (a bare `string`) is
 * what let `Category` widen to it for free at the one call site that still
 * has one (`Shell.tsx`'s nav).
 *
 * **`pluginLabel` falls back to the id itself, deliberately.** A fourth
 * plugin added to `@pickarr/contract`'s `TOKEN_NAMES_BY_PLUGIN` gets a row on
 * `/settings` with no edit here (`Settings.tsx`'s own `Object.entries`), and
 * with no entry in {@link PLUGIN_LABELS} it must read as its own id rather
 * than as `undefined` -- the same "degrade to the id" the contract docblock
 * asks for, not a second thing to remember to keep in sync.
 */
export const PLUGIN_LABELS: Readonly<Record<string, string>> = {
  tv: 'TV',
  movie: 'Movies',
  xxx: 'XXX',
};

/**
 * `PLUGIN_LABELS[pluginId]`, or `pluginId` itself for a plugin the map does
 * not name.
 *
 * **`Object.hasOwn`, not a bare index, and the difference is reachable.**
 * `PLUGIN_LABELS` is an object literal, so it inherits `Object.prototype`
 * -- and `api/server.ts`'s `PLUGIN_ID` is `/^[a-z][a-z0-9_]{0,31}$/`, which
 * `constructor` matches. Measured before this guard: `pluginLabel('constructor')`
 * answered the `Object` function itself, because a bare index found it on
 * the prototype and `??` only fires on `undefined`. Whatever a heading
 * would have done with a function child, it would not have been "read as
 * its own id", which is the whole of what the fallback promises.
 * `test/pluginLabels.test.tsx` pins it. It is the same
 * prototype-safety `media/shape.ts`'s resolver already applies to a token
 * name, for the same reason -- the key is not this module's to choose.
 */
export function pluginLabel(pluginId: string): string {
  const label = Object.hasOwn(PLUGIN_LABELS, pluginId) ? PLUGIN_LABELS[pluginId] : undefined;
  return label ?? pluginId;
}
