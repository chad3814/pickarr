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
 * host serves: artwork rows replicate without their bytes, so each picture is
 * a url built from its row id (#79).
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

/**
 * Every image this card can show, in the order the gallery walks them:
 * the media item's posters, then its backgrounds, then each cast member's
 * pictures, each list already in rank order.
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
  // Posters and backgrounds only. **The logo is deliberately not here**,
  // though `artwork.logos` still carries its rows and the job still
  // fetches and stores them: a wordmark on a transparent background is a
  // thing a card might one day draw *with*, not a picture anyone opens a
  // lightbox to look at.
  const media = [...gathered.artwork.posters, ...gathered.artwork.backgrounds]
    .map((image) => ({ url: image.url, caption: item.title }));
  const people = cast.flatMap((role) => {
    const person = role.person;
    return person === undefined ? [] : role.images.map((image) => ({ url: image.url, caption: person.name }));
  });
  return [...media, ...people];
}

export function MediaDetails({ item, gathered, extraLinks = [] }: MediaDetailsProps): ReactElement {
  // Which image the gallery opened on, or `undefined` for closed.
  const [openAt, setOpenAt] = useState<string | undefined>(undefined);
  const [posterFailed, setPosterFailed] = useState(false);
  const posterUrl = gathered.artwork.posters[0]?.url;
  // Where the poster button opens: the top poster, or the top background
  // when the item has none. Neither means a gallery with nothing to show,
  // which would close the instant it opened, so the button is disabled.
  const openUrl = posterUrl ?? gathered.artwork.backgrounds[0]?.url;

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
          disabled={openUrl === undefined}
          onClick={() => {
            setOpenAt(openUrl);
          }}
        >
          {posterFailed || posterUrl === undefined ? (
            <ImagePlaceholder label={`No poster for ${item.title}`} />
          ) : (
            <img
              src={posterUrl}
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
 * **No button without a working thumbnail.** A person with no stored
 * pictures, or whose rank-0 picture has 404'd, gets the placeholder and no
 * button: the button's whole content is that picture, and opening the
 * gallery on a url known to be dead would show a broken frame before
 * `Gallery` skips past it. Most people on a card have no picture at all
 * (the person artwork route 404s for all but a few), so this is the common
 * path, not an edge case. The poster's own button differs: it keeps
 * opening once its poster has failed, because the gallery behind it holds
 * more than that one image and walks on to the next that loads.
 */
function CastMember({
  role, provider, onOpen,
}: {
  role: GatheredRoleView;
  provider: string | null;
  onOpen: (url: string) => void;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const imageUrl = role.images[0]?.url;
  const name = role.person?.name ?? '';
  const href = role.person === undefined ? undefined : personLink(provider, role.person.providerRef);

  return (
    <li>
      {failed || imageUrl === undefined ? (
        <ImagePlaceholder label={`No picture of ${name}`} />
      ) : (
        <button
          type="button"
          onClick={() => {
            onOpen(imageUrl);
          }}
        >
          <img
            src={imageUrl}
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
