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
  isDefault: boolean;
  submit: FetchHostSubmit;
  onSaved: () => void;
}

function HostRow({ row, isDefault, submit, onSaved }: RowProps): ReactElement {
  const initial = shownFor(row, isDefault);
  const [draft, setDraft] = useState<{ concurrency?: string; timeoutS?: string }>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = isDefault ? DEFAULT_LABEL : row.hostname;
  const idPrefix = `fetch-host-${isDefault ? FETCH_DEFAULT_HOST : row.hostname.replaceAll('.', '-')}`;
  const nameId = `${idPrefix}-name`;
  const concurrencyId = `${idPrefix}-concurrency`;
  const timeoutId = `${idPrefix}-timeout`;
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
      setDraft({});
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
    if (isDefault && (patch.concurrency === null || patch.timeoutMs === null)) {
      setError(FETCH_REFUSAL_MESSAGES['default-required']);
      return;
    }
    void send(patch);
  }

  return (
    <li aria-labelledby={nameId}>
      <h3 id={nameId}>{label}</h3>
      <form onSubmit={save}>
        <div>
          <label htmlFor={concurrencyId}>In flight</label>
          <input
            id={concurrencyId}
            inputMode="numeric"
            value={concurrency}
            placeholder={initial.concurrencyPlaceholder}
            disabled={pending}
            onChange={(event) => { setDraft((d) => ({ ...d, concurrency: event.target.value })); }}
          />
        </div>
        <div>
          <label htmlFor={timeoutId}>Timeout (s)</label>
          <input
            id={timeoutId}
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
  return (
    <section aria-labelledby="fetching-heading">
      <h2 id="fetching-heading">Fetching</h2>
      <p>How many requests Pickarr makes to a host at once, and how long one may take. Blank fields inherit from Any other host.</p>
      {error !== null && <Refusal message={error} />}
      {data === undefined ? (
        <p>Loading…</p>
      ) : (
        <>
          <ul aria-label="Fetch hosts">
            <HostRow
              key={FETCH_DEFAULT_HOST}
              isDefault
              row={{ hostname: FETCH_DEFAULT_HOST, ...data.default, inherited: { concurrency: false, timeoutMs: false }, configured: true }}
              submit={submit}
              onSaved={reload}
            />
            {data.hosts.map((row) => (
              <HostRow key={`${row.hostname}:${String(row.concurrency)}:${String(row.timeoutMs)}:${String(row.configured)}`} row={row} isDefault={false} submit={submit} onSaved={reload} />
            ))}
          </ul>
          {data.hosts.length === 0 && <p>No hosts fetched yet</p>}
        </>
      )}
    </section>
  );
}
