import type { DownloadClients } from './downloads.ts';
import type { HostFetch } from './fetch.ts';
import type { JobQueue, JobRecord } from './jobs.ts';
import type { MediaReader, MediaWriter } from './media.ts';
import type { Migration } from './migrations.ts';

export type MediaType = 'tv' | 'movie' | 'xxx' | 'book';

export interface DownloadedFile {
  path: string;
  sizeBytes: number;
  downloadClientId: number;
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
   * The typed way to read the shared rows, scoped to this plugin: the host
   * builds one per plugin, closed over its id, so a plugin cannot read
   * another plugin's media items, nor the rss items and downloads under
   * another plugin's feeds -- all four methods are scoped, not just the two
   * that name a media item. `media` is deliberately *not* renamed to `write`
   * alongside it -- every plugin, the test double and the flow tests name it,
   * and the churn would buy nothing.
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

  onNewRssItems(ids: readonly number[], ctx: PluginContext): Promise<void>;
  onDownloadedFile(file: DownloadedFile, ctx: PluginContext): Promise<void>;
  onDownloadRequest(rssItemId: number, ctx: PluginContext): Promise<void>;
}
