import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import {
  api,
  RequestError,
  type DownloadView,
  type GroupView,
  type ManualField,
  type ReleaseDownloadView,
  type ReleaseView,
  type UntrackedEntry,
} from '../api/client.ts';
import { requeryOneGroup } from '../api/requeryMetadata.ts';
import { groupSearchText, matchesTerm } from '../api/search.ts';
import { useGroupDownloads } from '../api/useGroupDownloads.ts';
import { useGroupMetadata } from '../api/useGroupMetadata.ts';
import { useIdentityChange, type ApplyOutcome } from '../api/useIdentityChange.ts';
import { IdentityChangeConfirm } from '../components/IdentityChangeConfirm.tsx';
import { MediaCard } from '../components/MediaCard.tsx';
import { SearchBox } from '../components/SearchBox.tsx';

/**
 * `group.releases`, with each release's download live over static — the
 * release-level counterpart to `liveMetadata.get(group.id) ?? group.metadata`
 * below. `watched` only asks `useGroupDownloads` about a bounded set of
 * groups, so `liveDownloads.get(group.id)` is `undefined` for every group not
 * on that list, and every release in it falls back to whatever `/api/picks`
 * already said — the same fallback shape, one level deeper.
 */
function mergedReleases(
  group: GroupView,
  liveDownloads: Map<number, Map<number, ReleaseDownloadView>>,
): ReleaseView[] {
  const live = liveDownloads.get(group.id);
  if (live === undefined) return group.releases;
  return group.releases.map((release) => {
    const download = live.get(release.id);
    return download === undefined ? release : { ...release, download };
  });
}

/**
 * `updated`'s status, in the shape `release.download` carries. Mirrors
 * `useGroupDownloads`'s own `patch` (`downloadId`/`status`/`error`/
 * `absentSince`, nothing else), because both places are turning the same
 * `DownloadView` into the same `ReleaseDownloadView`.
 */
function releaseDownloadOf(updated: DownloadView): ReleaseDownloadView {
  return {
    downloadId: updated.id,
    status: updated.status,
    error: updated.error,
    absentSince: updated.absentSince,
  };
}

/**
 * Whether `seed` (whatever `groups` currently holds for a release) already
 * says what `live` (the poll's latest answer) says. Field-by-field rather
 * than `===`, because the two are never the same object — `live` comes from
 * `useGroupDownloads`'s map, `seed` from `/api/picks` or an earlier write —
 * and the write-back effect below needs this to be true once it has already
 * copied `live` in, or it would keep copying an unchanged value in on every
 * poll tick forever.
 */
function sameDownload(seed: ReleaseDownloadView | undefined, live: ReleaseDownloadView): boolean {
  return (
    seed !== undefined &&
    seed.downloadId === live.downloadId &&
    seed.status === live.status &&
    seed.error === live.error &&
    seed.absentSince === live.absentSince
  );
}

export function Picks() {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [fields, setFields] = useState<Record<string, ManualField[]>>({});
  const [untracked, setUntracked] = useState<UntrackedEntry[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { hash } = useLocation();
  const landed = useRef<string | null>(null);

  // Every group `/api/picks` returned, not a page of them — the route has no
  // "Load more", it answers everything picked in one response. That can
  // outgrow the 100-id cap `POST /api/metadata/request` and `GET
  // /api/metadata` share (see the hook's own comment), which is exactly why
  // the hook chunks internally rather than assuming its caller's list fits in
  // one request.
  const { metadata: liveMetadata, rearm: rearmMetadata } = useGroupMetadata(
    groups.map((group) => group.id),
  );

  /**
   * The groups worth polling: those whose static payload shows a download that is
   * neither `imported` nor `failed`.
   *
   * Bounded deliberately. Watching every picked group would be one request per
   * hundred of them every three seconds for a library where almost nothing is
   * downloading; this is normally one request per tick, which is what the screen
   * this replaces cost.
   *
   * The cost is that a download created in another tab is not noticed until this
   * screen reloads — the static payload is what seeds this list. `pickRelease`
   * has one caller, so a download only ever starts from a human clicking Pick
   * somewhere, and a click *here* already runs `reload()`.
   */
  const watched = groups
    .filter((group) =>
      group.releases.some(
        (release) =>
          release.download !== undefined &&
          release.download.status !== 'imported' &&
          release.download.status !== 'failed',
      ),
    )
    .map((group) => group.id);

  const { downloads: liveDownloads, patch: patchDownload } = useGroupDownloads(watched);

  /**
   * Folds a settled download (`imported` or `failed`) from the poll's own
   * answer back into `groups`, symmetric with what `retry()` below already
   * does for a retried one. Without this, `watched` above never drops a
   * group on its own: it is derived from `groups`, and nothing wrote the
   * poll's results back into `groups` before this effect existed, so a
   * download that settles purely through the reconcile loop's own tick — no
   * pick, no edit, no retry in between — left its group in `watched`
   * forever, polled every `POLL_MS` for a screen with nothing left to learn
   * about it. The display was never wrong, because `mergedReleases` always
   * prefers `liveDownloads` over `groups` — which is exactly how this could
   * go unnoticed: nothing a test asserts on by reading the screen can tell
   * the difference.
   *
   * Only a settled status is copied in. A non-terminal one needs no write:
   * `watched` already includes the group on the strength of `groups` alone,
   * and `mergedReleases` already shows the fresher value from `liveDownloads`
   * — copying it into `groups` too would just be doing `retry()`'s job with
   * no retry to justify it.
   *
   * `setGroups` runs in the functional form and returns the same `previous`
   * reference — not an equal-by-value copy — whenever nothing changed.
   * `liveDownloads` is a new `Map` on every poll tick regardless of whether
   * its contents moved (`useGroupDownloads`'s poll always replaces its whole
   * map), so this effect reruns every `POLL_MS` either way; returning
   * `previous` is what stops a tick that changed nothing from becoming a
   * `groups` update, a re-render, and therefore a reason for this effect —
   * and everything downstream of `groups` — to run again outside its own
   * `POLL_MS` cadence.
   */
  useEffect(() => {
    setGroups((previous) => {
      let changed = false;
      const next = previous.map((group) => {
        const live = liveDownloads.get(group.id);
        if (live === undefined) return group;
        let groupChanged = false;
        const releases = group.releases.map((release) => {
          const download = live.get(release.id);
          if (
            download === undefined ||
            (download.status !== 'imported' && download.status !== 'failed') ||
            sameDownload(release.download, download)
          ) {
            return release;
          }
          groupChanged = true;
          return { ...release, download };
        });
        if (!groupChanged) return group;
        changed = true;
        return { ...group, releases };
      });
      return changed ? next : previous;
    });
  }, [liveDownloads]);

  /**
   * `MediaCard`'s Requery button, via `onRequeryMetadata` — the same split
   * between "call the server" and "re-arm the hook" that Browse's own
   * `requeryMetadata` has, for the same reason: this route holds both the
   * `api` client and `useGroupMetadata`'s handle, and the card holds neither.
   * Literally the same implementation, too: this was a verbatim copy of
   * Browse's callback until `requeryOneGroup` became the one place it lives.
   */
  function requeryMetadata(groupId: number): Promise<void> {
    return requeryOneGroup(groupId, rearmMetadata);
  }

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

  // The schemas are configuration, one map for the whole screen, fetched once
  // rather than per card — the same reason Browse fetches it once for its
  // list. Picks had never needed this before: it offered no editing at all
  // until this change, which is exactly why a picked group whose identity
  // belonged to another group was unreachable — Browse only lists groups
  // still `state = 'new'` or flagged for upgrade.
  useEffect(() => {
    void (async () => {
      try {
        setFields(await api.manualFields());
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  /**
   * The download client's own queue, once on mount — this is `Downloads.tsx`'s
   * old poll narrowed to the one call this screen still needs.
   *
   * `api.downloads(null)` answers `{ tracked, untracked }` and `tracked` is
   * discarded here on purpose: the server sends the client's whole live queue
   * on every page rather than a slice (see `DownloadsResponse`'s own doc), so
   * one call already gets all of it, and standing up a second route to answer
   * one list on one screen is not worth what it would cost to add. Every
   * *tracked* download this screen cares about already arrives through
   * `useGroupDownloads` above, keyed by the group it belongs to.
   *
   * Not refreshed by that poll, or any poll of its own, unlike the rest of
   * this screen. `useGroupDownloads` asks `/api/downloads/for-groups`, and an
   * untracked entry has no group to be keyed by — it is not one of this
   * screen's picks, only a job on the client Pickarr never issued — so it does
   * not fit that endpoint's shape and there is nothing else here to poll it
   * with. The list is exactly as fresh as the page load that fetched it.
   */
  useEffect(() => {
    void (async () => {
      try {
        const { untracked: fetched } = await api.downloads(null);
        setUntracked(fetched);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
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

  /**
   * Resubmits a release's download. Patched into `useGroupDownloads` from the
   * retry's own response rather than reloaded: `reload()` refetches every
   * picked group's releases and metadata, which is a whole screen's worth of
   * work to learn one row — the same reasoning `Downloads.tsx`'s own `retry`
   * gives for patching rather than refetching. The next poll confirms it, or
   * corrects it if the reconcile loop disagrees.
   *
   * `groups` is patched too, not only the hook's own map. `watched` (above)
   * is derived from `groups`, so a retried `failed` download — the case
   * Retry exists for — has to leave `groups` saying something other than
   * `failed`, or `watched` still excludes its group next render exactly as
   * it did before the click: with another group already watched, the next
   * poll would replace the hook's whole map for the *watched* ids only and
   * wipe this patch straight back out; with nothing else watched, the poll
   * never starts at all and the patch would freeze forever instead of
   * reflecting real progress. Writing the response into `groups` is what
   * lets `watched` pick the retried group back up on its own merits — a
   * freshly-`queued` download is genuinely non-terminal — rather than
   * widening the filter to keep `failed` rows watched forever, which would
   * poll every dead download in the library on every tick.
   *
   * A rejection here used to go nowhere on Downloads before that screen's own
   * `retry` grew a catch; this one has it from the start, so a refused retry
   * (409 on a row no longer `failed`, a 404, a dropped connection) surfaces in
   * the same error paragraph every other failure on this screen does, rather
   * than leaving the button looking like it did nothing.
   */
  async function retry(downloadId: number): Promise<void> {
    try {
      const updated = await api.retry(downloadId);
      patchDownload(updated);
      setGroups((previous) =>
        previous.map((group) =>
          group.id !== updated.groupId
            ? group
            : {
                ...group,
                releases: group.releases.map((release) =>
                  release.id !== updated.releaseId
                    ? release
                    : { ...release, download: releaseDownloadOf(updated) },
                ),
              },
        ),
      );
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  /**
   * Reloads rather than patching the list, unlike Browse. A merge can take a
   * group off Picks entirely — when the survivor holds no pick — or bring one
   * onto it, and which list a group belongs to is the server's answer to
   * give, not one to reconstruct on the client.
   *
   * The `RequestError`/409 check is `useIdentityChange`'s own contract for
   * `apply` (see that hook's `ApplyOutcome` doc): only a stale `planDigest`
   * should send the dialog back for a fresh plan, and that is a 409
   * specifically — every other failure, a 400 from a plugin or a 500, is
   * reported here and closes the dialog instead of looping it.
   */
  async function applyEdit(
    groupId: number,
    values: Record<string, string>,
    planDigest?: string,
  ): Promise<ApplyOutcome> {
    try {
      const { failed } = await api.editGroup(groupId, values, planDigest);
      await reload();
      // A save that landed but left files unmoved is not fully done — the
      // library sits in two layouts until a retry finishes the job, so this
      // has to be told apart from silence, not folded into a plain success.
      setError(
        failed.length === 0
          ? null
          : `Saved, but ${failed.length} file(s) could not be moved: ${failed
              .map((entry) => `${entry.path} (${entry.error})`)
              .join('; ')}`,
      );
      return { saved: true };
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 409) return { saved: false, stale: true };
      setError((cause as Error).message);
      return { saved: false, stale: false };
    }
  }

  const identityChange = useIdentityChange(applyEdit, setError);

  /**
   * Reloads rather than patching, for the same reason `applyEdit` does:
   * rescoring a release can take the group's upgrade flag away, and whether
   * that leaves the group on Picks at all is the server's answer to give.
   */
  async function editRelease(releaseId: number, values: Record<string, string>): Promise<boolean> {
    try {
      await api.editRelease(releaseId, values);
      await reload();
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    }
  }

  /**
   * The cards the box leaves on screen.
   *
   * Filtered here rather than by asking the server: `/api/picks` answers
   * everything picked in one response — it has no cursor and no page — so there
   * is nothing off-screen for a term to reach, and a request per keystroke would
   * buy only latency. `groupSearchText` is what keeps the answer the same one
   * `/api/browse?q=` would give for the term (see its doc), and `matchesTerm` is
   * a plain substring test rather than a copy of that route's unescaped LIKE
   * (issue #32).
   *
   * Derived on each render rather than kept in state, so the term and the list
   * cannot drift apart: every reload — after a pick, an edit, a merge — replaces
   * `groups` wholesale, and a stored filtered copy would need re-deriving at
   * each of those call sites or would quietly go stale at whichever one forgot.
   *
   * `groups`, not this, is what `useGroupMetadata` above is handed: a card the
   * term is currently hiding is still one the reader will bring back by clearing
   * the box, and abandoning its pending answer — or re-asking for a narrowed
   * list on every keystroke — is not worth the requests it saves. For the same
   * reason the landing effect keeps looking at `groups`: whether the DOM holds
   * the card a `#group-N` link names is a question about what rendered, and the
   * effect already answers it by finding the element or giving up until a render
   * where it exists.
   */
  const shown = groups.filter((group) => matchesTerm(search, groupSearchText(group.display)));

  /**
   * A download matches on its title elsewhere on this screen (each card reads
   * its own release's status); an untracked entry has no release to attach to,
   * so it matches on its name instead — the only headline text it has, and the
   * only part of it a reader would think to type. Re-homed verbatim from
   * `Downloads.tsx`'s own `visibleUntracked`.
   */
  const visibleUntracked = untracked.filter((entry) => matchesTerm(search, entry.name));

  return (
    <section>
      <h1>Picks</h1>
      <SearchBox label="Search picks" value={search} onChange={setSearch} />
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
      {shown.map((group) => (
        <MediaCard
          key={group.id}
          // The live answer once the poll has one, falling back to what
          // `/api/picks` already carried — the same fallback Browse uses, for
          // the same reason: it is what lets the first paint show whatever
          // the last load already knew instead of every card flashing back to
          // "no metadata" the instant this hook takes over.
          group={{
            ...group,
            metadata: liveMetadata.get(group.id) ?? group.metadata,
            releases: mergedReleases(group, liveDownloads),
          }}
          onPick={(releaseId) => void pick(group.id, releaseId)}
          // A plugin with no manual hooks is *missing* from this map, and a
          // group can outlive the package that made it; either way the card
          // finds no schema and offers no editing.
          fields={fields[group.plugin]}
          onEditGroup={(values) => identityChange.begin(group.id, values)}
          onEditRelease={(releaseId, values) => editRelease(releaseId, values)}
          onRequeryMetadata={requeryMetadata}
          onRetry={(downloadId) => void retry(downloadId)}
        />
      ))}

      {/*
        The heading goes with the rows it labels, carried across verbatim from
        `Downloads.tsx`. It is the whole of what says these downloads are not
        Pickarr's, so leaving it standing over an empty list once a term has
        excluded every one of them would read as Pickarr having lost track of
        something.
      */}
      {visibleUntracked.length > 0 && (
        <>
          <h2>Not managed by Pickarr</h2>
          <ul className="downloads untracked">
            {/*
              Keyed on the client *and* the ref, carried across verbatim from
              `Downloads.tsx`. A `ref` is the download client's own id for a
              job and is unique only within that client, so with more than one
              configured (#34) two entries can arrive carrying the same one.
              React's answer to a duplicate key is that children "may be
              duplicated and/or omitted" and that the behaviour could change —
              not something to leave a list that re-renders from a poll every
              three seconds resting on.
            */}
            {visibleUntracked.map((entry) => (
              <li key={`${entry.clientId}:${entry.ref}`} className="download-row untracked">
                <span className="download-title">{entry.name}</span>
                <span className="download-status">{entry.state}</span>
                {entry.percentage !== null && <span>{entry.percentage}%</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
