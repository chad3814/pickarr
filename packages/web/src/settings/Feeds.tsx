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
import { useState, type ReactElement } from 'react';
import type { AddFeedInput, RssFeedSyncRead } from '@pickarr/contract';
import { useFeeds, type FeedsSource } from './useFeeds.ts';
import { AddFeed, type AddFeedOutcome } from './AddFeed.tsx';
import {
  removalMessage,
  FEED_REFUSAL_MESSAGES,
  type FeedRemovalSubmit,
} from './postFeedRemoval.ts';

/** Re-exported so a caller of this section (`Settings.tsx`, this file's own tests) needs one import, not two -- `useFeeds.ts` is where it is declared, since that hook is what actually needs it narrowed. */
export type { FeedsSource };

export interface FeedsProps {
  source: FeedsSource;
  /** Posts a new feed. Required, not defaulted -- see `AddFeed.tsx`'s own docblock. */
  submit: (input: AddFeedInput) => Promise<AddFeedOutcome>;
  /** Removes, pauses and resumes a feed. Required for the same reason -- see `postFeedRemoval.ts`. */
  removal: FeedRemovalSubmit;
}

/**
 * One feed, with the control that removes it or puts it back.
 *
 * **Its own component so each row owns its pending state and its own
 * sentence** -- with one exception. Held on `Feeds` they would be one map
 * keyed by feed id, and every click would have to be careful not to clear
 * another row's message. The exception is the `deleted` outcome: that row
 * leaves the list on the next sync tick, about twenty milliseconds after the
 * DELETE answers in a real browser (the e2e spec's own timeline), and a
 * sentence held here would unmount with it before anyone read it. So that
 * one sentence goes up through `onRemoved` to a status line `Feeds` keeps
 * outside the rows; "disabled" and every refusal keep the row and stay here.
 *
 * **Removing says what happened rather than "done".** A feed that produced
 * releases is disabled and keeps them, because `rss_item.feed_id` is
 * `NOT NULL` and those items own the rows that record where a library file
 * came from. An operator who asked to remove something and got "disabled"
 * is owed the reason, and the count is it.
 */
interface FeedRowProps {
  feed: RssFeedSyncRead;
  removal: FeedRemovalSubmit;
  /** The `deleted` sentence, which must outlive this row -- see the docblock above. */
  onRemoved: (sentence: string) => void;
}

function FeedRow({ feed, removal, onRemoved }: FeedRowProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const disabled = feed.disabledAt !== null;

  function run(work: () => Promise<string | undefined>): void {
    setPending(true);
    work()
      .then((next) => { setMessage(next); })
      .finally(() => {
        // Unconditional: a rejection that left this pending forever is the
        // wedge `postFeed` and `postMapping` both record, and the reason
        // the submit functions never throw in the first place.
        setPending(false);
      });
  }

  return (
    <li>
      <h3>{feed.name}</h3>
      <p>{feed.url}</p>
      {disabled && <p>Disabled. Its releases are kept and it is no longer polled.</p>}
      {disabled ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            run(async () => {
              const outcome = await removal.setDisabled(feed.id, false);
              return outcome.outcome === 'refused' ? FEED_REFUSAL_MESSAGES[outcome.refusal] : undefined;
            });
          }}
        >
          {pending ? 'Enabling\u2026' : `Enable ${feed.name}`}
        </button>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            run(async () => {
              const outcome = await removal.remove(feed.id);
              const sentence = removalMessage(outcome);
              if (outcome.outcome !== 'deleted') return sentence;
              onRemoved(sentence);
              return undefined;
            });
          }}
        >
          {pending ? 'Removing\u2026' : `Remove ${feed.name}`}
        </button>
      )}
      {message !== undefined && <p>{message}</p>}
    </li>
  );
}

export function Feeds({ source, submit, removal }: FeedsProps): ReactElement {
  const feeds = useFeeds(source);
  // The last removal's sentence, kept here because the row that earned it is
  // about to leave the list (see `FeedRow`'s docblock). One slot, not a map:
  // a second removal replaces the first sentence, which is the news anyway.
  const [removed, setRemoved] = useState<string | undefined>(undefined);

  return (
    <section aria-labelledby="feeds-heading">
      <h2 id="feeds-heading">Feeds</h2>
      <AddFeed submit={submit} />
      {removed !== undefined && <p role="status">{removed}</p>}
      {feeds !== undefined &&
        (feeds.length === 0 ? (
          <p>No feeds yet.</p>
        ) : (
          <ul aria-label="feeds">
            {feeds.map((feed) => (
              <FeedRow key={feed.id} feed={feed} removal={removal} onRemoved={setRemoved} />
            ))}
          </ul>
        ))}
    </section>
  );
}
