/**
 * Errors the host raises that a caller has to tell apart from every other
 * failure. Their own module so nothing importing one has to import
 * `host.ts` -- `clients/deliver.ts` catches the class below and `host.ts`
 * builds the reconcile job that calls into it, which would be an import
 * cycle if this lived there.
 */

/**
 * Thrown by `Host.deliverToPlugin` when `pluginId` names no plugin this host
 * currently has registered -- the same condition `requestDownload`'s own
 * throw describes in prose ("belongs to a feed whose plugin is not
 * registered"), given a distinct type here rather than left as a generic
 * `Error` because `deliverCompleted` (`clients/deliver.ts`) must tell this
 * one failure apart from every other way a plugin's `onDownloadedFile` can
 * reject: this one means "nobody owns this file", which it reports as
 * `unowned` and retries, the same shape `notifyNewRssItems`'s own `unowned`
 * gives an rss item whose feed names no registered plugin, rather than
 * folding it into an undifferentiated failure count.
 */
export class PluginNotRegisteredError extends Error {
  constructor(pluginId: string) {
    super(`plugin "${pluginId}" is not registered`);
    this.name = 'PluginNotRegisteredError';
  }
}
