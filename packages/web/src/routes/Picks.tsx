import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { api, type GroupView } from '../api/client.ts';
import { MediaCard } from '../components/MediaCard.tsx';

export function Picks() {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { hash } = useLocation();
  const landed = useRef<string | null>(null);

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

  /**
   * Scrolls to the card a `/picks#group-N` link names.
   *
   * The browser resolves a fragment when the document loads, and this is a
   * client-side navigation into a list that arrives from a later fetch — so by
   * the time the card exists nothing is looking for it any more, and a link
   * from Downloads would land at the top of a list its group may be far down.
   *
   * Once per hash: `reload()` runs again after every pick, and re-scrolling
   * then would drag the page back to a card the user has just finished with.
   *
   * "Once" counts only landings that happened. Marking the hash spent on a
   * list that does not contain the card — the first load raced the link, or the
   * group arrived in a later refresh — would spend the one chance on nothing
   * and never scroll, which is indistinguishable from the bug this effect
   * exists to fix. So the element is found first, and only then recorded.
   */
  useEffect(() => {
    if (hash === '' || hash === landed.current || groups.length === 0) return;
    const target = document.getElementById(hash.slice(1));
    if (target === null) return;
    landed.current = hash;
    target.scrollIntoView();
  }, [hash, groups]);

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
