import { useState, type FormEvent, type ReactElement } from 'react';
import type { FetchHostPatch, FetchHostRead } from '@pickarr/contract';
import { FETCH_DEFAULT_HOST } from '@pickarr/contract';
import { useFetchHosts, type FetchHostsLoader } from './useFetchHosts.ts';
import { FETCH_REFUSAL_MESSAGES, type FetchHostSubmit } from './putFetchHost.ts';

const DEFAULT_LABEL = 'Any other host';

function Refusal({ message }: { message: string }): ReactElement {
  return (
    <div role="alert">
      <p>{message}</p>
    </div>
  );
}

/** What one row shows: the pinned value as a string, or `''` with the effective value as placeholder. */
interface Shown {
  readonly concurrency: string;
  readonly timeoutS: string;
  readonly concurrencyPlaceholder: string;
  readonly timeoutPlaceholder: string;
}

function shownFor(row: FetchHostRead, isDefault: boolean): Shown {
  const seconds = String(Math.round(row.timeoutMs / 1000));
  return {
    concurrency: isDefault || !row.inherited.concurrency ? String(row.concurrency) : '',
    timeoutS: isDefault || !row.inherited.timeoutMs ? seconds : '',
    concurrencyPlaceholder: String(row.concurrency),
    timeoutPlaceholder: seconds,
  };
}

/** `''` clears; otherwise a whole number, or `undefined` for anything else. */
function wholeNumber(text: string): number | null | undefined {
  if (text === '') return null;
  if (!/^\d+$/.test(text)) return undefined;
  return Number(text);
}

interface RowProps {
  row: FetchHostRead;
  /** Where the row sits in the list: element ids derive from it, so two hostnames can never share one. */
  index: number;
  isDefault: boolean;
  submit: FetchHostSubmit;
  onSaved: () => void;
}

/**
 * The key a row is rendered under: every server-side value it shows, so a
 * reload that changes any of them remounts the row with a fresh `draft`.
 * That remount is what clears the typed values after a save -- not the save
 * itself, which would show the old values until the reload arrived.
 */
function rowKey(row: FetchHostRead): string {
  return [
    row.hostname,
    String(row.concurrency),
    String(row.timeoutMs),
    String(row.inherited.concurrency),
    String(row.inherited.timeoutMs),
    String(row.configured),
  ].join(':');
}

function HostRow({ row, index, isDefault, submit, onSaved }: RowProps): ReactElement {
  const initial = shownFor(row, isDefault);
  const [draft, setDraft] = useState<{ concurrency?: string; timeoutS?: string }>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = isDefault ? DEFAULT_LABEL : row.hostname;
  const idPrefix = `fetch-host-${isDefault ? FETCH_DEFAULT_HOST : String(index)}`;
  const nameId = `${idPrefix}-name`;
  const concurrencyId = `${idPrefix}-concurrency`;
  const concurrencyLabelId = `${concurrencyId}-label`;
  const timeoutId = `${idPrefix}-timeout`;
  const timeoutLabelId = `${timeoutId}-label`;
  const saveId = `${idPrefix}-save`;
  const revertId = `${idPrefix}-revert`;

  const concurrency = draft.concurrency ?? initial.concurrency;
  const timeoutS = draft.timeoutS ?? initial.timeoutS;
  const changed = concurrency !== initial.concurrency || timeoutS !== initial.timeoutS;

  async function send(patch: FetchHostPatch): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const outcome = await submit(isDefault ? FETCH_DEFAULT_HOST : row.hostname, patch);
      if ('refusal' in outcome) {
        setError(FETCH_REFUSAL_MESSAGES[outcome.refusal]);
        return;
      }
      // The draft stays until the reload: the row then remounts under its
      // new `rowKey`, so the typed values show until the server's replace them.
      onSaved();
    } catch {
      setError(FETCH_REFUSAL_MESSAGES.offline);
    } finally {
      setPending(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const patch: { concurrency?: number | null; timeoutMs?: number | null } = {};
    if (draft.concurrency !== undefined) {
      const value = wholeNumber(draft.concurrency);
      if (value === undefined) { setError(FETCH_REFUSAL_MESSAGES['invalid-concurrency']); return; }
      patch.concurrency = value;
    }
    if (draft.timeoutS !== undefined) {
      const seconds = wholeNumber(draft.timeoutS);
      if (seconds === undefined) { setError(FETCH_REFUSAL_MESSAGES['invalid-timeout']); return; }
      patch.timeoutMs = seconds === null ? null : seconds * 1000;
    }
    if (isDefault) {
      if (patch.concurrency === null || patch.timeoutMs === null) {
        setError(FETCH_REFUSAL_MESSAGES['default-required']);
        return;
      }
      // The host refuses a default missing either field, so an untouched one
      // is sent as the server's own value -- not the rounded seconds shown,
      // which would rewrite a hand-edited 1500 ms as 2000.
      void send({ concurrency: patch.concurrency ?? row.concurrency, timeoutMs: patch.timeoutMs ?? row.timeoutMs });
      return;
    }
    void send(patch);
  }

  return (
    <li aria-labelledby={nameId}>
      <h3 id={nameId}>{label}</h3>
      <form onSubmit={save}>
        <div>
          <label id={concurrencyLabelId} htmlFor={concurrencyId}>In flight</label>
          <input
            id={concurrencyId}
            aria-labelledby={`${concurrencyLabelId} ${nameId}`}
            inputMode="numeric"
            value={concurrency}
            placeholder={initial.concurrencyPlaceholder}
            disabled={pending}
            onChange={(event) => { setDraft((d) => ({ ...d, concurrency: event.target.value })); }}
          />
        </div>
        <div>
          <label id={timeoutLabelId} htmlFor={timeoutId}>Timeout (s)</label>
          <input
            id={timeoutId}
            aria-labelledby={`${timeoutLabelId} ${nameId}`}
            inputMode="numeric"
            value={timeoutS}
            placeholder={initial.timeoutPlaceholder}
            disabled={pending}
            onChange={(event) => { setDraft((d) => ({ ...d, timeoutS: event.target.value })); }}
          />
        </div>
        <button type="submit" id={saveId} aria-labelledby={`${saveId} ${nameId}`} disabled={pending || !changed}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {!isDefault && row.configured ? (
          <button
            type="button"
            id={revertId}
            aria-labelledby={`${revertId} ${nameId}`}
            disabled={pending}
            onClick={() => { void send({ concurrency: null, timeoutMs: null }); }}
          >
            Revert to default
          </button>
        ) : null}
      </form>
      {error !== null && <Refusal message={error} />}
    </li>
  );
}

export interface FetchingProps {
  load: FetchHostsLoader;
  submit: FetchHostSubmit;
}

export function Fetching({ load, submit }: FetchingProps): ReactElement {
  const { data, error, reload } = useFetchHosts(load);
  const defaultRow: FetchHostRead | undefined = data === undefined
    ? undefined
    : { hostname: FETCH_DEFAULT_HOST, ...data.default, inherited: { concurrency: false, timeoutMs: false }, configured: true };
  return (
    <section aria-labelledby="fetching-heading">
      <h2 id="fetching-heading">Fetching</h2>
      <p>How many requests Pickarr makes to a host at once, and how long one may take. Blank fields inherit from Any other host.</p>
      {error !== null && <Refusal message={error} />}
      {data === undefined || defaultRow === undefined ? (
        error === null && <p>Loading…</p>
      ) : (
        <>
          <ul aria-label="Fetch hosts">
            <HostRow key={rowKey(defaultRow)} row={defaultRow} index={0} isDefault submit={submit} onSaved={reload} />
            {data.hosts.map((row, index) => (
              <HostRow key={rowKey(row)} row={row} index={index} isDefault={false} submit={submit} onSaved={reload} />
            ))}
          </ul>
          {data.hosts.length === 0 && <p>No hosts fetched yet</p>}
        </>
      )}
    </section>
  );
}
