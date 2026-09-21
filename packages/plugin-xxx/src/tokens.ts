/**
 * What an xxx library path may name, and how each name resolves (design
 * spec §3).
 *
 * `site` is this plugin's own, from `xxx_site` through `xxx_scene`. There is
 * no `year`: a scene is dated to the day and `releaseDate` carries that,
 * where a film's library convention wants the year alone. The rest are
 * resolved by functions shared with every plugin.
 */
import type { PluginTokens, TokenResolver } from '@pickarr/contract';
import {
  mediaItemText,
  resolveExtension,
  resolveFilename,
  resolveReleaseDate,
  resolveResolution,
  resolveTitle,
} from '@pickarr/openmetadata';

/**
 * The producing site's canonical name.
 *
 * `null` for a scene whose site is unknown: `applyXxx` writes
 * `xxx_scene.site_id` only when the answer carried both a site name and a
 * site reference, because a name with no reference has nothing to key a row
 * on. A scene whose site is unknown is still a scene worth having, so this
 * is a hole design spec §8.8 renders rather than a fault.
 */
const resolveSite: TokenResolver = async (file, ctx) => mediaItemText(
  ctx,
  file,
  `SELECT t.name FROM xxx_scene s JOIN xxx_site t ON t.id = s.site_id
    WHERE s.media_item_id = ?`,
);

export const XXX_TOKENS: PluginTokens = {
  site: resolveSite,
  title: resolveTitle,
  releaseDate: resolveReleaseDate,
  resolution: resolveResolution,
  filename: resolveFilename,
  ext: resolveExtension,
};
