import { useCallback, useEffect, useState } from 'react';
import { api, type GroupView } from '../api/client.ts';
import { MediaCard } from '../components/MediaCard.tsx';

export function Browse() {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (from: string | null, term: string, replace: boolean): Promise<void> => {
      try {
        const page = await api.browse(from, term);
        setGroups((previous) => (replace ? page.groups : [...previous, ...page.groups]));
        setCursor(page.nextCursor);
        setDone(page.nextCursor === null);
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [],
  );

  useEffect(() => {
    void loadPage(null, search, true);
  }, [loadPage, search]);

  async function pick(groupId: number, releaseId: number): Promise<void> {
    try {
      await api.pick(groupId, releaseId);
      // Refetch rather than patch: picking can remove the group from this list.
      await loadPage(null, search, true);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return (
    <section>
      <h1>Browse</h1>
      <input
        type="search"
        placeholder="Search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {error !== null && <p className="error">{error}</p>}

      {groups.map((group) => (
        <MediaCard
          key={group.id}
          group={group}
          onPick={(releaseId) => void pick(group.id, releaseId)}
        />
      ))}

      {!done && (
        <button type="button" onClick={() => void loadPage(cursor, search, false)}>
          Load more
        </button>
      )}
    </section>
  );
}
