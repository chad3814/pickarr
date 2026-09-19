/**
 * The add-feed form: the host's first write surface (design spec
 * `2026-09-18-feed-settings-design.md`, whole doc).
 *
 * **`submit` is a required prop, not defaulted to the real one.** A default
 * that performs network I/O would be invisible at the call site -- a future
 * test that forgets the prop would silently get a real `fetch` under
 * jsdom, which hangs rather than fails, with nothing pointing at the
 * missing prop. {@link postFeed} below is the real implementation;
 * `shell/Shell.tsx` wires it in explicitly.
 *
 * **`pluginId` offers `CATEGORIES`, the same three ids the shell's nav
 * uses, and the host stays the authority on whether one is registered**
 * (design spec §4, §6). This select only narrows what a person can *try* --
 * `feeds/add.ts`'s `addFeed` (`packages/host`) is what actually checks a
 * `pluginId` against the host's registered plugins, and a value this select
 * never offered can still come back refused. Registering a fourth plugin
 * means adding it to `CATEGORIES` (`shell/useCounts.ts`); there is no
 * endpoint that would let this form discover one on its own.
 *
 * **The poll-interval bounds and the two download types guide the operator;
 * they are not a second copy of the host's validation.** `feeds/add.ts`
 * owns `MIN_POLL_INTERVAL_S`/`MAX_POLL_INTERVAL_S` and the `torrent`/`nzb`
 * pair, and `packages/web` cannot import that package -- it is the server
 * side of the wire (`store/wire.ts`'s own doc on why `SyncOp` is mirrored
 * rather than imported gives the identical reason). The constants below are
 * mirrored, not shared: they steer the `<input>`/`<select>` toward a value
 * the host will accept, but a value outside them still reaches `submit` and
 * comes back as `bad-poll-interval` or `bad-download-type` rather than
 * being blocked here -- the host's check is the one that counts.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { CATEGORIES } from '../shell/useCounts.ts';

/** Mirrors `packages/host/src/feeds/add.ts`'s own bounds -- see this file's docblock on why mirrored rather than imported. */
const MIN_POLL_INTERVAL_S = 60;
const MAX_POLL_INTERVAL_S = 86_400;
const DEFAULT_POLL_INTERVAL_S = 300;

/** Mirrors `feeds/add.ts`'s own `TRANSPORTS`. */
const DOWNLOAD_TYPES: readonly string[] = ['torrent', 'nzb'];
const DEFAULT_DOWNLOAD_TYPE = 'torrent';

/**
 * The wire shape `POST /api/feeds` needs -- mirrored from
 * `packages/host/src/feeds/add.ts`'s own `AddFeedInput` rather than
 * imported: this package ships to a browser and only needs to agree with
 * the host on the JSON shape that crosses the wire, not on a shared module
 * (`store/wire.ts`'s `SyncOp` doc gives the identical reasoning).
 */
export interface AddFeedInput {
  pluginId: string;
  name: string;
  url: string;
  downloadType: string;
  pollIntervalS: number;
}

/** Mirrors `feeds/add.ts`'s own `AddFeedRefusal`. */
export interface AddFeedRefusal {
  refusal: 'unknown-plugin' | 'duplicate-url' | 'bad-download-type' | 'bad-poll-interval';
}

/**
 * What `submit` resolves to.
 *
 * `offline` is this client's own outcome for a rejected `fetch` -- never a
 * server answer -- which is what keeps "no answer" distinguishable from
 * "refused" (design spec §4): an offline submit that read as "already on
 * file" would send the operator hunting for a feed that is not there.
 *
 * **`unrecognised` is a normal outcome, not a should-not-happen one**
 * (fix round 1, review-found). `POST /api/feeds` has two permanent response
 * shapes: `{ refusal }` for a duplicate url, an unregistered plugin, a bad
 * download type, a bad poll interval, and now the two shape-check refusals
 * (`invalid-shape`, `malformed-body`); and a bare `{ error }` with no
 * `refusal` key at all for a 401 (an expired session -- the single most
 * ordinary failure a real submit meets), a 405, a 413, or a 500. A client
 * this old will routinely outlive a host that has added a refusal code this
 * build does not know, or answer with a body this build cannot parse at
 * all -- neither is a defect in either side, so neither may crash this
 * form. `unrecognised` covers both: any answer that is not a recognised
 * accepted id and not one of `AddFeedRefusal`'s four known codes.
 */
export type AddFeedOutcome = { id: number } | AddFeedRefusal | { refusal: 'offline' | 'unrecognised' };

const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'unknown-plugin',
  'duplicate-url',
  'bad-download-type',
  'bad-poll-interval',
]);

function isRefusalCode(value: unknown): value is AddFeedRefusal['refusal'] {
  return typeof value === 'string' && REFUSAL_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The real `submit`: posts to `POST /api/feeds` and reads only what that
 * route's contract promises to carry.
 *
 * **Branches on the body's `refusal` field, never on the HTTP status**
 * (design spec §2.2) -- the status mapping is under review and may change;
 * the refusal codes are the stable contract. `response.status` is never
 * read here.
 *
 * `credentials: 'same-origin'` puts whatever session cookie the browser
 * already holds on the request; this function never reads, stores or
 * forwards the token itself (Global Constraint, matching
 * `auth/session.ts`'s own `postAuth`).
 *
 * A rejected `fetch` -- offline, DNS, a reset connection -- and a body that
 * fails to parse as JSON both answer `{ refusal: 'offline' }`: neither is a
 * server answer, so neither may be reported as a refusal, which would read
 * as "your feed was rejected" when nothing rejected it.
 *
 * **Never throws** (fix round 1, review-found: it did, and the five of six
 * real host answers that are not `{ id }` and not one of `AddFeedRefusal`'s
 * four codes -- a 401, this tree's 400, either landing 400, a 500 --
 * wedged the form with the submit button stuck disabled and nothing on
 * screen, because the throw escaped `handleSubmit`'s un-caught `await` and
 * `setPending(false)` never ran). A body that parses but matches neither an
 * accepted id nor a known refusal resolves to `{ refusal: 'unrecognised' }`
 * instead -- see `AddFeedOutcome`'s own doc on why this is a normal
 * outcome, not a should-not-happen one. Never reads `error` or any other
 * field a body might carry beyond `id`/`refusal` -- a server-authored
 * message never reaches a human here (Global Constraint).
 */
export async function postFeed(input: AddFeedInput): Promise<AddFeedOutcome> {
  let body: unknown;
  try {
    const response = await fetch('/api/feeds', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    body = await response.json();
  } catch {
    return { refusal: 'offline' };
  }
  if (isRecord(body) && typeof body.id === 'number') return { id: body.id };
  if (isRecord(body) && isRefusalCode(body.refusal)) return { refusal: body.refusal };
  return { refusal: 'unrecognised' };
}

/**
 * A fixed sentence per non-accepted outcome -- never the server's own words
 * (Global Constraint). One map covers all five, `offline` and
 * `unrecognised` included, so `handleSubmit` below has no special case to
 * get wrong between them.
 */
const REFUSAL_MESSAGES: Record<AddFeedRefusal['refusal'] | 'offline' | 'unrecognised', string> = {
  'duplicate-url': 'That url is already on file.',
  'unknown-plugin': 'That plugin is not registered on this host.',
  'bad-download-type': 'That download type is not supported.',
  'bad-poll-interval': 'That poll interval is out of range.',
  /** Distinct from every named refusal above, which are answers -- this one means the request never got one. */
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  /** `postFeed`'s own catch-all -- see `AddFeedOutcome`'s doc on why this is a normal outcome. Names no code, no status: those are exactly the server-authored detail the Global Constraint forbids rendering. */
  unrecognised: 'Pickarr refused this feed, but did not say why. The host may be a different version than this page expects -- reload and try again.',
};

export interface AddFeedProps {
  /** Posts the form. Required, not defaulted -- see this file's docblock. */
  submit: (input: AddFeedInput) => Promise<AddFeedOutcome>;
}

export function AddFeed({ submit }: AddFeedProps): ReactElement {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [pluginId, setPluginId] = useState<string>(CATEGORIES[0] ?? 'tv');
  const [downloadType, setDownloadType] = useState(DEFAULT_DOWNLOAD_TYPE);
  const [pollIntervalS, setPollIntervalS] = useState(DEFAULT_POLL_INTERVAL_S);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * `try`/`catch`/`finally { setPending(false) }`, matching `SignIn.tsx`'s
   * own hardened `handleSubmit` (design spec §4: "errors follow `SignIn`'s
   * hardened pattern") -- non-negotiable regardless of what `submit` does,
   * since it is an injected async function and any implementation of it may
   * reject (fix round 1, review-found: the previous version had none of the
   * three, and `postFeed`'s own throw -- since removed -- escaped straight
   * through the un-caught `await`, permanently disabling the button with
   * nothing rendered). The `catch` here is `submit` rejecting outright,
   * which `postFeed` itself no longer does; kept for the same reason
   * `SignIn.handleSubmit` keeps one even though today's `signIn`/`signUp`
   * only resolve -- a caller of this component may inject a `submit` this
   * file cannot see the inside of.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const outcome = await submit({ pluginId, name, url, downloadType, pollIntervalS });
      if ('id' in outcome) {
        setName('');
        setUrl('');
        return;
      }
      setError(REFUSAL_MESSAGES[outcome.refusal]);
    } catch {
      setError(REFUSAL_MESSAGES.offline);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      aria-labelledby="add-feed-heading"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <h2 id="add-feed-heading">Add a feed</h2>
      {error !== null && (
        <div role="alert">
          <h3>{error}</h3>
        </div>
      )}
      <div>
        <label htmlFor="add-feed-name">Name</label>
        <input
          id="add-feed-name"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="add-feed-url">Feed url</label>
        <input
          id="add-feed-url"
          type="url"
          required
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="add-feed-plugin">Plugin</label>
        <select
          id="add-feed-plugin"
          value={pluginId}
          onChange={(event) => {
            setPluginId(event.target.value);
          }}
        >
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="add-feed-download-type">Download type</label>
        <select
          id="add-feed-download-type"
          value={downloadType}
          onChange={(event) => {
            setDownloadType(event.target.value);
          }}
        >
          {DOWNLOAD_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="add-feed-poll-interval">Poll interval (seconds)</label>
        <input
          id="add-feed-poll-interval"
          type="number"
          min={MIN_POLL_INTERVAL_S}
          max={MAX_POLL_INTERVAL_S}
          required
          value={pollIntervalS}
          onChange={(event) => {
            setPollIntervalS(Number(event.target.value));
          }}
        />
      </div>
      <button type="submit" disabled={pending}>
        Add feed
      </button>
    </form>
  );
}
