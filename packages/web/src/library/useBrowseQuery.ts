/**
 * The category page's filter and search, read from and written to the URL
 * (design spec 2026-10-02 §3.2): `?filter=unpicked&q=dune` on the category's path.
 *
 * `q` is what the operator typed and what the input shows; `term` is what
 * the catalog is asked for. Typing is debounced before the URL changes so
 * a keystroke does not write history (and `replace` so the ones that do
 * land do not stack). Clearing is immediate: an empty box should empty the
 * list without a pause. All-with-empty-q writes no params at all, so the
 * default URL stays bare.
 *
 * Changing the filter is immediate too, and it takes a pending keystroke
 * with it: the debounce timer is cancelled and the filter is written
 * together with the typed value, so neither is lost or delayed. The timer
 * itself reads the filter current when it fires, not the one in scope when
 * the key was pressed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { normalizeTerm, type PickedFilter } from '../store/catalog.ts';

export const SEARCH_DEBOUNCE_MS = 150;

/** `q` as typed (what the URL and the input hold); `term` is `normalizeTerm(q)`, what the catalog is asked for. */
export interface BrowseQuery {
  filter: PickedFilter;
  q: string;
  term: string;
}

export interface BrowseQueryControls {
  filter: PickedFilter;
  input: string;
  setFilter(f: PickedFilter): void;
  setInput(v: string): void;
}

export function parseFilter(raw: string | null): PickedFilter {
  return raw === 'picked' || raw === 'unpicked' ? raw : 'all';
}

function paramsFor(filter: PickedFilter, q: string): URLSearchParams {
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('filter', filter);
  if (q !== '') params.set('q', q);
  return params;
}

export function useBrowseQuery(): { query: BrowseQuery; controls: BrowseQueryControls } {
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get('filter'));
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The typed value the pending timer will write; meaningful only while `timer` is set. */
  const pendingQ = useRef('');
  const filterRef = useRef(filter);
  filterRef.current = filter;
  // The URL is the source of truth; a back/forward navigation re-seeds the box.
  useEffect(() => {
    setInput(q);
  }, [q]);
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );
  const write = useCallback(
    (nextFilter: PickedFilter, nextQ: string) => {
      setParams(paramsFor(nextFilter, nextQ), { replace: true });
    },
    [setParams],
  );
  const setFilter = useCallback(
    (f: PickedFilter) => {
      let nextQ = q;
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        timer.current = undefined;
        nextQ = pendingQ.current;
      }
      write(f, nextQ);
    },
    [write, q],
  );
  const setInputDebounced = useCallback(
    (value: string) => {
      setInput(value);
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
      if (value.trim() === '') {
        write(filterRef.current, '');
        return;
      }
      pendingQ.current = value;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        write(filterRef.current, value);
      }, SEARCH_DEBOUNCE_MS);
    },
    [write],
  );
  return {
    query: { filter, q, term: normalizeTerm(q) },
    controls: { filter, input, setFilter, setInput: setInputDebounced },
  };
}
