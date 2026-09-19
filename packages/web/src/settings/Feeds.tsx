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
                <h2>{feed.name}</h2>
                <p>{feed.url}</p>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
