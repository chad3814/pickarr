import type { ComponentType } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { GatheredItemView, IdentifySubmit, PickSubmit } from './types.ts';

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
  /**
   * Tells web this card's expanded state changed, so it can start gathering
   * and stop again. Call it on **every** transition, with the state the
   * card is moving *to*.
   *
   * **One callback carrying the new value, rather than an `onExpand` and an
   * `onCollapse`.** The first version of this seam had only `onExpand`,
   * documented "idempotent; call it when the card expands", and gave web no
   * way to learn a card had closed. Web answered with a latch -- "has this
   * card ever been opened" -- which kept `useGatheredItem` enabled for the
   * life of the list. Measured on 24 cards opened and then closed again:
   * **72 live subscriptions, and 24 IndexedDB transactions for a single
   * `torrent_download` insert with nothing expanded on screen.** The
   * subscription fan-out had moved from "cards currently open" to "cards
   * ever opened", which is unbounded in a paging list.
   *
   * A pair of callbacks would have fixed the fan-out and left a worse
   * hazard: a card may call one and forget the other, which silently
   * reinstates the latch for that plugin alone and is invisible to every
   * test of the other two. A single callback taking the new value cannot
   * be half-implemented -- there is one call site per card, and the value
   * is the whole message.
   *
   * **A card still owns its own expanded state**; this reports it. Web
   * mirrors it to decide what to gather (design spec §2: the plugin owns
   * the card body, web owns the replica). A card that never calls this
   * renders an expander that reveals nothing, which is a loud failure
   * rather than a quiet one.
   */
  readonly onExpandedChange: (expanded: boolean) => void;
  /**
   * Open with the detail section showing. The grid's dialog sets this
   * (§2.2); the list never does. `useExpansion` takes it as its starting
   * state, so the heading is still a toggle afterwards.
   */
  readonly initiallyExpanded?: boolean;
  readonly submit: PickSubmit;
  /** Requery and manual edit for this card's releases; handed to `ReleaseList`. */
  readonly identify: IdentifySubmit;
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
  /**
   * Which image a grid tile shows for this plugin's items (design spec
   * 2026-10-04 §2.1): the item's rank-0 poster or its rank-0 background.
   * Required and undefaulted, so a plugin added later renders the grid
   * someone chose for it rather than whichever kind a default picked.
   */
  readonly tile: 'poster' | 'background';
  /**
   * The card body, rendered into the `<article>` web holds
   * (`web/src/library/MediaItemCard.tsx`).
   *
   * **A card ships markup and behaviour, not CSS** (design spec §2, as
   * amended by §2.1). Its styling comes from web's own stylesheet,
   * `packages/web/src/styles/library.css`, which is keyed on structure
   * rather than on any class: `article h2` and `article h2 button` style
   * the title line and its expander, and rules under
   * `ul[aria-label='releases']` style the release list this package's own
   * `ReleaseList.tsx` renders. There is no mechanism for a plugin to ship a
   * stylesheet, and none is planned until a card needs one.
   *
   * **So a card whose markup web has no rule for renders unstyled, and
   * every test still passes.** `getByRole` and `getByText` read the
   * accessibility tree, which a missing stylesheet rule does not touch, and
   * Playwright's `toBeVisible()` is satisfied by an unstyled block of text
   * — this repo has already shipped that exact failure once (`CLAUDE.md`'s
   * `IdentityChangeConfirm` entry: correct roles, ten passing tests, no
   * stylesheet rule, reported broken by its first user). Reuse the markup
   * the three shipped cards use, or add the rule to web's stylesheet in the
   * same change; a green suite is not evidence that the card is legible.
   */
  readonly Card: ComponentType<CardProps>;
}
