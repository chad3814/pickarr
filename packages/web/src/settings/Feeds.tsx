/**
 * `/settings`: every configured feed, read from the replica, plus the form
 * that adds one (design spec `2026-09-18-feed-settings-design.md`, whole
 * doc). The host's first write surface.
 *
 * **`data-testid="settings"` on the root element carries task 4's route-
 * mapping contract forward**, the same way `library/Category.tsx`'s
 * `category-${pluginId}` and `library/Unmatched.tsx`'s `unmatched` do:
 * `shell/Shell.test.tsx`'s mapping tests find whichever screen renders at
 * each route by this marker alone, not by rendered prose, so this
 * component's own text and layout stay free to change.
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

/** Re-exported so a caller of this screen (`Shell.tsx`, this file's own tests) needs one import, not two -- `useFeeds.ts` is where it is declared, since that hook is what actually needs it narrowed. */
export type { FeedsSource };

export interface FeedsProps {
  source: FeedsSource;
  /** Posts a new feed. Required, not defaulted -- see `AddFeed.tsx`'s own docblock. */
  submit: (input: AddFeedInput) => Promise<AddFeedOutcome>;
}

export function Feeds({ source, submit }: FeedsProps): ReactElement {
  const feeds = useFeeds(source);

  return (
    <section aria-labelledby="settings-heading" data-testid="settings">
      <h1 id="settings-heading">Feed settings</h1>
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
