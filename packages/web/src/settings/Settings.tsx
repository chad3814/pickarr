/**
 * The `/settings` route's whole screen: the feeds section and the download
 * clients section, one under the other (design spec §6 -- "the existing
 * `/settings` route gains a second section ... a separate route would split
 * one page across two urls for no reason a user could name").
 *
 * **A parent component rather than a second section bolted into
 * `Feeds.tsx`**, for three reasons, the first of which is structural.
 * `base.css` gives the routed screen its share of the shell's flex row with
 * `#root > div > section { flex: 1; min-width: 0 }` -- a selector that
 * matches every `<section>` the route renders directly. Two sibling
 * sections returned straight from the route would both match it and take
 * half the row each, side by side, which is a layout nobody asked for; one
 * wrapping `<section>` keeps that rule pointing at exactly one element and
 * leaves the two inner sections as ordinary blocks inside it. Second, each
 * section keeps its own data hook, so neither list's first read is a
 * precondition for the other's (`Settings.test.tsx` drives a stalled
 * `download_client` read and watches the feeds list render anyway). Third,
 * `Feeds.tsx` stays about feeds.
 *
 * **`data-testid="settings"` moved here from `Feeds.tsx`.** It carries the
 * route-mapping contract `library/Category.tsx`'s `category-${pluginId}`
 * and `library/Unmatched.tsx`'s `unmatched` also carry:
 * `shell/Shell.test.tsx`'s mapping tests find whichever screen renders at
 * each route by this marker alone, not by rendered prose, so a screen's own
 * text and layout stay free to change. It belongs on the screen's root, and
 * the feeds section stopped being that when this file landed.
 *
 * **One `source` for both sections, two hooks reading it.** The prop is the
 * store, which is a single replica; independence is a property of the hooks
 * (each subscribes to its own table and holds its own state), not of having
 * two connections.
 */
import type { ReactElement } from 'react';
import { Feeds } from './Feeds.tsx';
import { DownloadClients } from './DownloadClients.tsx';
import type { FeedsSource } from './useFeeds.ts';
import type { DownloadClientsListSource } from './DownloadClients.tsx';
import type { AddFeedInput, AddFeedOutcome } from './AddFeed.tsx';
import type { AddDownloadClientInput, AddDownloadClientOutcome } from './AddDownloadClient.tsx';
import type { MappingSubmit } from './postMapping.ts';

/**
 * Whatever both sections need. An intersection rather than either one
 * alone: writing that down as "both" means a section that grows a
 * requirement widens this type by itself instead of silently relying on
 * the other section's declaration.
 *
 * **They no longer want the same members, and this is the change that
 * ended that.** The feeds side still needs `listByTable` and
 * `subscribeInserts`; the download clients side now also needs
 * `subscribe`, because each client row expands to a mappings list with an
 * edit and a delete in it, and `store/apply.ts` reports neither as an
 * insert. `DownloadClientsListSource` is where that is declared, so this
 * line stays a statement about the two sections rather than a second
 * inventory of their members.
 */
export type SettingsSource = FeedsSource & DownloadClientsListSource;

export interface SettingsProps {
  source: SettingsSource;
  /** Posts a new feed. Required, not defaulted -- see `AddFeed.tsx`'s own docblock on why neither of these has a default that performs network I/O. */
  submitFeed: (input: AddFeedInput) => Promise<AddFeedOutcome>;
  /** Posts a new download client. Required for the same reason. */
  submitDownloadClient: (input: AddDownloadClientInput) => Promise<AddDownloadClientOutcome>;
  /** Adds, edits and removes a path mapping inside a download client's row. Required for the same reason -- `postMapping.ts`'s `MappingSubmit` has it at length. */
  submitMapping: MappingSubmit;
}

export function Settings({
  source,
  submitFeed,
  submitDownloadClient,
  submitMapping,
}: SettingsProps): ReactElement {
  return (
    <section aria-labelledby="settings-heading" data-testid="settings">
      <h1 id="settings-heading">Settings</h1>
      <Feeds source={source} submit={submitFeed} />
      <DownloadClients source={source} submit={submitDownloadClient} submitMapping={submitMapping} />
    </section>
  );
}
