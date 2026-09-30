import type { DatabaseSync } from 'node:sqlite';

/** A plugin-owned table a client replicates, and how to read it. */
export interface SyncedTable<T> {
  /** The table's name. Must carry the plugin's id as a prefix; see `assertSyncedTableName`. */
  readonly table: string;
  /** Current state for these row ids, in the shape the client receives. */
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, T>;
}

/** A plain SQL identifier: what may be interpolated into a trigger body. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * Refuses a table name that is malformed, or that does not carry the given
 * plugin id as a prefix.
 *
 * Two checks. The name must be a plain identifier, because it is
 * interpolated into a trigger body where SQLite binds no parameters
 * (`sync/log.ts`), so a name is the one place a plugin's declaration reaches
 * SQL as text -- that is the load-bearing one, refusing e.g.
 * `tv_a; DROP TABLE media_item`. And it must carry `pluginId` as a prefix,
 * the rule a plugin's migrations already follow.
 *
 * This checks shape and self-consistency only: given the *true* `pluginId`,
 * does the table it names look like one that plugin owns. It cannot check
 * more than that -- `packages/contract` has no business knowing the host's
 * table names, or any other plugin's -- so on its own it does **not** stop a
 * plugin claiming a table the host or another plugin already owns;
 * `assertSyncedTableName('media', 'media_item')` passes, because `media_item`
 * does carry `'media'` as a prefix. Refusing a table already owned elsewhere
 * is checked separately, by `sync/registry.ts` in the host, which is where
 * the host's own table names and every plugin's declared tables are actually
 * gathered.
 */
export function assertSyncedTableName(pluginId: string, table: string): void {
  if (!IDENTIFIER.test(table)) {
    throw new Error(`synced table ${JSON.stringify(table)} is not a plain identifier`);
  }
  if (!table.startsWith(`${pluginId}_`)) {
    throw new Error(
      `plugin ${JSON.stringify(pluginId)} declared synced table ${JSON.stringify(table)}, ` +
      `which does not carry its id as a prefix`,
    );
  }
}

/**
 * The six read shapes, one per synced **plugin** table. The host's own nine
 * are below, under `MediaItemSyncRead`.
 *
 * **Every one of these six omits the row's own id, and that is not an
 * oversight.** A client keys a row by the `id` the host puts on the op that
 * carries it, beside `op` and `table`, never by a field a read shape
 * happened to remember to include -- so the key is the protocol's, not each
 * plugin author's. See `sync/tail.ts`'s `SyncOp` for why: an op whose id
 * lived inside `value` could not be matched against the delete that later
 * names the same row, and the three shapes here carried no id at all until
 * the op did, which made every plugin upsert unkeyable and every plugin
 * delete unappliable. `SyncOp` is also where the three op kinds
 * (`create`/`upsert`/`delete`) and the two rules a client applies them by
 * are stated.
 *
 * **The host's nine do carry an `id`, and that does not contradict the
 * paragraph above.** `sync/tables.ts` projects `id` because its `SELECT`s
 * are the row and nothing maps them, and `readHostRows` keys its result by
 * that column -- so the field is there whether or not a client reads it. It
 * is redundant with the op's `id` rather than an alternative to it: the key a
 * client stores a row under is the op's on a host table exactly as on a
 * plugin one, because a `delete` op carries no `value` to read an id out of.
 *
 * The three *detail* shapes -- one row per media item -- do carry
 * `mediaItemId`, because grouping is a different question from keying: the
 * client has to attach a detail row to the media item it belongs to, and
 * `media_item.id` is not this row's key. The three *parent* shapes
 * (`TvSeasonRead`, `TvSeriesRead`, `XxxSiteRead`) carry no `mediaItemId`,
 * because their tables have no `media_item_id` column -- many episodes share
 * one season, many scenes one site -- and they are reached through the
 * detail rows that point at them.
 */

/** What a client receives for a television media item. */
export interface TvRead {
  /** The media item this release belongs to. Not this row's key; see the note above. */
  mediaItemId: number;
  kind: 'series' | 'season' | 'episode';
  seriesTitle: string;
  seriesRef: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/** What a client receives for a film media item. */
export interface MovieRead {
  /** The media item this detail row belongs to. Not this row's key; see the note above. */
  mediaItemId: number;
  runtimeMinutes: number | null;
  /** IMDb's `tt…` id, for the card's external link. Null for a film the service gave none for. */
  imdbId: string | null;
  tagline: string | null;
}

/** What a client receives for an adult media item. */
export interface XxxRead {
  /** The media item this scene belongs to. Not this row's key; see the note above. */
  mediaItemId: number;
  siteName: string | null;
  siteRef: string | null;
}

/**
 * What a client receives for a television season, independent of any one
 * release.
 *
 * `seriesId` is a `tv_series.id`, which resolves against the `id` on the
 * `tv_series` op -- the op-level key described above is what makes this
 * reference land on a row the client actually holds.
 *
 * **It resolves eventually, not in order.** Declaration order used to be
 * emission order, because the backfill emitted a group's plugin tables in the
 * order the plugin listed them; it walks `sync_log` now, so emission order is
 * write order and a plugin has no handle on it. A client can therefore hold a
 * season whose `seriesId` names a series it has not received yet, and the
 * series arrives elsewhere in the same walk. That is the same tolerance a
 * client already needs for `rss_item.feed_id` and `download_client_id`, which
 * name tables that are never synced at all -- see `sync/backfill.ts` for the
 * property and why it was accepted.
 */
export interface TvSeasonRead {
  seriesId: number;
  seasonNumber: number | null;
  title: string | null;
}

/** What a client receives for a television series, independent of any one release. */
export interface TvSeriesRead {
  title: string;
  providerRef: string;
  firstAirDate: string | null;
  overview: string | null;
}

/** What a client receives for an adult site, independent of any one scene. */
export interface XxxSiteRead {
  name: string;
  providerRef: string;
}

/**
 * The nine read shapes for the **host's** own synced tables --
 * `sync/tables.ts`'s `selectSql` projections, field for field.
 *
 * **Why `SyncRead` and not `Read`.** `MediaItemRead` and `RssItemRead` are
 * already taken, by `./media.ts`, and they are a different surface: those are
 * what `MediaReader` answers and what `/api/media` and `/api/rss-items`
 * serve, and neither matches its sync counterpart. `MediaItemRead` has no
 * `pluginId`; `RssItemRead` has `link` -- which this wire deliberately never
 * carries, since for a private tracker that url carries the passkey and a
 * replica is permanent -- and no `createdAt`, `updatedAt` or `rankingScore`.
 * Reusing
 * either would either leak a field or silently drop one. All nine carry the
 * suffix rather than only the two that had to, so the family reads as one;
 * the plugin shapes above keep their bare `Read` because renaming them means
 * touching three plugin packages for no requirement.
 *
 * **These are not the wire's source of truth -- the projections are.** They
 * exist so a client types against a declaration instead of transcribing
 * `selectSql` by hand -- the field-name drift design spec §6 names, as
 * "the worst failure this design can have, moved from triggers to types"
 * after §3.7's silently diverging client. What keeps them from being a second
 * source of truth is
 * `packages/host/test/sync/tables.test.ts`: it reads each projection's key
 * set off a real row and compares it against a `Record<keyof …, true>`
 * witness per shape, so a column added to a `SELECT` and not to the shape
 * fails, and a field added here and not to the `SELECT` fails to compile.
 * That check is over *names*; a field's declared type is not mechanisable
 * from a TypeScript type at run time and is not covered.
 *
 * **This family used to carry two fields naming a row a client would never
 * receive, and it now carries none.** `RssItemSyncRead.feedId` was the first
 * to stop being one, when `rss_feed` joined this family below in the same
 * slice that added `RssFeedSyncRead`. `TorrentDownloadSyncRead`'s and
 * `NzbDownloadSyncRead`'s `downloadClientId` was the second and the harder
 * of the two -- it was documented as unresolvable *in principle*, not merely
 * today -- and `DownloadClientSyncRead` below is what retired that. Each
 * field says so on itself rather than here, because a client that reads only
 * the field list is the one that needs to know.
 */

/**
 * A media item -- the group a client browses -- as the replica holds it.
 *
 * `id` is redundant with the op's; see the note above `TvRead`.
 */
export interface MediaItemSyncRead {
  id: number;
  /** Which plugin owns this item, and so which category it browses under. */
  pluginId: string;
  createdAt: number;
  updatedAt: number;
  /** Null while no lookup has claimed this item for a provider. */
  provider: string | null;
  /** Null with `provider`: the two are claimed together (`claimProviderRef`). */
  providerRef: string | null;
  title: string;
  releaseDate: string | null;
  description: string | null;
}

/** A release found in a feed, as the replica holds it. */
export interface RssItemSyncRead {
  id: number;
  /**
   * The `rss_feed` this release came from. **This used to be an id a client
   * could never resolve to a name, and that changed when `rss_feed` joined
   * the synced set** (`sync/tables.ts`'s top docblock has why, and the
   * redaction its url now travels under). A client can therefore join this
   * to `RssFeedSyncRead.id` and label the feed, not merely group and count
   * by it as before.
   */
  feedId: number;
  filename: string;
  createdAt: number;
  updatedAt: number;
  /**
   * `'torrent'` or `'nzb'` in every row this host writes, but typed `string`
   * rather than a union, because nothing narrows it on the way here. The
   * column is TEXT with no CHECK and `PluginContext.db` hands a plugin the
   * raw connection, so a row can hold any string; `/api/rss-items` gets its
   * `'torrent' | 'nzb'` from `downloadTypeOf`, a guard at that read boundary
   * which this projection has no equivalent of. A union here would be a
   * promise the wire does not keep.
   */
  downloadType: string;
  /** Null for a release no lookup has attached to a group yet. */
  mediaItemId: number | null;
  rankingScore: number | null;
  /**
   * What became of this release's identification -- `./media.ts`'s
   * `LookupState`. `string` rather than that union for the reason
   * `downloadType` above gives: the column is unconstrained TEXT and nothing
   * narrows it between the `SELECT` and the wire.
   */
  lookupState: string;
  lookupStateDetail: string | null;
  /**
   * The lookup service's parse of this release's video resolution --
   * `normalizeVideoResolution`'s output, so `1080p`, `2160p`, or `null` when
   * the name stated none or no answer has arrived. Written by the lookup
   * engine on every answer (issue #98).
   */
  videoResolution: string | null;
  /**
   * The lookup service's own answer for this release, as JSON, or `null`.
   *
   * **Only present while a release is unmatched.** Written wherever the
   * engine reaches a terminal resolution that is not `resolved` -- the
   * two such resolutions are `refused` and `unresolved`, across **three**
   * call sites in `packages/openmetadata/src/engine.ts`, because
   * `unresolved` is reached both when the service says so and when it
   * never finishes inside `MAX_POLLS`. (This sentence said "the two
   * terminal branches" and was miscounting branches as resolutions.)
   * Cleared by the `UPDATE` that resolves one, so a matched release
   * carries no copy of the answer that matched it. That
   * bound is the whole reason this column is affordable: without it, every
   * client's replica would grow by one lookup response per release for
   * ever.
   *
   * Serialised from the validated `LookupEnvelope`, never from the
   * response bytes -- `media` included. It was omitted in an earlier
   * revision on the assumption that a non-resolved envelope always carries
   * a null `media`; `packages/openmetadata/src/validate.ts`'s
   * `readEnvelope` parses `media` unconditionally, with no gate on `state`
   * or `refusal`, so that assumption was false, and dropping it would have
   * discarded the most direct evidence of *why* a half-identified release
   * was not confirmed -- the whole question this column exists to answer.
   * Capped: over the cap the column holds a short marker instead, which
   * the unmatched screen renders in place of the answer.
   */
  lookupJson: string | null;
  deliveredAt: number | null;
}

/**
 * The most `RssItemSyncRead.lookupJson` may hold, in bytes on the wire.
 *
 * Lives here, in `@pickarr/contract`, rather than beside the code that
 * writes or renders it, because both sides need it and neither may depend
 * on the other: the host side that writes this column lives behind
 * `@pickarr/openmetadata`, and `packages/web` must never depend on that
 * package -- it reaches `node:sqlite` through drizzle, which has no browser
 * build. `@pickarr/contract` is the one package both already depend on.
 *
 * 32768, not 8192: `Media` carries a synopsis, an arbitrary `details`
 * object, its `parents` chain and a full cast, and fifty people is roughly
 * 6 KB on its own now that `media` is part of what this column stores. At
 * the smaller cap the richest answers -- the ones with the most cast and
 * detail to show -- would all become the marker and only the thin ones
 * would stay readable, which is backwards: the bound should cost the
 * unmatched set as a whole, not punish the answers most worth reading. It
 * is still a real bound, because only non-resolved releases store
 * anything here and the unmatched set is normally a short tail.
 */
export const LOOKUP_JSON_CAP_BYTES = 32768;

/**
 * What `lookupJson` holds instead of an answer too large to keep. Valid
 * JSON, so a client can parse it and recognise it rather than render
 * wreckage. See `LOOKUP_JSON_CAP_BYTES` immediately above for why both
 * constants live here rather than beside the code that uses them.
 */
export const LOOKUP_JSON_TOO_LARGE = '{"pickarr":"lookup-answer-too-large"}';

/**
 * A pick submitted to a torrent client, as the replica holds it.
 *
 * Neither `storagePath` nor `lastError` is here, and neither ever will be:
 * `sync/tables.ts`'s `selectSql` doc has why a path and a partly-redacted
 * error string are served through `/api/downloads` and refused here.
 *
 * **`FilepathMappingSyncRead` below carries two filesystem paths, and that
 * is not this rule bending.** The two cases differ in where the string came
 * from. A `storagePath` is **discovered** -- the download client reports
 * where it happened to put a file, so replicating it discloses a layout
 * nobody chose to disclose, and no operator ever asked to see it. A mapping
 * is **dictated**: both of its paths are strings the operator typed into
 * the settings screen, and reading them back shows someone their own input.
 * The rule's purpose -- that this host does not leak filesystem structure
 * to a client that never asked for it -- is untouched, and the sentence
 * above still means exactly what it says. Design spec §5 argues it in full.
 */
export interface TorrentDownloadSyncRead {
  id: number;
  rssItemId: number;
  /**
   * The `download_client` this was submitted to. **This used to say the id
   * could never be resolved to a name, and that is no longer true.** The
   * reason it gave was that a `download_client` row holds a service's
   * address and the names of its secrets -- so the table was said to be not
   * merely unsynced today but unsyncable. What changed is that the
   * projection stopped carrying either: `DownloadClientSyncRead` names no
   * secret name at all, and its `url` is rebuilt from origin and path. So a
   * client can now say *which* client a download went to, not only group by
   * it.
   */
  downloadClientId: number;
  /** Null until the client confirms the submission. */
  infohash: string | null;
  /** The client's own handle for this download. Null until it confirms. */
  clientRef: string | null;
  /** The host's own vocabulary, which grows; `string` for the reason `DownloadRead.status` gives. */
  status: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  percentage: number | null;
  absentSince: number | null;
  deliveredAt: number | null;
  reclaimedAt: number | null;
}

/**
 * A pick submitted to an nzb client, as the replica holds it: the torrent
 * shape minus `infohash`, which an nzb has no equivalent of.
 *
 * Declared in full rather than as `Omit<TorrentDownloadSyncRead, 'infohash'>`,
 * because the two projections are two `SELECT`s and the shapes are what the
 * key-set check compares them against one at a time. An `Omit` would make a
 * column added to one table and not the other look like a shape error in the
 * wrong place.
 */
export interface NzbDownloadSyncRead {
  id: number;
  rssItemId: number;
  /** See `TorrentDownloadSyncRead.downloadClientId`: resolvable since `download_client` joined this family. */
  downloadClientId: number;
  clientRef: string | null;
  status: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  percentage: number | null;
  absentSince: number | null;
  deliveredAt: number | null;
  reclaimedAt: number | null;
}

/** Someone who appears in a media item, as the replica holds it. */
export interface PersonSyncRead {
  id: number;
  name: string;
  /** The provider's own person id, which is how lookups de-duplicate people. */
  providerRef: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One person's part in one media item, as the replica holds it.
 *
 * **No `updatedAt`, because the column does not exist** -- `role` is written
 * by an upsert on `(media_item_id, person_id, role)` and has `created_at`
 * alone. Design spec §5.3 notes that neither client obligation needs a
 * per-row version, which is what makes that survivable on the wire.
 */
export interface RoleSyncRead {
  id: number;
  /** The media item this part is in. Not this row's key; the op carries that. */
  mediaItemId: number;
  /** The `person` this part belongs to, which *is* resolvable: `person` is synced. */
  personId: number;
  /** What they did -- the provider's word for it, e.g. `actor`. */
  role: string;
  /** The character's name, where the provider gives one. */
  name: string | null;
  billingOrder: number | null;
  createdAt: number;
}

/**
 * A feed configured on the host, as the replica holds it -- the seventh host
 * synced table, and the first added since the other six shipped
 * (`sync/tables.ts`'s top docblock has the whole story).
 *
 * `url` is the reason this shape exists at all: the operator needs to tell
 * two feeds apart in a settings screen, and a name alone cannot always do
 * that. It reaches this wire **redacted**, not raw -- `readHostRows` strips
 * a `?apikey=` query parameter's value before this row is ever built, which
 * is the one shape `clients/redact.ts`'s `redactUrl` knows. `?passkey=`,
 * `?token=` and a passkey embedded as a path segment all pass through this
 * field unchanged today; issue #78 tracks widening what `redactUrl` catches.
 * A client must not treat this field as safe to log or display without
 * remembering that gap.
 */
export interface RssFeedSyncRead {
  id: number;
  /** Which plugin owns this feed, and so which category it belongs to. */
  pluginId: string;
  name: string;
  /**
   * When polling stopped, or `null` while it has not.
   *
   * A feed that produced releases cannot be deleted -- `rss_item.feed_id`
   * is `NOT NULL` and those items own download rows -- so removing one
   * disables it instead and keeps the history (`host/src/feeds/remove.ts`).
   * A client shows the difference; it does not decide it.
   */
  disabledAt: number | null;
  /**
   * `'torrent'` or `'nzb'`, typed `string` for the reason
   * `RssItemSyncRead.downloadType` gives: the column is unconstrained TEXT
   * and nothing narrows it between the `SELECT` and the wire.
   */
  downloadType: string;
  pollIntervalS: number;
  /** The `download_client` this feed submits to -- resolvable; see `TorrentDownloadSyncRead.downloadClientId`. */
  downloadClientId: number | null;
  createdAt: number;
  updatedAt: number;
  /** Redacted -- see the note above this interface for what that does and does not cover. */
  url: string;
}

/**
 * A configured download client, as the replica holds it.
 *
 * **Two columns of `download_client` are deliberately absent and no future
 * slice should add them**: `api_key_secret_name` and `password_secret_name`.
 * Neither is a credential -- the value lives in the `secret` table and a
 * name is safe to log by this codebase's own rule -- but a name is the
 * layout of the secret store, and a browser has no use for it. The list
 * screen says whether a client has a credential configured; it says so from
 * the *shape* of the auth it was given, never from a name it was handed.
 *
 * `url` is the reason this shape needed a decision rather than a
 * transcription. It does **not** reach this wire the way
 * `RssFeedSyncRead.url` does. A feed's url is `redactUrl`'d, which knows one
 * query parameter (`apikey`) and is why issue #78 is open; this one is
 * rebuilt from its origin and its path, which drops userinfo, query and
 * fragment structurally rather than by recognising them. A client may treat
 * this field as an address and nothing more.
 *
 * **It can be the empty string**, and a client must render that rather than
 * assume it away: `sync/tables.ts`'s `readHostRows` projects `''` for a row
 * whose url is not an http(s) address at all, which the production writer
 * (`clients/add.ts`) refuses but a migration or an operator's own SQL can
 * still produce.
 */
export interface DownloadClientSyncRead {
  id: number;
  name: string;
  /**
   * The transport, `'torrent'` or `'nzb'`. Typed `string` for the reason
   * `RssItemSyncRead.downloadType` gives: the column is unconstrained TEXT
   * and nothing narrows it between the `SELECT` and the wire.
   */
  type: string;
  /** The product, `'qbittorrent'` or `'sabnzbd'` -- `string` for the same reason `type` is. */
  implementation: string;
  /** Origin and path only, and possibly `''`. See the note above this interface. */
  url: string;
  /** Plaintext on purpose: a username is not a credential (`db/schema.ts`). Null when the client authenticates with an api key. */
  username: string | null;
  /** `''` means "no category", which is a configuration rather than a missing value (`clients/sabnzbd.ts`). */
  category: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One path translation for one download client, as the replica holds it --
 * the ninth host synced table.
 *
 * **Its projection is the whole row, and it is the fifth of those rather
 * than the first**, which an earlier version of this sentence claimed.
 * Counted against `PRAGMA table_info` rather than by eye: `media_item`
 * (9 of 9), `person` (5 of 5), `role` (7 of 7) and `rss_feed` (9 of 9) all
 * precede it, and `rss_item` (11 of 13), the two download tables (13 of 15,
 * 12 of 14) and `download_client` (9 of 12) are the ones that hold columns
 * back. What is unusual here is narrower and still worth saying: this table
 * has six columns and no seventh a client is being spared, so unlike every
 * other entry in this family there is no omission to justify -- and
 * `rss_feed`, the whole-row projection nearest to it, still transforms its
 * `url` on the way out, where nothing here is transformed at all.
 *
 * **Both fields are filesystem paths, and both are here deliberately.** See
 * `TorrentDownloadSyncRead` above for why that does not contradict the
 * `storagePath` rule it states: these two are operator input, not client
 * report. `sync/tables.ts`'s top docblock and design spec §5 have the
 * argument.
 *
 * **Neither is validated, normalised or platform-shaped, so a client must
 * not treat either as a path *this* machine could open.**
 * `clients/paths.ts` refuses `node:path` outright -- these are foreign
 * paths, possibly Windows-shaped, always from a machine that is not the
 * one rendering them -- so `D:\Downloads` is a legitimate `fromPath` and
 * the empty string is the only value the writer refuses (design spec §7).
 * A client displays and edits these strings; it does not parse them.
 *
 * `downloadClientId` resolves against `DownloadClientSyncRead.id`, which a
 * client holds: a mapping is meaningless away from the client it belongs
 * to, and the screen nests it under that client's row.
 */
export interface FilepathMappingSyncRead {
  id: number;
  /** The `download_client` whose reported paths this translates. Resolvable; see above. */
  downloadClientId: number;
  /** The prefix a download client reports, matched at a path boundary by `mapClientPath`. */
  fromPath: string;
  /** What that prefix becomes for the host. */
  toPath: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One plugin's library destination as a replica holds it -- the tenth host
 * synced table, and the second whole-row projection that carries a
 * filesystem path on purpose.
 *
 * **Why a path is here at all**, on the same distinction
 * `FilepathMappingSyncRead` above draws and not as a second exception to it:
 * `root` is *dictated*, a string the operator typed into the settings screen
 * that reads it back, where `TorrentDownloadSyncRead.storagePath` is
 * *discovered* -- a client reporting a layout nobody chose to disclose. The
 * `storagePath` rule stands exactly as written.
 *
 * **`pluginId` is not resolvable against any row a client holds.** There is
 * no plugin table: a plugin is code the host loaded, and this string is the
 * `MediaPlugin.id` it registered under -- the same value `MediaItemSyncRead.pluginId`
 * and `RssFeedSyncRead.pluginId` already carry. A client groups by it and
 * addresses `PUT /api/destinations/:pluginId` with it; it does not join on it.
 *
 * Seven columns and the whole row, like `filepath_mapping`: there is nothing
 * else in this table for a client to be spared.
 */
export interface PluginDestinationSyncRead {
  id: number;
  /** The `MediaPlugin.id` this destination belongs to. Unique across the table. */
  pluginId: string;
  /**
   * The absolute directory this plugin's library lives in.
   *
   * Absolute is checked on save (`not-absolute-root`), and nothing else about
   * it is: design spec §7 is explicit that a root that does not exist is a
   * misconfiguration an operator should see rather than a directory the
   * importer invents. A client displays and edits this string; it does not
   * parse it and must not assume it names a directory that exists.
   */
  root: string;
  /**
   * The `{token}` template a resolved path is built from, under `root`.
   *
   * Every token in it is one the owning plugin declared (`MediaPlugin.tokens`),
   * which is checked on save -- a client rendering a token picker reads that
   * same declaration rather than inferring the vocabulary from this string.
   */
  shape: string;
  /**
   * Where a release that matched nothing lands, relative to `root`.
   *
   * A literal directory name: design spec §6 is explicit that nothing in it
   * is a token and nothing in it is interpolated, so a client renders it as
   * typed. Never empty, never absolute and never escaping the root -- all
   * three checked on save.
   */
  unmatchedDir: string;
  createdAt: number;
  updatedAt: number;
}
