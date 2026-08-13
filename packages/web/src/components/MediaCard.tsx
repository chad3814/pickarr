import { useState } from 'react';
import type { GroupView, ManualField } from '../api/client.ts';
import { groupAnchor } from '../api/anchors.ts';
import { formatDuration } from '../api/format.ts';
import { useIdentityPreview } from '../api/useIdentityPreview.ts';
import { ImageModal } from './ImageModal.tsx';
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
  // One piece of state, so the poster and a performer's full image can never
  // both be open at once.
  const [modal, setModal] = useState<{ src: string; alt: string } | null>(null);

  // A field's scope says which record it belongs to: the group owns its
  // identity and display (§7.3), each release its own quality (§7.4).
  const identityFields = fields?.filter((field) => field.scope === 'identity');
  const qualityFields = fields?.filter((field) => field.scope === 'quality');
  // Absence, not emptiness: the server omits `manualValues` for a plugin that
  // cannot read a record back into form values, and an empty map is a
  // legitimate prefill for a plugin whose fields are all optional.
  const values = group.manualValues;
  // Optional on the wire, unlike core's `MetadataView`: a stale bundle or an
  // old-server response can omit it, so absence is folded into `null` rather
  // than trusted to mean anything on its own.
  const sceneUrl = group.metadata.state === 'confirmed' ? group.metadata.sceneUrl ?? null : null;

  async function save(submitted: Record<string, string>): Promise<void> {
    // Closed only on success, so a refused merge leaves the values the user
    // typed on screen next to the reason they were refused.
    if (await onEditGroup?.(submitted)) setEditing(false);
  }

  return (
    // The id is what a Downloads row's link aims at. Given unconditionally
    // rather than only on Picks: it is derived from the group id, so it is the
    // same string wherever the card is drawn, and only one list is mounted at
    // a time — there is no arrangement in which two cards claim it.
    <article className="media-card" id={groupAnchor(group.id)}>
      <header>
        <h2>{display.title}</h2>
        {display.subtitle !== undefined && <p className="subtitle">{display.subtitle}</p>}
        {display.date !== undefined && <p className="date">{display.date}</p>}
        {group.upgradeReleaseId !== null && <span className="badge">Upgrade available</span>}
      </header>

      {group.metadata.state === 'confirmed' && group.metadata.hasPoster && (
        <button
          type="button"
          className="poster-thumb"
          onClick={() => setModal({ src: `/api/groups/${group.id}/poster`,
                                    alt: `Poster for ${display.title}` })}
        >
          <img src={`/api/groups/${group.id}/poster`} alt={`Poster for ${display.title}`} />
        </button>
      )}

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
            // Per release, not per group: an upgrade that failed leaves
            // `pickedReleaseId` on the file the user still has, so the row to
            // mark is frequently not the current one. Absent means "not
            // failed" — the server omits the field rather than sending
            // `false`, so a card built from a response that predates it reads
            // exactly as it did before.
            hasFailed={release.downloadFailed}
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

      {/*
       * A lookup in flight is the one state worth telling the user about: it
       * is the only one that resolves into something else on its own, so a
       * card that says nothing here looks identical to one that will never
       * get an answer. `none` (asked, nothing came back) and `absent` (never
       * asked) are both terminal from the SPA's point of view and stay
       * silent on purpose.
       */}
      {group.metadata.state === 'pending' && <p className="metadata-pending">pending</p>}

      {/*
       * A second opinion, never a replacement: `display.title` above stays
       * the card's title even when the provider disagrees with it — adopting
       * a provider value is later work (this phase is deliberately
       * non-destructive). Rendered only once the answer is `confirmed`: a
       * `pending` or `absent` group has nothing to show yet (`pending` gets
       * its own note above), and `none` means the provider was asked and
       * came back with nothing, which is likewise nothing to show. The
       * provider populates poster, synopsis, performers, release date and
       * running time unevenly, so each is checked and rendered on its own —
       * one being missing says nothing about the others. The poster itself
       * is rendered above, out of this section: it is absolutely positioned
       * and out of flow, so it does not compete with anything here.
       */}
      {group.metadata.state === 'confirmed' && (
        <section className="metadata" aria-label="Scene metadata">
          {group.metadata.title !== null && (
            <p className="metadata-title">
              {sceneUrl === null ? (
                group.metadata.title
              ) : (
                <a href={sceneUrl} target="_blank" rel="noopener noreferrer">
                  {group.metadata.title}
                </a>
              )}
            </p>
          )}
          {group.metadata.releaseDate !== null && (
            <p className="metadata-release-date">{group.metadata.releaseDate}</p>
          )}
          {group.metadata.durationSeconds !== null && (
            <p className="metadata-duration">{formatDuration(group.metadata.durationSeconds)}</p>
          )}
          {group.metadata.synopsis !== null && (
            <p className="metadata-synopsis">{group.metadata.synopsis}</p>
          )}
          {/*
           * One list or the other, never both. The server already guarantees
           * that — `metadataViewOf` empties `performerNames` the moment there
           * is a structured cast — but as two independent `&&` blocks the
           * card would happily render both if that ever stopped being true,
           * showing every performer twice. The `else` makes the exclusivity a
           * property of this component rather than a promise made elsewhere,
           * and picks the richer list when they disagree.
           */}
          {(group.metadata.performers ?? []).length > 0 ? (
            <ul className="metadata-performers">
              {(group.metadata.performers ?? []).map((performer) => (
                <li key={performer.id}>
                  {performer.hasAvatar &&
                    (performer.hasImage ? (
                      <button
                        type="button"
                        className="avatar-thumb"
                        onClick={() => setModal({ src: `/api/performers/${performer.id}/image`,
                                                  alt: performer.name })}
                      >
                        <img src={`/api/performers/${performer.id}/avatar`} alt={performer.name} />
                      </button>
                    ) : (
                      // A face with no full image: shown, not clickable.
                      // Opening a modal onto a 404 is worse than not offering.
                      <img className="avatar-thumb"
                           src={`/api/performers/${performer.id}/avatar`} alt={performer.name} />
                    ))}
                  <a href={performer.url} target="_blank" rel="noopener noreferrer">
                    {performer.name}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            (group.metadata.performerNames ?? []).length > 0 && (
              // Answered before migration 7 and not yet refetched: names only,
              // and no link, because no slug was stored to build one from.
              <ul className="metadata-performers">
                {(group.metadata.performerNames ?? []).map((name) => <li key={name}>{name}</li>)}
              </ul>
            )
          )}
        </section>
      )}

      {modal !== null && <ImageModal {...modal} onClose={() => setModal(null)} />}
    </article>
  );
}
