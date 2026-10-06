/**
 * The live view of the config file's `fetch` section, and the only thing
 * that writes it.
 *
 * `createHostFetch` (`./queue.ts`) asks `limitFor` and `timeoutFor` on
 * every request, so a save here is in force for the next request without a
 * restart. The in-memory view is replaced only after `handle.update`
 * resolves: a write that fails leaves the queue answering what is on disk,
 * which is also what the next boot will read.
 *
 * Resolution is per field: an entry's own value, then -- for the lookup
 * service's hostname alone -- the fallback `main.ts` always gave it, then
 * `default`. The fallback lives here rather than in the file so an install
 * that never touched the section has an empty section.
 */
import type { FetchHostPatch, FetchHostRead, FetchHostsRead, FetchPair, FetchRefusalCode } from '@pickarr/contract';
import {
  FETCH_CONCURRENCY_MAX,
  FETCH_CONCURRENCY_MIN,
  FETCH_DEFAULT_HOST,
  FETCH_TIMEOUT_MAX_MS,
  FETCH_TIMEOUT_MIN_MS,
} from '@pickarr/contract';
import type { ConfigHandle } from '../config/instance.ts';
import type { FetchConfig, FetchHostEntry } from '../config/schemas.ts';
import { isHostname } from './hostname.ts';

export interface FetchRefusal {
  readonly refusal: FetchRefusalCode;
}

export interface FetchSettings {
  limitFor(hostname: string): number;
  timeoutFor(hostname: string): number;
  /** The effective table: every configured hostname plus every one in `seen`, sorted. */
  read(seen: Iterable<string>): FetchHostsRead;
  saveDefault(patch: FetchHostPatch): Promise<FetchPair | FetchRefusal>;
  saveHost(hostname: string, patch: FetchHostPatch): Promise<FetchHostRead | FetchRefusal>;
}

function refuse(refusal: FetchRefusalCode): FetchRefusal {
  return { refusal };
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** `undefined` and `null` pass (absent and clear); a number must be an integer in range. */
function checkConcurrency(value: number | null | undefined): FetchRefusal | undefined {
  if (value === undefined || value === null) return undefined;
  return inRange(value, FETCH_CONCURRENCY_MIN, FETCH_CONCURRENCY_MAX) ? undefined : refuse('invalid-concurrency');
}

function checkTimeout(value: number | null | undefined): FetchRefusal | undefined {
  if (value === undefined || value === null) return undefined;
  return inRange(value, FETCH_TIMEOUT_MIN_MS, FETCH_TIMEOUT_MAX_MS) ? undefined : refuse('invalid-timeout');
}

/** The entry after `patch`: present replaces, absent keeps, `null` drops. Built by spread so no field is ever `undefined`. */
function patched(previous: FetchHostEntry, patch: FetchHostPatch): FetchHostEntry {
  const concurrency = patch.concurrency === undefined ? previous.concurrency : patch.concurrency ?? undefined;
  const timeoutMs = patch.timeoutMs === undefined ? previous.timeoutMs : patch.timeoutMs ?? undefined;
  return {
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

export function createFetchSettings(deps: {
  handle: ConfigHandle<FetchConfig>;
  lookupHostname: string;
  lookupFallback: FetchPair;
}): FetchSettings {
  let config: FetchConfig = deps.handle.current;

  function resolve(hostname: string): FetchHostRead {
    const entry = config.hosts[hostname];
    const fallback = hostname === deps.lookupHostname ? deps.lookupFallback : undefined;
    return {
      hostname,
      concurrency: entry?.concurrency ?? fallback?.concurrency ?? config.default.concurrency,
      timeoutMs: entry?.timeoutMs ?? fallback?.timeoutMs ?? config.default.timeoutMs,
      inherited: {
        concurrency: entry?.concurrency === undefined && fallback === undefined,
        timeoutMs: entry?.timeoutMs === undefined && fallback === undefined,
      },
      configured: entry !== undefined,
    };
  }

  // The tail of the save chain. `handle.update` serializes whole documents
  // but does not merge them, so each save must build its document from what
  // the previous save committed; otherwise two saves in flight both copy the
  // same `config` and the second write drops the first's change.
  let saves: Promise<unknown> = Promise.resolve();

  /** Runs `body` after every earlier save has settled. The chain advances even when `body` rejects; the caller still sees the rejection. */
  function serialized<T>(body: () => Promise<T>): Promise<T> {
    const run = saves.then(body);
    saves = run.then(() => undefined, () => undefined);
    return run;
  }

  async function write(next: FetchConfig): Promise<void> {
    await deps.handle.update(next);
    config = next;
  }

  return {
    limitFor: (hostname) => resolve(hostname).concurrency,
    timeoutFor: (hostname) => resolve(hostname).timeoutMs,

    read(seen) {
      const names = new Set<string>([...Object.keys(config.hosts), ...seen]);
      return {
        default: config.default,
        hosts: [...names].toSorted().map(resolve),
      };
    },

    async saveDefault(patch) {
      if (patch.concurrency === undefined || patch.concurrency === null
        || patch.timeoutMs === undefined || patch.timeoutMs === null) {
        return refuse('default-required');
      }
      const refused = checkConcurrency(patch.concurrency) ?? checkTimeout(patch.timeoutMs);
      if (refused !== undefined) return refused;
      const pair: FetchPair = { concurrency: patch.concurrency, timeoutMs: patch.timeoutMs };
      return serialized(async () => {
        await write({ default: pair, hosts: config.hosts });
        return pair;
      });
    },

    async saveHost(hostname, patch) {
      if (hostname === FETCH_DEFAULT_HOST || !isHostname(hostname)) return refuse('invalid-hostname');
      const refused = checkConcurrency(patch.concurrency) ?? checkTimeout(patch.timeoutMs);
      if (refused !== undefined) return refused;

      return serialized(async () => {
        const previous = config.hosts[hostname];
        const entry = patched(previous ?? {}, patch);
        const hosts: Record<string, FetchHostEntry> = { ...config.hosts };
        if (Object.keys(entry).length === 0) delete hosts[hostname];
        else hosts[hostname] = entry;

        // An unconfigured host patched with nothing has nothing to write.
        // Any other patch writes the document, even one that leaves it
        // identical (a configured host patched with `{}`).
        const unchanged = previous === undefined && Object.keys(entry).length === 0;
        if (!unchanged) await write({ default: config.default, hosts });
        return resolve(hostname);
      });
    },
  };
}
