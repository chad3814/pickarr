/**
 * The `/settings` screen's download clients section: every configured
 * client, read from the replica, plus the form that adds one (design spec
 * §6). `Feeds.tsx`'s sibling, and deliberately the same shape -- a
 * `<section>` with a heading, the add form, then the list.
 *
 * **The route-mapping marker is not here.** It sits on `Settings.tsx`'s
 * root, which is this screen's root now that `/settings` holds two
 * sections; see that file's docblock.
 *
 * **Each listed client's name is an `<h3>`**, one level under this
 * section's own `<h2>`, for the reason `Feeds.tsx` records at length: the
 * stylesheet already rendered it as the third tier and the accessibility
 * tree still announced it as the second. Same shape as the feeds side, so
 * the two sections stay alike here too.
 *
 * **Every value is rendered as the replica holds it.** The host already
 * reduced `url` to origin and path (design spec §5), which drops userinfo,
 * query and fragment structurally -- so there is nothing here to parse,
 * repair or reconstruct, and doing so could only undo what the host
 * stripped. The one thing this section supplies of its own is the wording
 * around each value, including the two blank cases: `''` in `url` and `''`
 * in `category` are both real answers (`DownloadClientSyncRead`'s own doc),
 * and an empty line on screen states neither.
 *
 * **Each row now expands to that client's path mappings**
 * (`ClientMappings.tsx`, design spec §8). It is nested here rather than
 * given a section or a screen of its own because a mapping belongs to
 * exactly one client by foreign key and is meaningless away from it, and
 * because that is the only place an operator can see which client's paths
 * they are translating. This file supplies the client id and the id of the
 * heading its controls are named from, and nothing else: the mappings
 * list, its reads and its three writes are entirely that component's.
 *
 * **What this section does not say.** It never claims a client has an api
 * key on file. `DownloadClientSyncRead` projects no secret name and no
 * credential, deliberately, so the only evidence of authentication that
 * reaches this page is `username` -- which is present exactly when the
 * client signs in with a username and password. Design spec §6 says the
 * list "says whether a client has a credential configured"; §5's
 * projection only supports saying it for the login strategy, and inferring
 * the other from `username === null` would be a sentence about a row this
 * page has never seen. Naming the username is the whole of what is
 * honestly available.
 */
import type { ReactElement } from 'react';
import { useDownloadClients, type DownloadClientsSource } from './useDownloadClients.ts';
import { ClientMappings } from './ClientMappings.tsx';
import type { ClientMappingsSource } from './useClientMappings.ts';
import type { MappingSubmit } from './postMapping.ts';
import {
  AddDownloadClient,
  implementationLabel,
  type AddDownloadClientInput,
  type AddDownloadClientOutcome,
} from './AddDownloadClient.tsx';

/** Re-exported so a caller of this section needs one import, not two -- `useDownloadClients.ts` is where it is declared, since that hook is what needs it narrowed. */
export type { DownloadClientsSource };

/**
 * Both hooks this section drives: its own list of clients, and the
 * per-client mappings hook `ClientMappings` mounts inside each row.
 *
 * An intersection rather than the wider `Store`, on `Settings.tsx`'s own
 * reasoning: writing down "both" means a nested component that grows a
 * requirement widens this type by itself instead of silently relying on
 * the outer one's declaration. `ClientMappingsSource` is the one that
 * brings `subscribe`, which no settings list needed until a list gained an
 * edit and a delete.
 */
export type DownloadClientsListSource = DownloadClientsSource & ClientMappingsSource;

/** The id on one client's name heading, spelled once so the heading and everything named from it cannot disagree. */
function clientNameId(id: number): string {
  return `download-client-${String(id)}-name`;
}

export interface DownloadClientsProps {
  source: DownloadClientsListSource;
  /** Posts a new download client. Required, not defaulted -- see `AddDownloadClient.tsx`'s own docblock. */
  submit: (input: AddDownloadClientInput) => Promise<AddDownloadClientOutcome>;
  /** Adds, edits and removes a path mapping. Required for the same reason -- see `postMapping.ts`'s `MappingSubmit`. */
  submitMapping: MappingSubmit;
}

export function DownloadClients({ source, submit, submitMapping }: DownloadClientsProps): ReactElement {
  const clients = useDownloadClients(source);

  return (
    <section aria-labelledby="download-clients-heading">
      <h2 id="download-clients-heading">Download clients</h2>
      <AddDownloadClient submit={submit} />
      {clients !== undefined &&
        (clients.length === 0 ? (
          <p>No download clients yet.</p>
        ) : (
          <ul aria-label="download clients">
            {clients.map((client) => (
              <li key={client.id}>
                {/*
                  The heading carries an id now, because `ClientMappings`
                  names its expander and its list from it. That is the
                  whole reason it is here: a mapping's controls have to be
                  distinguishable between clients, and composing their
                  accessible names from this visible heading is what avoids
                  an `aria-label` repeating a string already on screen.
                */}
                <h3 id={clientNameId(client.id)}>{client.name}</h3>
                <p>{implementationLabel(client.implementation)}</p>
                <p>{client.url === '' ? 'No address recorded.' : client.url}</p>
                <p>{client.category === '' ? 'No category' : `Category: ${client.category}`}</p>
                {client.username !== null && <p>{`Signs in as ${client.username}`}</p>}
                <ClientMappings
                  source={source}
                  downloadClientId={client.id}
                  clientNameId={clientNameId(client.id)}
                  submit={submitMapping}
                />
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
