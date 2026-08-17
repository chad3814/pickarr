import { useEffect, useId, useRef } from 'react';
import type { IdentityPlanView } from '../api/client.ts';

interface Props {
  plan: IdentityPlanView;
  onConfirm(): void;
  onCancel(): void;
  busy?: boolean;
  /**
   * True when `plan` just replaced an earlier one the user was looking at,
   * because the digest they were about to confirm went stale (§8: "replaces
   * the plan in place and says why"). This is the "says why" — without it the
   * plan swaps silently and the next Confirm click confirms a plan the user
   * may never have noticed changed.
   */
  stale?: boolean;
}

/**
 * The read-only plan from `POST /api/groups/:id/identity-plan`, laid out for a
 * human to approve or refuse before `useIdentityChange` echoes its digest back
 * to the PATCH that applies it.
 *
 * Renders full `from → to` paths rather than basenames: a plan the user
 * cannot read is a guess with extra steps, and the paths are the only thing
 * here that says whether a rename lands somewhere sane.
 *
 * Built on a native `<dialog>` opened with `showModal()`, for the same reasons
 * `ImageModal` gives: the page behind goes inert, focus is trapped and then
 * restored, Escape works, and a backdrop is painted — none of it worth
 * hand-rolling. It began as a plain `<div role="dialog">` with an `aria-label`
 * and no stylesheet rule at all, which made it invisible as a dialog to
 * everyone not using a screen reader: it rendered as an unstyled block of text
 * directly beneath the page's own error banner, and the first person to meet it
 * read it as an error, did not press Confirm, and reported that their merge had
 * silently not happened. The title is a real heading rather than an
 * `aria-label` so that the announced name and the visible one are the same
 * string by construction.
 *
 * Escape maps to Cancel, which is safe because nothing has been applied yet —
 * but only while nothing is in flight: once Confirm is pressed there is a
 * request whose outcome the dialog is still needed to report, so `busy`
 * suppresses it. A click on the backdrop deliberately does NOT dismiss, unlike
 * `ImageModal`: this dialog exists to be read, and a stray click while reading
 * a list of file moves should not throw the plan away.
 */
export function IdentityChangeConfirm({
  plan,
  onConfirm,
  onCancel,
  busy = false,
  stale = false,
}: Props) {
  const blocked = plan.blockers.length > 0;
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element === null || element.open) return;
    element.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="confirm"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId}>Confirm identity change</h2>
      {stale && (
        <p className="warning">
          This plan changed since you opened it, so it was refreshed below — check it again
          before confirming.
        </p>
      )}
      {plan.mergeInto !== null ? (
        <p>
          This will merge into <strong>{plan.mergeInto.title}</strong>, moving{' '}
          {plan.releasesMoving} release(s) and {plan.downloadsMoving} download(s).
        </p>
      ) : (
        <p>
          This will re-key the group to <code>{plan.identityKey}</code>.
        </p>
      )}

      {plan.pick.surviving !== null && (
        <p>
          Picked release: {plan.pick.surviving.releaseId} (score {plan.pick.surviving.score}
          {plan.pick.surviving.side === 'target' ? ', already picked here' : ', moved in'}).
        </p>
      )}
      {plan.pick.superseded !== null && (
        <p className="warning">
          Release {plan.pick.superseded.releaseId} (score {plan.pick.superseded.score}) is no
          longer picked; its files are trashed below.
        </p>
      )}

      {plan.renames.length > 0 && (
        <>
          <h3>Files renamed</h3>
          <ul>
            {plan.renames.map((move) => (
              <li key={move.importedFileId}>
                <code>{move.from}</code> → <code>{move.to}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {plan.trashing.length > 0 && (
        <>
          <h3>Files trashed</h3>
          <ul>
            {plan.trashing.map((entry) => (
              <li key={entry.importedFileId}>
                <code>{entry.path}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {plan.warnings.map((warning) => (
        <p className="warning" key={warning}>
          {warning}
        </p>
      ))}
      {plan.blockers.map((blocker) => (
        <p className="error" key={blocker}>
          {blocker}
        </p>
      ))}

      <button type="button" onClick={onConfirm} disabled={blocked || busy}>
        Confirm
      </button>
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </dialog>
  );
}
