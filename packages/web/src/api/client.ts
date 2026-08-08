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

export interface ReleaseView {
  id: number;
  score: number;
  quality: QualityTokens;
  releaseName: string;
  publishedAt: number | null;
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
}

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
};
