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
 * **Every value is rendered as the replica holds it.** The host already
 * reduced `url` to origin and path (design spec §5), which drops userinfo,
 * query and fragment structurally -- so there is nothing here to parse,
 * repair or reconstruct, and doing so could only undo what the host
 * stripped. The one thing this section supplies of its own is the wording
 * around each value, including the two blank cases: `''` in `url` and `''`
 * in `category` are both real answers (`DownloadClientSyncRead`'s own doc),
 * and an empty line on screen states neither.
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
import {
  AddDownloadClient,
  implementationLabel,
  type AddDownloadClientInput,
  type AddDownloadClientOutcome,
} from './AddDownloadClient.tsx';

/** Re-exported so a caller of this section needs one import, not two -- `useDownloadClients.ts` is where it is declared, since that hook is what needs it narrowed. */
export type { DownloadClientsSource };

export interface DownloadClientsProps {
  source: DownloadClientsSource;
  /** Posts a new download client. Required, not defaulted -- see `AddDownloadClient.tsx`'s own docblock. */
  submit: (input: AddDownloadClientInput) => Promise<AddDownloadClientOutcome>;
}

export function DownloadClients({ source, submit }: DownloadClientsProps): ReactElement {
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
                <h2>{client.name}</h2>
                <p>{implementationLabel(client.implementation)}</p>
                <p>{client.url === '' ? 'No address recorded.' : client.url}</p>
                <p>{client.category === '' ? 'No category' : `Category: ${client.category}`}</p>
                {client.username !== null && <p>{`Signs in as ${client.username}`}</p>}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
