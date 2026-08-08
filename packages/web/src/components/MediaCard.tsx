import { useState } from 'react';
import type { GroupView, ManualField } from '../api/client.ts';
import { useIdentityPreview } from '../api/useIdentityPreview.ts';
import { ManualForm, seed } from './ManualForm.tsx';
import { ReleaseRow } from './ReleaseRow.tsx';

interface Props {
  group: GroupView;
  onPick(releaseId: number): void;
  /** The plugin's whole schema; absent for a plugin with no manual hooks. */
  fields?: ManualField[] | undefined;
  /**
   * Resolves true when the edit was saved. Both handlers are optional: a caller
   * with nowhere to send an edit gets a card with no controls rather than
   * controls that do nothing.
   */
  onEditGroup?(values: Record<string, string>): Promise<boolean>;
  onEditRelease?(releaseId: number, values: Record<string, string>): Promise<boolean>;
}

interface IdentityProps {
  plugin: string;
  fields: ManualField[];
  values: Record<string, string>;
  onSubmit(values: Record<string, string>): void;
  onCancel(): void;
}

/**
 * The identity half of a group, with the plugin's live reading of it.
 *
 * Separate from the card so the draft the preview watches is state of the
 * form's own, mounted and discarded with it — the same reason `Failed`'s
 * `FixForm` is separate from its row.
 */
function IdentityForm({ plugin, fields, values, onSubmit, onCancel }: IdentityProps) {
  // Seeded over the *identity* fields with `ManualForm`'s own seeding, not a
  // lookalike: a group's prefill carries the whole schema's worth of values,
  // quality keys included, and the preview has to describe what the form will
  // submit rather than what it was handed.
  const [draft, setDraft] = useState(() => seed(fields, values));
  const preview = useIdentityPreview(plugin, draft);

  return (
    <ManualForm
      fields={fields}
      values={values}
      preview={preview}
      submitLabel="Save"
      onChange={setDraft}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

/**
 * One card renders every media type. Plugins supply display fields, never UI.
 */
export function MediaCard({ group, onPick, fields, onEditGroup, onEditRelease }: Props) {
  const { display } = group;
  const [editing, setEditing] = useState(false);

  // A field's scope says which record it belongs to: the group owns its
  // identity and display (§7.3), each release its own quality (§7.4).
  const identityFields = fields?.filter((field) => field.scope === 'identity');
  const qualityFields = fields?.filter((field) => field.scope === 'quality');
  // Absence, not emptiness: the server omits `manualValues` for a plugin that
  // cannot read a record back into form values, and an empty map is a
  // legitimate prefill for a plugin whose fields are all optional.
  const values = group.manualValues;

  async function save(submitted: Record<string, string>): Promise<void> {
    // Closed only on success, so a refused merge leaves the values the user
    // typed on screen next to the reason they were refused.
    if (await onEditGroup?.(submitted)) setEditing(false);
  }

  return (
    <article className="media-card">
      <header>
        <h2>{display.title}</h2>
        {display.subtitle !== undefined && <p className="subtitle">{display.subtitle}</p>}
        {display.date !== undefined && <p className="date">{display.date}</p>}
        {group.upgradeReleaseId !== null && <span className="badge">Upgrade available</span>}
      </header>

      {values !== undefined &&
        identityFields !== undefined &&
        onEditGroup !== undefined &&
        (editing ? (
          <IdentityForm
            plugin={group.plugin}
            fields={identityFields}
            values={values}
            onSubmit={(submitted) => void save(submitted)}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
        ))}

      {/*
       * A field is rendered as a single text node ("Label: Value") rather
       * than separate <dt>/<dd> elements. A plugin's field value can equal
       * the group's subtitle or date verbatim (e.g. a "Site" field mirroring
       * the subtitle) — keeping label and value in one node means a query
       * for the bare value never collides with an unrelated element that
       * happens to hold the exact same string.
       */}
      <ul className="fields">
        {display.fields.map((field) => (
          <li key={field.label}>
            {field.label}: {field.value}
          </li>
        ))}
      </ul>

      <ul className="releases">
        {group.releases.map((release) => (
          <ReleaseRow
            key={release.id}
            release={release}
            isCurrent={release.id === group.pickedReleaseId}
            onPick={onPick}
            fields={qualityFields}
            onEdit={
              onEditRelease === undefined
                ? undefined
                : (submitted) => onEditRelease(release.id, submitted)
            }
          />
        ))}
      </ul>
    </article>
  );
}
