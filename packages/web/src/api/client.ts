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

export type ManualFieldType = 'text' | 'number' | 'select';

/** Mirrors `ManualField` in `@pickarr/plugin-api`; see the note on `request` below. */
export interface ManualField {
  name: string;
  label: string;
  type: ManualFieldType;
  scope: 'identity' | 'quality';
  required?: boolean;
  /** Permitted values, for `type: 'select'`. An empty string means "unset". */
  options?: string[];
  placeholder?: string;
  help?: string;
}

/**
 * Keyed by plugin id. A plugin with no field list is *missing* from this map
 * rather than mapped to `[]`, which is how the SPA decides there is no form to
 * offer for its items at all.
 */
export type ManualFieldsResponse = Record<string, ManualField[]>;

export interface ReleaseView {
  id: number;
  score: number;
  quality: QualityTokens;
  releaseName: string;
  publishedAt: number | null;
  /**
   * The quality half of an edit form, prefilled. Optional rather than
   * `| undefined`: the server omits the key entirely for a plugin with no
   * `toManualValues`, and its absence is what says "offer no Edit control".
   */
  manualValues?: Record<string, string>;
}

export interface GroupView {
  id: number;
  plugin: string;
  display: DisplayFields;
  state: 'new' | 'picked';
  pickedReleaseId: number | null;
  upgradeReleaseId: number | null;
  listRankAt: number;
  releases: ReleaseView[];
  /** The identity half of an edit form, prefilled. Absent as on `ReleaseView`. */
  manualValues?: Record<string, string>;
}

/** One name the parser refused, and everything a human needs to describe it. */
export interface FailedItemView {
  id: number;
  feedId: string;
  /** The plugin id, so the SPA picks the right schema. Empty when the feed has left configuration. */
  plugin: string;
  rawTitle: string;
  link: string;
  parseError: string;
  firstSeenAt: number;
  publishedAt: number | null;
  /** Best-effort and *sparse*: only the keys the plugin could work out. */
  suggestedValues: Record<string, string>;
  dismissedAt: number | null;
}

export interface FailedResponse {
  items: FailedItemView[];
  nextCursor: string | null;
}

export interface ResolveResponse {
  group: GroupView;
  joinedExisting: boolean;
}

export interface DismissResponse {
  id: number;
  dismissedAt: number;
}

/**
 * `group` is the *surviving* group, which on a merge is the target rather than
 * the one that was patched; `mergedInto` names it, and is null when nothing
 * merged. The caller knows the source id because it sent it, so the two
 * together are what let a paginated list drop one card and replace another.
 */
export interface GroupEditResponse {
  group: GroupView;
  mergedInto: number | null;
}

/**
 * `group` is the edited release's standing in browse afterwards; null means it
 * left, exactly as on `PickResponse`. Rescoring re-derives the upgrade flag, so
 * downgrading the release that was the only reason a picked group was listed
 * takes that group out of the list.
 */
export interface ReleaseEditResponse {
  group: GroupView | null;
}

/**
 * `/api/manual-preview` answers 200 either way: the form calls it on a debounce
 * while the user is still typing, so a plugin's complaint about a half-typed
 * date is an answer to "what would these values produce?", not a failed
 * request.
 */
export type ManualPreviewResponse = { identityKey: string } | { error: string };

export interface BrowseResponse {
  groups: GroupView[];
  nextCursor: string | null;
}

export interface PicksResponse {
  groups: GroupView[];
}

export interface DownloadView {
  id: number;
  groupId: number;
  releaseId: number;
  title: string;
  kind: 'initial' | 'upgrade';
  status: string;
  error: string | null;
  attempts: number;
  updatedAt: number;
}

export interface UntrackedEntry {
  ref: string;
  name: string;
  state: 'downloading' | 'completed' | 'failed' | 'in-progress';
  percentage: number | null;
}

export interface DownloadsResponse {
  tracked: DownloadView[];
  untracked: UntrackedEntry[];
}

/** `group` is the group's standing in browse afterwards; null means it left. */
export interface PickResponse {
  download: DownloadView;
  group: GroupView | null;
}

/**
 * `content-type: application/json` is set only when there is a body to
 * describe. Sending it on a bodyless POST is what broke retry from the day it
 * was written: Fastify's JSON parser sees the header, finds nothing to parse,
 * and answers 400 FST_ERR_CTP_EMPTY_JSON_BODY without the route ever running.
 * `/api/downloads/:id/retry` takes no body, so every click was a 400 — and
 * because the caller had no catch, a silent one.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const request: RequestInit =
    init?.body === undefined
      ? { ...init }
      : { ...init, headers: { 'content-type': 'application/json', ...init.headers } };
  const response = await fetch(path, request);
  if (!response.ok) {
    const body: { error?: string } = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request to ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  browse: (cursor: string | null, search: string) => {
    const params = new URLSearchParams();
    if (cursor !== null) params.set('cursor', cursor);
    if (search.length > 0) params.set('q', search);
    return request<BrowseResponse>(`/api/browse?${params.toString()}`);
  },
  picks: () => request<PicksResponse>('/api/picks'),
  downloads: () => request<DownloadsResponse>('/api/downloads'),
  pick: (groupId: number, releaseId: number) =>
    request<PickResponse>(`/api/groups/${groupId}/pick`, {
      method: 'POST',
      body: JSON.stringify({ releaseId }),
    }),
  retry: (downloadId: number) =>
    request<DownloadView>(`/api/downloads/${downloadId}/retry`, { method: 'POST' }),
  manualFields: () => request<ManualFieldsResponse>('/api/manual-fields'),
  failed: (cursor: string | null, includeDismissed: boolean) => {
    const params = new URLSearchParams();
    if (cursor !== null) params.set('cursor', cursor);
    // The literal '1'; the server compares against it rather than coercing,
    // because every non-empty string coerces to true and `=false` would then
    // include them.
    if (includeDismissed) params.set('includeDismissed', '1');
    return request<FailedResponse>(`/api/failed?${params.toString()}`);
  },
  resolveFeedItem: (feedItemId: number, values: Record<string, string>) =>
    request<ResolveResponse>(`/api/feed-items/${feedItemId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ values }),
    }),
  dismissFeedItem: (feedItemId: number) =>
    request<DismissResponse>(`/api/feed-items/${feedItemId}/dismiss`, { method: 'POST' }),
  editGroup: (groupId: number, values: Record<string, string>) =>
    request<GroupEditResponse>(`/api/groups/${groupId}`, {
      method: 'PATCH',
      body: JSON.stringify({ values }),
    }),
  editRelease: (releaseId: number, values: Record<string, string>) =>
    request<ReleaseEditResponse>(`/api/releases/${releaseId}`, {
      method: 'PATCH',
      body: JSON.stringify({ values }),
    }),
  manualPreview: (plugin: string, values: Record<string, string>) =>
    request<ManualPreviewResponse>('/api/manual-preview', {
      method: 'POST',
      body: JSON.stringify({ plugin, values }),
    }),
};
