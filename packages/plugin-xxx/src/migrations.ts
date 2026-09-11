/**
 * Two tables: the producing site, and the scene itself.
 *
 * The site is its own table because scenes from one site share it -- a scene's
 * `details` names the site every time, and a row per scene would store the
 * same name a thousand times and still have nowhere to hang a site's own
 * artwork or url later.
 *
 * Version 2, because version 1 is the engine's state table.
 */
import type { Migration } from '@pickarr/contract';

export const XXX_MIGRATIONS: readonly Migration[] = [{
  version: 2,
  up: (db) => db.exec(`
CREATE TABLE xxx_site (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX xxx_site_provider_ref ON xxx_site (provider, provider_ref);

CREATE TABLE xxx_scene (
  id               INTEGER PRIMARY KEY,
  media_item_id    INTEGER NOT NULL REFERENCES media_item (id),
  site_id          INTEGER REFERENCES xxx_site (id),
  duration_seconds INTEGER,
  released_on      TEXT,
  details_json     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX xxx_scene_media_item ON xxx_scene (media_item_id);
`),
}];
