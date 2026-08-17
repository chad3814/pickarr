import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { api, RequestError, type GroupView, type ManualField } from '../api/client.ts';
import { useGroupMetadata } from '../api/useGroupMetadata.ts';
import { useIdentityChange, type ApplyOutcome } from '../api/useIdentityChange.ts';
import { IdentityChangeConfirm } from '../components/IdentityChangeConfirm.tsx';
import { MediaCard } from '../components/MediaCard.tsx';

export function Picks() {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [fields, setFields] = useState<Record<string, ManualField[]>>({});
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
   * `MediaCard`'s Requery button, via `onRequeryMetadata` — the same split
   * between "call the server" and "re-arm the hook" that Browse's own
   * `requeryMetadata` has, for the same reason: this route holds both the
   * `api` client and `useGroupMetadata`'s handle, and the card holds neither.
   */
  async function requeryMetadata(groupId: number): Promise<void> {
    await api.requeryMetadata([groupId]);
    rearmMetadata(groupId);
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

  return (
    <section>
      <h1>Picks</h1>
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
          // `/api/picks` already carried — the same fallback Browse uses, for
          // the same reason: it is what lets the first paint show whatever
          // the last load already knew instead of every card flashing back to
          // "no metadata" the instant this hook takes over.
          group={{ ...group, metadata: liveMetadata.get(group.id) ?? group.metadata }}
          onPick={(releaseId) => void pick(group.id, releaseId)}
          // A plugin with no manual hooks is *missing* from this map, and a
          // group can outlive the package that made it; either way the card
          // finds no schema and offers no editing.
          fields={fields[group.plugin]}
          onEditGroup={(values) => identityChange.begin(group.id, values)}
          onEditRelease={(releaseId, values) => editRelease(releaseId, values)}
          onRequeryMetadata={requeryMetadata}
        />
      ))}
    </section>
  );
}
