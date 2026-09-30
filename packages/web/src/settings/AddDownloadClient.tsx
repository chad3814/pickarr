/**
 * The add-download-client form: `AddFeed.tsx`'s sibling, and built to the
 * same rules (design spec §6). Read that file's docblock first -- the three
 * decisions it records are inherited here rather than re-argued, and two of
 * them each cost the feeds slice a fix round. The heading level this form
 * is named by is inherited from there too: an `<h3>` under the download
 * clients section's `<h2>`, with the error banner's heading left a peer
 * `<h3>` for the reason that file spells out.
 *
 * **`submit` is a required prop, not defaulted to the real one.** A default
 * that performs network I/O would be invisible at the call site -- a future
 * test that forgets the prop would silently get a real `fetch` under jsdom,
 * which hangs rather than fails, with nothing pointing at the missing prop.
 * {@link postDownloadClient} below is the real implementation;
 * `shell/Shell.tsx` wires it in explicitly, through `Settings.tsx`.
 *
 * **The credential crosses the wire exactly once, in the POST body, and
 * lives nowhere else** (design spec §2, §3). It is never logged, never put
 * in a message, never read back: nothing on this screen can show it,
 * because the replica does not carry it -- `DownloadClientSyncRead`
 * projects no secret name and no value. Every credential input is
 * `type="password"`, and a successful add clears all three so the next
 * render of this form holds nothing.
 *
 * **What is mirrored from the host and what is imported.**
 * {@link ADD_DOWNLOAD_CLIENT_REFUSALS} and `AddDownloadClientInput` are
 * both imported from `@pickarr/contract`, because a refusal code and a
 * write input are both the wire's shared vocabulary and a second spelling
 * of either drifts silently -- the feeds slice shipped a hand-copied
 * `AddFeedInput` and the follow-up review measured a host-side field
 * rename leaving the entire web suite green (issue #88).
 * {@link IMPLEMENTATIONS} and {@link AUTH_STRATEGIES} are mirrored from
 * `clients/config.ts` and `clients/add.ts`'s `planCredential` instead, on
 * `AddFeed.tsx`'s own distinction: they are host *policy* this widget
 * hints at. If the host grew a third implementation and this select still
 * offered two, an operator would simply not see the new one here, and
 * anything this form did offer that the host does not support comes back
 * as `unknown-implementation` -- the right sentence, from the right
 * authority. A drifting refusal code or input field, by contrast, makes
 * this form say the wrong thing, or fail every submission, with nothing
 * to notice it at the type level.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import {
  ADD_DOWNLOAD_CLIENT_REFUSALS,
  type AddDownloadClientInput,
  type AddDownloadClientRefusalCode,
} from '@pickarr/contract';
import { sendJson } from '../auth/sendJson.ts';
import { SESSION_EXPIRED_MESSAGE } from '../auth/sessionExpired.ts';

/**
 * The implementations `clients/config.ts`'s `isImplementation` resolves --
 * mirrored, not imported; see this file's docblock on why this one is
 * allowed to drift and a refusal code is not.
 */
const IMPLEMENTATIONS = ['qbittorrent', 'sabnzbd'] as const;
type ImplementationId = (typeof IMPLEMENTATIONS)[number];

/**
 * This client's own word for each product, used by the select here and by
 * the list in `DownloadClients.tsx`. Spelled the way the projects spell
 * themselves; the wire value stays the lowercase id either side of it.
 */
const IMPLEMENTATION_LABELS: Readonly<Record<ImplementationId, string>> = {
  qbittorrent: 'qBittorrent',
  sabnzbd: 'SABnzbd',
};

/**
 * What to call `implementation` on screen, falling back to the value
 * itself.
 *
 * The fallback is not defensive padding. `DownloadClientSyncRead.implementation`
 * is a `string`, not a union, precisely because the column is unconstrained
 * and a replica outlives the build that reads it -- so a row naming a
 * product this build has no word for must still render as *something a
 * human can act on*, which the host's own spelling is and an empty line is
 * not.
 */
export function implementationLabel(implementation: string): string {
  return isImplementationId(implementation) ? IMPLEMENTATION_LABELS[implementation] : implementation;
}

/**
 * `Object.hasOwn` against the label map rather than `IMPLEMENTATIONS.includes`:
 * that array is a `const` tuple, so its `includes` only accepts an
 * `ImplementationId` and calling it with a `string` needs a widening
 * assertion -- and this slice's diff is cast-free. Asking the map whether
 * it has a label is also the question {@link implementationLabel} actually
 * needs answered, so nothing here can drift from what that function does
 * next.
 */
function isImplementationId(value: string): value is ImplementationId {
  return Object.hasOwn(IMPLEMENTATION_LABELS, value);
}

/**
 * The two credential shapes a qBittorrent client can be given, mirroring
 * `clients/add.ts`'s `planCredential` -- an api key alone (the bearer
 * strategy) or a username and password with no api key (the login one).
 * SABnzbd has a single strategy and is never asked (design spec §4).
 */
const AUTH_STRATEGIES = ['api-key', 'login'] as const;
type AuthStrategy = (typeof AUTH_STRATEGIES)[number];

const AUTH_STRATEGY_LABELS: Readonly<Record<AuthStrategy, string>> = {
  'api-key': 'Api key',
  login: 'Username and password',
};

/** A refusal the host actually sent, carrying one of the four codes `@pickarr/contract` declares -- the same declaration `clients/add.ts`'s own `AddDownloadClientRefusal` is built from, so the two cannot drift. */
export interface AddDownloadClientRefusal {
  refusal: AddDownloadClientRefusalCode;
}

/**
 * What `submit` resolves to.
 *
 * `offline` is this client's own outcome for a submit that never reached
 * the host -- a rejected `fetch`, or a reply Pickarr's route layer could
 * not have produced (see {@link postDownloadClient} on why an unparseable
 * body is one of those). Never a server answer, which is what keeps "no
 * answer" distinguishable from "refused": an offline submit reading as
 * "already on file" would send the operator hunting for a client that is
 * not there.
 *
 * `expired` is a 401 -- an expired session, the most ordinary failure a
 * real submit meets (issue #94). It used to fall into `unrecognised`, whose
 * sentence blamed version skew; `auth/sendJson.ts` now answers it on the
 * status, and the shell returns to sign-in on it.
 *
 * **`unrecognised` is a normal outcome, not a should-not-happen one.**
 * `POST /api/download-clients` answers `{ id }`, or `{ refusal }` with one
 * of six codes (the contract's four plus the route's own `invalid-shape`
 * and `malformed-body`), or a bare `{ error }` with no `refusal` key at all
 * for a 405, a 413 or a 500. A client is routinely older than its host, so
 * a code this build has never heard of is a normal answer, not a defect in
 * either side. `unrecognised` covers every parseable answer this build
 * cannot read.
 */
export type AddDownloadClientOutcome =
  | { id: number }
  | AddDownloadClientRefusal
  | { refusal: 'offline' | 'expired' | 'unrecognised' };

/**
 * The codes this client recognises, built from the contract's list rather
 * than spelled again here -- a second spelling is exactly what let the
 * feeds host rename one and leave that form quietly answering with its
 * catch-all.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set(ADD_DOWNLOAD_CLIENT_REFUSALS);

function isRefusalCode(value: unknown): value is AddDownloadClientRefusalCode {
  return typeof value === 'string' && REFUSAL_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The real `submit`: posts to `POST /api/download-clients` and reads only
 * what that route's contract promises to carry.
 *
 * **Branches on the body's `refusal` field, never on the HTTP status.**
 * The route answers 409 for `duplicate-name` and 422 for the other three
 * today (`api/server.ts`'s `statusForDownloadClientRefusal`); the codes are
 * the stable contract and the statuses are not. No status is read here;
 * the guard's 401 is read once in `auth/sendJson.ts` for every write path.
 *
 * `credentials: 'same-origin'` puts whatever session cookie the browser
 * already holds on the request; this function never reads, stores or
 * forwards the token itself (Global Constraint).
 *
 * **This is the one place a credential leaves the browser**, inside
 * `body`. Nothing here logs, and in particular `sendJson`'s `catch`
 * inspects no error: a `TypeError` from a rejected `fetch` names the url, and a
 * caught error's message is the classic way a request's detail reaches a
 * console.
 *
 * **Never throws.** A rejected `fetch` and a body that fails to parse both
 * answer `{ refusal: 'offline' }`; a 401 answers `{ refusal: 'expired' }`;
 * a body that parses but matches neither an accepted id nor a known refusal
 * answers `{ refusal: 'unrecognised' }`. The first two are decided by
 * `auth/sendJson.ts`, which makes the request for every write path; the
 * argument below is why it decides an unparseable body the way it does.
 *
 * **Why an unparseable body is `offline` and not `unrecognised`**, since
 * the two are one `await` apart inside the same `try` and the reason this
 * line used to give -- "neither is a server answer" -- is not true of the
 * second as written. An unparseable body plainly *is* an answer; something
 * sent those bytes. The question is whether *Pickarr* sent them, and it
 * cannot have: `api/static-route.ts` refuses every `/api` path before it
 * touches the filesystem precisely so a mistyped endpoint cannot answer
 * HTML ("a client that parses markup as JSON and reports a nonsense
 * error"), and `server.ts`'s catch-all is `json(404, { error: 'unknown
 * route' })`. Every answer this route layer can produce is JSON. So
 * unparseable bytes came from something in front of Pickarr -- a gateway's
 * HTML 502, a captive portal, a transfer cut mid-stream -- and in each of
 * those the submit did not reach the host. "Could not reach Pickarr" is
 * the accurate sentence and "the host may be a different version" is not:
 * version skew produces a *parseable* body here, which is exactly what
 * `unrecognised` is for. A renamed endpoint answers that JSON 404 and
 * lands there, not here.
 *
 * The ordering is what makes this hold, and it is the thing to re-check if
 * the route layer ever gains a non-JSON answer under `/api`: at that point
 * an unparseable body stops implying "not Pickarr" and this branch needs
 * splitting.
 * The feeds slice shipped a version that threw, and because `handleSubmit`
 * is invoked as `void handleSubmit(event)` the rejection was swallowed, so
 * five of six real host answers wedged the form with the button stuck
 * disabled and nothing on screen. Never reads `error` or any field beyond
 * `id`/`refusal`: a server-authored message never reaches a human here
 * (Global Constraint).
 *
 * `AddDownloadClientInput` is `@pickarr/contract`'s now (issue #88) --
 * that module's own doc has the full reasoning, including the credential
 * and `type`-omission rules this function relies on to build the request
 * body.
 */
export async function postDownloadClient(input: AddDownloadClientInput): Promise<AddDownloadClientOutcome> {
  const result = await sendJson('/api/download-clients', { method: 'POST', body: input });
  if (result.outcome !== 'answered') return { refusal: result.outcome };
  const { body } = result;
  if (isRecord(body) && typeof body.id === 'number') return { id: body.id };
  if (isRecord(body) && isRefusalCode(body.refusal)) return { refusal: body.refusal };
  return { refusal: 'unrecognised' };
}

/**
 * A fixed sentence per non-accepted outcome -- never the server's own words
 * (Global Constraint). One map covers all seven, `offline`, `expired` and
 * `unrecognised` included, so `handleSubmit` below has no special case to get wrong
 * between them.
 *
 * **The keyed `Record` is load-bearing, not decoration.** Its key type is
 * the contract's four codes plus this client's own three, so a code added to
 * `ADD_DOWNLOAD_CLIENT_REFUSALS` fails to compile here until someone writes
 * the sentence for it, and a code renamed there fails twice -- an unwritten
 * key and an unreachable one. `AddDownloadClient.test.tsx`'s two
 * `refusal codes` tests are the runtime half, and they exist because
 * `npm run test:web` does not typecheck.
 *
 * **No sentence names a value the operator submitted**, and in particular
 * none can name a credential: each says which rule was broken. That is the
 * same discipline `clients/add.ts` keeps on the other side of the wire.
 */
export const REFUSAL_MESSAGES: Record<AddDownloadClientRefusalCode | 'offline' | 'expired' | 'unrecognised', string> = {
  'unknown-implementation': 'Pickarr cannot drive that kind of download client.',
  'bad-auth-shape': 'Fill in exactly one set of credentials: an api key, or a username and password.',
  'duplicate-name': 'A download client with that name is already on file.',
  'bad-url': 'That address is not an http or https url.',
  /** Distinct from every named refusal above, which are answers from the host -- this one means the submit never reached it. The first clause is the load-bearing half: "could not reach Pickarr" is true of a rejected `fetch` and of a gateway answering in Pickarr's place alike, where "check your connection" is advice that happens to fit the first case better than the second. */
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  /** A 401. One sentence shared by every write path (`auth/sessionExpired.ts`), so no two can word it differently. */
  expired: SESSION_EXPIRED_MESSAGE,
  /** `postDownloadClient`'s own catch-all. Names no code and no status: those are exactly the server-authored detail the Global Constraint forbids rendering. */
  unrecognised:
    'Pickarr refused this download client, but did not say why. The host may be a different version than this page expects — reload and try again.',
};

export interface AddDownloadClientProps {
  /** Posts the form. Required, not defaulted -- see this file's docblock. */
  submit: (input: AddDownloadClientInput) => Promise<AddDownloadClientOutcome>;
}

export function AddDownloadClient({ submit }: AddDownloadClientProps): ReactElement {
  const [name, setName] = useState('');
  const [implementation, setImplementation] = useState<string>(IMPLEMENTATIONS[0]);
  const [strategy, setStrategy] = useState<AuthStrategy>('api-key');
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which credentials this submission actually carries, derived rather than
   * stored: SABnzbd has one strategy and is never asked, so the chooser's
   * own value is ignored for it rather than reset behind the operator's
   * back.
   */
  const effectiveStrategy: AuthStrategy = implementation === 'sabnzbd' ? 'api-key' : strategy;

  /**
   * `clients/add.ts`'s `planCredential` refuses a qBittorrent client
   * carrying both an api key and a login, deliberately -- silently
   * discarding half of what someone typed is worse than saying the shape is
   * wrong. So the strategy the form is *showing* decides what is sent, and
   * whatever was typed under the other one is left behind rather than
   * submitted alongside. Without this, typing an api key and then switching
   * to username and password would produce `bad-auth-shape` for a form the
   * operator filled in exactly as displayed.
   */
  function credentialsForSubmit(): Pick<AddDownloadClientInput, 'apiKey' | 'username' | 'password'> {
    return effectiveStrategy === 'api-key'
      ? { apiKey, username: '', password: '' }
      : { apiKey: '', username, password };
  }

  /**
   * `try`/`catch`/`finally { setPending(false) }`, matching `AddFeed.tsx`'s
   * own hardened `handleSubmit` -- non-negotiable regardless of what
   * `submit` does, since it is an injected async function and any
   * implementation of it may reject. The `finally` is the only thing that
   * makes "the button always comes back" true; the feeds slice shipped
   * without one and wedged the form on five of six real host answers.
   *
   * A successful add clears the name, the address, the category and all
   * three credential fields. The credentials are cleared because nothing
   * may hold one longer than the request that carried it; the other three
   * because they identify the client just created. `implementation` and the
   * strategy are kept -- they are the operator's context for whatever they
   * add next, and neither is a value about the client that was accepted.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const outcome = await submit({ name, implementation, url, category, ...credentialsForSubmit() });
      if ('id' in outcome) {
        setName('');
        setUrl('');
        setCategory('');
        setApiKey('');
        setUsername('');
        setPassword('');
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
      aria-labelledby="add-download-client-heading"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <h3 id="add-download-client-heading">Add a download client</h3>
      {error !== null && (
        <div role="alert">
          {/*
            Real text in a real heading, never an `aria-label` on an empty
            element (`CLAUDE.md`'s longest testing hazard, and the defect the
            previous slice shipped): the announced string and the visible one
            are the same string here, so they cannot drift apart.
          */}
          <h3>{error}</h3>
        </div>
      )}
      <div>
        <label htmlFor="add-download-client-name">Client name</label>
        <input
          id="add-download-client-name"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="add-download-client-implementation">Implementation</label>
        <select
          id="add-download-client-implementation"
          value={implementation}
          onChange={(event) => {
            setImplementation(event.target.value);
          }}
        >
          {IMPLEMENTATIONS.map((id) => (
            <option key={id} value={id}>
              {IMPLEMENTATION_LABELS[id]}
            </option>
          ))}
        </select>
      </div>
      {implementation !== 'sabnzbd' && (
        <div>
          <label htmlFor="add-download-client-auth">Sign-in method</label>
          <select
            id="add-download-client-auth"
            value={strategy}
            onChange={(event) => {
              setStrategy(event.target.value === 'login' ? 'login' : 'api-key');
            }}
          >
            {AUTH_STRATEGIES.map((id) => (
              <option key={id} value={id}>
                {AUTH_STRATEGY_LABELS[id]}
              </option>
            ))}
          </select>
        </div>
      )}
      {effectiveStrategy === 'api-key' ? (
        <div>
          <label htmlFor="add-download-client-api-key">Api key</label>
          <input
            id="add-download-client-api-key"
            type="password"
            required
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
            }}
          />
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="add-download-client-username">Username</label>
            {/* `type="text"`: a username is not a credential (`db/schema.ts`), and masking it would only make it harder to check. */}
            <input
              id="add-download-client-username"
              type="text"
              required
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
            />
          </div>
          <div>
            <label htmlFor="add-download-client-password">Password</label>
            <input
              id="add-download-client-password"
              type="password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          </div>
        </>
      )}
      <div>
        <label htmlFor="add-download-client-url">Address</label>
        <input
          id="add-download-client-url"
          type="url"
          required
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
        />
      </div>
      <div>
        {/* Optional on purpose: `''` means "file downloads under no category", which every consumer already understands (`clients/add.ts`), so there is nothing to refuse and nothing to default. */}
        <label htmlFor="add-download-client-category">Category</label>
        <input
          id="add-download-client-category"
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
          }}
        />
      </div>
      <button type="submit" disabled={pending}>
        Add download client
      </button>
    </form>
  );
}
