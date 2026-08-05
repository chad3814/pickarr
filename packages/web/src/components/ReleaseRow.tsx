import type { ReleaseView } from '../api/client.ts';
import { formatQuality, formatBytes } from '../api/format.ts';

interface Props {
  release: ReleaseView;
  isCurrent: boolean;
  onPick(releaseId: number): void;
}

export function ReleaseRow({ release, isCurrent, onPick }: Props) {
  return (
    <li className="release-row">
      <span className="release-quality">{formatQuality(release.quality)}</span>
      {release.quality.sizeBytes !== undefined && (
        <span className="release-size">{formatBytes(release.quality.sizeBytes)}</span>
      )}
      <span className="release-name" title={release.releaseName}>
        {release.releaseName}
      </span>
      {isCurrent ? (
        <span className="release-current">Current</span>
      ) : (
        <button type="button" onClick={() => onPick(release.id)}>
          Pick
        </button>
      )}
    </li>
  );
}
