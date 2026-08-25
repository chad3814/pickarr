import type { GroupView } from './client.ts';

/**
 * One image a group has, addressed and described.
 *
 * `label` is the image's kind, not the caption the user reads. The modal
 * renders `${label} · ${n} of ${total}`, and the position half is the modal's
 * to know — nothing here can say where in a list an item will be shown.
 */
export interface GroupImage {
  src: string;
  /**
   * What a screen reader announces, per image. A performer portrait must never
   * be announced as the scene's poster: before this existed the card labelled
   * every image `Poster for {title}`, which told a screen-reader user something
   * untrue about what they were looking at.
   */
  alt: string;
  label: string;
}

/**
 * Every image the group has, in browse order: poster, background, then each
 * performer's full image.
 *
 * Composed here rather than fetched, because the SPA already holds every input.
 * The four `has*` booleans and the cast arrive with the group view, so an
 * endpoint would ship the same facts twice and put the order in a second place
 * (spec §4).
 *
 * Poster and background are read only under `state === 'confirmed'`, and that
 * is the type system rather than a precaution: both live inside that variant of
 * `MetadataView`, while `performers` sits outside it. A group with no scene
 * answer has no scene artwork and may still have a cast.
 */
export function groupImages(group: GroupView): GroupImage[] {
  const images: GroupImage[] = [];
  const { metadata } = group;
  const title = group.display.title;

  if (metadata.state === 'confirmed') {
    if (metadata.hasPoster) {
      images.push({
        src: `/api/groups/${group.id}/poster`,
        alt: `Poster for ${title}`,
        label: 'Poster',
      });
    }
    if (metadata.hasBackground) {
      images.push({
        src: `/api/groups/${group.id}/background`,
        alt: `Background for ${title}`,
        label: 'Background',
      });
    }
  }

  for (const performer of metadata.performers ?? []) {
    if (!performer.hasImage) continue;
    images.push({
      src: `/api/performers/${performer.id}/image`,
      alt: performer.name,
      label: performer.name,
    });
  }

  return images;
}

/**
 * The one image the card's slot shows, or `null` for no slot at all.
 *
 * Deliberately **not** `groupImages(group)[0]`, and the difference is the point
 * of this phase. The slot is a fixed 2:3 frame that crops what it is given, so a
 * landscape background in it is the exact outcome the poster/background split
 * was made to end. The modal has no such constraint and lists the background
 * second — reachable by clicking the slot or a performer avatar, whichever the
 * card has. Neither exists for a group whose only artwork is a background with
 * no cast portrait, so for that group the background is unreachable, not merely
 * one click further away.
 *
 * A group with a background and no performer therefore draws no slot even though
 * `groupImages` returns one image. That is not an oversight to tidy up later.
 */
export function slotImage(group: GroupView): GroupImage | null {
  const { metadata } = group;

  if (metadata.state === 'confirmed' && metadata.hasPoster) {
    return {
      src: `/api/groups/${group.id}/poster`,
      alt: `Poster for ${group.display.title}`,
      label: 'Poster',
    };
  }

  // Cast order, which is the provider's: `performersForGroups` ends
  // `ORDER BY gp.group_id, gp.position`, so "first" needs no sort here.
  for (const performer of metadata.performers ?? []) {
    if (performer.hasImage) {
      return {
        src: `/api/performers/${performer.id}/image`,
        alt: performer.name,
        label: performer.name,
      };
    }
  }

  return null;
}
