/**
 * One media item's releases -- filename, resolution, ranking score, and
 * each download's status and percentage (design spec §5) -- and, on every
 * release that has no download, the `Pick` button that submits one (picks
 * design §2, §3).
 *
 * A release with no `torrent_download` or `nzb_download` row is still not
 * an edge case here; it is the normal state of every release nobody has
 * acted on yet. What this docblock used to add to that -- "because nobody
 * can" -- is no longer true: `POST /api/picks` exists, and this list is
 * where an operator reaches it. The absence of a download is now the
 * *precondition* for the button rather than a permanent condition of the
 * screen.
 *
 * **One button per release, never one per media card** (picks design §2).
 * A pick names an `rssItemId`; a media card is a `media_item` and maps to
 * many releases. Putting the button on the row means the operator picks the
 * release they just read, with no auto-selection rule to design and no way
 * to act on something they did not see. A release that already has a
 * download shows its status and no button.
 *
 * **`Picking…` ends when the download row arrives, not on a timer** (picks
 * design §3, acceptance 6). The button disables and reads `Picking…` from
 * the click until this component is handed a `releases` array in which that
 * release has a download -- at which point the `downloads.length === 0`
 * test below stops rendering a button at all and the status display takes
 * over. Nothing here polls or waits: `useGatheredItem` subscribes to
 * inserts on both download tables and re-gathers, which is what re-renders
 * this list (picks design §7).
 *
 * **This sentence was false when it was first written, and the browser is
 * what found it.** The first version of `pick` below cleared `pending` in
 * an unconditional `finally`, so an accepted pick re-enabled the button at
 * the 202 and not at the row. Measured end to end by the styling task's
 * Playwright spec, on the real submission path: **enabled and reading
 * `Pick` again 33ms after the click, status arriving at 2934ms** -- ~2.9
 * seconds during which the host already held a `submitted` row and the
 * browser still offered a live button, and a second click there answers
 * `already-submitted` and leaves a `failed` row behind. What is written
 * above is now what the code does; see {@link ReleaseRow} for the shape,
 * and for the hang it deliberately accepts.
 *
 * **Each row is a component, so each row owns its own pending flag and its
 * own error.** State held up here and keyed by release id would work too; a
 * single flag shared by the list would not -- it disables every button in
 * the list on any pick.
 *
 * Measured rather than argued, and the first draft of this paragraph had
 * the measurement wrong. Hoisting `pending` into `ReleaseList` and passing
 * it down reddens **two** tests in this file, not one: the three-release
 * test, by the assertion written for exactly this, and the
 * every-refusal-at-once test, because after the first click every other
 * button is disabled and the six clicks that would have answered the rest
 * land on nothing. Only the first is aimed at the defect; the second is
 * what a shared flag does to any list somebody uses twice.
 *
 * **`submit` is a required prop, not defaulted to the real one.** A default
 * that performs network I/O would be invisible at the call site -- a future
 * test that forgets the prop would silently get a real `fetch` under jsdom,
 * which hangs rather than fails, with nothing pointing at the missing prop.
 * `postPick.ts` is the real implementation; `shell/Shell.tsx` wires it in
 * explicitly, through `Category` and `MediaItemCard`.
 *
 * Driven entirely by props otherwise: `MediaItemCard` is this component's
 * only caller, and hands it `GatheredItem['releases']` straight from
 * `store/gather.ts` with no transformation of its own.
 */
import { useState, type ReactElement } from 'react';
import type { GatheredDownload, GatheredItem, GatheredRelease } from '../store/gather.ts';
import { PICK_REFUSAL_MESSAGES, type PickSubmit } from './postPick.ts';

export interface ReleaseListProps {
  releases: GatheredItem['releases'];
  /** Submits one pick. Required, never defaulted -- see this file's docblock. */
  submit: PickSubmit;
}

/**
 * One download's visible status text, e.g. `Status: downloading (42%)`.
 */
function statusText(download: GatheredDownload): string {
  const { status, percentage } = download.row;
  return percentage === null ? `Status: ${status}` : `Status: ${status} (${String(percentage)}%)`;
}

/**
 * A stable key for one download, since a release can carry more than one
 * (a torrent and an nzb submitted for the same release) and neither table's
 * `id` alone is unique across both.
 */
function downloadKey(download: GatheredDownload): string {
  return `${download.table}:${String(download.id)}`;
}

/**
 * One release's ranking score, or `undefined` when it has none.
 *
 * Design spec §5 names this alongside the resolution and the download
 * status; it was dropped in the spec-to-plan translation and every seat
 * downstream reviewed against the plan, so nothing caught it until the
 * whole-branch review read the spec directly.
 *
 * `=== null`, never a falsy check: `rankingScore` is `number | null` on the
 * wire and a score of **0** is a real answer a ranker can give, distinct
 * from "nothing has ranked this yet". A release with no score renders no
 * score at all -- unlike a release with no download, which now renders a
 * button, because a missing score is not something anyone can act on from
 * here and a missing download is.
 */
function scoreText(row: GatheredRelease['row']): string | undefined {
  return row.rankingScore === null ? undefined : `Score: ${String(row.rankingScore)}`;
}

/**
 * The two strings the Pick button ever renders, and the two
 * `--size-pick-button` was measured against (`styles/tokens.css`: 40.64px
 * and 66.58px, floored at 72px so the row does not reflow when the label
 * changes).
 *
 * Exported so a test can pin them. That token is a floor sized to these
 * exact strings and nothing recomputes it, so a third label or a longer one
 * would widen the button past 72px and move everything to its left again,
 * with no test failing. `ReleaseList.test.tsx` pins this object literally,
 * which is deliberately *conservative* rather than exact: it reddens on any
 * label change, including one that would still fit. A red that says
 * "re-measure the token" is the cheap half of that trade, and measuring a
 * string's rendered width is not something a jsdom test can do at all.
 */
export const PICK_LABELS = { idle: 'Pick', pending: 'Picking…' } as const;

interface ReleaseRowProps {
  release: GatheredRelease;
  submit: PickSubmit;
}

/**
 * One release: its detail, and either the downloads it has or the button to
 * ask for one.
 *
 * **The `finally` is still here and still clears, for every outcome but
 * one.** The reasoning it was added for is untouched and still governs
 * every non-202 path: `submit` is an injected async function, any
 * implementation of it may reject, and a refusal that left the control
 * disabled with nothing on screen is precisely how the feeds slice wedged
 * its form on five of six real host answers. A refusal, an `offline`, an
 * `unrecognised` and a `submit` that throws outright all re-enable the
 * button and show a sentence, exactly as before.
 *
 * **What changed is that the unconditional half of that was too blunt: it
 * cleared on success too.** `pending` means "this pick is not finished",
 * and at the 202 it is not -- the host has accepted a submission whose
 * download row has not reached this browser yet (picks design §3,
 * acceptance 6; the 33ms/2934ms measurement is in this file's top
 * docblock). So `accepted` below is an explicit opt-*out* of a clear that
 * otherwise always happens: the default is to re-enable, and only a 202
 * declines it. Writing it the other way round -- clearing on each failure
 * path instead -- would put the wedge one forgotten branch away, which is
 * the bug this `finally` exists to make unreachable.
 *
 * **The hang this accepts, deliberately and with no guard.** A plugin may
 * resolve `onDownloadRequest` having submitted nothing; the contract
 * permits it and `packages/e2e/src/harness-2.ts` shipped exactly such a
 * stub for several slices. Against one of those the 202 is truthful and no
 * row ever arrives, so that one button stays `Picking…` until the card is
 * collapsed and reopened. There is no timeout and no fallback here on
 * purpose -- a timer would re-enable a button whose pick may still be in
 * flight, which is the `already-submitted`-and-a-`failed`-row outcome
 * again, arrived at more slowly. It is scoped to one row of one card and
 * survives no remount, and it is the price of never offering a second pick
 * on a release the host has already accepted one for.
 *
 * An accepted pick sets no message. There is nothing to say that the row
 * does not already say.
 */
function ReleaseRow({ release, submit }: ReleaseRowProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `listitem` is not named from its own contents (measured: an unlabelled
  // `<li>` reads with an empty accessible name even when full of visible
  // text), so this points `aria-labelledby` at the filename span rather
  // than duplicating it into an `aria-label` -- one visible string, not two
  // that could drift apart.
  const filenameId = `release-${String(release.id)}-filename`;
  // The button's own accessible name is composed from two spans of visible
  // text -- its own label and the filename -- for the same reason: a list
  // of buttons all named `Pick` is ambiguous announced, and an `aria-label`
  // saying `Pick <filename>` would be a second copy of a string already on
  // screen. Self-reference in `aria-labelledby` resolves to the element's
  // own content, so nothing here is announced that is not also rendered.
  const pickId = `release-${String(release.id)}-pick`;
  const score = scoreText(release.row);

  async function pick(): Promise<void> {
    setPending(true);
    setError(null);
    // Set only on the one path that keeps the button pending, and read in
    // the `finally` -- so every other path, including one nobody has
    // thought of, clears by default. See this component's docblock.
    let accepted = false;
    try {
      const outcome = await submit(release.id);
      if ('accepted' in outcome) {
        accepted = true;
        return;
      }
      setError(PICK_REFUSAL_MESSAGES[outcome.refusal]);
    } catch {
      setError(PICK_REFUSAL_MESSAGES.offline);
    } finally {
      if (!accepted) setPending(false);
    }
  }

  return (
    <li aria-labelledby={filenameId}>
      <span id={filenameId}>{release.row.filename}</span> <span>{release.row.resolution}</span>
      {score !== undefined && <span> {score}</span>}
      {release.downloads.map((download) => (
        <span key={downloadKey(download)}> {statusText(download)}</span>
      ))}
      {release.downloads.length === 0 && (
        <button
          type="button"
          id={pickId}
          aria-labelledby={`${pickId} ${filenameId}`}
          disabled={pending}
          onClick={() => {
            void pick();
          }}
        >
          {pending ? PICK_LABELS.pending : PICK_LABELS.idle}
        </button>
      )}
      {error !== null && (
        <div role="alert">
          {/*
            Real text in a real element, never an `aria-label` on an empty
            one (`CLAUDE.md`'s longest testing hazard, and the defect a
            previous slice shipped): the announced string and the visible
            one are the same string here, so they cannot drift apart.
            `styles/library.css` is what makes the visible half legible --
            an `aria-label` would have passed a `getByRole` name query with
            no stylesheet rule reaching it at all, which is exactly how
            `IdentityChangeConfirm` shipped.
          */}
          <span>{error}</span>
        </div>
      )}
    </li>
  );
}

export function ReleaseList({ releases, submit }: ReleaseListProps): ReactElement {
  return (
    <ul aria-label="releases">
      {releases.map((release) => (
        <ReleaseRow key={release.id} release={release} submit={submit} />
      ))}
    </ul>
  );
}
