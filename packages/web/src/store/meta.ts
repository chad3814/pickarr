/**
 * Accessors for the `meta` store: the sync cursors and the database
 * generation (design spec §5, §6).
 *
 * Every accessor takes either an `IDBDatabase` or an `IDBTransaction`. A
 * caller passing its own transaction can join a cursor write to the same
 * transaction as the rows it covers — task 2 needs exactly that, because the
 * cursor advance has to commit atomically with the ops it covers, and an
 * accessor that always opened its own transaction could never be made
 * atomic with anything else.
 */
import { request } from './idb.ts';

/** The tail cursor (`since`) and the backfill cursor. `before: null` means the backfill has retired (spec §5). */
export interface Cursors {
  since: number;
  before: number | null;
}

interface CursorsRecord {
  key: 'cursors';
  since: number;
  before: number | null;
}

interface GenerationRecord {
  key: 'generation';
  value: string;
}

function metaStore(target: IDBDatabase | IDBTransaction, mode: IDBTransactionMode): IDBObjectStore {
  const tx = target instanceof IDBTransaction ? target : target.transaction('meta', mode);
  return tx.objectStore('meta');
}

/** `undefined` on a fresh database — task 6 bootstraps from that. */
export async function readCursors(target: IDBDatabase | IDBTransaction): Promise<Cursors | undefined> {
  const record = await request<CursorsRecord | undefined>(metaStore(target, 'readonly').get('cursors'));
  return record === undefined ? undefined : { since: record.since, before: record.before };
}

export async function writeCursors(target: IDBDatabase | IDBTransaction, cursors: Cursors): Promise<void> {
  const record: CursorsRecord = { key: 'cursors', since: cursors.since, before: cursors.before };
  await request(metaStore(target, 'readwrite').put(record));
}

/** `undefined` on a fresh database — task 6 bootstraps from that. */
export async function readGeneration(target: IDBDatabase | IDBTransaction): Promise<string | undefined> {
  const record = await request<GenerationRecord | undefined>(metaStore(target, 'readonly').get('generation'));
  return record?.value;
}

export async function writeGeneration(target: IDBDatabase | IDBTransaction, generation: string): Promise<void> {
  const record: GenerationRecord = { key: 'generation', value: generation };
  await request(metaStore(target, 'readwrite').put(record));
}
