import type { DownloadClients } from './downloads.ts';
import type { HostFetch } from './fetch.ts';
import type { JobQueue, JobRecord } from './jobs.ts';
import type { MediaWriter } from './media.ts';
import type { Migration } from './migrations.ts';

export type MediaType = 'tv' | 'movie' | 'xxx' | 'book';

export interface DownloadedFile {
  path: string;
  sizeBytes: number;
  downloadClientId: number;
}

export interface PluginContext {
  /**
   * Drizzle over this plugin's own tables. Typed from the plugin's own schema,
   * which is why the host cannot type it: only the plugin knows the shape.
   */
  db: unknown;
  media: MediaWriter;
  jobs: JobQueue;
  fetch: HostFetch;
  downloads: DownloadClients;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

export type JobHandler = (job: JobRecord, ctx: PluginContext) => Promise<void>;

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
