import type { ComponentType } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { GatheredItemView, PickSubmit } from './types.ts';

/**
 * Replica rows for one media item, keyed by table name.
 *
 * `unknown`, for the reason `web/src/store/rows.ts` returns `unknown`: the
 * store does not know what shape any table holds, and a plugin's own
 * narrowing is where that knowledge belongs. A replica persists across
 * client builds, so a row written by one build is read against whatever the
 * next build's contract means -- narrow with `in` guards and decline a row
 * that does not match, never assert one.
 *
 * Every table the plugin declared is a key, with an empty array when the
 * item has no rows in it. A caller never has to distinguish "no rows" from
 * "table not fetched".
 */
export type PluginRows = Readonly<Record<string, readonly unknown[]>>;

export interface CardProps {
  /** The media item, already held by the list before anything is gathered. */
  readonly item: MediaItemSyncRead;
  /** This plugin's declared tables, for this item. See {@link PluginRows}. */
  readonly rows: PluginRows;
  /**
   * Releases and their downloads, or `undefined` until the card has
   * expanded and the gather has landed. A card renders its collapsed state
   * without this, which is what keeps a collapsed row free.
   */
  readonly gathered: GatheredItemView | undefined;
  /** Tells web to start gathering. Idempotent; call it when the card expands. */
  readonly onExpand: () => void;
  readonly submit: PickSubmit;
}

export interface BrowserPlugin {
  /** Matches `MediaItemSyncRead.pluginId` and the host plugin's id. */
  readonly id: string;
  /** What the nav, the heading and the route label call this category. */
  readonly label: string;
  /**
   * Replica tables this plugin's card reads. Web fetches exactly these and
   * hands them to `Card` as {@link PluginRows}; the plugin never touches
   * the store.
   */
  readonly tables: readonly string[];
  readonly Card: ComponentType<CardProps>;
}
