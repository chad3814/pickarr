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
 */
export function IdentityChangeConfirm({
  plan,
  onConfirm,
  onCancel,
  busy = false,
  stale = false,
}: Props) {
  const blocked = plan.blockers.length > 0;

  return (
    <div className="confirm" role="dialog" aria-label="Confirm identity change">
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
    </div>
  );
}
