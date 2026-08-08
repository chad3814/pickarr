import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, QualityTokens } from '@pickarr/plugin-api';
import type { GroupRow } from '../db/groups.ts';
import { releasesForGroup } from '../db/releases.ts';
import type { DownloadRow } from '../db/downloads.ts';
import type { UntrackedEntry } from '../pipeline/reconcile.ts';
import { str, type SqlRow } from '../db/row.ts';

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

export interface DownloadsResponse {
  tracked: DownloadView[];
  untracked: UntrackedEntry[];
}

/**
 * `group` is the picked group's standing in the *browse* list afterwards: its
 * refreshed view, or `null` when the pick took it out of that list. It lets a
 * paginated browse patch the one card that changed instead of refetching, and
 * refetching was not a harmless shortcut — it threw away every page past the
 * first, so picking anything after "Load more" snapped the list back to one
 * page.
 *
 * The server answers this because the server owns the rule (`BROWSABLE` in
 * db/groups.ts). A client deciding for itself from `state` and
 * `upgradeReleaseId` would be a second copy of that rule, free to drift.
 */
export interface PickResponse {
  download: DownloadView;
  group: GroupView | null;
}

export function toGroupView(db: DatabaseSync, group: GroupRow): GroupView {
  const releases = releasesForGroup(db, group.id).map((release) => {
    const feedItem = db
      .prepare('SELECT raw_title, published_at FROM feed_items WHERE id = ?')
      .get(release.feedItemId);
    return {
      id: release.id,
      score: release.score,
      quality: JSON.parse(release.quality) as QualityTokens,
      releaseName: feedItem === undefined ? '' : str(feedItem as SqlRow, 'raw_title'),
      publishedAt:
        feedItem === undefined || (feedItem as SqlRow)['published_at'] === null
          ? null
          : Number((feedItem as SqlRow)['published_at']),
    };
  });

  return {
    id: group.id,
    plugin: group.plugin,
    display: JSON.parse(group.display) as DisplayFields,
    state: group.state,
    pickedReleaseId: group.pickedReleaseId,
    upgradeReleaseId: group.upgradeReleaseId,
    listRankAt: group.listRankAt,
    releases,
  };
}

export function toDownloadView(db: DatabaseSync, download: DownloadRow): DownloadView {
  const group = db.prepare('SELECT display FROM media_groups WHERE id = ?').get(download.groupId);
  const display =
    group === undefined
      ? { title: `Group ${download.groupId}`, fields: [] }
      : (JSON.parse(str(group as SqlRow, 'display')) as DisplayFields);

  return {
    id: download.id,
    groupId: download.groupId,
    releaseId: download.releaseId,
    title: display.title,
    kind: download.kind,
    status: download.status,
    error: download.error,
    attempts: download.attempts,
    updatedAt: download.updatedAt,
  };
}
