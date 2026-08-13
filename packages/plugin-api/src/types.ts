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

export type ManualFieldType = 'text' | 'number' | 'select';

/**
 * One field in the form a human fills in to describe a release by hand.
 *
 * `scope` is what lets a single schema drive three different forms: the whole
 * list when describing a failed item from scratch, the `identity` fields when
 * correcting a group, the `quality` fields when correcting one release. Core
 * renders from this list and never learns what a "site" is.
 */
export interface ManualField {
  readonly name: string;
  readonly label: string;
  readonly type: ManualFieldType;
  readonly scope: 'identity' | 'quality';
  readonly required?: boolean;
  /** Permitted values, for `type: 'select'`. An empty string means "unset". */
  readonly options?: readonly string[];
  readonly placeholder?: string;
  readonly help?: string;
}

/** A group as a metadata lookup sees it: its key, and what it displays. */
export interface GroupIdentity {
  readonly identityKey: string;
  readonly display: DisplayFields;
}

/**
 * What to ask a scene-metadata service about a group, and the axes an answer
 * must corroborate.
 *
 * The same shape of seam as `siteCandidates`: the plugin says what to ask and
 * what would count, the host decides how and when to ask. A group with no site
 * yields `null` rather than a title-only query — searching a title across every
 * site a service knows is how you confirm the wrong scene.
 */
export interface MetadataQuery {
  /** Search strings to try, in order. The first yielding a confirmation wins. */
  readonly queries: readonly string[];
  /** Canonical site name. The host resolves it to a provider id from its own cache. */
  readonly siteName?: string;
  /** The group's own date, ISO `yyyy-mm-dd`, when it has one. */
  readonly date?: string;
}

/**
 * One performer on a scene, as the metadata service describes them.
 *
 * `kind` records which of the service's two namespaces this identity lives
 * in, because that decides the page it links to. It is set by the same branch
 * that decides where the images came from — a performer read from a `parent`
 * is canonical, a parentless one is a site alias — so the link and the avatar
 * cannot disagree about which entity this is.
 */
export interface MetadataPerformer {
  readonly sourceUuid: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: 'performer' | 'performer-site';
  /** A square crop, suited to a thumbnail. */
  readonly faceUrl: string | null;
  /** The full image, for a modal. */
  readonly imageUrl: string | null;
}

/** One scene as the metadata service describes it. */
export interface MetadataCandidate {
  readonly sourceUuid: string | null;
  readonly title: string;
  readonly siteUuid: string | null;
  readonly siteId: number | null;
  readonly siteName: string;
  readonly date: string | null;
  readonly performers: readonly MetadataPerformer[];
  readonly durationSeconds: number | null;
  readonly synopsis: string | null;
  readonly posterUrl: string | null;
  /** The service's own slug for this scene, from which its page URL is built. */
  readonly slug: string | null;
}

/** A candidate that was not believed, and the reason it was not. */
export interface MetadataRejection {
  readonly candidate: MetadataCandidate;
  readonly reason: string;
}

/**
 * `confirmed: null` with a populated `nearMisses` is the interesting outcome:
 * the service answered, nothing was believed, and the reasons are recorded so
 * the rule can be measured instead of argued about.
 */
export interface MetadataVerdict {
  readonly confirmed: MetadataCandidate | null;
  readonly nearMisses: readonly MetadataRejection[];
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
   * What to ask a scene-metadata service about this group. `null` means the
   * group cannot be looked up — no site, typically — and it is then never
   * queued.
   *
   * Unlike `siteCandidates`, nothing here reaches the identity key, which is
   * what makes the lookup safe to perform long after the group was created.
   */
  metadataQuery?(group: GroupIdentity): MetadataQuery | null;

  /**
   * Which candidate, if any, is this group's scene.
   *
   * Must be strict: a wrong confirmation puts another scene's performers on a
   * card and never says so, while a missed one merely leaves the card as it is
   * today. Rejections are returned rather than discarded.
   */
  confirmMetadata?(
    candidates: readonly MetadataCandidate[],
    query: MetadataQuery,
  ): MetadataVerdict;

  /**
   * Why the most recent `parse` returned `null`.
   *
   * `null` alone cannot say what to fix. A log reading `unrecognized` eight
   * times is a count; `no date, and the site is not in the known list` is a
   * worklist. Valid only immediately after the `parse` call it describes, and
   * purely descriptive — nothing may depend on it.
   */
  refusalReason?(): string | null;

  /**
   * The fields a human may fill in to describe a release this plugin handles.
   *
   * A plugin implementing none of the manual hooks simply gets no edit UI;
   * core hides the controls. Dismissing a failed item still works, because
   * that is core's own bookkeeping and needs no plugin knowledge.
   */
  manualFields?(): readonly ManualField[];

  /**
   * Field values turned into a release, or a message naming what is wrong.
   *
   * Must produce a correct `identityKey` and `display` from the
   * `identity`-scoped values alone: core does not send quality values when
   * editing a group, and ignores `media.quality` if one comes back.
   */
  fromManualValues?(
    values: Readonly<Record<string, string>>,
  ): { media: ParsedRelease } | { error: string };

  /**
   * The inverse, to prefill an edit form. Manual values are never stored —
   * only the `ParsedRelease` is — so this is how a form is repopulated, and
   * why a plugin renaming a field later orphans nothing.
   */
  toManualValues?(media: ParsedRelease): Record<string, string>;

  /**
   * Best-effort prefill for a name that failed to parse. Runs on names the
   * parser has already refused, so returning little or nothing is normal.
   * Must never throw: a suggestion is a convenience, not a contract.
   */
  suggestManualValues?(releaseName: string): Record<string, string>;
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
