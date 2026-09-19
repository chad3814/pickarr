/**
 * The `/settings` screen's feeds section: every configured feed, read from
 * the replica, plus the form that adds one (design spec
 * `2026-09-18-feed-settings-design.md`, whole doc). The host's first write
 * surface.
 *
 * **This was the whole of `/settings` and is now one of two sections on
 * it** (the download clients slice, design spec §6). Two things moved out
 * with that change and both moved to `Settings.tsx`, which is the route's
 * element now: the `data-testid="settings"` route-mapping marker, which
 * belongs on the screen's root element and this is no longer that, and the
 * page's `<h1>`. What is left here is a `<section>` named by its own `<h2>`
 * -- the same shape `DownloadClients.tsx` has, so the two read alike.
 *
 * **Each listed feed's name is an `<h3>`, one level under this section's
 * own `<h2>`.** It was an `<h2>` until the accessibility-tree repair, which
 * made a feed a sibling of the section listing it; `settings.css`'s
 * heading-hierarchy rule had already given it the third tier's *size*, so
 * the announced structure and the rendered one disagreed. `Settings.tsx`
 * owns the `<h1>` and the levels below it are fixed by that: `<h2>` for a
 * section, `<h3>` for anything inside one. `Settings.test.tsx` pins the
 * whole screen's levels so this cannot flatten again silently.
 *
 * **The feed's `url` is rendered exactly as the replica holds it.** It
 * arrives redacted by the host, not raw (`RssFeedSyncRead`'s own doc), and
 * this screen never parses, reconstructs or otherwise "fixes" it -- doing
 * so could only either fail on a redacted value or quietly undo whatever
 * the host already stripped.
 */
import type { ReactElement } from 'react';
import { useFeeds, type FeedsSource } from './useFeeds.ts';
import { AddFeed, type AddFeedInput, type AddFeedOutcome } from './AddFeed.tsx';

/** Re-exported so a caller of this section (`Settings.tsx`, this file's own tests) needs one import, not two -- `useFeeds.ts` is where it is declared, since that hook is what actually needs it narrowed. */
export type { FeedsSource };

export interface FeedsProps {
  source: FeedsSource;
  /** Posts a new feed. Required, not defaulted -- see `AddFeed.tsx`'s own docblock. */
  submit: (input: AddFeedInput) => Promise<AddFeedOutcome>;
}

export function Feeds({ source, submit }: FeedsProps): ReactElement {
  const feeds = useFeeds(source);

  return (
    <section aria-labelledby="feeds-heading">
      <h2 id="feeds-heading">Feeds</h2>
      <AddFeed submit={submit} />
      {feeds !== undefined &&
        (feeds.length === 0 ? (
          <p>No feeds yet.</p>
        ) : (
          <ul aria-label="feeds">
            {feeds.map((feed) => (
              <li key={feed.id}>
                <h3>{feed.name}</h3>
                <p>{feed.url}</p>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
