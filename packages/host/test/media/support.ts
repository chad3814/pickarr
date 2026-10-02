import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtworkStore } from '../../src/artwork/store.ts';
import { createArtworkStore } from '../../src/artwork/store.ts';

/** Hooks for a writer under test that never drops an item through `reassignRelease`. */
export const noHooks = { dropRows: async (): Promise<void> => {} };

/** One entry per call to the log function a real `createArtworkStore` was built with. */
export interface LoggedCall {
  message: string;
  detail: Readonly<Record<string, unknown>> | undefined;
}

/**
 * A minimal, valid GIF: `image-size` reads width and height straight out of
 * the logical screen descriptor (bytes 6-9), with no CRC or pixel data
 * needed -- probed directly against `image-size` before this file was
 * written. Far cheaper than constructing a PNG, which does need a valid CRC
 * per chunk.
 */

/**
 * A real `ArtworkStore` backed by a fresh temp directory, removed afterward
 * so a test that attaches artwork does not leave files behind. Real, rather
 * than a fake that skips the filesystem: these tests are exactly the ones
 * that need to prove the row and the cached file agree. `logs` collects
 * every call the store's `log` made, for the one test that needs to see one.
 */
export async function withArtworkStore(
  run: (artwork: ArtworkStore, dir: string, logs: LoggedCall[]) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-writer-artwork-'));
  const logs: LoggedCall[] = [];
  try {
    await run(createArtworkStore(dir, (message, detail) => logs.push({ message, detail })), dir, logs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** An rss feed, inserted directly: nothing in `MediaWriter` writes this table. */
export function insertFeed(raw: DatabaseSync, url: string): number {
  const result = raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `).run('alpha', 'a feed', url, 0, 0);
  return Number(result.lastInsertRowid);
}

