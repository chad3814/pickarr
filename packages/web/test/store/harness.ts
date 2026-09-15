import 'fake-indexeddb/auto';
import { openStore } from '../../src/store/db.ts';

let counter = 0;

/** A database no other test shares, so tests need no cleanup order. */
export async function freshDb(): Promise<IDBDatabase> {
  counter += 1;
  return openStore(`test-${String(counter)}`);
}
