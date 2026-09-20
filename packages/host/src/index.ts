export type { ReadServer, ReadServerDeps } from './api/server.ts';
export { API_VERSION, DEFAULT_HOST, DEFAULT_PORT, createReadServer } from './api/server.ts';
// `createAuth` and `ensureClaimToken` are the two pieces `createReadServer`'s
// own `authFor` needs that this package otherwise keeps internal -- exported
// for the same reason `Timers` below is: an external caller assembling a real
// `ReadServerDeps` (task 8's browser e2e harness, which boots the read API
// in-process rather than through `main`) cannot build an `Auth` instance or
// read the install's claim token any other way.
export { createAuth } from './auth/instance.ts';
export { ensureClaimToken } from './auth/claim.ts';
export { createDownloadClients } from './clients/downloads.ts';
// `randomIndex` is `createDownloadClients`'s required `chooseIndex` in
// production. Exported for the same external caller as `createAuth` above:
// the e2e harness builds its own `DownloadClients` and would otherwise have
// to invent a chooser, which is the one dependency it should not be
// choosing differently from `main`.
export type { ChooseIndex } from './clients/select.ts';
export { randomIndex } from './clients/select.ts';
export type { HostDb } from './db/open.ts';
export { openDatabase, openTestDatabase } from './db/open.ts';
export { migrateHost, migratePlugin } from './db/migrate.ts';
// `ensureSyncGeneration`, for the same external caller as `createAuth` above:
// `ReadServerDeps.generation` is minted from the database exactly this way in
// `main`, and there is no other public path to it.
export { ensureSyncGeneration } from './db/host-state.ts';
export type { FetchLimits, QueuedFetch } from './fetch/queue.ts';
export { createHostFetch } from './fetch/queue.ts';
export type { Host, NotifyOutcome } from './host.ts';
export { createHost, DEFAULT_MAX_ATTEMPTS, HOST_PLUGIN_ID } from './host.ts';
// `Timers` names the type of `createHost`'s own optional `timers` override
// -- a caller supplying one (a test standing up the dispatcher's clock
// deterministically, as `dispatcher.test.ts` already does for
// `createDispatcher` directly) needs to name it from outside this package.
export type { Timers } from './jobs/dispatcher.ts';
export type { PollResult } from './feeds/reader.ts';
export { createFeedReader } from './feeds/reader.ts';
export { main } from './main.ts';
// `createSyncRegistry`, for the same external caller once more:
// `ReadServerDeps.registry` needs one, and `media_item` (the table task 8's
// harness seeds and the shell's counts read) is a host table synced with no
// plugin involved at all, so an empty plugin list is a legitimate registry to
// build.
export { createSyncRegistry } from './sync/registry.ts';
