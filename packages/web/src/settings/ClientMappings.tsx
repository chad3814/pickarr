/**
 * One download client's path mappings, inside that client's own row on
 * `/settings`: the list, the form that adds one, and an edit and a remove
 * on each (design spec §8).
 *
 * **Nested under the client rather than given a screen of its own.** A
 * mapping belongs to exactly one client by foreign key and is meaningless
 * away from it (design spec §8), so `library/MediaItemCard.tsx` expanding
 * to its releases is the shape this follows: a button that owns
 * `aria-expanded`, and children that render only once it is pressed.
 *
 * **Three components, because each owns state the others must not see.**
 * `AddMapping` holds the two fields being typed and the add's own pending
 * flag; each {@link MappingRow} holds whether *it* is being edited, what
 * is in its form, whether *its* request is in flight and what *it* was
 * refused. State held up here and keyed by mapping id would work too; a
 * single flag shared by the list would not.
 *
 * Measured, twice, against the 214 web tests. Hoisting `pending` into
 * this component and passing it down reddens **one** test -- `acting on
 * one mapping leaves the others alone`, on the assertion written for
 * exactly this (`the other mapping is still removable while this one is
 * in flight`: `true !== false`). Hoisting `editing` instead reddens the
 * same one test, on the assertion two lines further down (`the other row
 * did not open a form nobody asked it to`). Every other test in the file
 * stays green under both, which is the point: with one mapping on screen
 * a shared flag has nothing to spill onto, so only a test that puts two
 * up and acts on one of them can see it. `library/ReleaseList.tsx`
 * records the same split, and its own measurement is a different shape --
 * two tests, because that file has a walk that clicks six buttons in a
 * row.
 *
 * **Nothing here is refetched after a write** (Global Constraint). The
 * three controls call `submit` and stop; the row appears, changes or
 * leaves when the replica says so, through `useClientMappings`'s
 * subscriptions. So a control's success is not the row's -- see
 * {@link MappingRow} on why every control still re-enables anyway, where
 * `ReleaseList`'s Pick button deliberately does not.
 *
 * **Nothing here validates a path** (design spec §7). `clients/paths.ts`
 * refuses `node:path` because these are foreign paths, possibly
 * Windows-shaped, always from a machine that is not this one -- so a UI
 * that demanded a leading `/`, rejected a backslash or trimmed a trailing
 * space would be stricter than the consumer and would refuse mappings
 * that work. In particular the two inputs are **not** `required`:
 * `empty-path` is the host's one path-content rule and marking the fields
 * required here would make that refusal unreachable from this screen and
 * its sentence dead text.
 *
 * **Every name a screen reader announces is composed from text that is on
 * screen.** The expander, the list and each row's four buttons are all
 * named through `aria-labelledby` pointing at visible spans -- the client
 * heading `DownloadClients` renders, this component's own button labels,
 * and each mapping's own client path. `CLAUDE.md`'s longest testing
 * hazard is a component whose accessible name came from an `aria-label`
 * on an element with nothing in it; nothing here has an `aria-label` at
 * all.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import type { FilepathMappingSyncRead } from '@pickarr/contract';
import { useClientMappings, type ClientMappingsSource } from './useClientMappings.ts';
import {
  MAPPING_REFUSAL_MESSAGES,
  type AddMappingOutcome,
  type EditMappingOutcome,
  type MappingSubmit,
  type RemoveMappingOutcome,
} from './postMapping.ts';

/** Re-exported so a caller of this section needs one import, not two -- `useClientMappings.ts` is where it is declared, since that hook is what needs it narrowed. */
export type { ClientMappingsSource };

/**
 * The sentence for whatever a control was answered with, or `null` for an
 * outcome that was not a refusal at all.
 *
 * One function rather than the same `'refusal' in outcome` branch written
 * three times: the add, the edit and the remove have three different
 * success shapes and one failure shape, and this is the half they share.
 */
function refusalMessage(outcome: AddMappingOutcome | EditMappingOutcome | RemoveMappingOutcome): string | null {
  return 'refusal' in outcome ? MAPPING_REFUSAL_MESSAGES[outcome.refusal] : null;
}

/**
 * The announced error, and the one an operator can read, as the same
 * string in the same element.
 *
 * `CLAUDE.md`: `role` and `aria-*` are assertions about the *announced*
 * interface and prove nothing about the rendered one -- `IdentityChangeConfirm`
 * shipped with an `aria-label`, no visible text and no stylesheet rule,
 * passed ten tests, and the first human to see it misread it. Real text in
 * a real element is what makes the two impossible to drift apart.
 */
function Refusal({ message }: { message: string }): ReactElement {
  return (
    <div role="alert">
      <p>{message}</p>
    </div>
  );
}

interface PathFieldsProps {
  idPrefix: string;
  fromPath: string;
  toPath: string;
  onFromPath: (value: string) => void;
  onToPath: (value: string) => void;
}

/**
 * The two inputs every mapping form has, add and edit alike.
 *
 * **`Client path` and `Host path`, not `From` and `To`.** The column names
 * say which end of the translation each is; these say *whose machine* it
 * is on, which is the distinction an operator is actually making
 * (`FilepathMappingSyncRead`: "the prefix a download client reports" and
 * "what that prefix becomes for the host"). The refusal sentences in
 * `postMapping.ts` use the same two words, so the field a refusal is about
 * is the field it names.
 *
 * `idPrefix` is what keeps two expanded clients -- or one client's add
 * form and one of its rows' edit forms -- from sharing an input id, which
 * would point both labels at the same field.
 */
function PathFields({ idPrefix, fromPath, toPath, onFromPath, onToPath }: PathFieldsProps): ReactElement {
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-from`}>Client path</label>
        <input
          id={`${idPrefix}-from`}
          value={fromPath}
          onChange={(event) => {
            onFromPath(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-to`}>Host path</label>
        <input
          id={`${idPrefix}-to`}
          value={toPath}
          onChange={(event) => {
            onToPath(event.target.value);
          }}
        />
      </div>
    </>
  );
}

interface AddMappingProps {
  downloadClientId: number;
  idPrefix: string;
  submit: MappingSubmit;
}

/**
 * The add form for one client.
 *
 * `try`/`catch`/`finally { setPending(false) }`, matching
 * `AddDownloadClient.tsx`'s own hardened `handleSubmit` -- non-negotiable
 * regardless of what `submit` does, since it is an injected async function
 * and any implementation of it may reject. The `finally` is the only thing
 * that makes "the button always comes back" true; the feeds slice shipped
 * without one and wedged its form on five of six real host answers.
 *
 * A successful add clears both fields, because they identify the mapping
 * that was just accepted and the next one is a different pair. It does
 * **not** put a row on screen: that arrives from the replica or not at all.
 */
function AddMapping({ downloadClientId, idPrefix, submit }: AddMappingProps): ReactElement {
  const [fromPath, setFromPath] = useState('');
  const [toPath, setToPath] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = `${idPrefix}-heading`;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const outcome = await submit.add({ downloadClientId, fromPath, toPath });
      const message = refusalMessage(outcome);
      if (message === null) {
        setFromPath('');
        setToPath('');
        return;
      }
      setError(message);
    } catch {
      setError(MAPPING_REFUSAL_MESSAGES.offline);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      aria-labelledby={headingId}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      {/* An `<h4>`: one level under the `<h3>` `DownloadClients` gives each client's name, which is this form's parent in the outline as well as on screen. */}
      <h4 id={headingId}>Add a path mapping</h4>
      {error !== null && <Refusal message={error} />}
      <PathFields
        idPrefix={idPrefix}
        fromPath={fromPath}
        toPath={toPath}
        onFromPath={setFromPath}
        onToPath={setToPath}
      />
      <button type="submit" disabled={pending}>
        Add path mapping
      </button>
    </form>
  );
}

interface MappingRowProps {
  mapping: FilepathMappingSyncRead;
  submit: MappingSubmit;
}

/**
 * One mapping: the two paths as the replica holds them, and the two
 * controls that change it.
 *
 * **Every control re-enables after every outcome, success included**, and
 * that is where this deliberately differs from `library/ReleaseList.tsx`.
 * That button stays pending through an accepted pick because a second
 * pick on the same release is a wasted refusal and the row it is waiting
 * for is the only honest signal it is done. Here the wait has no such
 * floor: a `submit` that resolves and a replica that never catches up
 * would leave this row's Edit and Remove dead with nothing on screen
 * saying why, which is the wedge the `finally` exists to make
 * unreachable. A second Remove against a row already gone is answered
 * `unknown-mapping`, which is a sentence rather than a lost mapping.
 *
 * **Editing starts from the replica's value every time it opens**, not
 * from whatever the last abandoned edit left behind: `Cancel` that only
 * hid a change would be a change still there next time.
 */
function MappingRow({ mapping, submit }: MappingRowProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [fromPath, setFromPath] = useState(mapping.fromPath);
  const [toPath, setToPath] = useState(mapping.toPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idPrefix = `mapping-${String(mapping.id)}`;
  const fromId = `${idPrefix}-from-path`;
  const editId = `${idPrefix}-edit`;
  const removeId = `${idPrefix}-remove`;
  const saveId = `${idPrefix}-save`;
  const cancelId = `${idPrefix}-cancel`;

  function openEditor(): void {
    setFromPath(mapping.fromPath);
    setToPath(mapping.toPath);
    setError(null);
    setEditing(true);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const outcome = await submit.edit(mapping.id, { fromPath, toPath });
      const message = refusalMessage(outcome);
      if (message === null) {
        setEditing(false);
        return;
      }
      setError(message);
    } catch {
      setError(MAPPING_REFUSAL_MESSAGES.offline);
    } finally {
      setPending(false);
    }
  }

  async function remove(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      setError(refusalMessage(await submit.remove(mapping.id)));
    } catch {
      setError(MAPPING_REFUSAL_MESSAGES.offline);
    } finally {
      setPending(false);
    }
  }

  return (
    // Named from its own client path rather than from its contents: an
    // unlabelled `<li>` reads with an empty accessible name even when full
    // of visible text (measured, `ReleaseList.tsx`), and `from_path` is
    // unique per client by the index design spec §6 adds.
    <li aria-labelledby={fromId}>
      <span id={fromId}>{mapping.fromPath}</span>
      {/* Decoration, and hidden from the accessibility tree so it does not land inside any button's announced name. The two paths either side of it are the content. */}
      <span aria-hidden="true"> → </span>
      <span>{mapping.toPath}</span>
      {!editing && (
        <>
          {/*
            Each button's accessible name is composed from two spans of
            visible text -- its own label and this mapping's client path --
            because a list of buttons all named `Edit` is ambiguous
            announced, and an `aria-label` saying `Edit <path>` would be a
            second copy of a string already on screen. Self-reference in
            `aria-labelledby` resolves to the element's own content, so
            nothing announced here is not also rendered.
          */}
          <button
            type="button"
            id={editId}
            aria-labelledby={`${editId} ${fromId}`}
            disabled={pending}
            onClick={openEditor}
          >
            Edit
          </button>
          <button
            type="button"
            id={removeId}
            aria-labelledby={`${removeId} ${fromId}`}
            disabled={pending}
            onClick={() => {
              void remove();
            }}
          >
            Remove
          </button>
        </>
      )}
      {/*
        The edit form carries no accessible name of its own: `Save` and
        `Cancel` inside it are named from this row's client path, and a
        `<form>` with no name has no `form` role, so there is no unlabelled
        landmark announced here.
      */}
      {editing && (
        <form
          onSubmit={(event) => {
            void save(event);
          }}
        >
          <PathFields
            idPrefix={`${idPrefix}-editor`}
            fromPath={fromPath}
            toPath={toPath}
            onFromPath={setFromPath}
            onToPath={setToPath}
          />
          <button type="submit" id={saveId} aria-labelledby={`${saveId} ${fromId}`} disabled={pending}>
            Save
          </button>
          <button
            type="button"
            id={cancelId}
            aria-labelledby={`${cancelId} ${fromId}`}
            disabled={pending}
            onClick={() => {
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {error !== null && <Refusal message={error} />}
    </li>
  );
}

export interface ClientMappingsProps {
  source: ClientMappingsSource;
  /** The client these mappings belong to. Every listed row has this as its `downloadClientId`, and every added one is given it. */
  downloadClientId: number;
  /** The id of the element carrying this client's visible name, so the expander and the list are announced with it. `DownloadClients.tsx` puts it on the `<h3>`. */
  clientNameId: string;
  /** The three writes. Required, never defaulted -- see `postMapping.ts`'s `MappingSubmit`. */
  submit: MappingSubmit;
}

export function ClientMappings({
  source,
  downloadClientId,
  clientNameId,
  submit,
}: ClientMappingsProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const mappings = useClientMappings(source, downloadClientId);
  const toggleId = `client-${String(downloadClientId)}-mappings-toggle`;

  return (
    <div>
      <button
        type="button"
        id={toggleId}
        aria-expanded={expanded}
        aria-labelledby={`${toggleId} ${clientNameId}`}
        onClick={() => {
          setExpanded((value) => !value);
        }}
      >
        Path mappings
      </button>
      {expanded && (
        <>
          <AddMapping
            downloadClientId={downloadClientId}
            idPrefix={`client-${String(downloadClientId)}-add-mapping`}
            submit={submit}
          />
          {/*
            `undefined` is the first read still running and is neither of
            the two answers below; an empty array is "this client has
            none", which gets a sentence rather than an empty list nobody
            can interpret (Global Constraint: zero is an answer).
          */}
          {mappings !== undefined &&
            (mappings.length === 0 ? (
              <p>No path mappings for this download client.</p>
            ) : (
              <ul aria-labelledby={`${toggleId} ${clientNameId}`}>
                {mappings.map((mapping) => (
                  <MappingRow key={mapping.id} mapping={mapping} submit={submit} />
                ))}
              </ul>
            ))}
        </>
      )}
    </div>
  );
}
