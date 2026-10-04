/**
 * Where each plugin's library lives and what a path inside it looks like:
 * the third section of `/settings`, one row per plugin (design spec §3, §6).
 *
 * **The tokens a row offers come from the plugin that declared them, never
 * from a list in this package.** `MediaPlugin.tokens` is the one place
 * `{season}` is said to mean something, and design spec §3 is explicit that
 * only a plugin can say -- the host validates a saved shape against the
 * declaring plugin's array and this screen renders the same array, "so the
 * list cannot drift from what resolves". A vocabulary spelled again here
 * would be either the union of every plugin's tokens (and then a film row
 * offers `{season}`, which `unknown-token` exists to refuse) or a
 * per-plugin copy that goes stale the first time a plugin changes. That is
 * the copy-inheritance defect an earlier slice found in the refusal codes
 * and had to fix, and it is what {@link DestinationsProps.plugins} being a
 * required, undefaulted prop is for.
 *
 * Measured 2026-10-03 against the whole `test:web` suite (#104), by
 * replacing `plugin.tokens` below with the union of the three plugins'
 * lists written out here: **2 red**, and only those two --
 * `the tokens a row offers are the ones that plugin declared: …` and
 * `every token a plugin declared is offered on its row, and no token it
 * did not`. (The first is cited by its leading clause because its full name
 * ends by naming two plugins, and `test/plugins/registry.test.ts` refuses a
 * plugin id anywhere in `src/`. Both names are verbatim prefixes and grep
 * finds them.) Every other web test stays green under it, which is the
 * point: a row that renders *some* plausible token list satisfies
 * everything except a
 * test that checks the list against the plugin that owns it.
 *
 * **Three components, because each row owns state the others must not
 * see.** Each {@link DestinationRow} holds its own draft, its own pending
 * flag and its own refusal. State hoisted into this component and keyed by
 * plugin id would work too; a single flag shared by the section would not.
 * Measured the same way, by hoisting `pending` into this component and
 * passing it down: **1 red of 258** -- `saving one plugin's row leaves the
 * other rows alone`, on the assertion written for exactly this (`the other
 * rows are not` busy: `true !== false`). With one row on screen a shared
 * flag has nothing to spill onto, which is why that test puts three up and
 * saves one of them. `ClientMappings.tsx` records the same split and the
 * same shape of measurement.
 *
 * **Nothing here is refetched after a write** (Global Constraint). `Save`
 * calls `submit` and stops; the accepted values reach the screen when the
 * replica says so, through `useDestinations`'s subscriptions. So a save's
 * success is not the row's -- see {@link DestinationRow} on why the
 * controls re-enable anyway.
 *
 * **Nothing here validates a root, a shape or a folder name.** All three
 * are the host's rules (`media/destinations.ts`, `media/shape.ts`) and a
 * second, weaker copy of them in a browser could only disagree with the one
 * that decides. The one thing this form does interpret is a *blank*
 * unmatched folder, which means "use the default" and is documented on
 * `SaveDestinationRequest.unmatchedDir` -- an encoding, not a validation.
 *
 * **Every name a screen reader announces is composed from text that is on
 * screen.** Each row is named by its own `<h3>` through `aria-labelledby`,
 * and each `Save` is named from that heading and its own label. `CLAUDE.md`'s
 * longest testing hazard is a component whose accessible name came from an
 * `aria-label` on an element with nothing in it; nothing here has an
 * `aria-label` at all.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import type { PluginDestinationSyncRead } from '@pickarr/contract';
import { useDestinations, type DestinationsSource } from './useDestinations.ts';
import {
  DESTINATION_REFUSAL_MESSAGES,
  destinationRefusalMessage,
  type DestinationSubmit,
  type SaveDestinationRequest,
} from './postDestination.ts';
import { pluginFor } from '../plugins/registry.ts';

/** Re-exported so a caller of this section needs one import, not two -- `useDestinations.ts` is where it is declared, since that hook is what needs it narrowed. */
export type { DestinationsSource };

/**
 * One plugin, as this screen needs it: the id it is addressed by and the
 * tokens it declared.
 *
 * **Both fields come off the same `MediaPlugin`.** `pluginId` is
 * `MediaPlugin.id`, which is the `:pluginId` segment
 * `PUT /api/destinations/:pluginId` takes and the value
 * `PluginDestinationSyncRead.pluginId` carries; `tokens` is
 * `MediaPlugin.tokens` verbatim, in the order the plugin listed them. They
 * are a pair rather than two props because a token list detached from the
 * plugin it belongs to is the drift this whole arrangement exists to
 * prevent.
 */
export interface PluginTokens {
  pluginId: string;
  tokens: readonly string[];
}

/**
 * The announced error and the one an operator can read, as the same string
 * in the same element -- `ClientMappings.tsx`'s `Refusal`, unchanged.
 *
 * `CLAUDE.md`: `role` and `aria-*` are assertions about the *announced*
 * interface and prove nothing about the rendered one. Real text in a real
 * element is what makes the two impossible to drift apart.
 */
function Refusal({ message }: { message: string }): ReactElement {
  return (
    <div role="alert">
      <p>{message}</p>
    </div>
  );
}

/** The three values a row edits. */
interface Draft {
  root: string;
  shape: string;
  unmatchedDir: string;
}

/**
 * What the operator has typed into a row, **per field**: a key is present
 * once that field has been edited and absent until then.
 *
 * Per field rather than per row, which is the distinction
 * `Destinations.test.tsx`'s `a replica row arriving mid-edit does not
 * overwrite what is being typed` pins. A whole-row draft would freeze the
 * two fields nobody has touched as well, so a destination saved from
 * another tab -- or this plugin's first row arriving after the operator
 * started typing -- would show in none of them. An absent key is "no local
 * opinion, show the replica", which is a different thing from `''`: an
 * empty string is a deliberate blank, and for the unmatched folder that is
 * a meaningful value (see {@link UNMATCHED_DEFAULT}).
 */
type PartialDraft = Partial<Draft>;

/**
 * Design spec §6's default, spelled here because this is the only place a
 * *client* has to say it.
 *
 * **This is not a second spelling of the host's constant, and the
 * difference matters.** `media/destinations.ts` holds the value that is
 * actually written when the field is omitted, and migration 20 deliberately
 * keeps it out of the DDL so there are not two. This string is never sent:
 * it is the placeholder that tells an operator what leaving the field blank
 * will get them. If the host's default changed and this did not, the screen
 * would be wrong about a default rather than writing a wrong one -- which
 * is why the field is left *blank* rather than pre-filled with it, so
 * nothing here can be mistaken for a stored value.
 */
const UNMATCHED_DEFAULT = '_unmatched';

interface DestinationRowProps {
  plugin: PluginTokens;
  /** The replica's row for this plugin, or `undefined` if none has been saved -- which is every plugin on a fresh install. */
  destination: PluginDestinationSyncRead | undefined;
  submit: DestinationSubmit;
}

/**
 * One plugin's destination: what the replica holds, the tokens the plugin
 * declared, and the one control that changes it.
 *
 * **A field shows the replica until it is typed into, and goes back to
 * showing it once a save is accepted.** So a first read that resolves after
 * mount fills the form, and another client's save updates whatever the
 * operator is not in the middle of -- while the field they *are* in the
 * middle of stays theirs. `ClientMappings.tsx` reaches the same place with
 * an explicit `Edit` button that re-seeds from the replica every time it
 * opens; there is no such button here, because a destination row is always
 * a form. See {@link PartialDraft} on why this is per field.
 *
 * **Every control re-enables after every outcome, success included**, in a
 * `finally` -- non-negotiable regardless of what `submit` does, since it is
 * an injected async function and any implementation of it may reject. The
 * feeds slice shipped without one and wedged its form on five of six real
 * host answers; `postDestination.ts` additionally never throws, and the two
 * together are why a wedge is unreachable rather than merely unlikely.
 * Staying pending through an accepted save -- which `library/ReleaseList.tsx`
 * does deliberately -- would be wrong here: `PUT` is an upsert, so a second
 * save is legitimate rather than a wasted refusal, and a replica that never
 * caught up would leave the row dead with nothing on screen saying why.
 */
function DestinationRow({ plugin, destination, submit }: DestinationRowProps): ReactElement {
  const [draft, setDraft] = useState<PartialDraft>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idPrefix = `destination-${plugin.pluginId}`;
  const nameId = `${idPrefix}-name`;
  const rootId = `${idPrefix}-root`;
  const shapeId = `${idPrefix}-shape`;
  const unmatchedId = `${idPrefix}-unmatched`;
  const unmatchedHintId = `${idPrefix}-unmatched-hint`;
  const tokensId = `${idPrefix}-tokens`;
  const saveId = `${idPrefix}-save`;

  const shown: Draft = {
    root: draft.root ?? destination?.root ?? '',
    shape: draft.shape ?? destination?.shape ?? '',
    unmatchedDir: draft.unmatchedDir ?? destination?.unmatchedDir ?? '',
  };

  function edit(change: PartialDraft): void {
    setDraft((previous) => ({ ...previous, ...change }));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      // A blank unmatched folder is **omitted**, not sent as `''`: the host
      // reads an absent field as design spec §6's default and an empty one
      // as the `empty-path` refusal. See `SaveDestinationRequest`.
      const input: SaveDestinationRequest =
        shown.unmatchedDir === ''
          ? { root: shown.root, shape: shown.shape }
          : { root: shown.root, shape: shown.shape, unmatchedDir: shown.unmatchedDir };
      const outcome = await submit(plugin.pluginId, input);
      if ('refusal' in outcome) {
        // `destinationRefusalMessage`, not the map directly: an
        // `unknown-token` the host named gets a sentence with the name in
        // it, and every other outcome gets the map's fixed text. The map is
        // still read directly for the `catch` below, which has no outcome
        // to hand it.
        setError(destinationRefusalMessage(outcome));
        return;
      }
      // Back to following the replica, every field of it. The row the host
      // just wrote arrives through `useDestinations`; nothing is refetched
      // to fetch it.
      setDraft({});
    } catch {
      setError(DESTINATION_REFUSAL_MESSAGES.offline);
    } finally {
      setPending(false);
    }
  }

  return (
    <li aria-labelledby={nameId}>
      {/*
        An `<h3>`: one level under this section's `<h2>`, which is the level
        `Feeds.tsx` and `DownloadClients.tsx` fixed for anything inside a
        settings section.

        The registry's `label`, not `plugin.pluginId`. The nav
        (`shell/Shell.tsx`) reads the same `BrowserPlugin.label`; before the
        two were joined, this heading read the raw id instead, so the nav
        named this row's plugin **TV** while the row itself, one click away,
        named its own id.

        **Falling back to the id is deliberate, and reachable.** This
        screen's rows come from `@pickarr/contract`'s
        `TOKEN_NAMES_BY_PLUGIN` (`Settings.tsx`'s own `Object.entries` over
        it), which is a different list from `plugins/registry.ts`: one
        declares which plugins have path tokens, the other which have a
        browse card, and nothing holds the two in step. A plugin in the
        first and not the second has no label here, and its own id is the
        only honest thing to head the row with -- without the `??` the
        `<h3>` renders empty and the row loses its accessible name
        altogether.
      */}
      <h3 id={nameId}>{pluginFor(plugin.pluginId)?.label ?? plugin.pluginId}</h3>
      <form
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <div>
          <label htmlFor={rootId}>Library folder</label>
          <input
            id={rootId}
            value={shown.root}
            disabled={pending}
            onChange={(event) => {
              edit({ root: event.target.value });
            }}
          />
        </div>
        <div>
          <label htmlFor={shapeId}>Path shape</label>
          <input
            id={shapeId}
            value={shown.shape}
            disabled={pending}
            aria-describedby={tokensId}
            onChange={(event) => {
              edit({ shape: event.target.value });
            }}
          />
        </div>
        <div>
          <label htmlFor={unmatchedId}>Unmatched folder</label>
          <input
            id={unmatchedId}
            value={shown.unmatchedDir}
            /*
              The default is a placeholder and the hint below, never a
              pre-filled value: a value in the field would read as a stored
              setting, and until this plugin has a row there is nothing
              stored at all.
            */
            placeholder={UNMATCHED_DEFAULT}
            aria-describedby={unmatchedHintId}
            disabled={pending}
            onChange={(event) => {
              edit({ unmatchedDir: event.target.value });
            }}
          />
          <p id={unmatchedHintId}>{`Leave this blank and Pickarr uses ${UNMATCHED_DEFAULT}.`}</p>
        </div>
        <p id={tokensId}>Available tokens</p>
        {/*
          Named from the same visible text the shape field points at with
          `aria-describedby`, so the list an operator is told to check is the
          list the field names.
        */}
        <ul aria-labelledby={tokensId}>
          {plugin.tokens.map((token) => (
            <li key={token}>
              <code>{`{${token}}`}</code>
            </li>
          ))}
        </ul>
        {/*
          `Save` alone is ambiguous announced with three of them on the
          page, so its name is composed from its own label and this row's
          heading -- two spans of text that are already on screen, never an
          `aria-label` repeating one of them.
        */}
        <button type="submit" id={saveId} aria-labelledby={`${saveId} ${nameId}`} disabled={pending}>
          Save
        </button>
      </form>
      {error !== null && <Refusal message={error} />}
    </li>
  );
}

export interface DestinationsProps {
  source: DestinationsSource;
  /**
   * Every plugin that can have a destination, with the tokens each one
   * declared (`MediaPlugin.tokens`), in the order they should be listed.
   *
   * **Required, never defaulted, and never assembled in this package.** See
   * this file's docblock: a list of tokens written here would drift from
   * what the host validates against and what the resolver can fill in, and
   * no test of this screen except the one comparing a row against its own
   * plugin's declaration would notice.
   */
  plugins: readonly PluginTokens[];
  /** Saves one plugin's destination. Required, never defaulted -- see `postDestination.ts`'s `DestinationSubmit`. */
  submit: DestinationSubmit;
}

export function Destinations({ source, plugins, submit }: DestinationsProps): ReactElement {
  const destinations = useDestinations(source);
  // A `Map` rather than a `find` per row: the lookup is by the column the
  // table is unique on, and building it once keeps this linear in the
  // number of plugins rather than quadratic in it.
  const byPlugin = new Map((destinations ?? []).map((destination) => [destination.pluginId, destination]));

  return (
    <section aria-labelledby="destinations-heading">
      <h2 id="destinations-heading">Library destinations</h2>
      <p>
        A finished download is copied into its plugin&apos;s library folder, at the path its shape
        describes. Pickarr never moves or deletes what is already there, and it will not create a
        library folder that does not exist.
      </p>
      {/*
        Carried from the resolver, and this is the only screen that could
        say it: `media/shape.ts` has no escape syntax, so an operator has no
        way to write a folder or file whose name contains a brace. Its
        review judged that an acceptable trade and flagged that nothing told
        the operator.
      */}
      <p>A brace always opens a token, so a folder or file name cannot contain &#123; or &#125; itself.</p>
      {/*
        `undefined` is the first read still running and is neither of the
        two answers below. An empty array is "no plugin has a destination
        yet", which is what a fresh install holds -- and it still renders a
        row per plugin, because an empty row is the form for setting one
        (Global Constraint: zero is an answer, and the two must not render
        the same way).
      */}
      {destinations === undefined ? (
        <p>Reading saved destinations…</p>
      ) : (
        <ul aria-labelledby="destinations-heading">
          {plugins.map((plugin) => (
            <DestinationRow
              key={plugin.pluginId}
              plugin={plugin}
              destination={byPlugin.get(plugin.pluginId)}
              submit={submit}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
