import { useCallback, useEffect, useState } from 'react';
import { api, RequestError, type ManualFieldsResponse } from '../api/client.ts';
import { requeryOneGroup } from '../api/requeryMetadata.ts';
import { useGroupMetadata } from '../api/useGroupMetadata.ts';
import { usePagedList } from '../api/usePagedList.ts';
import { useIdentityChange, type ApplyOutcome } from '../api/useIdentityChange.ts';
import { IdentityChangeConfirm } from '../components/IdentityChangeConfirm.tsx';
import { MediaCard } from '../components/MediaCard.tsx';
import { SearchBox } from '../components/SearchBox.tsx';

export function Browse() {
  const [fields, setFields] = useState<ManualFieldsResponse>({});
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rebuilt whenever the term changes, which is `usePagedList`'s signal to start
  // the list over from the first page.
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const page = await api.browse(cursor, search);
      return { items: page.groups, nextCursor: page.nextCursor };
    },
    [search],
  );

  const {
    items: groups,
    setItems: setGroups,
    loading,
    done,
    loadMore,
    sentinelRef,
  } = usePagedList(fetchPage, setError);

  // Every group ever loaded onto this screen, not just the current page: a page
  // that arrived earlier — by scrolling, or from the fallback button — is still
  // on screen, and its cards still need their answers polled while any of them is
  // pending. The cap on `POST /api/metadata/request` and `GET /api/metadata` is
  // per *request*, not per page, so the hook itself chunks a list this long
  // rather than the caller having to.
  const { metadata: liveMetadata, rearm: rearmMetadata } = useGroupMetadata(
    groups.map((group) => group.id),
  );

  /**
   * `MediaCard`'s Requery button, via `onRequeryMetadata`. This route (not the
   * card, and not the hook) is what holds both halves `requeryOneGroup` needs:
   * the server call, and the hook's own handle to tell it to watch the group
   * again. The body is shared with Picks, which does the same two things for
   * the same reason — see that function's own doc for why a refused requeue
   * must not reach `rearmMetadata`.
   */
  function requeryMetadata(groupId: number): Promise<void> {
    return requeryOneGroup(groupId, rearmMetadata);
  }

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
      // discarded every page loaded past it, so a pick made further down the list
      // snapped it back to its original length — worse now that pages arrive by
      // scrolling, where a list that silently shortens just gets scrolled
      // again. The server says whether
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
   * Corrects a group's identity and display, and answers whether it saved —
   * `useIdentityChange`'s `apply`, not `MediaCard`'s `onEditGroup` (that is
   * `identityChange.begin`, wired in below). Named `applyEdit` rather than
   * `editGroup` for exactly that reason: this is one step of the plan →
   * confirm → apply sequence, not the whole of what happens when the user
   * clicks Edit.
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
   *
   * A stale `planDigest` answers 409 and is the one failure `confirm` retries
   * by re-planning (see `useIdentityChange`'s `ApplyOutcome` doc) — reporting
   * it through `setError` here as well would show a banner for a failure the
   * dialog is about to silently correct. Every other failure has no such
   * second chance, so it is reported and the dialog closes.
   */
  async function applyEdit(
    groupId: number,
    values: Record<string, string>,
    planDigest?: string,
  ): Promise<ApplyOutcome> {
    try {
      const { group, mergedInto, failed } = await api.editGroup(groupId, values, planDigest);
      setGroups((previous) => {
        const kept =
          mergedInto === null ? previous : previous.filter((existing) => existing.id !== groupId);
        return kept.map((existing) => (existing.id === group.id ? group : existing));
      });
      setNotice(mergedInto === null ? null : `Releases moved into ${group.display.title}`);
      // A save that landed but left files unmoved is not fully done — the
      // library sits in two layouts until a retry finishes the job, so this
      // has to be told apart from silence rather than folded into a plain
      // success.
      setError(
        failed.length === 0
          ? null
          : `Saved, but ${failed.length} file(s) could not be moved: ${failed
              .map((entry) => `${entry.path} (${entry.error})`)
              .join('; ')}`,
      );
      return { saved: true };
    } catch (cause) {
      setNotice(null);
      if (cause instanceof RequestError && cause.status === 409) return { saved: false, stale: true };
      setError((cause as Error).message);
      return { saved: false, stale: false };
    }
  }

  const identityChange = useIdentityChange(applyEdit, setError);

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
      {/*
        The same control Picks and Downloads render, but not the same job: this
        term goes to `/api/browse?q=` rather than filtering rows already in hand,
        because browse is paginated and the matches may be on pages nobody has
        loaded. Rebuilding `fetchPage` is what starts the list over — see the
        callback above, and `usePagedList`'s `generation` for how a page still in
        flight for the previous term is dropped rather than appended.
      */}
      <SearchBox label="Search groups" value={search} onChange={setSearch} />
      {notice !== null && <p className="notice">{notice}</p>}
      {error !== null && <p className="error">{error}</p>}
      {identityChange.plan !== null && (
        <IdentityChangeConfirm
          plan={identityChange.plan}
          onConfirm={() => void identityChange.confirm()}
          onCancel={identityChange.cancel}
          busy={identityChange.busy}
          stale={identityChange.stale}
        />
      )}

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
          onEditGroup={(values) => identityChange.begin(group.id, values)}
          onEditRelease={(releaseId, values) => editRelease(group.id, releaseId, values)}
          onRequeryMetadata={requeryMetadata}
        />
      ))}

      {!done && (
        <>
          {/* Coming into view is what asks for the next page. */}
          <div ref={sentinelRef} aria-hidden="true" />
          {loading && <p className="loading">Loading…</p>}
          {/*
            Kept, rather than replaced by the scrolling. An observer that never
            fires — a viewport too short to scroll, an odd zoom, a browser that
            reports nothing — would otherwise strand the reader with no way to
            ask for the rest, and it is the retry after a page that failed.
          */}
          <button type="button" onClick={loadMore} disabled={loading}>
            Load more
          </button>
        </>
      )}
    </section>
  );
}
