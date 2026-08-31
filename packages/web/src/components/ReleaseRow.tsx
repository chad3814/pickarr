import { useState } from 'react';
import type { ManualField, ReleaseDownloadView, ReleaseView } from '../api/client.ts';
import { formatQuality, formatBytes, formatElapsed } from '../api/format.ts';
import { ManualForm } from './ManualForm.tsx';

interface Props {
  release: ReleaseView;
  isCurrent: boolean;
  /**
   * This release's most recent download, absent when it has never had one.
   *
   * Read whether or not the row is current, because a failed release
   * frequently is not the pick: an upgrade that fails leaves
   * `pickedReleaseId` on the file the user still has, and the version that
   * failed is one of the alternatives further down the card.
   *
   * Optional so that every caller written before this existed keeps working.
   */
  download?: ReleaseDownloadView | undefined;
  onPick(releaseId: number): void;
  /**
   * Resubmits this release's download. Optional the same way `onEdit` is
   * below: a caller with nowhere to send a retry gets a row with no button
   * rather than one that does nothing.
   */
  onRetry?: ((downloadId: number) => void) | undefined;
  /** The quality half of the plugin's schema; absent when it has no manual hooks. */
  fields?: ManualField[] | undefined;
  /**
   * Resolves true when the edit was saved. The row closes its form only then,
   * so a refusal leaves the typed values where the user can correct them.
   *
   * Spelled `| undefined` rather than as an optional method so that a caller
   * can pass the absent case along: under `exactOptionalPropertyTypes` an
   * optional method may be omitted but not handed `undefined`.
   */
  onEdit?: ((values: Record<string, string>) => Promise<boolean>) | undefined;
}

export function ReleaseRow({ release, isCurrent, download, onPick, onRetry, fields, onEdit }: Props) {
  const [editing, setEditing] = useState(false);
  // Absence, not emptiness: the server omits `manualValues` for a plugin that
  // cannot read a release back into form values, and an empty map is a
  // legitimate prefill for a plugin whose fields are all optional.
  const values = release.manualValues;

  // Spec §4's precedence, in the order that IS the rule — this is an
  // if/else-if chain, not three independent conditions, so a status word
  // never has to be excluded from `Failed` by name and `Current` never has to
  // be excluded from either by name. Checking `failed` first is what keeps a
  // failed download from also matching the "any non-terminal status" branch
  // below it; checking the status branch before `isCurrent` is what keeps a
  // downloading *upgrade* of the current release from reading `Current` out
  // from under its own status.
  const failed = download?.status === 'failed';
  const label: { text: string; className: string } | null = failed
    ? { text: 'Failed', className: isCurrent ? 'release-current release-failed' : 'release-failed' }
    : download !== undefined && download.status !== 'imported'
      ? { text: download.status, className: 'release-status' }
      : isCurrent
        ? { text: 'Current', className: 'release-current' }
        : null;

  // In flight: a download exists and has neither landed (`imported`) nor
  // given up (`failed`). Pick is suppressed only for that window — a failed
  // alternative keeps its Pick, deliberately: it is the user's way out of a
  // failure, and it now sits beside the Retry below that resubmits the same
  // download.
  const inFlight = download !== undefined && download.status !== 'imported' && !failed;

  // Copied from `DownloadRow.tsx`'s own guard, for the reason stated there:
  // retry has to accept exactly what `POST /api/downloads/:id/retry` accepts,
  // or a wider or narrower offer here just becomes a 409 on click.
  const retryable = download !== undefined && (failed || download.absentSince !== null);
  const downloadId = download?.downloadId;
  const error = download?.error ?? null;
  const absentSince = download?.absentSince ?? null;
  const hasDetail = error !== null || absentSince !== null || retryable;

  async function save(submitted: Record<string, string>): Promise<void> {
    if (await onEdit?.(submitted)) setEditing(false);
  }

  return (
    <li className="release-row">
      <span className="release-quality">{formatQuality(release.quality)}</span>
      {release.quality.sizeBytes !== undefined && (
        <span className="release-size">{formatBytes(release.quality.sizeBytes)}</span>
      )}
      <span className="release-name" title={release.releaseName}>
        {release.releaseName}
      </span>
      {/*
       * A failed *current* release reads `Failed` in place of `Current`, and
       * still offers no Pick button: `Current` is the wrong word for a file
       * the user does not have, but the pick has not been released either, so
       * the offer to make is one of the alternatives below — a retry of this
       * one is the Retry button on this row's own detail line, further down.
       *
       * A failed *alternative* reads `Failed` beside its Pick button rather
       * than instead of it. That button is how a user retries from this
       * screen, and it is the reason they were sent here; removing it would
       * leave the card stating a problem and offering no way out of it.
       */}
      {label !== null && <span className={label.className}>{label.text}</span>}
      {!isCurrent && !inFlight && (
        <button type="button" className="pick" onClick={() => onPick(release.id)}>
          Pick
        </button>
      )}

      {hasDetail && (
        <div className="release-detail">
          {error !== null && <span className="download-error">{error}</span>}
          {/*
           * Absence is never a verdict on its own — reconcile leaves a
           * download `downloading` for as long as the client just doesn't
           * mention it, which is what makes "never auto-fail" safe. But an
           * invisible stuck download is exactly what let 35 healthy ones sit
           * unnoticed for a day, so this is the row's only window onto that
           * state and it has to say so plainly.
           */}
          {absentSince !== null && (
            <span className="download-absent">
              missing from client for {formatElapsed(Date.now() - absentSince)}
            </span>
          )}
          {retryable && downloadId !== undefined && onRetry !== undefined && (
            <button type="button" onClick={() => onRetry(downloadId)}>
              Retry
            </button>
          )}
        </div>
      )}

      {values !== undefined &&
        fields !== undefined &&
        onEdit !== undefined &&
        (editing ? (
          // No identity preview here: a quality edit cannot change the
          // identity key (§7.4), so previewing one would put an answer to a
          // question this form does not ask under its fields — and, given only
          // quality values, that answer would be the plugin complaining about
          // the identity fields it was not sent.
          <ManualForm
            fields={fields}
            values={values}
            submitLabel="Save"
            onSubmit={(submitted) => void save(submitted)}
            onCancel={() => setEditing(false)}
          />
        ) : (
          // Named for what it edits: the card carries an "Edit" of its own, and
          // one row among several is not the obvious owner of a bare one.
          <button type="button" onClick={() => setEditing(true)}>
            Edit quality
          </button>
        ))}
    </li>
  );
}
