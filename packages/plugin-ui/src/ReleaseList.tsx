/**
 * One media item's releases -- download type, filename, resolution, ranking
 * score, and each download's status and percentage (design spec §5) -- and,
 * on every release that has no download, the `Pick` button that submits one
 * (picks design §2, §3).
 *
 * **The resolution is `row.videoResolution`, the lookup service's parse**
 * (issue #98), or `unknown` when it has none. The row once printed
 * `row.resolution`, which was the lookup state, and for one commit parsed
 * the filename in the browser instead.
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
 * what found it.** The first version of the pick handler -- now
 * `PickControl.tsx`'s -- cleared `pending` in
 * an unconditional `finally`, so an accepted pick re-enabled the button at
 * the 202 and not at the row. Measured end to end by the styling task's
 * Playwright spec, on the real submission path: **enabled and reading
 * `Pick` again 33ms after the click, status arriving at 2934ms** -- ~2.9
 * seconds during which the host already held a `submitted` row and the
 * browser still offered a live button, and a second click there answers
 * `already-submitted`. What is written above is now what the code does;
 * see `PickControl.tsx` for the shape, and {@link ReleaseRow}'s doc for
 * the hang it deliberately accepts.
 *
 * **That sentence used to end "and leaves a `failed` row behind", which
 * this list then rendered forever beside the `submitted` one.** It does
 * not any more: the host's release-level index refuses the second pick at
 * the insert, before a row exists, so a refused pick writes nothing at
 * all. Nothing here changed for it -- the row this component would have
 * had to hide is simply never written.
 *
 * **Each row is a component rendering its own `PickControl`, so each row
 * owns its own pending flag and its own error.** State held up here and keyed by release id would work too; a
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
import { DownloadTypeIcon } from './icons.tsx';
import { IdentifyForm } from './IdentifyForm.tsx';
import {
  IDENTIFY_REFUSAL_MESSAGES,
  REQUERY_LABELS,
  type GatheredItemView,
  type GatheredReleaseView as GatheredRelease,
  type IdentifySubmit,
  type PickSubmit,
} from './types.ts';
import { PickControl } from './PickControl.tsx';
import { downloadKey, downloadStatusText } from './downloadStatus.ts';

export interface ReleaseListProps {
  releases: GatheredItemView['releases'];
  /** Submits one pick. Required, never defaulted -- see this file's docblock. */
  submit: PickSubmit;
  /** Requeries or edits one release. Required, never defaulted, for `submit`'s reason. */
  identify: IdentifySubmit;
  /** The plugin whose card this list is on; the combobox suggests only that plugin's titles. */
  pluginId: string;
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
export { PICK_LABELS } from './PickControl.tsx';

interface ReleaseRowProps {
  release: GatheredRelease;
  submit: PickSubmit;
  identify: IdentifySubmit;
  pluginId: string;
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
 * docblock). So `accepted` in `PickControl` is an explicit opt-*out* of a clear that
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
 * flight, which is the `already-submitted` outcome again, arrived at more
 * slowly -- a refusal shown for a pick that was in fact working. It is scoped to one row of one card and
 * survives no remount, and it is the price of never offering a second pick
 * on a release the host has already accepted one for.
 *
 * An accepted pick sets no message. There is nothing to say that the row
 * does not already say.
 *
 * **Every line also offers `Requery` and `Edit`, whether or not it has a
 * download.** `Requery` asks the lookup service again and, like `Retry` on
 * the unmatched card (`web/src/library/Unmatched.tsx`'s `RetryButton`), is
 * pending from the click until this row's `updatedAt` differs from the one
 * it had then -- one piece of state, `requeryingSince`, rather than a flag
 * that could disagree with it. A refusal clears the wait; an acceptance does
 * not, and no timer does either. `Edit` replaces the buttons with
 * {@link IdentifyForm}; saving it starts the same wait, because a saved edit
 * is also a lookup the row has yet to reflect. The line's status word
 * (`Looking up…`, `unresolved`, `refused`) reads `lookupState`; a resolved
 * release shows none.
 */
function ReleaseRow({ release, submit, identify, pluginId }: ReleaseRowProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [requeryingSince, setRequeryingSince] = useState<number | undefined>(undefined);
  const [requeryError, setRequeryError] = useState<string | null>(null);
  const requerying = requeryingSince !== undefined && release.row.updatedAt === requeryingSince;

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
  const requeryId = `release-${String(release.id)}-requery`;
  const editId = `release-${String(release.id)}-edit`;
  const score = scoreText(release.row);


  async function requery(): Promise<void> {
    setRequeryingSince(release.row.updatedAt);
    setRequeryError(null);
    try {
      const outcome = await identify.identify(release.id, { mode: 'requery' });
      if ('refusal' in outcome) {
        setRequeryingSince(undefined);
        setRequeryError(IDENTIFY_REFUSAL_MESSAGES[outcome.refusal]);
      }
    } catch {
      setRequeryingSince(undefined);
      setRequeryError(IDENTIFY_REFUSAL_MESSAGES.offline);
    }
  }

  const lookupState = release.row.lookupState;

  return (
    <li aria-labelledby={filenameId}>
      {/*
        `title` so the full filename is reachable when the rendered one is
        cut off. A release filename is the longest string on this screen
        and the one an operator most needs to read exactly -- it is what
        distinguishes two releases that are otherwise identical.

        It does **not** change what this span announces, and that is worth
        knowing rather than assuming: `title` is the last fallback in the
        accessible-name algorithm, so an element with content is named by
        its content. The button above points `aria-labelledby` here, so a
        `title` that did win would have silently renamed every Pick button
        on the card. `ReleaseList.test.tsx` pins the name against exactly
        that.
      */}
      <DownloadTypeIcon type={release.row.downloadType} />
      <span id={filenameId} title={release.row.filename}>{release.row.filename}</span>{' '}
      <span>{release.row.videoResolution ?? 'unknown'}</span>
      {score !== undefined && <span> {score}</span>}
      {release.downloads.map((download) => (
        <span key={downloadKey(download)}> {downloadStatusText(download)}</span>
      ))}
      {(lookupState === 'pending' || lookupState === 'unresolved' || lookupState === 'refused') && (
        <span> {lookupState === 'pending' ? 'Looking up…' : lookupState}</span>
      )}
      {editing ? (
        <IdentifyForm
          pluginId={pluginId}
          rssItemId={release.id}
          identify={identify}
          onDone={() => {
            setEditing(false);
            setRequeryingSince(release.row.updatedAt);
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : (
        <>
          {release.downloads.length === 0 && (
            <PickControl id={pickId} labelledBy={filenameId} rssItemId={release.id} submit={submit} />
          )}
          <button
            type="button"
            id={requeryId}
            aria-labelledby={`${requeryId} ${filenameId}`}
            disabled={requerying}
            onClick={() => {
              void requery();
            }}
          >
            {requerying ? REQUERY_LABELS.pending : REQUERY_LABELS.idle}
          </button>
          <button
            type="button"
            id={editId}
            aria-labelledby={`${editId} ${filenameId}`}
            onClick={() => {
              setEditing(true);
            }}
          >
            Edit
          </button>
        </>
      )}
      {requeryError !== null && (
        <div role="alert">
          <span>{requeryError}</span>
        </div>
      )}
    </li>
  );
}

export function ReleaseList({ releases, submit, identify, pluginId }: ReleaseListProps): ReactElement {
  return (
    <ul aria-label="releases">
      {releases.map((release) => (
        <ReleaseRow key={release.id} release={release} submit={submit} identify={identify} pluginId={pluginId} />
      ))}
    </ul>
  );
}
