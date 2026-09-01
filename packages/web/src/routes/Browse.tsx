import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  RequestError,
  type BrowseItem,
  type FailedItemView,
  type GroupView,
  type ManualFieldsResponse,
} from '../api/client.ts';
import { requeryOneGroup } from '../api/requeryMetadata.ts';
import { useGroupMetadata } from '../api/useGroupMetadata.ts';
import { usePagedList } from '../api/usePagedList.ts';
import { useIdentityChange, type ApplyOutcome } from '../api/useIdentityChange.ts';
import { readView, writeView, type BrowseView } from '../browseView.ts';
import { FailedCard } from '../components/FailedCard.tsx';
import { GroupList, matchesSelection, type BrowseSelection } from '../components/GroupList.tsx';
import { IdentityChangeConfirm } from '../components/IdentityChangeConfirm.tsx';
import { MediaCard } from '../components/MediaCard.tsx';
import { SearchBox } from '../components/SearchBox.tsx';
import { ViewToggle } from '../components/ViewToggle.tsx';

export function Browse() {
  const [fields, setFields] = useState<ManualFieldsResponse>({});
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<BrowseView>(readView);
  const [selection, setSelection] = useState<BrowseSelection | null>(null);

  // Rebuilt whenever the term changes, which is `usePagedList`'s signal to start
  // the list over from the first page.
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const page = await api.browse(cursor, search);
      return { items: page.items, nextCursor: page.nextCursor };
    },
    [search],
  );

  const { items, setItems, loading, done, loadMore, sentinelRef } = usePagedList(
    fetchPage,
    setError,
  );

  // The group half of `items`, in the same order they arrived — used only to
  // seed the metadata poll below. Both views render from `shown` (below),
  // which carries a failed row exactly where the server placed it and renders
  // each item by its own kind.
  const groups = useMemo(
    () => items.flatMap((item) => (item.kind === 'group' ? [item.group] : [])),
    [items],
  );

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
   * Every loaded item with the poll's answer folded into its group half — the
   * one list both views read from, in the order the server sent it. A failed
   * item carries no metadata and passes through unchanged.
   *
   * Merged here rather than per card, and that is the whole point. `groupTitle`
   * being one shared function only makes the master row and the detail pane
   * agree if they are handed the same *value*, and for a while they were not:
   * the card merged the live answer inline while `GroupList` got the raw list,
   * so a provider title arriving by poll — or by Requery, which arrives no
   * other way at all — moved the pane's heading and left the row's alone (spec
   * §5). Two places to keep in step is how that happened, so there is now one.
   *
   * The live answer where the poll has one, falling back to what browse
   * already carried (typically `absent`, since nothing has asked yet): the
   * fallback is what lets the very first paint show whatever the last page
   * load already knew, rather than every card flashing "no metadata" until the
   * hook's first request lands.
   *
   * `useGroupMetadata` is still asked about `groups`, not this: the ids are
   * the same either way, and depending on the merged list would make the hook's
   * own output an input to the array it keys off.
   */
  const shown = useMemo<BrowseItem[]>(
    () =>
      items.map((item) =>
        item.kind === 'group'
          ? {
              kind: 'group',
              group: { ...item.group, metadata: liveMetadata.get(item.group.id) ?? item.group.metadata },
            }
          : item,
      ),
    [items, liveMetadata],
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

  function chooseView(next: BrowseView): void {
    writeView(next);
    setView(next);
  }

  /**
   * One group's card, however it is being shown. Both views render this rather
   * than each composing the card's seven props, because two copies of a prop
   * list are two things to keep in step — and the pane and the list are meant
   * to show the same card, not similar ones.
   */
  function cardFor(group: GroupView) {
    return (
      <MediaCard
        // Prefixed against `failedCardFor`'s key below: a group and a failed
        // item can carry the same numeric id, since the two are minted from
        // separate tables, and both kinds can land as siblings in this list.
        key={`group-${group.id}`}
        // Already carrying the poll's answer: every caller passes a group out
        // of `shown`.
        group={group}
        onPick={(releaseId) => void pick(group.id, releaseId)}
        // A plugin with no manual hooks is *missing* from this map, and a
        // group can outlive the package that made it; either way the card
        // finds no schema and offers no editing.
        fields={fields[group.plugin]}
        onEditGroup={(values) => identityChange.begin(group.id, values)}
        onEditRelease={(releaseId, values) => editRelease(group.id, releaseId, values)}
        onRequeryMetadata={requeryMetadata}
      />
    );
  }

  /**
   * One refused name's card. The counterpart to `cardFor`, kept as a
   * separate function rather than folded into it because the two kinds share
   * no props: a failed item has no releases, no metadata and no identity to
   * edit, only a fix form and a dismissal.
   */
  function failedCardFor(item: FailedItemView) {
    return (
      <FailedCard
        key={`failed-${item.id}`}
        item={item}
        // A plugin with no manual hooks is *missing* from this map, and an
        // item whose feed has left configuration reports no plugin at all;
        // either way the card finds no schema and offers no editing.
        fields={fields[item.plugin]}
        onFix={(values) => void fix(item.id, values)}
        onDismiss={() => void dismiss(item.id)}
      />
    );
  }

  // The schemas are configuration, one map for every card on every page —
  // group cards and failed cards alike — so they are fetched once for the
  // screen rather than per row.
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
      setItems((previous) =>
        group === null
          ? previous.filter((existing) => !(existing.kind === 'group' && existing.group.id === groupId))
          : previous.map((existing) =>
              existing.kind === 'group' && existing.group.id === groupId
                ? { kind: 'group', group }
                : existing,
            ),
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
   * thing `fix`, below, reports when it joins an existing group.
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
      setItems((previous) => {
        const kept =
          mergedInto === null
            ? previous
            : previous.filter((existing) => !(existing.kind === 'group' && existing.group.id === groupId));
        return kept.map((existing) =>
          existing.kind === 'group' && existing.group.id === group.id
            ? { kind: 'group', group }
            : existing,
        );
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
      setItems((previous) =>
        group === null
          ? previous.filter((existing) => !(existing.kind === 'group' && existing.group.id === groupId))
          : previous.map((existing) =>
              existing.kind === 'group' && existing.group.id === group.id
                ? { kind: 'group', group }
                : existing,
            ),
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

  /**
   * Resolves a refused name into a group and drops its card from this list.
   *
   * The joined or new group is not inserted here: placing it correctly in a
   * keyset-ordered list means computing where the server would have put it,
   * which is the client re-deriving the server's ordering rule — the thing
   * this whole design keeps out of the client. The notice says where it went
   * instead; it shows up for real on the next page load, the same account a
   * merge gives when its target is not on a loaded page (see `applyEdit`'s
   * own doc).
   */
  async function fix(itemId: number, values: Record<string, string>): Promise<void> {
    try {
      const { group, joinedExisting } = await api.resolveFeedItem(itemId, values);
      setItems((previous) =>
        previous.filter((existing) => !(existing.kind === 'failed' && existing.item.id === itemId)),
      );
      setNotice(
        `${group.display.title} ${joinedExisting ? 'joined an existing group' : 'became a new group'}`,
      );
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  /**
   * Dismisses a refused name and drops its card unconditionally.
   *
   * Simpler than the old Failed tab's version, which had to choose between
   * dropping the row and flipping it to a `Dismissed` badge depending on a
   * "show dismissed" toggle this screen does not have: Browse shows only open
   * failures, so a dismissed one no longer belongs here at all.
   */
  async function dismiss(itemId: number): Promise<void> {
    try {
      await api.dismissFeedItem(itemId);
      setItems((previous) =>
        previous.filter((existing) => !(existing.kind === 'failed' && existing.item.id === itemId)),
      );
      setNotice(null);
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  // The pane derives its item from `shown` rather than holding a copy, so a
  // metadata answer, a pick or an edit reaches it the same way it reaches a
  // card: the route merges the update into the list and this re-derives.
  // `matchesSelection` compares both halves of the composite key — a bare id
  // lookup would hand the pane a group whenever a failed item happened to
  // share its numeric id with the one actually selected.
  const selectedItem =
    selection === null ? null : shown.find((item) => matchesSelection(item, selection)) ?? null;

  // A term that filters the selected row out — or a new term, which rebuilds
  // the list from page one — leaves a selection pointing at nothing. Clearing
  // is the honest outcome: the alternative is a pane showing a row the list
  // beside it says is not there. Two conditions, two different jobs:
  // `!loading` is for the page-in-flight case, where a term change has
  // emptied or is about to replace `shown` and the still-valid old selection
  // must survive until the new page actually lands; `selectedItem === null`
  // is for the filtered-out case, once loading has settled, where `shown` no
  // longer has the row at all. `shown.length > 0` used to stand in for the
  // first half and got the second one wrong: a term matching nothing leaves
  // `shown` at `[]` forever, so that guard suppressed the clear permanently
  // instead of just until the fetch landed (spec §4).
  useEffect(() => {
    if (selection !== null && !loading && selectedItem === null) setSelection(null);
  }, [selection, loading, selectedItem]);

  return (
    <section data-browse-view={view}>
      <h1>Browse</h1>
      {/*
        The same control Picks and Downloads render, but not the same job: this
        term goes to `/api/browse?q=` rather than filtering rows already in hand,
        because browse is paginated and the matches may be on pages nobody has
        loaded. Rebuilding `fetchPage` is what starts the list over — see the
        callback above, and `usePagedList`'s `generation` for how a page still in
        flight for the previous term is dropped rather than appended.
      */}
      <div className="browse-controls">
        <SearchBox label="Search groups" value={search} onChange={setSearch} />
        <ViewToggle view={view} onChange={chooseView} />
      </div>
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

      {view === 'list' ? (
        shown.map((item) => (item.kind === 'group' ? cardFor(item.group) : failedCardFor(item.item)))
      ) : (
        <div className="browse-split">
          <GroupList items={shown} selected={selection} onSelect={setSelection} />
          <div className="browse-detail">
            {selectedItem === null ? (
              <p className="browse-detail-empty">Select a group to see its releases.</p>
            ) : selectedItem.kind === 'group' ? (
              cardFor(selectedItem.group)
            ) : (
              failedCardFor(selectedItem.item)
            )}
          </div>
        </div>
      )}

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
