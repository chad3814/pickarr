import { useEffect, useState } from 'react';
import type { GroupView, ManualField } from '../api/client.ts';
import type { GroupImage } from '../api/groupImages.ts';
import { groupAnchor } from '../api/anchors.ts';
import { groupImages, slotImage } from '../api/groupImages.ts';
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
  /**
   * Re-asks the provider about this group's already-settled metadata. Owned
   * by the route, the same as the three handlers above: it is the route that
   * holds `useGroupMetadata`'s handle and can tell it to watch this id again
   * once the requery lands, which is machinery this card has no business
   * duplicating.
   *
   * Rejecting is how the card learns the attempt did not happen, and that
   * covers refusals as well as failures: `POST /api/metadata/requery` answers
   * 200 with counters, so a call can succeed while requeuing nothing (no
   * metadata provider configured, the group gone, its plugin unable to build
   * a query). `requeryOneGroup` turns each of those into a rejection carrying
   * the reason, so this card still has exactly one channel to render rather
   * than a boolean outcome the way `onEditGroup` has.
   */
  onRequeryMetadata?(groupId: number): Promise<void>;
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
 * A string with something in it, or `null` — every string this card renders can
 * arrive as `''` rather than as an absent value, and `??` accepts `''`.
 * `maybeStr` in `db/row.ts` folds only `NULL` and `undefined` into `null`, so an
 * empty column reaches the view as an empty string and nothing upstream
 * normalises it. Two of those would show: an empty provider title renders an
 * empty `<h2>`, a card with no heading and nothing on it naming the group; an
 * empty context part renders a span that `card.css`'s sibling separator then
 * decorates, so the line reads ` · 2023-04-15`. `commit.ts`'s `isText` guards
 * the same class of value for `display`'s own optional strings, though only
 * against `undefined` — there is no shared helper to reuse here.
 */
function text(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/**
 * One card renders every media type. Plugins supply display fields, never UI.
 */
export function MediaCard({ group, onPick, fields, onEditGroup, onEditRelease, onRequeryMetadata }: Props) {
  const { display } = group;
  const [editing, setEditing] = useState(false);
  // One piece of state, so the card slot's image and a performer's full image
  // can never both be open at once. Both now open the *same* list, differing
  // only in where they start.
  const [modal, setModal] = useState<{ images: GroupImage[]; startIndex: number } | null>(null);
  const [requerying, setRequerying] = useState(false);
  const [requeryError, setRequeryError] = useState<string | null>(null);
  // No local override of `group.metadata` any more: the route re-arms
  // `useGroupMetadata` for this id once `onRequeryMetadata` lands (see that
  // prop's doc), and the *same* map Browse/Picks already merge in is what
  // delivers the fresher answer back to this card — through `group.metadata`
  // itself, on the next render, exactly like every other card's answer
  // always has. A card-local copy here would be a second place that answer
  // could live, disagreeing with the map the instant a poll updated one but
  // not the other.
  const { metadata } = group;

  // Two rules, deliberately different, and both stated in `groupImages.ts`:
  // the slot is a fixed 2:3 frame that crops, so it refuses a landscape
  // background; the modal has no such constraint and lists it. That only
  // reaches a user when the card has an opener at all — a group whose only
  // artwork is a background with no cast portrait has neither a slot nor an
  // avatar, so that image is unreachable, not one click away.
  const slot = slotImage(group);
  const images = groupImages(group);

  // A requery's error message describes one attempt, and a fresher answer
  // outlives it: leaving it up would caption a card that has since updated
  // with the reason an earlier attempt failed. The dependency is the view
  // object itself rather than a deep compare of its contents — the parent's
  // map hands out a new object for every answer it fetches and the same one
  // on every other render, so object identity is exactly "a new answer
  // arrived". Clearing an already-null error is a no-op React bails out of,
  // so the mount-time run costs nothing.
  useEffect(() => {
    setRequeryError(null);
  }, [metadata]);

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
  const sceneUrl = metadata.state === 'confirmed' ? metadata.sceneUrl ?? null : null;
  // The provider's answer is what the card shows, with the plugin's display as
  // the fallback — spec §4. This reverses the rule the old panel comment stated
  // ("a second opinion, never a replacement"): a collapsed header has room for
  // one title, and the provider's is the scene's actual title where the parsed
  // one is usually performer-name-led. All three are inside the `'confirmed'`
  // member of the union, so they narrow together.
  const answered = metadata.state === 'confirmed' ? metadata : null;
  // `text`, not `??`: an empty provider title is a title the card cannot show,
  // so it falls back the same way a null one does.
  const title = text(answered?.title) ?? display.title;
  const runtime = answered?.durationSeconds ?? null;
  // The date has no fallback on purpose: `display.date` is the parse of a
  // release name, and this phase stops presenting that as the scene's date.
  const releaseDate = text(answered?.releaseDate);
  // Every part of the line is tested for emptiness the same way, because the
  // separator between them is drawn by CSS on whichever spans exist: a part
  // that renders as an empty span is invisible and still gets a ` · `. The two
  // strings go through `text`; the runtime is a number that is only ever
  // absent as `null`, and `formatDuration` has no empty return — `0` renders
  // `0m`, which a card is expected to show.
  const studio = text(display.subtitle);
  const context: string[] = [];
  if (studio !== null) context.push(studio);
  if (releaseDate !== null) context.push(releaseDate);
  if (runtime !== null) context.push(formatDuration(runtime));
  // The lazy trigger (`useGroupMetadata`) already owns every group that has
  // never been asked or is still waiting on an answer; a button here for
  // either would be a second path to the one thing that hook already does.
  // Only a group with a recorded answer — an opinion the provider might now
  // want to revise — is this button's business. Gated on the handler too,
  // the same way `canEdit` is gated on `onEditGroup`: a caller with nowhere
  // to send a requery gets a card with no button rather than one that does
  // nothing.
  const settled =
    (metadata.state === 'confirmed' || metadata.state === 'none') && onRequeryMetadata !== undefined;
  const canEdit = values !== undefined && identityFields !== undefined && onEditGroup !== undefined;

  /**
   * The group's cast as one list, or `null` when there is nobody to list.
   *
   * `null` rather than an empty `<ul>` is what lets the bare `{cast}` inside
   * `.card-head-main` render nothing at all. Not for the bullet — `card.css`
   * sets `list-style: none` on `.metadata-performers`, so an empty list draws
   * no marker — but for that same rule's `margin: var(--space-2) 0`, which
   * applies to an empty list as readily as to a full one and leaves a band of
   * blank space at the foot of the identity column on every unanswered card in
   * the library. Built as its own variable
   * here, alongside the component's other derived values, rather than inlined
   * into the return: the two-branch ternary below is long enough that
   * inlining it would bury the one place that actually renders it.
   *
   * One list or the other, never both. The server already guarantees that —
   * `metadataViewOf` empties `performerNames` the moment there is a structured
   * cast — but as two independent `&&` blocks the card would happily render both
   * if that ever stopped being true, showing every performer twice. The ternary
   * makes the exclusivity a property of this component rather than a promise
   * made elsewhere, and picks the richer list when they disagree.
   */
  const performers = metadata.performers ?? [];
  const performerNames = metadata.performerNames ?? [];
  const cast =
    performers.length > 0 ? (
      <ul className="metadata-performers">
        {performers.map((performer) => (
          <li key={performer.id}>
            {performer.hasAvatar &&
              (performer.hasImage ? (
                <button
                  type="button"
                  className="avatar-thumb"
                  onClick={() => setModal({
                    images,
                    // Cannot be -1 here: this button only renders under
                    // `performer.hasImage`, which is the same condition
                    // `groupImages` includes the entry under, so its src is
                    // always present in `images`.
                    startIndex: images.findIndex(
                      (image) => image.src === `/api/performers/${performer.id}/image`,
                    ),
                  })}
                >
                  <img src={`/api/performers/${performer.id}/avatar`} alt={performer.name} />
                </button>
              ) : (
                // A face with no full image: shown, not clickable. Opening a
                // modal onto a 404 is worse than not offering.
                <img className="avatar-thumb"
                     src={`/api/performers/${performer.id}/avatar`} alt={performer.name} />
              ))}
            <a href={performer.url} target="_blank" rel="noopener noreferrer">
              {performer.name}
            </a>
          </li>
        ))}
      </ul>
    ) : performerNames.length > 0 ? (
      // Answered before migration 7 and not yet refetched: names only, and no
      // link, because no slug was stored to build one from.
      <ul className="metadata-performers">
        {performerNames.map((name) => <li key={name}>{name}</li>)}
      </ul>
    ) : null;

  async function save(submitted: Record<string, string>): Promise<void> {
    // Closed only on success, so a refused merge leaves the values the user
    // typed on screen next to the reason they were refused.
    if (await onEditGroup?.(submitted)) setEditing(false);
  }

  /**
   * Asks the route to re-ask the provider for this one group. All the actual
   * work — the `POST /api/metadata/requery` call, and re-arming
   * `useGroupMetadata` so its existing poll notices whatever comes back —
   * lives in `onRequeryMetadata` (Browse's or Picks' own callback); this
   * function only owns the button's own in-flight/error presentation, the
   * same division `save` above has with `onEditGroup`. Because the fresher
   * answer arrives back through `group.metadata` on a later render rather
   * than through this call's return value, there is nothing to do here on
   * success beyond letting the button re-enable — `metadata` above already
   * updates itself the moment the parent's map does.
   */
  async function requery(): Promise<void> {
    if (onRequeryMetadata === undefined) return;
    setRequerying(true);
    setRequeryError(null);
    try {
      await onRequeryMetadata(group.id);
    } catch (cause) {
      setRequeryError((cause as Error).message);
    } finally {
      setRequerying(false);
    }
  }

  return (
    // The id is what a Downloads row's link aims at. Given unconditionally
    // rather than only on Picks: it is derived from the group id, so it is the
    // same string wherever the card is drawn, and only one list is mounted at
    // a time — there is no arrangement in which two cards claim it.
    <article className="media-card" id={groupAnchor(group.id)}>
      {/*
       * The card's slot — a poster or a performer portrait — leads in the
       * left column, everything identifying the group follows in the right,
       * and the row is as tall as whichever is taller. The slot's image was
       * positioned absolutely once, which reserved no height at all and left
       * it hanging over the release rows; giving it a column beside the
       * whole identity block — title, Edit, fields — rather than beside the
       * title alone is what keeps that column tall enough to sit next to the
       * slot without leaving a band of empty space under it.
       */}
      <div className="card-head">
        {slot !== null && (
          <button
            type="button"
            className="card-artwork"
            // Named for what pressing it does, rather than taking its name from
            // the `alt` of the image inside it. That `alt` stays per-image, as
            // §3.1 requires — but with no poster the slot shows the first cast
            // portrait, which is the shape 3,046 of this library's 4,313 groups
            // have — 71%, measured in §6 of the spec, and the ordinary case
            // rather than the exception —
            // and an `alt`-derived name made this button and that same
            // performer's avatar button in the cast list beside it two controls
            // in one tab order with one accessible name and two different
            // actions (index 0 versus that performer's own entry).
            //
            // The group is named by `title` — the value the `<h2>` above
            // actually renders — and not by `display.title`, which on the 45%
            // of groups carrying a provider title is a name appearing nowhere
            // on the card. The announced string and the visible one cannot
            // drift apart if there is only one of them (`docs/known-issues.md`,
            // "Test-suite blind spots", on `IdentityChangeConfirm`).
            aria-label={`Browse images for ${title}`}
            onClick={() => setModal({ images, startIndex: 0 })}
          >
            <img src={slot.src} alt={slot.alt} />
          </button>
        )}

        <div className="card-head-main">
          <header>
            <h2>
              {sceneUrl === null ? (
                title
              ) : (
                <a href={sceneUrl} target="_blank" rel="noopener noreferrer">
                  {title}
                </a>
              )}
            </h2>
            {/*
              * One span per part, each on its own condition, because the
              * provider populates them unevenly — the scene panel this
              * replaces recorded a running time with no release date as
              * ordinary rather than rare. The separator between them is drawn
              * by CSS rather than joined here. Not because a join
              * could not omit the absent parts — `context` above is built from
              * the present ones only, and `formatQuality` in `format.ts`
              * already joins a conditional list with this same ` · ` — but
              * because the separator is a different colour from the line it
              * sits in: `.card-context > span + span::before` (`card.css`)
              * paints it `--color-text-faint` against the line's own
              * `--color-text-dim`. That two-tone came from the pairwise
              * `.metadata-release-date + .metadata-duration::before` rule this
              * replaced, and one joined text node cannot carry it.
              */}
            {context.length > 0 && (
              <p className="card-context">
                {context.map((part) => (
                  <span key={part}>{part}</span>
                ))}
              </p>
            )}
            {group.upgradeReleaseId !== null && <span className="badge">Upgrade available</span>}
          </header>

          {/*
           * The one state worth telling the user about on its own: it is the
           * only one that resolves into something else, so a card that says
           * nothing here looks identical to one that will never get an
           * answer. `none` (asked, nothing came back) and `absent` (never
           * asked) are both terminal from the SPA's point of view and stay
           * silent on purpose. Placed right after the header rather than
           * down by the fields (spec §3): the note describes the lookup that
           * will change the title and the context line above it, so it
           * belongs beside them, not buried under the identity form or the
           * field chips.
           */}
          {metadata.state === 'pending' && <p className="metadata-pending">pending</p>}

          {canEdit && editing && (
            <IdentityForm
              plugin={group.plugin}
              fields={identityFields}
              values={values}
              onSubmit={(submitted) => void save(submitted)}
              onCancel={() => setEditing(false)}
            />
          )}

          {/*
           * Edit and Requery live in the same row because they are the same
           * kind of thing to a user reading the card: two ways to correct
           * what it shows, one for what the parser produced and one for what
           * the provider answered. Requery renders on its own condition
           * (`settled`), independent of whether this plugin even offers
           * editing — the two controls have no requirement in common beyond
           * both belonging here.
           *
           * The condition is per *button*, not per capability: `canEdit` with
           * the form already open renders no Edit button, so gating the row on
           * `canEdit` alone left an empty `.card-actions` div — and its
           * margin — under an open identity form on a plugin with no Requery
           * button to keep it company.
           */}
          {((canEdit && !editing) || settled) && (
            <div className="card-actions">
              {canEdit && !editing && (
                <button type="button" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
              {settled && (
                <button type="button" onClick={() => void requery()} disabled={requerying}>
                  {requerying ? 'Requerying…' : 'Requery metadata'}
                </button>
              )}
            </div>
          )}
          {requeryError !== null && <p className="error">{requeryError}</p>}

          {/*
           * A field is rendered as a single text node ("Label: Value") rather
           * than separate <dt>/<dd> elements. A plugin's field value can equal
           * the group's subtitle or date verbatim (e.g. a "Site" field
           * mirroring the subtitle) — keeping label and value in one node
           * means a query for the bare value never collides with an unrelated
           * element that happens to hold the exact same string.
           */}
          <ul className="fields">
            {display.fields.map((field) => (
              <li key={field.label}>
                {field.label}: {field.value}
              </li>
            ))}
          </ul>

          {/*
           * What the provider adds beyond the title, date and runtime already
           * promoted into the collapsed header above: the synopsis and the
           * cast — the parts with nowhere to go in one line of context.
           * These used to sit in a scene panel below the release rows; they
           * now render here instead, in the same column as the title,
           * because that panel had nothing left to be a panel about once its
           * own title, date, duration and pending note (see above) moved
           * into the header.
           *
           * The synopsis renders only once the answer is `confirmed`, checked
           * independently of the cast — one being missing says nothing about
           * the other. `cast` needs no guard of its own: it is already `null`
           * when there is nobody to list, which is what lets one call site
           * serve both a confirmed group and one the provider had nothing
           * for, where the old two-panel layout needed a call site each.
           */}
          {metadata.state === 'confirmed' && metadata.synopsis !== null && (
            <p className="metadata-synopsis">{metadata.synopsis}</p>
          )}
          {cast}
        </div>
      </div>

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

      {modal !== null && <ImageModal {...modal} onClose={() => setModal(null)} />}
    </article>
  );
}
