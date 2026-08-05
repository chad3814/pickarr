import type { GroupView } from '../api/client.ts';
import { ReleaseRow } from './ReleaseRow.tsx';

interface Props {
  group: GroupView;
  onPick(releaseId: number): void;
}

/**
 * One card renders every media type. Plugins supply display fields, never UI.
 */
export function MediaCard({ group, onPick }: Props) {
  const { display } = group;
  return (
    <article className="media-card">
      <header>
        <h2>{display.title}</h2>
        {display.subtitle !== undefined && <p className="subtitle">{display.subtitle}</p>}
        {display.date !== undefined && <p className="date">{display.date}</p>}
        {group.upgradeReleaseId !== null && <span className="badge">Upgrade available</span>}
      </header>

      {/*
       * A field is rendered as a single text node ("Label: Value") rather
       * than separate <dt>/<dd> elements. A plugin's field value can equal
       * the group's subtitle or date verbatim (e.g. a "Site" field mirroring
       * the subtitle) — keeping label and value in one node means a query
       * for the bare value never collides with an unrelated element that
       * happens to hold the exact same string.
       */}
      <ul className="fields">
        {display.fields.map((field) => (
          <li key={field.label}>
            {field.label}: {field.value}
          </li>
        ))}
      </ul>

      <ul className="releases">
        {group.releases.map((release) => (
          <ReleaseRow
            key={release.id}
            release={release}
            isCurrent={release.id === group.pickedReleaseId}
            onPick={onPick}
          />
        ))}
      </ul>
    </article>
  );
}
