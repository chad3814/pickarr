/**
 * The one write the destinations screen makes -- `PUT /api/destinations/:pluginId`,
 * this API's first upsert -- and the sentence this client answers each of
 * its outcomes with (design spec §3, §6).
 *
 * **Modelled on `postMapping.ts`, which is the file to read first.** Two of
 * the decisions there each cost an earlier slice a fix round and are
 * inherited here rather than re-argued:
 *
 * **Never throws.** A rejected `fetch` and a body that fails to parse both
 * answer `offline`; a body that parses but is neither a success shape nor a
 * known refusal answers `unrecognised`.
 * The feeds slice shipped a sibling that threw, and because its caller
 * invoked it as `void handleSubmit(event)` the rejection was swallowed: the
 * pending flag never cleared and the form wedged on five of six real host
 * answers. `Destinations.tsx` invokes this the same way, once per plugin
 * row, so it would wedge the same way once per row.
 *
 * **Branches on the body, never on the status.** The codes are the stable
 * contract and the statuses are not. `postMapping.ts`'s `deleteMapping` is
 * the one narrowly-argued exception in this package and it exists because a
 * 204 has no body to branch on; this route answers a body on every path it
 * has, success included, so the rule stands here with no exception at all.
 *
 * **Why an unparseable body is `offline` and not `unrecognised`.**
 * `postMapping.ts` and `AddDownloadClient.tsx` argue this at length and the
 * argument is about the route *layer*: every answer `api/server.ts` can
 * produce under `/api` is JSON, and its catch-all is
 * `json(404, { error: 'unknown route' })`. So unparseable bytes came from
 * something in front of Pickarr and the request did not reach the host.
 * Version skew, by contrast, produces a *parseable* body, which is what
 * `unrecognised` is for -- and `invalid-shape`, the envelope refusal
 * `api/server.ts` declares and no contract module does, lands there too.
 *
 * `credentials: 'same-origin'` puts whatever session cookie the browser
 * already holds on the request; nothing here reads, stores or forwards the
 * token itself (Global Constraint). Nothing here logs, and the `catch`
 * never inspects its error: a `TypeError` from a rejected `fetch` names the
 * url, and a caught error's message is the classic way a request's detail
 * reaches a console. A root and a shape are both paths, which is the other
 * half of why nothing here is logged.
 *
 * **The codes are imported, never spelled again.** The download-clients
 * review found them hand-copied and required exactly this fix: a second
 * spelling drifts silently, because renaming one half reddens only that
 * half's tests.
 */
import { DESTINATION_REFUSALS, type DestinationRefusalCode } from '@pickarr/contract';

/**
 * The wire shape `PUT /api/destinations/:pluginId` needs -- mirrored from
 * `packages/host/src/media/destinations.ts`'s own `SaveDestinationInput`
 * rather than imported, for the reason `postMapping.ts`'s twin gives: this
 * package ships to a browser and only needs to agree with the host on the
 * JSON that crosses the wire.
 *
 * The plugin id is **not** in here. It is the path segment, so there is no
 * way for a body to name one plugin while the url names another.
 */
export interface SaveDestinationInput {
  /**
   * Absolute, and spelled as it resolves: the host refuses
   * `not-absolute-root` without a leading `/`, and `unusable-root` for `/`
   * itself or for any value holding an empty, `.` or `..` segment. Whether
   * it *exists* is still not checked -- design spec §7 is explicit that a
   * root which does not exist is a misconfiguration to see, not a
   * directory to invent, so that one surfaces in the host's log at import
   * rather than here.
   */
  root: string;
  /** The `{token}` template, validated on save against the declaring plugin's own list. */
  shape: string;
  /**
   * Where a release that matched nothing lands, relative to `root`.
   *
   * **Optional, and the absence is load-bearing.** `api/server.ts`'s
   * `destinationBodyFrom` reads an absent `unmatchedDir` as "use the host's
   * own default" -- design spec §6's `_unmatched`, which lives in
   * `media/destinations.ts` as a constant and deliberately not in the DDL --
   * and reads an empty string as the `empty-path` refusal. So a field the
   * operator left blank must be **omitted**, not sent as `''`, or the
   * documented default becomes unreachable and answers a refusal instead.
   */
  unmatchedDir?: string;
}

/**
 * Every way the save can fail to do what was asked.
 *
 * `offline` is this client's own outcome for a request that never reached
 * the host, and `unrecognised` its outcome for an answer it cannot read --
 * a refusal code this build has never heard of, or a body with no `refusal`
 * key at all. That last shape is the most ordinary real failure there is: a
 * 401 from an expired session answers `{ error }`, as do 405, 413 and 500,
 * and none of them carries a `refusal`. A client is routinely older than
 * its host, so neither of these two is a defect in either side.
 */
export interface DestinationRefusal {
  refusal: DestinationRefusalCode | 'offline' | 'unrecognised';
  /**
   * The token the host refused, for `unknown-token`, and `null` for every
   * other outcome -- including an `unknown-token` the host declined to
   * name, and both of this client's own two, which never saw a body.
   *
   * **Read, not ignored, and the distinction cost an operator the feature.**
   * `@pickarr/contract`'s `DestinationRefusalBody` has carried this field
   * since the host started answering it, and this client dropped it on the
   * floor while telling the operator in so many words that Pickarr "does
   * not say which one it refused". It does. See
   * {@link destinationRefusalMessage}.
   *
   * Required-but-nullable rather than optional, matching the host's own
   * `DestinationRefusal` and for the reason
   * {@link SaveDestinationInput.unmatchedDir} gives about
   * `exactOptionalPropertyTypes`: absent and explicitly null would be two
   * spellings of one thing.
   */
  token: string | null;
}

/** An accepted save: the row id the host upserted. Answered on an update as well as an insert, which is the only way a client learns the key its replica holds the row under. */
export type SaveDestinationOutcome = { id: number } | DestinationRefusal;

/**
 * The one verb `Destinations` takes as a required prop.
 *
 * A bare function rather than `postMapping.ts`'s object of three, because
 * there is one write here and an object of one member is a wrapper around
 * nothing. It is **required and never defaulted to {@link destinationSubmit}**:
 * a default that performs network I/O is invisible at the call site, and a
 * test that forgets the prop would silently get a real `fetch` under jsdom,
 * which hangs rather than fails, with nothing pointing at the missing prop.
 */
export type DestinationSubmit = (
  pluginId: string,
  input: SaveDestinationInput,
) => Promise<SaveDestinationOutcome>;

/** The codes this client recognises, built from the contract's list rather than spelled again here. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(DESTINATION_REFUSALS);

function isRefusalCode(value: unknown): value is DestinationRefusalCode {
  return typeof value === 'string' && REFUSAL_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Saves one plugin's destination. See this file's docblock; in particular,
 * this never throws.
 *
 * `encodeURIComponent` on the id even though `api/server.ts` answers 404 for
 * anything outside `/^[a-z][a-z0-9_]{0,31}$/`: this client does not own that
 * pattern, and a value it did not check is not a value it may paste into a
 * url. The 404 that a malformed id earns carries `{ error }` and no
 * `refusal`, so it reads back as `unrecognised` -- which is true of it.
 */
export async function putDestination(
  pluginId: string,
  input: SaveDestinationInput,
): Promise<SaveDestinationOutcome> {
  let body: unknown;
  try {
    const response = await fetch(`/api/destinations/${encodeURIComponent(pluginId)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      // `JSON.stringify` drops an `undefined` member, which is exactly the
      // omission `SaveDestinationInput.unmatchedDir` documents -- so a
      // caller that leaves it unset sends no field rather than an empty
      // one. Pinned by `postDestination.test.tsx` rather than left to this
      // comment, because it is a property of `JSON.stringify` and not of
      // anything visible here.
      body: JSON.stringify(input),
    });
    body = await response.json();
  } catch {
    return { refusal: 'offline', token: null };
  }
  if (isRecord(body) && typeof body.id === 'number') return { id: body.id };
  if (isRecord(body) && isRefusalCode(body.refusal)) {
    // `typeof === 'string'` rather than a cast: the body is `unknown` and
    // an older or newer host may send anything at all under this key. A
    // host that sends no `token` -- every refusal but `unknown-token`, and
    // some of those -- lands on `null`, which is the value the sentence
    // below falls back on.
    return { refusal: body.refusal, token: typeof body.token === 'string' ? body.token : null };
  }
  return { refusal: 'unrecognised', token: null };
}

/**
 * The real implementation, which is what `shell/Shell.tsx` wires into the
 * settings screen. A module-level constant rather than a function returning
 * one: there is nothing in it that varies per render.
 */
export const destinationSubmit: DestinationSubmit = putDestination;

/**
 * A fixed sentence per non-accepted outcome -- never the server's own words
 * (Global Constraint). One map covers all twelve, `offline` and
 * `unrecognised` included, so no two plugin rows can word the same outcome
 * differently. The one outcome that is not a fixed sentence is an
 * `unknown-token` the host named, which {@link destinationRefusalMessage}
 * composes from this map's key set plus the one datum the wire carries.
 *
 * **The keyed `Record` is load-bearing, not decoration.** Its key type is
 * the contract's ten codes plus this client's own two, so a code added to
 * `DESTINATION_REFUSALS` fails to compile here until someone writes the
 * sentence for it, and a code renamed there fails twice -- an unwritten key
 * and an unreachable one. The three tests at the top of
 * `postDestination.test.tsx` -- one pinning this object's key set against
 * `DESTINATION_REFUSALS` *and* against a literal list of ten, one pinning
 * that no two of its sentences are the same, one pinning that the two
 * escape refusals name different fields -- are the runtime half, and they
 * exist because `npm run test:web` does not typecheck.
 *
 * **Distinctness is only half of it; the rendering has to pick the right
 * one.** Measured against the web suite by replacing every
 * `setError(destinationRefusalMessage(...))` in `Destinations.tsx` with one
 * fixed sentence: the test that names the property is `each of the twelve
 * outcomes reads as its own sentence`. The three tests above all stay green
 * under that mutation, because this object is still correct -- which is why
 * the component has a walk of its own rather than trusting this one.
 *
 * **Each sentence names the field it is about.** The refusal is rendered
 * once per row rather than once per input, so the field has to be in the
 * words: `packages/contract/src/destinations.ts` renamed `escapes-root` to
 * `escaping-shape` precisely so `escaping-path` could stay the unmatched
 * folder's version of the same rule, and a client that worded them alike
 * would have thrown that distinction away at the last step.
 *
 * **No sentence quotes a root, a shape or a folder name.** A value the
 * operator just typed is already on screen in the field they typed it into,
 * and all three are paths: design spec §7's rule about what may reach a log
 * is the same instinct, and there is nothing an error gains by repeating
 * one.
 */
export const DESTINATION_REFUSAL_MESSAGES: Record<
  DestinationRefusalCode | 'offline' | 'unrecognised',
  string
> = {
  'unknown-plugin':
    'Pickarr no longer has that plugin loaded, so it has nowhere to put this. Reload the page to see which plugins it does have.',
  'not-absolute-root':
    'The library folder has to be an absolute path — it must start with a slash.',
  /**
   * **One sentence for two limbs**, because the code is one
   * (`unusable-root`) and a refusal is rendered once per row. The host
   * refuses `/` itself and any value holding an empty, `.` or `..`
   * segment; "a folder of its own" covers the first and "written out
   * plainly" the rest, and the three examples are the three spellings that
   * were measured saving happily and then failing at every import.
   */
  'unusable-root':
    'The library folder has to be a folder of its own, written out plainly — not / itself, and no //, no trailing slash and no . or .. in it.',
  /**
   * **The fallback, for an `unknown-token` the host did not name.** That
   * is a real answer and not a defect on either side: `ECHOABLE_TOKEN` in
   * `host/src/media/destinations.ts` repeats a name only when it matches
   * the character class a declared token is in, so `{http:host/x?apikey=k}`
   * minus its slashes comes back `unknown-token` with `token: null` rather
   * than as a query string in a response body. An older host that sends no
   * `token` at all lands here too.
   *
   * This sentence therefore does **not** name a token, and equally does not
   * claim none can be named -- it said the latter for a whole slice, while
   * the host was sending the name and this client was discarding it. When
   * there is a name, {@link destinationRefusalMessage} uses it instead.
   *
   * Guessing the token by parsing the shape here is still refused: that
   * would put a second token vocabulary in `packages/web`, the exact
   * copy-inheritance defect the token list on this screen is read from the
   * plugin's declaration to avoid.
   */
  'unknown-token':
    'The path shape names a token this plugin does not have. Check each {token} in it against the list of available tokens above.',
  'malformed-shape':
    'Every brace in the path shape has to open and close one token. Look for a { with no matching }, or a } on its own.',
  'backslash-in-shape':
    'The path shape may not contain a backslash. Separate folders with a forward slash, on every platform.',
  'escaping-shape':
    'The path shape has to stay inside the library folder. Remove the leading slash, or the .. segment, that takes it out.',
  'empty-filename':
    'The path shape ends in a folder rather than a file. Its last segment needs some text or a token of its own.',
  /**
   * **Not reachable from this form, and that is a property of the form
   * rather than of the rule.** A blank unmatched-folder field means "use the
   * default" here and is omitted from the body (`SaveDestinationInput`), so
   * this client never sends the `''` the host refuses. `ClientMappings.tsx`
   * keeps its two inputs un-`required` for the opposite reason -- there,
   * blank has no second meaning and marking them required would make the
   * refusal dead text. Here blank already means something, so the sentence
   * stays for an answer the host can still give (a build newer than this
   * one, another client) and is not this form's to provoke.
   */
  'empty-path':
    'Pickarr will not tip unmatched releases straight into the library folder. Give the unmatched folder a name of its own.',
  'escaping-path':
    'The unmatched folder has to stay inside the library folder. Remove the leading slash, or the .. segment, that takes it out. A folder inside another one is fine.',
  /** Worded exactly as `postMapping.ts`'s and `AddDownloadClient.tsx`'s own `offline`, because it is the same event and a second wording for it would be two sentences for one condition. */
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  /** The catch-all. Names no code and no status: those are exactly the server-authored detail the Global Constraint forbids rendering. */
  unrecognised:
    'Pickarr refused this destination, but did not say why. The host may be a different version than this page expects — reload and try again.',
};

/**
 * The sentence for one refused save: {@link DESTINATION_REFUSAL_MESSAGES}'s
 * fixed text, except for an `unknown-token` the host named, which gets a
 * sentence with the name in it.
 *
 * **This function exists because the client was ignoring a field the wire
 * has always carried.** `@pickarr/contract`'s `DestinationRefusalBody`
 * declares `token`, `api/server.ts` sends it, and design spec §3 asks for an
 * unknown token to be "refused, naming it" -- and this screen told the
 * operator, in a shipped sentence, that Pickarr "does not say which one it
 * refused" while the name sat unread in the response. Naming it is the
 * whole point of the second field, and a `{token}` list of seven on the tv
 * row is exactly the case where a code alone leaves an operator comparing
 * strings by eye.
 *
 * **The client still owns every word.** The host sends a datum, not a
 * sentence (`contract/src/destinations.ts`: "It is never a sentence"), and
 * the name is the operator's own input coming back to the operator who
 * typed it. It is safe to render for a reason that lives at the host and is
 * worth knowing here: `ECHOABLE_TOKEN` gates it to `/^[A-Za-z][A-Za-z0-9]{0,31}$/`,
 * so a "token" that is really a query string is answered with `token: null`
 * and falls through to the fixed sentence. React escapes what it renders,
 * so this braces the name for legibility rather than for safety.
 *
 * A function rather than a second entry in the map, because the map's keys
 * are the outcome codes and this is not a new outcome -- it is the same
 * `unknown-token` with one more thing known about it. Keeping the map a
 * total `Record` over the codes is what makes a new code a compile error.
 */
export function destinationRefusalMessage(refusal: DestinationRefusal): string {
  if (refusal.refusal === 'unknown-token' && refusal.token !== null) {
    return `The path shape names {${refusal.token}}, which this plugin does not have. Check it against the list of available tokens above.`;
  }
  return DESTINATION_REFUSAL_MESSAGES[refusal.refusal];
}
