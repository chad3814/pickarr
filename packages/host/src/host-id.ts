/**
 * The host's own plugin id. `jobs.plugin_id` is `NOT NULL` and handlers are
 * keyed by `(pluginId, kind)`, so a job the host itself owns still needs a
 * plugin id to dispatch on -- this is the one no plugin may claim.
 * `register` refuses it outright, so a plugin can never silently capture the
 * host's own handlers (`poll` and `reconcile`). It declares no tables, so
 * `migratePlugin`'s `<pluginId>_` prefix rule never applies to it -- nothing
 * ever calls `migratePlugin` with this id.
 *
 * Its own module, rather than living in `host.ts` beside the code that uses
 * it most, purely to keep the import graph acyclic: `clients/reconcile-job.ts`
 * needs this constant and `host.ts` needs that module's handler factory. A
 * cycle between the two works only for as long as every use stays inside a
 * function body -- a `const` read at module-evaluation time on the wrong side
 * of an ESM cycle is `undefined`, and the failure would surface far from the
 * edit that caused it. One module holding one string removes the question.
 */
export const HOST_PLUGIN_ID = 'host';
