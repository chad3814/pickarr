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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
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
    request<DownloadView>(`/api/groups/${groupId}/pick`, {
      method: 'POST',
      body: JSON.stringify({ releaseId }),
    }),
  retry: (downloadId: number) =>
    request<DownloadView>(`/api/downloads/${downloadId}/retry`, { method: 'POST' }),
};
