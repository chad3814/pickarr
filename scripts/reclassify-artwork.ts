/**
 * Corrects rows migration 15 could not, by measuring the cached file already
 * on disk.
 *
 * A migration gets a database and nothing else, so migration 15 classifies
 * existing poster/background rows by URL shape and deliberately leaves the
 * ambiguous remainder — studio-CDN images whose shape nothing in the payload
 * records — filed as posters rather than guessed at. This measures each
 * cached file with `classifyArtwork` and moves a row, url and path together,
 * whenever the measurement disagrees with the column it is in.
 *
 * Where the correct slot is already filled the mismatching image cannot be
 * moved anywhere, so the row's column is cleared and the image's file deleted —
 * an image that cannot be correctly placed is not kept under a name that
 * misdescribes it, and is not left on disk unreferenced either.
 *
 * Offline in the fullest sense: no network request, no API key, nothing but
 * local bytes already on disk. It does write to the database, and it deletes an
 * artwork file for every row it clears.
 *
 *   npm run reclassify-artwork -- --database=/config/pickarr.db --dry-run
 *   npm run reclassify-artwork -- --database=/config/pickarr.db
 *
 * Stop Pickarr first. Nothing here coordinates with the running metadata
 * worker, and both could touch the same row.
 *
 * Re-runnable: a row already agreeing with its own column is left alone, so a
 * second pass over a clean library moves nothing.
 *
 * This is a harness. Every judgement lives in `@pickarr/core`'s
 * `reclassifyArtwork`, which has tests; the script only parses flags and
 * prints — see `parse-corpus.ts` for the same argument stated at length.
 */
// Reached by path rather than by package name, exactly as parse-corpus.ts is:
// @pickarr/core exports only its application entrypoint, and widening that for
// repo-local tooling would add production surface nothing ships against.
import { openDatabase } from '../packages/core/src/db/open.ts';
import { resolveArtworkDir } from '../packages/core/src/main.ts';
import { reclassifyArtwork } from '../packages/core/src/media/reclassify.ts';

interface Options {
  databasePath: string;
  /** Defaults to `artwork/` beside the database, as the application's own does. */
  artworkDir: string | null;
  /** Report what would move and change nothing, in the database or on disk. */
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { databasePath: '', artworkDir: null, dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith('--database=')) options.databasePath = arg.slice('--database='.length);
    else if (arg.startsWith('--artwork=')) options.artworkDir = arg.slice('--artwork='.length);
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.databasePath.length === 0) {
    throw new Error(
      'Usage: npm run reclassify-artwork -- --database=<path> [--artwork=<dir>] [--dry-run]',
    );
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = openDatabase(options.databasePath);
  const artworkDir = resolveArtworkDir(options.databasePath, options.artworkDir ?? undefined);

  console.log(`database : ${options.databasePath}`);
  console.log(`artwork  : ${artworkDir}`);
  if (options.dryRun) console.log('dry run  : nothing will be written or deleted');

  const started = Date.now();
  const result = await reclassifyArtwork({
    db,
    dir: artworkDir,
    dryRun: options.dryRun,
    log: (message) => console.log(`  ${message}`),
  });
  db.close();

  // `cleared` is reported as a deletion rather than by its internal name: an
  // operator reading one summary line should not have to already know that
  // clearing a column also removes the file underneath it. Under --dry-run the
  // same number is an intention, and reads as one.
  const clearedLabel = options.dryRun ? 'would be deleted' : 'deleted';
  console.log(
    `\n${result.moved} moved, ${result.cleared} ${clearedLabel}, ${result.unreadable} unreadable, ` +
      `of ${result.examined} examined in ${Math.round((Date.now() - started) / 1000)}s`,
  );
  if (options.dryRun && (result.moved > 0 || result.cleared > 0)) {
    console.log('Dry run: nothing was written or deleted. Re-run without --dry-run to apply.');
  }
  if (result.cleared > 0) {
    console.log(
      options.dryRun
        ? 'Those rows hold an image the correct slot is already filled with, so it would be dropped from the row and deleted from the artwork directory.'
        : 'Those rows held an image the correct slot was already filled with, so it was dropped from the row and deleted from the artwork directory.',
    );
  }
  if (result.unreadable > 0) {
    console.log('Unreadable rows were left as they were; re-run to try them again.');
  }
}

main().catch((error: Error) => {
  console.error(`reclassify-artwork: ${error.message}`);
  process.exit(1);
});
