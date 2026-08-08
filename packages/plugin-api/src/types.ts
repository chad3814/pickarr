export interface DisplayField {
  label: string;
  value: string;
}

export interface DisplayFields {
  title: string;
  subtitle?: string;
  date?: string;
  fields: DisplayField[];
}

export type QualityExtra = string | number | boolean;

export interface QualityTokens {
  resolution?: number;
  source?: string;
  videoCodec?: string;
  audioCodec?: string;
  bitrateKbps?: number;
  sizeBytes?: number;
  releaseGroup?: string;
  extras?: Record<string, QualityExtra>;
}

export interface ParsedRelease {
  identityKey: string;
  display: DisplayFields;
  quality: QualityTokens;
}

export interface DownloadedFile {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
}

export interface ImportFile {
  source: string;
  destination: string;
}

export interface ImportPlan {
  files: ImportFile[];
}

/**
 * A lookup request: what to search for, and what a result must match.
 *
 * The two are deliberately separate, because a search string is rarely the
 * site's whole name. Searching a metadata service for the release's first two
 * words is a good way to *find* `2 Chicks Same Time` — but nothing is named
 * `2 Chicks`, so judging results by whether one equals the query would reject
 * the site that was just found. Worse, retrying with the first word alone can
 * confirm a real but wrong site: there is a site called `Free`, so
 * `Free.Use.Fantasy...` resolves to it unless results are checked against
 * something better.
 *
 * `prefixes` is that something better: the leading runs of the release's own
 * name, longest first. A result is believed when it *is* one of them.
 */
export interface SiteLookupCandidates {
  /** Search strings to try, in order. The first one that yields a match wins. */
  readonly queries: readonly string[];
  /**
   * Leading runs of the release name a returned site may match, longest
   * first. The longest match is the answer, so a four-word site beats the
   * two-word run inside it.
   */
  readonly prefixes: readonly string[];
}

export interface MediaTypePlugin {
  readonly id: string;
  readonly displayName: string;
  parse(releaseName: string): ParsedRelease | null;
  score(quality: QualityTokens): number;
  planImport(media: ParsedRelease, files: DownloadedFile[]): ImportPlan | null;

  /**
   * What to ask a site-metadata service about this release, and what an answer
   * has to look like to be believed.
   *
   * `parse` is synchronous and must stay that way — it runs once per feed item
   * inside a transaction. Confirming a site means asking a remote service,
   * which is neither. These two hooks are the seam: the host collects
   * candidates for a whole batch, resolves them however it likes, hands back
   * the confirmed ones, and only then parses.
   *
   * Returns `null` for a name that needs no help, which is the usual case.
   */
  siteCandidates?(releaseName: string): SiteLookupCandidates | null;

  /**
   * Adds confirmed site names to whatever set `parse` consults. Additive; the
   * host may call it repeatedly.
   */
  learnSites?(sites: readonly string[]): void;

  /**
   * Why the most recent `parse` returned `null`.
   *
   * `null` alone cannot say what to fix. A log reading `unrecognized` eight
   * times is a count; `no date, and the site is not in the known list` is a
   * worklist. Valid only immediately after the `parse` call it describes, and
   * purely descriptive — nothing may depend on it.
   */
  refusalReason?(): string | null;
}

/**
 * A plugin's own configuration block, passed through from `plugins.<package>`
 * verbatim. String lists are permitted because some plugin-specific knowledge
 * is irreducibly a list — the scenes plugin's known-site names, for one — and
 * encoding those as a delimited string would make every plugin invent its own
 * escaping for names that contain the delimiter.
 */
export type PluginConfig = Record<string, string | number | boolean | readonly string[]>;

export type PluginFactory = (config: PluginConfig) => MediaTypePlugin;
