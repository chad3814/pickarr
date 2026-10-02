/**
 * The library titles the identify combobox offers for a typed term, read
 * from the replica's derived catalog -- the same `catalog` store the
 * category pages search -- and `identifySubmit`, which binds that read and
 * `postIdentify` into the one `IdentifySubmit` the cards take.
 *
 * Lists come from the replica only; nothing here calls `fetch` except
 * through `postIdentify`.
 */
import { SUGGEST_LIMIT, type Candidate, type IdentifySubmit } from '@pickarr/plugin-ui';
import type { Store } from '../store/index.ts';
import { normalizeTerm } from '../store/catalog.ts';
import { postIdentify } from './postIdentify.ts';
import { isMediaItem } from './useMediaItems.ts';

/** The two `Store` members suggestions need, so a test can bind them to a bare database. */
export type SuggestSource = Pick<Store, 'listCatalog' | 'getRows'>;

/**
 * Up to {@link SUGGEST_LIMIT} titles of plugin `pluginId` matching `raw`,
 * in catalog order. A blank term suggests nothing; a catalog record whose
 * `media_item` row is absent or malformed is skipped.
 */
export async function suggestCandidates(source: SuggestSource, pluginId: string, raw: string): Promise<readonly Candidate[]> {
  const term = normalizeTerm(raw);
  if (term === '') return [];
  const records = await source.listCatalog({ pluginId, filter: 'all', term }, { limit: SUGGEST_LIMIT });
  const rows = await source.getRows('media_item', records.map((record) => record.id));
  return records.flatMap((record) => {
    const value = rows.get(record.id);
    if (!isMediaItem(value)) return [];
    const year = typeof value.releaseDate === 'string' && value.releaseDate.length >= 4 ? value.releaseDate.slice(0, 4) : null;
    return [{ mediaItemId: record.id, title: value.title, year }];
  });
}

/** The `IdentifySubmit` the shell hands every card: the real post, and suggestions off `store`. */
export function identifySubmit(store: SuggestSource): IdentifySubmit {
  return { identify: postIdentify, suggest: (pluginId, term) => suggestCandidates(store, pluginId, term) };
}
