/**
 * One row of the paged per-category list: the poster, and beneath it
 * whatever the item's plugin renders (design spec §2 -- "a plugin owns its
 * card body ... web keeps the poster, routing, paging, the replica, and the
 * shell").
 *
 * **This component holds the `<article>`, and the plugin's `Card` renders
 * into it.** One card is one `<article>`, so `styles/library.css`'s bare
 * `article` and `article img` rules still reach a card and its poster with
 * no class added, and `packages/e2e/tests/shell.spec.ts`'s
 * `getByRole('article')` still names exactly one element per row. The three
 * plugin cards render their body without a wrapper of their own for that
 * reason -- an `<article>` inside this one would be two per row, and the
 * poster would fall outside the bordered card that `article img` styles.
 *
 * **That last sentence is now enforced rather than argued.** It rested on a
 * measurement no test in the tree could reproduce, so the decision could
 * have been reversed by anyone who disagreed with the prose.
 * `packages/e2e/tests/shell.spec.ts`'s `a TV card reads its series and
 * episode before anyone expands it, under a cropped poster` reads
 * `width`, `aspect-ratio` and `object-fit` back off the real poster in
 * Chromium, and both ways of putting `article img` out of its reach were
 * run against it: with that rule deleted the poster computes `1px` -- the
 * seeded image's own intrinsic width -- and with the wrapper opened by the
 * plugin instead of here the poster sits outside the `<article>` entirely
 * and the pin reds on an element it cannot find. `styles/library.css`'s own
 * header lists both, and the two mutations of the heading rule beside them.
 *
 * **The poster renders immediately from `item`, before anything is
 * gathered.** `item` is the `MediaItemSyncRead` the list already holds, and
 * `rows` is this item's plugin rows, batched for the whole page by
 * `library/usePluginRows.ts` -- so a collapsed card's headline costs
 * nothing beyond what the list already paid for. Releases, and whatever
 * download each has, come from `useGatheredItem` and are fetched only while
 * the plugin's card reports itself expanded -- which it does through
 * `CardProps.onExpandedChange`, on the way down as well as up.
 *
 * **This component renders no artwork of its own, and used to.** It held a
 * browse-row poster until the detail section landed, at which point an
 * expanded card showed the same image twice -- once above the heading and
 * once inside the section. The browse one was removed outright rather than
 * hidden while expanded, so a collapsed row is now text.
 *
 * Two things went with it. `library.css`'s `article img` rule existed for
 * that poster, so the images `@pickarr/plugin-ui` renders into this
 * `<article>` now size themselves rather than overriding it. And the
 * end-to-end proof that `/api/artwork/poster/:id` serves real bytes moved
 * to `packages/e2e/tests/shell.spec.ts`'s expanded card: the detail poster
 * is the only `<img>` left that loads from the real route instead of an
 * intercepted one, which is why that spec still seeds bytes to disk before
 * the item reaches the replica (`harness-2.ts`'s `seedTvRelease`).
 */
import { useCallback, useState, type ReactElement } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { IdentifySubmit, PluginRows } from '@pickarr/plugin-ui';
import { useGatheredItem, type GatheredSource } from './useGatheredItem.ts';
import { pluginFor } from '../plugins/registry.ts';
import type { PickSubmit } from './postPick.ts';

export interface MediaItemCardProps {
  source: GatheredSource;
  item: MediaItemSyncRead;
  /**
   * This item's rows in whatever tables its plugin declared -- fetched by
   * the list this card renders inside, one batched read for the whole
   * page (`library/usePluginRows.ts`), and handed down rather than
   * fetched here. A card cannot fetch its own: the plugin needs these rows
   * to render its headline while *collapsed* (design spec §4, acceptance
   * 1), and `gatherMediaItem`/`useGatheredItem` only run once a card
   * expands (`useGatheredItem.ts`'s own doc on why).
   */
  rows: PluginRows;
  /**
   * Submits one pick, handed to the plugin's card and never called here.
   * Required and threaded from `Shell.tsx` rather than defaulted to the
   * real `postPick`, for the reason `ReleaseList.tsx`'s docblock gives: a
   * default doing network I/O is invisible at the call site, and a test
   * that forgets it gets a real `fetch` under jsdom.
   */
  submit: PickSubmit;
  /**
   * The seam the plugin's card identifies a release through (Requery and
   * Edit), handed to it and never called here. Required for the reason
   * `submit` is.
   */
  identify: IdentifySubmit;
}

export function MediaItemCard({ source, item, rows, submit, identify }: MediaItemCardProps): ReactElement {
  /**
   * The plugin card's own expanded state, mirrored here because that is
   * what decides whether to gather. The plugin owns the state and reports
   * every transition through `CardProps.onExpandedChange`; this holds no
   * opinion of its own and never renders from it.
   *
   * **It mirrors, rather than latching on the first expand, because a latch
   * cost 72 live subscriptions for 24 cards.** The first version of this
   * seam gave web only an `onExpand` and no collapse, so this state could
   * only ever be a "has it ever been opened" latch -- and
   * `useGatheredItem`'s fan-out moved from "cards currently open" to "cards
   * ever opened", which a paging list makes unbounded. Measured before the
   * seam gained `onExpandedChange`: 24 cards opened and closed again held
   * 72 subscriptions, and one `torrent_download` insert cost **24**
   * IndexedDB transactions with nothing open on screen. The same scenario
   * now holds 0 and costs 0. `@pickarr/plugin-ui`'s `onExpandedChange` doc
   * has the contract reasoning.
   */
  const [expanded, setExpanded] = useState(false);
  const gathered = useGatheredItem(source, item.id, expanded);

  // `useCallback` so the plugin's card gets the same function every render.
  // Nothing in the three shipped cards puts it in a dependency array, but
  // `CardProps` is a public seam and a card that did would otherwise
  // rebuild an effect on every keystroke anywhere in the list.
  const onExpandedChange = useCallback((next: boolean) => {
    setExpanded(next);
  }, []);

  const plugin = pluginFor(item.pluginId);

  return (
    <article>
      {/*
        An item whose `pluginId` no plugin in the registry claims renders
        its title and nothing else.

        **This is defensive, and no screen in this build can reach it.** An
        earlier version of this comment claimed the opposite; the
        whole-branch review tried to construct the case and found the call
        graph closed. This component is rendered from one site,
        `Category.tsx`; `Category` is rendered from one site, `Shell.tsx`,
        once per `BROWSER_PLUGINS` entry with `pluginId={plugin.id}`; and
        `useMediaItems` lists through `listByTablePlugin('media_item',
        pluginId, ...)`, a key range scoped to that one id. So `item.pluginId`
        here is always an id the registry holds, and `pluginFor` never
        answers `undefined` at this line. A plugin dropped from the registry
        does not produce fallback cards -- it loses its route, its nav entry
        and its count, so its items become invisible instead, which is
        design spec acceptance 8 working as specified.

        **What justifies keeping the branch is the replica, not a reachable
        screen.** A `media_item` row's `pluginId` comes from IndexedDB,
        which persists across client builds and was written by whatever
        plugins the *host* had registered -- a set this client does not
        control -- so the value genuinely is unvalidated data of open range,
        and `pluginFor`'s signature says so by returning `undefined`. The
        branch is what keeps rendering a card a total function over that
        data, and what defends the first caller that lists media items
        outside a category route, where the key-range filter above is the
        only thing making the id safe today.

        Rendering the title keeps such a row identifiable and the page
        usable; throwing would take the whole list down, and rendering
        nothing would leave a poster with no name under it.
      */}
      {plugin === undefined ? (
        <h2>{item.title}</h2>
      ) : (
        <plugin.Card item={item} rows={rows} gathered={gathered} onExpandedChange={onExpandedChange} submit={submit} identify={identify} />
      )}
    </article>
  );
}
