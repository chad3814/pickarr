import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { api, type GroupView } from '../api/client.ts';
import { useGroupMetadata } from '../api/useGroupMetadata.ts';
import { MediaCard } from '../components/MediaCard.tsx';

export function Picks() {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { hash } = useLocation();
  const landed = useRef<string | null>(null);

  // Every group `/api/picks` returned, not a page of them — the route has no
  // "Load more", it answers everything picked in one response. That can
  // outgrow the 100-id cap `POST /api/metadata/request` and `GET
  // /api/metadata` share (see the hook's own comment), which is exactly why
  // the hook chunks internally rather than assuming its caller's list fits in
  // one request.
  const liveMetadata = useGroupMetadata(groups.map((group) => group.id));

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
          // The live answer once the poll has one, falling back to what
          // `/api/picks` already carried — the same fallback Browse uses, for
          // the same reason: it is what lets the first paint show whatever
          // the last load already knew instead of every card flashing back to
          // "no metadata" the instant this hook takes over.
          group={{ ...group, metadata: liveMetadata.get(group.id) ?? group.metadata }}
          onPick={(releaseId) => void pick(group.id, releaseId)}
        />
      ))}
    </section>
  );
}
