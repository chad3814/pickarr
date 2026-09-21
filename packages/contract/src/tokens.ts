/**
 * What each shipped plugin's library path shape may name -- the **names**
 * only, with every resolver left in the plugin that owns it.
 *
 * ## Why these are here and not in the three plugin packages
 *
 * The settings screen has to list the tokens an operator may type, per
 * plugin, and design spec §3 is explicit that it must read them from the
 * same declaration the host validates against, "so the list cannot drift
 * from what resolves". A browser cannot reach that declaration.
 *
 * **Measured, rather than assumed.** Adding `@pickarr/plugin-tv` to
 * `packages/web`'s `dependencies` fails `npm run build`: a plugin package
 * reaches `node:sqlite` through `drizzle-orm`, which no browser bundle can
 * resolve. The other route -- a copy of the three lists in
 * `packages/web/src` -- is what `packages/web`'s own tests forbid, and is
 * the drift this module exists to remove.
 *
 * So the names live in the package both sides already depend on, exactly as
 * `./destinations.ts`, `./mappings.ts`, `./feeds.ts` and
 * `./download-clients.ts` each argue for their refusal codes: one
 * declaration, a compile error on both sides when it is renamed.
 *
 * ## The names are shared; the resolvers are not, and cannot be
 *
 * A {@link TokenResolver} takes a `PluginContext` and reads the plugin's own
 * tables -- `tv_series`, `movie_detail`, `xxx_scene` -- which this package
 * has never seen and must not. So a plugin declares
 * `tokens: TokensFor<TvTokenName>` and writes the function behind each name
 * itself. {@link TokensFor} is what locks the two together: a name added
 * here without a resolver is a missing-property error in the plugin, and a
 * resolver written for a name that is not here is an excess-property error
 * on the same literal. Neither side can move alone.
 *
 * That is the same guard `MediaPlugin.tokens` already carries one level
 * down -- declaration and resolver are one entry, so "declared but never
 * resolved" is not a state -- extended across the package boundary.
 *
 * ## Which plugin's list is which, and why they differ
 *
 * `{season}` is a television token and nothing else; `{collection}` and
 * `{year}` are a film's; `{site}` is a scene's. Validating a shape against
 * the union of all three would accept `{season}` in a film shape and
 * produce a hole at import, which is what `PUT /api/destinations/:pluginId`
 * refuses `unknown-token` for (design spec §3).
 *
 * `title`, `releaseDate`, `filename` and `ext` are on every list because
 * they come from `media_item` and the source path rather than from any
 * plugin's own tables. They are **written out in each list** rather than
 * spread in from a shared constant, for the reason `MediaPlugin.tokens`
 * gives: one array is the whole answer to "what may a shape of this kind
 * say", with nothing a reader has to go and find.
 *
 * ## `resolution` is not here, and design spec §3 is wrong about it
 *
 * §3 lists `resolution` among the tokens that "come from `rss_item`".
 * `rss_item.resolution` is the **lookup state** -- `'pending' | 'resolved' |
 * 'refused' | 'unresolved'`, `./media.ts`'s `Resolution`, inserted as the
 * literal `'pending'` by `host/src/feeds/reader.ts` -- not a video
 * resolution, and 2.0 stores a video resolution nowhere. Interpolating it
 * would name an episode `The Bear - S03E01 resolved.mkv`, permanently,
 * since §10 puts re-importing out of scope. `{resolution}` is therefore
 * `unknown-token` on save. Issue #98 tracks it, and the day something does
 * record one, the name comes back here and the resolver goes in the
 * plugins.
 */
import type { TokenResolver } from './plugin.ts';

/**
 * A `MediaPlugin.tokens` whose keys are exactly `Name` -- no more, no
 * fewer.
 *
 * **Both directions, and both are the compiler's.** A missing key is a
 * missing-property error; an extra key on an object literal is an
 * excess-property error. That is what makes a list here and a map in a
 * plugin one declaration rather than two that agree today.
 *
 * Assignable to `PluginTokens` (`Readonly<Record<string, TokenResolver>>`)
 * because a mapped type receives an implicit index signature, so a plugin
 * declaring this still satisfies `MediaPlugin` unchanged.
 */
export type TokensFor<Name extends string> = Readonly<Record<Name, TokenResolver>>;

/**
 * What a television path may name.
 *
 * `series`, `season` and `episode` are `plugin-tv`'s own, from `tv_series`,
 * `tv_season` and `tv_release`. `{series}` is deliberately not `{title}`:
 * `media_item.title` for an episode is the *episode's* title, so a shape
 * using `{title}` as a directory would put every episode in a directory
 * named after itself.
 */
export const TV_TOKEN_NAMES = [
  'series', 'season', 'episode', 'title', 'releaseDate', 'filename', 'ext',
] as const;

/** One of {@link TV_TOKEN_NAMES}. */
export type TvTokenName = (typeof TV_TOKEN_NAMES)[number];

/**
 * What a film path may name.
 *
 * `collection` is `plugin-movie`'s own, from `movie_detail`. `year` sits
 * beside `releaseDate` because the convention every film library already
 * uses is `Title (2024)`, and deriving a year from a date string is not
 * something a shape can express.
 *
 * There is no `season` and no `episode`; a film shape naming either is
 * refused on save.
 */
export const MOVIE_TOKEN_NAMES = [
  'title', 'year', 'releaseDate', 'collection', 'filename', 'ext',
] as const;

/** One of {@link MOVIE_TOKEN_NAMES}. */
export type MovieTokenName = (typeof MOVIE_TOKEN_NAMES)[number];

/**
 * What a scene path may name.
 *
 * `site` is `plugin-xxx`'s own, from `xxx_site` through `xxx_scene`. There
 * is no `year`: a scene is dated to the day and `releaseDate` carries that,
 * where a film library's convention wants the year alone.
 */
export const XXX_TOKEN_NAMES = [
  'site', 'title', 'releaseDate', 'filename', 'ext',
] as const;

/** One of {@link XXX_TOKEN_NAMES}. */
export type XxxTokenName = (typeof XXX_TOKEN_NAMES)[number];

/**
 * Every shipped plugin's token names, keyed by `MediaPlugin.id` -- what a
 * settings screen iterates to offer an operator the right vocabulary for
 * the destination it is editing.
 *
 * **Keyed by plugin id, not by `MediaType`.** The two are equal for `tv`
 * and `xxx` and are *not* the thing being keyed: a destination row is
 * `plugin_destination.plugin_id`, the route is
 * `PUT /api/destinations/:pluginId`, and `MediaItemSyncRead.pluginId` is
 * what a client already groups by. Keying by media type would make the
 * caller convert, on a mapping only the host holds.
 *
 * **The ids are spelled here and declared in the plugins**, which is the
 * one pair in this module the compiler cannot lock: `TV_PLUGIN_ID` is
 * `packages/plugin-tv`'s and this package must not import it.
 * `host/test/plugins/tokens.test.ts` drives the comparison instead, against
 * the plugins `main` actually builds, so a renamed id fails there rather
 * than leaving a settings screen offering tokens under a key nothing
 * matches.
 */
export const TOKEN_NAMES_BY_PLUGIN: Readonly<Record<string, readonly string[]>> = {
  tv: TV_TOKEN_NAMES,
  movie: MOVIE_TOKEN_NAMES,
  xxx: XXX_TOKEN_NAMES,
};
