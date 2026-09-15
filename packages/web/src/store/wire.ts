/**
 * The wire shape of one sync op.
 *
 * Mirrored from `packages/host/src/sync/tail.ts`'s `SyncOp` rather than
 * imported from `@pickarr/host`: that package is the server, this one ships
 * to a browser, and the two sides only need to agree on the JSON shape that
 * crosses the wire between them, not on a shared module.
 */
export interface SyncOp {
  op: 'create' | 'upsert' | 'delete';
  table: string;
  /** The row's primary key in `table`. Present on every op. */
  id: number;
  /** Present on a create and an upsert: the row as the client receives it. Absent on a delete. */
  value?: unknown;
}
