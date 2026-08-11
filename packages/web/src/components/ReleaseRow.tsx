import { useState } from 'react';
import type { ManualField, ReleaseView } from '../api/client.ts';
import { formatQuality, formatBytes } from '../api/format.ts';
import { ManualForm } from './ManualForm.tsx';

interface Props {
  release: ReleaseView;
  isCurrent: boolean;
  /**
   * This release's most recent download failed.
   *
   * Read whether or not the row is current, because the failed release
   * frequently is not the pick: an upgrade that fails leaves
   * `pickedReleaseId` on the file the user still has, and the version that
   * failed is one of the alternatives further down the card.
   *
   * Optional so that every caller written before this existed keeps working.
   */
  hasFailed?: boolean | undefined;
  onPick(releaseId: number): void;
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

export function ReleaseRow({ release, isCurrent, hasFailed, onPick, fields, onEdit }: Props) {
  const [editing, setEditing] = useState(false);
  // Absence, not emptiness: the server omits `manualValues` for a plugin that
  // cannot read a release back into form values, and an empty map is a
  // legitimate prefill for a plugin whose fields are all optional.
  const values = release.manualValues;

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
       * still offers no Pick button: `Current` is the wrong word for a file the
       * user does not have, but the pick has not been released either, so the
       * offer to make is one of the alternatives below — a retry of this one
       * belongs to the Downloads tab, which has a Retry control for it.
       *
       * A failed *alternative* reads `Failed` beside its Pick button rather
       * than instead of it. That button is how a user retries from this screen,
       * and it is the reason they were sent here; removing it would leave the
       * card stating a problem and offering no way out of it.
       */}
      {hasFailed === true && (
        <span className={isCurrent ? 'release-current release-failed' : 'release-failed'}>
          Failed
        </span>
      )}
      {isCurrent ? (
        hasFailed !== true && <span className="release-current">Current</span>
      ) : (
        <button type="button" onClick={() => onPick(release.id)}>
          Pick
        </button>
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
