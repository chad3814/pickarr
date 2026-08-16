/**
 * Replaces already-cached posters that are really 800x1200 crops of a scene's
 * background with the background image itself.
 *
 * A one-shot repair for libraries built before `readPosterUrl` learned to
 * prefer the background. Offline in the sense that matters: it makes no
 * ThePornDB API request and needs no API key, because the original image is
 * encoded inside the crop URL already stored on each row. It does fetch from
 * `cdn.theporndb.net`, and it overwrites files in the artwork directory.
 *
 *   npm run repair-posters -- --database=/config/pickarr.db --dry-run
 *   npm run repair-posters -- --database=/config/pickarr.db
 *
 * Stop Pickarr first. Nothing here coordinates with the running metadata
 * worker, and both write the same files.
 *
 * Re-runnable: a repaired row stops matching, and a row whose download failed
 * keeps its old url and file for the next attempt.
 *
 * This is a harness. Every judgement lives in `@pickarr/core`'s
 * `repairBackgroundPosters`, which has tests; the script only parses flags and
 * prints — see `parse-corpus.ts` for the same argument stated at length.
 */
// Reached by path rather than by package name, exactly as parse-corpus.ts is:
// @pickarr/core exports only its application entrypoint, and widening that for
// repo-local tooling would add production surface nothing ships against.
import { openDatabase } from '../packages/core/src/db/open.ts';
import { resolveArtworkDir } from '../packages/core/src/main.ts';
import {
  postersNeedingRepair,
  repairBackgroundPosters,
} from '../packages/core/src/media/repair-posters.ts';
import { backgroundFromCrop } from '../packages/core/src/clients/theporndb.ts';

interface Options {
  databasePath: string;
  /** Defaults to `artwork/` beside the database, as the application's own does. */
  artworkDir: string | null;
  /** Report what would change and write nothing. */
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
      'Usage: npm run repair-posters -- --database=<path> [--artwork=<dir>] [--dry-run]',
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

  if (options.dryRun) {
    // Deliberately not `repairBackgroundPosters` with a flag threaded through
    // it: a repair function that sometimes does not repair is a function whose
    // tested path and real path differ. This reads the same rows and applies
    // the same decoder, and writes nothing at all.
    const rows = postersNeedingRepair(db);
    console.log(`\n${rows.length} poster(s) would be replaced\n`);
    for (const row of rows) {
      const background = backgroundFromCrop(row.posterUrl);
      console.log(`  group ${row.groupId} (${row.posterPath ?? 'no cached file'})`);
      console.log(`    -> ${background ?? 'UNREADABLE — would be skipped'}`);
    }
    db.close();
    return;
  }

  const started = Date.now();
  const result = await repairBackgroundPosters({
    db,
    artwork: { dir: artworkDir, fetchImpl: fetch, log: (message) => console.log(`  ${message}`) },
    log: (message) => console.log(`  ${message}`),
  });
  db.close();

  console.log(
    `\n${result.repaired} repaired, ${result.failed} failed, of ${result.looked} found ` +
      `in ${Math.round((Date.now() - started) / 1000)}s`,
  );
  if (result.failed > 0) {
    console.log('Failed rows kept their existing poster; re-run to try them again.');
  }
}

main().catch((error: Error) => {
  console.error(`repair-posters: ${error.message}`);
  process.exit(1);
});
