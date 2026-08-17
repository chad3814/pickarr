import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type MetadataView } from './client.ts';

/**
 * How long to wait before the first poll, and the ceiling backoff grows
 * toward. Metadata is a background enhancement, not something the user is
 * staring at a spinner for, so this favours fewer requests over a snappy
 * first paint — unlike `useIdentityPreview`'s 200ms, which is answering a
 * keystroke.
 */
const START_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

/**
 * Both `/api/metadata/request` and `/api/metadata` cap at this many ids per
 * call (`MAX_PAGE_LIMIT` in `packages/core/src/http/server.ts`, mirrored here
 * because the web package does not import core). A page can outgrow it once
 * "Load more" has run a few times, so every call below chunks rather than
 * assuming the ids handed in fit in one request.
 */
const BATCH_LIMIT = 100;

/**
 * The floor under a server-driven sleep. `nextAttemptAt` is usually very
 * close to now — a group waiting behind others the worker hasn't reached yet
 * this tick, not one deferred for an outage — and without a floor that reads
 * as "poll again immediately", a hot loop once `next_at` is in the past by
 * even a millisecond. The worker's own default `intervalSeconds` is 5 (see
 * the README's `metadata.intervalSeconds`), so nothing this hook could learn
 * by asking again sooner than that has actually changed server-side; 5s is
 * the fastest polling can possibly be useful, not an arbitrary round number.
 */
const MIN_SERVER_DELAY_MS = 5_000;

/**
 * The ceiling on a server-driven sleep, independent of `MAX_DELAY_MS` (the
 * ceiling for the *ladder*, used only when the server gives no `next_at` to
 * trust). The worker's own per-row backoff caps at six hours
 * (`deferMetadata`'s caller), and sleeping that long in a live tab would mean
 * a poster that finally arrives, a server restart that resets in-memory
 * queue state, or a browser reload none of them get noticed until the tab is
 * closed and reopened. Five minutes bounds the staleness a still-open tab can
 * ever show without hammering anything: at most one request every five
 * minutes per still-pending page, forever, during the worst outage.
 */
const MAX_SERVER_DELAY_MS = 5 * 60_000;

function chunk(ids: readonly number[], size: number): number[][] {
  const batches: number[][] = [];
  for (let start = 0; start < ids.length; start += size) batches.push(ids.slice(start, start + size));
  return batches;
}

/**
 * How long to sleep before re-checking `ids`, all of which `found` reported
 * `pending` a moment ago — or `undefined` to say "trust none of this, fall
 * back to the escalating ladder instead".
 *
 * Every one of them needs a `nextAttemptAt` for this hook to trust the
 * server's clock at all — a mixed batch where even one id lacks it (talking
 * to a server that predates this field; see the note on `MetadataView`)
 * falls the *whole* poll back to the ladder, rather than trusting the ids
 * that do have one and guessing for the rest. A single page is one request
 * either way, so there is no way to sleep two different amounts for two ids
 * in it, and silently ignoring the ids with no answer would be worse than
 * the ladder this hook already had.
 *
 * Among ids that do carry it, the earliest `nextAttemptAt` wins, not an
 * average or the latest: any one of them becoming ready is news for that
 * card, and the whole point of reading the server's clock is to be
 * responsive to whichever group is closest to answered. Waiting for the
 * *slowest* of several pending ids would silently delay a card that could
 * have updated minutes sooner just because it happened to share a page load
 * with one deferred for hours.
 *
 * Ids `poll` is still chasing only because a rearm's answer hasn't changed
 * yet (see `rearmedSnapshots` below) are not `'pending'`, so this function
 * already skips them via the `state !== 'pending'` guard below exactly as it
 * would skip a `'confirmed'` id from any other batch — they fall back to the
 * escalating ladder on their own, which is right: they carry no
 * `nextAttemptAt` to trust, because the server never reports them as
 * anything but their last settled answer (see `requeueMetadata`'s own doc:
 * "the answer ... never changes" until the worker actually writes a new
 * one).
 */
function serverDelayFor(found: ReadonlyMap<number, MetadataView>, ids: readonly number[]): number | undefined {
  let earliest: number | undefined;
  for (const id of ids) {
    const view = found.get(id);
    if (view?.state !== 'pending') continue;
    if (view.nextAttemptAt === undefined) return undefined;
    earliest = earliest === undefined ? view.nextAttemptAt : Math.min(earliest, view.nextAttemptAt);
  }
  // `ids` is always the still-unresolved subset the caller just computed, so
  // `earliest` is only ever undefined if `ids` is empty (guarded by `poll`
  // before scheduling anything) or if none of them are genuinely `'pending'`
  // (the all-rearmed case). Both fall back to the ladder, which is correct.
  if (earliest === undefined) return undefined;
  return Math.min(Math.max(earliest - Date.now(), MIN_SERVER_DELAY_MS), MAX_SERVER_DELAY_MS);
}

/**
 * Where a view sits on the one axis that matters for deciding whether a new
 * one may replace it: `'confirmed'` and `'none'` are equally settled (a
 * fresh answer is free to swap between them — the provider revising "yes"
 * to "no" or back is not a regression), `'pending'` is partway there, and
 * `'absent'` is nothing at all.
 */
function rank(view: MetadataView): number {
  if (view.state === 'confirmed' || view.state === 'none') return 2;
  return view.state === 'pending' ? 1 : 0;
}

/** Structural equality for two `GET /api/metadata` answers about the same id. */
function sameMetadata(a: MetadataView, b: MetadataView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What `useGroupMetadata` hands back: the live answers, and the one way to ask it to watch an id again. */
export interface GroupMetadataHandle {
  metadata: Map<number, MetadataView>;
  /**
   * Tells this hook that something *outside* it (the Requery button, via
   * `POST /api/metadata/requery`) has asked the provider again about a
   * settled group this hook had already stopped watching, and it should
   * resume watching. See the doc on `rearm` itself, below, for how.
   */
  rearm(groupId: number): void;
}

/**
 * The provider's answer for every id the caller is currently asking about,
 * kept live by polling while any of them is still `pending` — or has been
 * `rearm`ed and has not yet shown a different answer than it had at the
 * moment of the rearm.
 *
 * One request per render of the id list, not one per card: the caller (Browse,
 * for one page at a time) collects the ids it actually rendered and hands them
 * here as a single array, and this hook is the only thing that ever calls
 * `POST /api/metadata/request` — never a per-card effect, which is the
 * side-effecting-GET shape this feature was built to avoid.
 *
 * The dependency below is the ids' content (`key`), not the array's identity:
 * a caller that rebuilds the array every render (Browse does) would otherwise
 * re-ask on every render that changed nothing about which groups are on
 * screen — the same reasoning `useIdentityPreview` gives for keying off
 * `JSON.stringify(values)` instead of `values` itself.
 */
export function useGroupMetadata(groupIds: readonly number[]): GroupMetadataHandle {
  // `metadataRef` mirrors `metadata` so the effect below can read the latest
  // known state without depending on it — depending on state that the effect
  // itself sets would either loop or need `key` alone to guard it, and the
  // ref is the simpler of the two.
  const metadataRef = useRef<Map<number, MetadataView>>(new Map());
  const [metadata, setMetadata] = useState<Map<number, MetadataView>>(metadataRef.current);
  // Ids already sent to `/api/metadata/request` in this hook's lifetime, so a
  // page that keeps some ids across renders while dropping or adding others
  // never re-asks the server to enqueue work it already asked for. The
  // enqueue is idempotent server-side regardless, so this is an optimization,
  // not a correctness requirement. Deliberately never touched by `rearm`: a
  // rearmed id asks again through `/api/metadata/requery` instead (the
  // caller's job, not this hook's), and re-sending `/api/metadata/request`
  // for an id already answered would do nothing but cost a request — the
  // route's own precondition is "settled", which is exactly what
  // `alreadyAnswered` already reports for it.
  const requestedRef = useRef<Set<number>>(new Set());
  // Every id currently `rearm`ed, mapped to the answer it had at the moment
  // of the rearm. An id stays in here for as long as its answer keeps
  // matching that snapshot — which is this hook's only way to tell "the
  // worker hasn't drained the requeued row yet" from "it has, and had
  // nothing new to say" when both look identical over the wire: a requery
  // never touches `group_metadata` (`requeueMetadata`'s own doc), so
  // `GET /api/metadata` keeps reporting the *old* settled answer, unchanged,
  // for exactly as long as that remains true. It leaves the map the moment
  // a poll sees a genuinely different answer (see `poll`'s `stillUnresolved`
  // below).
  const rearmedSnapshotsRef = useRef<Map<number, MetadataView>>(new Map());
  // Bumped by `rearm` to make the effect below re-run without changing `key`.
  // `groupIds` did not change — only this hook's own memory of one id's
  // resolution did — so `key` is the wrong lever to pull; a second state
  // variable dedicated to "something asked this effect to look again" is.
  const [generation, setGeneration] = useState(0);

  const key = groupIds.join(',');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Applies `found` to the shared map, except where doing so would
     * replace a more-settled answer with a less-settled one (`rank` above).
     * This is the hard invariant "never blank a card that already has an
     * answer" holds by construction on: ordinarily it is a no-op, because
     * `run`'s `unresolved` filter (below) never re-fetches an id this hook
     * already settled, so `commit` never even sees a downgrade for one in
     * the ordinary lazy-trigger path. It is not a no-op for a rearmed id,
     * which this hook *does* re-fetch on purpose — and for which the server
     * is documented to never actually answer with anything less settled
     * than what it already had (see `rearmedSnapshotsRef`'s doc) — so this
     * guard is defense against that documented contract changing under this
     * hook, not a workaround for a case that fires today.
     */
    function commit(found: ReadonlyMap<number, MetadataView>): void {
      const next = new Map(metadataRef.current);
      for (const [id, view] of found) {
        const current = next.get(id);
        if (current !== undefined && rank(current) > rank(view)) continue;
        next.set(id, view);
      }
      metadataRef.current = next;
      setMetadata(next);
    }

    async function fetchStates(ids: number[]): Promise<Map<number, MetadataView>> {
      const found = new Map<number, MetadataView>();
      for (const batch of chunk(ids, BATCH_LIMIT)) {
        const answer = await api.metadata(batch, controller.signal);
        for (const [idText, view] of Object.entries(answer)) found.set(Number(idText), view);
      }
      return found;
    }

    async function ensureRequested(ids: readonly number[]): Promise<void> {
      const unseen = ids.filter((id) => !requestedRef.current.has(id));
      for (const batch of chunk(unseen, BATCH_LIMIT)) {
        await api.requestMetadata(batch, controller.signal);
        for (const id of batch) requestedRef.current.add(id);
      }
    }

    async function poll(ids: number[], delay: number): Promise<void> {
      if (cancelled || ids.length === 0) return;
      let found: Map<number, MetadataView>;
      try {
        found = await fetchStates(ids);
      } catch {
        // Aborted on unmount, or a genuine network failure: either way there
        // is no channel for this hook to report through (its whole interface
        // is the map), and hammering a failing endpoint on a fixed backoff
        // would be worse than leaving the panel as "not shown yet".
        return;
      }
      if (cancelled) return;
      commit(found);

      // Still worth asking about again if the answer is genuinely `pending`,
      // or if it is a rearmed id whose answer still matches the snapshot
      // taken the moment it was rearmed — i.e. the requery has not yet
      // produced anything different. A view missing from `found` entirely
      // (should not happen; every id asked about gets an entry) is treated
      // as resolved, the same as the original ladder did implicitly by
      // reading `undefined?.state`.
      const stillUnresolved = ids.filter((id) => {
        const view = found.get(id);
        if (view === undefined) return false;
        if (view.state === 'pending') return true;
        const snapshot = rearmedSnapshotsRef.current.get(id);
        return snapshot !== undefined && sameMetadata(view, snapshot);
      });

      // Every id that resolved this round — genuinely for the first time, or
      // because a rearmed one's answer finally differs from its snapshot —
      // has nothing left to compare against, so its snapshot is dropped.
      // Left alone for anything still unresolved: a rearmed id's snapshot is
      // always the answer at the moment of the rearm, never a moving target
      // updated round to round, or "the worker hasn't answered yet" could
      // never be told apart from "it answered with the same thing again".
      for (const id of ids) {
        if (!stillUnresolved.includes(id)) rearmedSnapshotsRef.current.delete(id);
      }

      if (stillUnresolved.length === 0) return;

      const serverWait = serverDelayFor(found, stillUnresolved);
      if (serverWait !== undefined) {
        // Every still-unresolved id trusted the server's clock, so sleep to
        // roughly the earliest of them rather than guess. `delay` (the
        // ladder's own state) is threaded through unchanged rather than
        // advanced: the ladder is dormant while the server keeps answering
        // with a `nextAttemptAt`, so if some later response ever drops the
        // field, the ladder resumes from where it left off rather than from
        // wherever server-driven sleeps happened to leave a doubled value.
        timer = setTimeout(() => void poll(stillUnresolved, delay), serverWait);
        return;
      }

      const nextDelay = Math.min(delay * 2, MAX_DELAY_MS);
      timer = setTimeout(() => void poll(stillUnresolved, nextDelay), delay);
    }

    async function run(): Promise<void> {
      // Worth asking about again if this hook has never resolved it, if it
      // is still (or newly, via `rearm`) `pending`, or if it is rearmed and
      // has not yet shown a different answer. An id already `confirmed` or
      // `none` and *not* rearmed cannot change, and re-fetching it on every
      // unrelated change to the id list (a new page landing, a picked card
      // leaving) would turn "one request per page" back into "one request
      // per render" — the property this filter has always protected, now
      // shared with the rearm path via the same three-way check.
      const unresolved = groupIds.filter((id) => {
        const known = metadataRef.current.get(id);
        return known === undefined || known.state === 'pending' || rearmedSnapshotsRef.current.has(id);
      });
      if (unresolved.length === 0) return;
      try {
        await ensureRequested(unresolved);
      } catch {
        return;
      }
      if (cancelled) return;
      await poll(unresolved, START_DELAY_MS);
    }

    void run();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // `key` stands in for `groupIds`; see the doc comment above. `generation`
    // is `rearm`'s own lever (see its doc): bumping it re-runs this effect,
    // which re-enters `run()` and so re-derives `unresolved` with the newly
    // rearmed id included. Re-running does mean any *other* id still
    // genuinely `pending` at that exact moment has its in-flight fetch
    // aborted and its ladder restarted from `START_DELAY_MS` — a real, if
    // narrow, timing side effect of sharing one effect rather than running a
    // second poller (which the design this hook now serves specifically
    // rules out). It does not change which answer that other id eventually
    // settles on, only when the next of its own polls lands.
  }, [key, generation]);

  const rearm = useCallback((groupId: number): void => {
    const current = metadataRef.current.get(groupId);
    // Nothing to snapshot for an id this hook never resolved — `unresolved`
    // above already treats an absent id as needing a fetch, so bumping the
    // generation alone is enough to make `run` pick it up.
    if (current !== undefined) rearmedSnapshotsRef.current.set(groupId, current);
    setGeneration((previous) => previous + 1);
  }, []);

  return { metadata, rearm };
}
