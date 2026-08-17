import { useState } from 'react';
import { api, type IdentityPlanView } from './client.ts';

interface Pending {
  plan: IdentityPlanView;
  values: Record<string, string>;
  resolve(saved: boolean): void;
}

/**
 * What `apply` reports back to the hook. This is the hook's own contract with
 * its injected dependency, not `MediaCard`'s — `MediaCard`'s
 * `onEditGroup(values) => Promise<boolean>` is untouched; `begin` below is
 * what flattens this into that plain boolean for the card.
 *
 * `stale` only means anything when `saved` is `false`, which is why it lives
 * on that branch rather than being a bare `boolean` field: a caller cannot
 * accidentally set `stale: true` on a successful save and have it silently
 * ignored, because there is no such state to construct.
 *
 * The implementation Task 10 writes for Browse and Picks must build this by
 * catching the `RequestError` `api.editGroup` throws (see `client.ts`) and
 * setting `stale: cause.status === 409` — a stale `planDigest` is the only
 * failure the confirmation dialog should react to by re-planning; every other
 * failure (a 400 from a plugin, a 500, a dropped connection) must be reported
 * to the user through this hook's `onError` and close the dialog, not loop it.
 */
export type ApplyOutcome = { saved: true } | { saved: false; stale: boolean };

/**
 * Only a merge, file work, or a blocked plan needs a confirmation: a
 * display-only edit, or a rekey/none that moves no files on disk and blocks
 * nothing, is the one-click save this feature must not slow down. `kind`
 * alone is not enough — an interrupted rename retry can plan as `kind: 'none'`
 * (the key and display already match) while `renames` is still non-empty,
 * and that case must still be confirmed. Get this the other way round and a
 * merge would apply unconfirmed.
 *
 * `blockers` must be checked too, and for the same reason as `renames`: a
 * plan can carry a blocker with empty `renames`/`trashing` (its one file work
 * is the blocked one), and `kind` says nothing about that either. Skipping
 * the dialog for a blocked plan sent it straight to `apply`, which refuses it
 * with a 409 that this hook's own contract (see `ApplyOutcome` above) can only
 * read as a stale digest — so the blocker text the dialog would have shown
 * never reached the user, and the failure was reported as "the group kept
 * changing underneath this edit" instead. Routing every blocked plan through
 * the dialog is what makes `IdentityChangeConfirm` — which already renders
 * `blockers` unconditionally and disables Confirm on them — the one place
 * that reason is shown, exactly as §8 specifies.
 */
function needsConfirmation(plan: IdentityPlanView): boolean {
  return (
    plan.kind === 'merge' ||
    plan.renames.length > 0 ||
    plan.trashing.length > 0 ||
    plan.blockers.length > 0
  );
}

/**
 * The plan → confirm → apply sequence, in one place so Browse and Picks cannot
 * disagree about it.
 *
 * `begin` fulfils `MediaCard`'s `onEditGroup(values) => Promise<boolean>`
 * contract, so the card stays presentational — the same reason
 * `useIdentityPreview` was factored out of it. Not to be confused with that
 * hook: it previews the identity *key* per keystroke and knows nothing about a
 * group, where this is a one-shot plan for one group, fetched once per
 * attempted save.
 *
 * A plan that moves nothing resolves without ever showing a confirmation,
 * which is what keeps a typo fix a one-click save, exactly as it was before
 * this feature existed.
 */
export function useIdentityChange(
  apply: (
    groupId: number,
    values: Record<string, string>,
    digest?: string,
  ) => Promise<ApplyOutcome>,
  onError: (message: string) => void,
) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  // §8: a stale digest "replaces the plan in place and says why". This is the
  // "says why" — `IdentityChangeConfirm` reads it to add the one line, rather
  // than the plan swapping under the user with nothing said. Reset to `false`
  // whenever a dialog opens on a plan nobody has confirmed yet, so it never
  // outlives the plan it was reported against.
  const [stale, setStale] = useState(false);

  async function begin(groupId: number, values: Record<string, string>): Promise<boolean> {
    let plan: IdentityPlanView;
    try {
      plan = await api.identityPlan(groupId, values);
    } catch (cause) {
      onError((cause as Error).message);
      return false;
    }

    if (needsConfirmation(plan)) {
      return new Promise<boolean>((resolve) => {
        setStale(false);
        setPending({ plan, values, resolve });
      });
    }

    const outcome = await apply(groupId, values, undefined);
    if (outcome.saved) return true;
    if (!outcome.stale) return false;

    // The one-click path applied with no digest because the plan looked like
    // a display-only edit — but the situation on the server changed between
    // that plan and this apply (a concurrent ingest claimed the identity key,
    // say), and the apply came back 409 anyway. Silently returning false here
    // would be a Save click that does nothing with no explanation, which is
    // exactly what this feature exists to avoid: every other refusal in this
    // flow is shown to the user, and this one must be too. Re-plan and hand
    // whatever it becomes to the same confirmation path a merge would have
    // taken, rather than resolving false with nothing said.
    let fresh: IdentityPlanView;
    try {
      fresh = await api.identityPlan(groupId, values);
    } catch (cause) {
      onError((cause as Error).message);
      return false;
    }

    if (needsConfirmation(fresh)) {
      return new Promise<boolean>((resolve) => {
        setStale(false);
        setPending({ plan: fresh, values, resolve });
      });
    }

    // Still no confirmation needed, so this is still a display-only edit by
    // the fresh plan's own reckoning — but that plan is itself now stale the
    // instant a second apply is attempted against it. One retry, no more: two
    // identical races back to back is a situation to report, not a loop to
    // keep running silently.
    const retried = await apply(groupId, values, undefined);
    if (retried.saved) return true;
    if (retried.stale) {
      onError(
        `Could not save ${plan.identityKey}: the group kept changing underneath this edit. Try again.`,
      );
    }
    return false;
  }

  async function confirm(): Promise<void> {
    if (pending === null) return;
    setBusy(true);
    const outcome = await apply(pending.plan.groupId, pending.values, pending.plan.digest);

    if (outcome.saved) {
      setBusy(false);
      pending.resolve(true);
      setPending(null);
      return;
    }

    // Only a stale digest re-plans in place, replacing `pending.plan` so the
    // user reads what changed instead of losing their position in an
    // already-open dialog. Any other failure is not a problem with the plan —
    // re-fetching it would show the same plan again and teach the user
    // nothing about why the save actually failed — so it resolves false and
    // closes, leaving `apply`'s own `onError`/`setError` call (made before it
    // returned) as the only report of what went wrong.
    //
    // `setBusy(false)` stays inside each branch below rather than running
    // once up front: Confirm must stay disabled through this `await` too, or
    // a second click while the re-plan is in flight could re-apply
    // `pending.plan`'s now-stale digest a second time (harmless — it is
    // refused again the same way — but there is no reason to allow it).
    if (outcome.stale) {
      try {
        const fresh = await api.identityPlan(pending.plan.groupId, pending.values);
        setBusy(false);
        setStale(true);
        setPending({ ...pending, plan: fresh });
        return;
      } catch (cause) {
        setBusy(false);
        onError((cause as Error).message);
        pending.resolve(false);
        setPending(null);
        return;
      }
    }
    setBusy(false);
    pending.resolve(false);
    setPending(null);
  }

  function cancel(): void {
    if (pending === null) return;
    pending.resolve(false);
    setPending(null);
    setStale(false);
  }

  return { begin, plan: pending?.plan ?? null, confirm, cancel, busy, stale };
}
