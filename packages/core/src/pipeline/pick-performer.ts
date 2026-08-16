import type { MetadataPerformer } from '@pickarr/plugin-api';
import type { PerformerSearchResult } from '../clients/theporndb.ts';

/**
 * The form two spellings of one name have to agree on.
 *
 * Case, and punctuation that *separates* words — a release title writes
 * `Anne Marie` where the provider writes `Anne-Marie`. Both are the same claim
 * about the same person, and folding the hyphen to a space is what lets them
 * compare equal; a comparison that called them different would reject a large
 * share of real hits.
 *
 * An apostrophe is not that kind of punctuation, so it gets its own rule,
 * applied first: it is *elided*, not folded to a space. A hyphen sits between
 * two words (`Anne-Marie` is a title's rendering of `Anne Marie`), but an
 * apostrophe sits inside one (`O'Neil` is one word, and a release title
 * routinely drops the mark to write it `ONeil`). Folding it to a space instead
 * would split the word — `O'Neil` would become `o neil`, two tokens where the
 * other spelling has one — and the two would never match. This is also why the
 * elision has to run before the general punctuation fold below: run the other
 * way round, the hyphen rule would have already turned the apostrophe into a
 * space and the damage would be done. If this line is ever removed as
 * apparently-redundant with the fold that follows it, `Katie O'Neil` stops
 * matching `Katie ONeil` again — that regression is exactly what it exists to
 * prevent.
 *
 * Deliberately *not* aggressive beyond that: it does not strip vowels, collapse
 * doubled letters or fold `Anna Bell` into `Annabelle`. Over-normalising here
 * does not merely admit a wrong match, it manufactures ties — two distinct
 * performers reading as equal is an ambiguity, and an ambiguity discards a real
 * single match. The cost of being too loose is silence where there was an
 * answer, so the bar is "spelled the same, punctuated differently".
 */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The one performer worth linking, or `null`.
 *
 * Tiered, and the tiers are ordered by how strong a claim they are:
 *
 * 1. An exact `name` match. Exactly one → that one. **Two or more → nothing,
 *    and the alias tier is not consulted.** A tie among canonical names is the
 *    strongest ambiguity available; reaching for a weaker signal to break it
 *    would be backwards.
 * 2. An exact alias match, only when tier one found none. Exactly one → that
 *    one. Two or more → nothing.
 *
 * Aliases count at all because the provider searches them and because the
 * filenames this query came from carry whatever the site billed, which is
 * frequently an alias rather than the canonical name. Excluding them would
 * reject most real hits; ranking them second is what stops that breadth costing
 * precision.
 *
 * "Exactly one" throughout, never "the first" or "the best scoring". The query
 * is two words off the front of a scene title — a guess that those words name a
 * performer at all — so the failure this must not have is a plausible wrong
 * name written onto a group's cast. Silence is the correct answer to doubt, and
 * it is by far the most common one.
 */
export function pickPerformer(
  query: string,
  results: readonly PerformerSearchResult[],
): MetadataPerformer | null {
  const wanted = normalise(query);
  if (wanted.length === 0) return null;

  const byName = results.filter((result) => normalise(result.performer.name) === wanted);
  if (byName.length === 1) return byName[0]?.performer ?? null;
  if (byName.length > 1) return null;

  const byAlias = results.filter((result) =>
    result.aliases.some((alias) => normalise(alias) === wanted),
  );
  return byAlias.length === 1 ? (byAlias[0]?.performer ?? null) : null;
}
