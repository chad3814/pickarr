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
 * **The poster renders immediately from `item`, before anything is
 * gathered.** `item` is the `MediaItemSyncRead` the list already holds, and
 * `rows` is this item's plugin rows, batched for the whole page by
 * `library/usePluginRows.ts` -- so a collapsed card's headline costs
 * nothing beyond what the list already paid for. Releases, and whatever
 * download each has, come from `useGatheredItem` and are fetched only once
 * the plugin's card says it expanded.
 *
 * **Artwork is not replicated** (design spec §1.2, #79). The poster below is
 * a request to `/api/artwork/poster/:mediaItemId`, which 404s for most items
 * for a long while yet; `onError` swaps it out rather than letting a broken
 * image blank the rest of the card.
 */
import { useCallback, useState, type ReactElement } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { PluginRows } from '@pickarr/plugin-ui';
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
}

export function MediaItemCard({ source, item, rows, submit }: MediaItemCardProps): ReactElement {
  /**
   * Whether this card has *ever* been expanded -- a latch, not the plugin's
   * own expanded/collapsed state, which web does not see.
   *
   * `CardProps` gives a plugin one signal, `onExpand`, and no matching
   * collapse (`@pickarr/plugin-ui`'s own doc: "Tells web to start
   * gathering. Idempotent"). So gathering starts on the first expand and
   * never stops, which is a deliberate trade and not an oversight: the
   * reason `useGatheredItem` used to re-gather on re-expand was that it
   * tore its subscriptions down while collapsed and so missed anything that
   * landed in that window. A subscription that is never torn down cannot
   * miss it, so the re-gather has nothing left to correct. What it costs is
   * a `media_item` subscription and two insert subscriptions per card the
   * operator has opened at least once, held until the list unmounts.
   */
  const [everExpanded, setEverExpanded] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const gathered = useGatheredItem(source, item.id, everExpanded);

  // `useCallback` so the plugin's card gets the same function every render.
  // Nothing in the three shipped cards puts it in a dependency array, but
  // `CardProps` is a public seam and a card that did would otherwise
  // rebuild an effect on every keystroke anywhere in the list.
  const onExpand = useCallback(() => {
    setEverExpanded(true);
  }, []);

  const plugin = pluginFor(item.pluginId);

  return (
    <article>
      {!posterFailed && (
        <img
          src={`/api/artwork/poster/${String(item.id)}`}
          alt={item.title}
          onError={() => {
            setPosterFailed(true);
          }}
        />
      )}
      {/*
        An item whose `pluginId` no plugin in the registry claims renders
        its title and nothing else. This is reachable, not defensive: the
        replica persists across client builds and its rows were written by
        whatever plugins the *host* had registered, so a build that drops a
        plugin -- or one that meets a host carrying an extra -- reads rows
        it cannot place. Rendering the title keeps the row identifiable and
        the page usable; throwing would take the whole list down, and
        rendering nothing would leave a poster with no name under it.
      */}
      {plugin === undefined ? (
        <h2>{item.title}</h2>
      ) : (
        <plugin.Card item={item} rows={rows} gathered={gathered} onExpand={onExpand} submit={submit} />
      )}
    </article>
  );
}
