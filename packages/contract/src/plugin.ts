import type { DownloadClients } from './downloads.ts';
import type { HostFetch } from './fetch.ts';
import type { JobQueue, JobRecord } from './jobs.ts';
import type { MediaReader, MediaWriter } from './media.ts';
import type { Migration } from './migrations.ts';
import type { SyncedTable } from './sync.ts';

export type MediaType = 'tv' | 'movie' | 'xxx' | 'book';

/**
 * A finished download, as the host hands it to the plugin that owns it.
 *
 * `path` is the **mapped** path -- what this host can open, not what the
 * download client called it. That is also why `rssItemId` is a field rather
 * than something a plugin recovers for itself: `torrent_download` and
 * `nzb_download` store the client's raw `storage_path`, so a plugin looking
 * itself up by `(storage_path, download_client_id)` would find nothing
 * exactly when a `filepath_mapping` row applies. See the importer design
 * spec §2.
 */
export interface DownloadedFile {
  path: string;
  sizeBytes: number;
  downloadClientId: number;
  /** The rss item this download was started for. */
  rssItemId: number;
  /**
   * The media item that rss item resolved to, or `null` for a release
   * nothing matched.
   *
   * Nullable and required rather than optional: an unmatched release is a
   * real outcome with its own destination (design spec §6), and stating it
   * at the boundary is what keeps it from being discovered part-way through
   * an import. A plugin that forgot the case gets a type error, not a
   * `NaN` in a path.
   */
  mediaItemId: number | null;
}

export interface PluginContext {
  /**
   * The host's raw `node:sqlite` connection, untyped here because only the
   * plugin knows its own schema. The host cannot hand back a Drizzle handle
   * typed to that schema — it has never seen it — so a plugin wraps this
   * connection in Drizzle itself, over whichever tables its own migrations
   * created.
   */
  db: unknown;
  /**
   * The typed way to write the shared rows -- and, unlike `read` below,
   * **not** scoped to this plugin. It is one writer shared by every plugin
   * context, closed over no plugin id, so `setResolution`,
   * `updateMediaItem` and `dropMediaItem` all act on any row id handed to
   * them regardless of who owns the row. See `MediaWriter` for why that
   * asymmetry stands for now.
   */
  media: MediaWriter;
  /**
   * The intended way a plugin reads shared rows, not the only way -- the
   * same caveat `MediaWriter` opens with, and for the same reason: `db`
   * above is the host's raw connection, the very one the shared tables live
   * in, so nothing stops a plugin from selecting another plugin's
   * `media_item`, `rss_item` or download rows directly. What follows is a
   * property of reads that come *through this interface*.
   *
   * Through it, every read is scoped to this plugin: the host builds one
   * reader per plugin, closed over its id, so a plugin cannot read another
   * plugin's media items, nor the rss items and downloads under another
   * plugin's feeds -- all four methods are scoped, not just the two that
   * name a media item. That is a typed boundary a plugin can rely on, not a
   * sandbox the host enforces; there is no confinement here to breach.
   *
   * `media` is deliberately *not* renamed to `write` alongside it -- every
   * plugin, the test double and the flow tests name it, and the churn would
   * buy nothing.
   */
  read: MediaReader;
  jobs: JobQueue;
  fetch: HostFetch;
  downloads: DownloadClients;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/**
 * `signal` is optional so every handler written before the dispatcher
 * existed remains a valid `JobHandler` untouched. The dispatcher passes a
 * real one, tied to its five-minute per-job ceiling; a handler that ignores
 * it still runs, it just cannot be asked to unwind early.
 */
export type JobHandler = (job: JobRecord, ctx: PluginContext, signal?: AbortSignal) => Promise<void>;

/**
 * A media plugin.
 *
 * Three entry points, none optional: a plugin that cannot answer all three is
 * not a plugin. This does **not** reduce the number of entry points — `jobs` is
 * open-ended, so a plugin with eleven job kinds has eleven of them, behind
 * `JobHandler` rather than in this interface. What changes is that the host's
 * coupling is fixed at three, the handlers are uniform in shape, and a job kind
 * enqueued but not handled is a visible dead-letter row rather than a silently
 * absent method.
 */
export interface MediaPlugin {
  /** Also the required prefix for every table this plugin declares. */
  readonly id: string;
  readonly mediaType: MediaType;
  readonly migrations: readonly Migration[];
  readonly jobs: Readonly<Record<string, JobHandler>>;

  /**
   * The tables this plugin contributes to a client's replica. Empty means the
   * plugin adds nothing beyond the host's own tables.
   *
   * The host owns the triggers for these, not the plugin: a trigger a plugin
   * forgot would diverge every client with nothing failing, so it is not left
   * to a caller.
   */
  readonly synced: readonly SyncedTable<unknown>[];

  /**
   * The tokens this plugin's library path shape may name, without braces --
   * `season`, not `{season}`.
   *
   * Declared by the plugin for the same reason `synced` is declared and its
   * triggers are not: only the plugin knows what it can resolve. `{season}`
   * means something for television and nothing for a film, and the host has
   * no way to tell which is which. The host validates a saved shape against
   * the declaring plugin's list and refuses an unknown token by name, so a
   * typo fails where it is typed rather than months later as a wrong path
   * (design spec §3).
   *
   * Includes the tokens every plugin shares -- `resolution`, `filename` and
   * `ext`, which come from `rss_item` and the source path rather than from
   * the plugin's own tables. They are listed by each plugin rather than
   * merged in here so that one list answers "what may I type", with nothing
   * a reader has to know to add to it.
   */
  readonly tokens: readonly string[];

  onNewRssItems(ids: readonly number[], ctx: PluginContext): Promise<void>;
  onDownloadedFile(file: DownloadedFile, ctx: PluginContext): Promise<void>;
  onDownloadRequest(rssItemId: number, ctx: PluginContext): Promise<void>;
}
