import { useEffect, useState } from 'react';
import { api, type GroupView } from '../api/client.ts';
import { MediaCard } from '../components/MediaCard.tsx';

export function Picks() {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function reload(): Promise<void> {
    try {
      setGroups((await api.picks()).groups);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function pick(groupId: number, releaseId: number): Promise<void> {
    try {
      await api.pick(groupId, releaseId);
      await reload();
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return (
    <section>
      <h1>Picks</h1>
      {error !== null && <p className="error">{error}</p>}
      {groups.map((group) => (
        <MediaCard
          key={group.id}
          group={group}
          onPick={(releaseId) => void pick(group.id, releaseId)}
        />
      ))}
    </section>
  );
}
