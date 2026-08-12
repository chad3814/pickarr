import { useCallback, useEffect, useState } from 'react';
import { api, type GroupView, type ManualFieldsResponse } from '../api/client.ts';
import { useGroupMetadata } from '../api/useGroupMetadata.ts';
import { MediaCard } from '../components/MediaCard.tsx';

export function Browse() {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [fields, setFields] = useState<ManualFieldsResponse>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every group ever loaded onto this screen, not just the current page: a
  // page loaded earlier via "Load more" is still on screen, and its cards
  // still need their answers polled while any of them is pending. The cap on
  // `POST /api/metadata/request` and `GET /api/metadata` is per *request*, not
  // per page, so the hook itself chunks a list this long rather than the
  // caller having to.
  const liveMetadata = useGroupMetadata(groups.map((group) => group.id));

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

  // The schemas are configuration, one map for every card on every page, so
  // they are fetched once for the screen rather than per group.
  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const next = await api.manualFields();
        if (!cancelled) setFields(next);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function pick(groupId: number, releaseId: number): Promise<void> {
    try {
      // Patch the one card that changed. Refetching the first page instead
      // discarded every page loaded past it, so a pick made after "Load more"
      // snapped the list back to its original length. The server says whether
      // the group still belongs here — picking the best release takes it out,
      // picking a lesser one leaves it with the better release still offered —
      // so nothing here has to re-derive that rule.
      const { group } = await api.pick(groupId, releaseId);
      setGroups((previous) =>
        group === null
          ? previous.filter((existing) => existing.id !== groupId)
          : previous.map((existing) => (existing.id === groupId ? group : existing)),
      );
      setNotice(null);
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  /**
   * Corrects a group's identity and display, and answers whether it saved.
   *
   * The response is patched in for the same reason a pick's is: refetching the
   * first page discards every page loaded past it. A merge is the one case
   * where two cards change — the edited group is gone, its releases now under
   * the group whose identity the new values matched, and that group is what
   * came back. The target is patched only if it is loaded; where it belongs in
   * a list ordered by rank is the server's answer to give, not one to guess
   * from here.
   *
   * That is also why a merge says so out loud. When the target is on a page
   * nobody has loaded, the card disappears and nothing else on screen changes,
   * so the notice is the only account of where the releases went — the same
   * thing the Failed tab reports when a fix joins an existing group.
   */
  async function editGroup(groupId: number, values: Record<string, string>): Promise<boolean> {
    try {
      const { group, mergedInto } = await api.editGroup(groupId, values);
      setGroups((previous) => {
        const kept =
          mergedInto === null ? previous : previous.filter((existing) => existing.id !== groupId);
        return kept.map((existing) => (existing.id === group.id ? group : existing));
      });
      setNotice(mergedInto === null ? null : `Releases moved into ${group.display.title}`);
      setError(null);
      return true;
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
      return false;
    }
  }

  /**
   * Corrects one release's quality, which rescores it and re-derives the
   * group's upgrade flag — so the server answers with the whole group, already
   * in its new order, and the card becomes it.
   *
   * A null group is the server saying the group left this list: a picked group
   * is listed only while something better is on offer, and downgrading that
   * something is exactly what takes the flag away. Patching the card back in
   * would leave a Pick button that queues an *upgrade* to the release the user
   * just marked as worse, which on import trashes the file they already have.
   */
  async function editRelease(
    groupId: number,
    releaseId: number,
    values: Record<string, string>,
  ): Promise<boolean> {
    try {
      const { group } = await api.editRelease(releaseId, values);
      setGroups((previous) =>
        group === null
          ? previous.filter((existing) => existing.id !== groupId)
          : previous.map((existing) => (existing.id === group.id ? group : existing)),
      );
      setNotice(null);
      setError(null);
      return true;
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
      return false;
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
      {notice !== null && <p className="notice">{notice}</p>}
      {error !== null && <p className="error">{error}</p>}

      {groups.map((group) => (
        <MediaCard
          key={group.id}
          // The live answer once the poll has one, falling back to what
          // browse already carried (typically `absent`, since nothing has
          // asked yet): the fallback is what lets the very first paint show
          // whatever the last page load already knew, rather than every card
          // flashing "no metadata" until the hook's first request lands.
          group={{ ...group, metadata: liveMetadata.get(group.id) ?? group.metadata }}
          onPick={(releaseId) => void pick(group.id, releaseId)}
          // A plugin with no manual hooks is *missing* from this map, and a
          // group can outlive the package that made it; either way the card
          // finds no schema and offers no editing.
          fields={fields[group.plugin]}
          onEditGroup={(values) => editGroup(group.id, values)}
          onEditRelease={(releaseId, values) => editRelease(group.id, releaseId, values)}
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
