/**
 * What a media item is, shown above its release list.
 *
 * Shared rather than written three times: all three plugins render the
 * same section, and the alternative is three copies that drift. This is
 * the second web-shaped component in this package after `CardHeading`,
 * for the same reason.
 *
 * Everything here comes from the replica -- `media_item`'s own columns and
 * the `roles` the gather resolves -- except the images, which are urls the
 * host serves because artwork is deliberately not replicated (#79).
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import { Gallery, type GalleryImage } from './Gallery.tsx';
import { DownloadTypeIcon, ImagePlaceholder, ProviderBadge } from './icons.tsx';
import { mediaLink, personLink, providerDisplayName, type ExternalLink } from './links.ts';
import type { GatheredItemView, GatheredRoleView } from './types.ts';

export interface MediaDetailsProps {
  readonly item: MediaItemSyncRead;
  readonly gathered: GatheredItemView;
  /**
   * Links this card's own plugin knows about and the shared component
   * cannot. `plugin-movie` passes IMDb from `movie_detail.imdb_id`; the
   * other two pass nothing, having no such identity.
   */
  readonly extraLinks?: readonly ExternalLink[];
}

/**
 * The distinct people to show, most prominently billed first.
 *
 * **Distinct people, not roles.** One person can hold several roles on an
 * item, and five rows could be two people. De-duplicated on `personId`,
 * keeping the best-billed of that person's rows.
 *
 * `billingOrder` ascending with nulls last, then by name so the order is
 * total -- two runs over the same data must agree, and a provider that
 * leaves billing null for a whole cast would otherwise render in replica
 * order, which is arrival order.
 *
 * A role whose `person` has not replicated yet is dropped: it has no name
 * to show, and a nameless face is worse than a shorter cast.
 */
export function topBilled(roles: readonly GatheredRoleView[], limit: number): readonly GatheredRoleView[] {
  const best = new Map<number, GatheredRoleView>();
  for (const role of roles) {
    if (role.person === undefined) continue;
    const held = best.get(role.row.personId);
    if (held === undefined || rank(role) < rank(held)) best.set(role.row.personId, role);
  }
  return [...best.values()]
    .toSorted((a, b) => {
      const byBilling = rank(a) - rank(b);
      if (byBilling !== 0) return byBilling;
      return (a.person?.name ?? '').localeCompare(b.person?.name ?? '');
    })
    .slice(0, limit);
}

/** Nulls sort last, which `Number.MAX_SAFE_INTEGER` expresses without a branch at every comparison. */
function rank(role: GatheredRoleView): number {
  return role.row.billingOrder ?? Number.MAX_SAFE_INTEGER;
}

/** How many of the cast the section shows. */
const CAST_LIMIT = 5;

/** What the gallery is currently open over, or `undefined` for closed. */
/**
 * Every image this card can show, in the order the gallery walks them:
 * the media item's own three slots first, then each cast member's.
 *
 * Built once and handed whole to the gallery, rather than one subject's
 * images per click, because the attribution is per image -- the title
 * under the poster, a person's name under theirs -- which only means
 * anything if the arrows reach both.
 */
function galleryImages(
  item: MediaItemSyncRead,
  gathered: GatheredItemView,
  cast: readonly GatheredRoleView[],
): readonly GalleryImage[] {
  const media = [gathered.artwork.poster, gathered.artwork.background, gathered.artwork.logo]
    .map((url) => ({ url, caption: item.title }));
  const people = cast.flatMap((role) => (
    role.person === undefined ? [] : [{ url: role.imageUrl, caption: role.person.name }]
  ));
  return [...media, ...people];
}
export function MediaDetails({ item, gathered, extraLinks = [] }: MediaDetailsProps): ReactElement {
  // Which image the gallery opened on, or `undefined` for closed.
  const [openAt, setOpenAt] = useState<string | undefined>(undefined);
  const [posterFailed, setPosterFailed] = useState(false);

  const cast = topBilled(gathered.roles, CAST_LIMIT);
  const own = mediaLink(item.provider, item.providerRef);
  const links = own === undefined ? extraLinks : [own, ...extraLinks];
  const transports = [...new Set(gathered.releases.map((release) => release.row.downloadType))].toSorted();
  const attribution = item.provider === null ? undefined : providerDisplayName(item.provider);

  return (
    <section className="details">
      <div className="details-head">
        <button
          type="button"
          className="poster"
          onClick={() => {
            setOpenAt(gathered.artwork.poster);
          }}
        >
          {posterFailed ? (
            <ImagePlaceholder label={`No poster for ${item.title}`} />
          ) : (
            <img
              src={gathered.artwork.poster}
              alt={item.title}
              onError={() => {
                setPosterFailed(true);
              }}
            />
          )}
        </button>

        <div className="details-body">
          <p className="icon-row">
            {transports.map((type) => <DownloadTypeIcon key={type} type={type} />)}
            {links.map((link) => (
              <a key={link.href} href={link.href} target="_blank" rel="noreferrer noopener">
                <ProviderBadge label={link.label} />
              </a>
            ))}
          </p>
          {item.description !== null && <p className="description">{item.description}</p>}
        </div>
      </div>

      {cast.length > 0 && (
        <ul className="cast">
          {cast.map((role) => (
            <CastMember
              key={role.row.personId}
              role={role}
              provider={item.provider}
              onOpen={setOpenAt}
            />
          ))}
        </ul>
      )}

      <p className="details-foot">
        {item.releaseDate !== null && <span>Release Date: {item.releaseDate}</span>}
        {attribution !== undefined && <small>data provided by {attribution}</small>}
      </p>

      {openAt !== undefined && (
        <Gallery
          key={openAt}
          images={galleryImages(item, gathered, cast)}
          startUrl={openAt}
          onClose={() => {
            setOpenAt(undefined);
          }}
        />
      )}
    </section>
  );
}

/**
 * One person: their picture, and their name linked to the provider's own
 * page for them.
 *
 * Its own component because it holds per-person state -- whether that
 * picture failed -- which a `map` in the parent cannot.
 *
 * **No button once the picture has failed, whole-branch review finding
 * 2.** A person's gallery holds exactly one url (`role.imageUrl`, unlike
 * the media gallery's three), so once that url has 404'd there is nothing
 * left for the gallery to show. `Gallery`'s own effect closes itself the
 * instant it finds no image showing -- which fires the same render pass it
 * mounts in, since the 404 this button's own `onError` reacted to is
 * already cached -- so a button that still opened it would flash a dialog
 * open and shut in one frame, stealing and returning focus for nothing.
 * Most people on a card have no picture at all (the person artwork route
 * 404s for all but a few), so this is the common path, not an edge case.
 * A control that opens nothing is worse than no control, so the button is
 * dropped rather than kept as a no-op -- unlike the poster's own button
 * just below, which keeps opening even once its poster has failed, because
 * that gallery also holds a background and a logo that may still resolve.
 */
function CastMember({
  role, provider, onOpen,
}: {
  role: GatheredRoleView;
  provider: string | null;
  onOpen: (url: string) => void;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const name = role.person?.name ?? '';
  const href = role.person === undefined ? undefined : personLink(provider, role.person.providerRef);

  return (
    <li>
      {failed ? (
        <ImagePlaceholder label={`No picture of ${name}`} />
      ) : (
        <button
          type="button"
          onClick={() => {
            onOpen(role.imageUrl);
          }}
        >
          <img
            src={role.imageUrl}
            alt={name}
            onError={() => {
              setFailed(true);
            }}
          />
        </button>
      )}
      {href === undefined
        ? <span>{name}</span>
        : <a href={href} target="_blank" rel="noreferrer noopener">{name}</a>}
    </li>
  );
}
