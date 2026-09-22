/**
 * `createLibraryImporter`: the half of the importer that touches a disk.
 *
 * **Every test here makes its own temporary directory and removes it.**
 * Nothing in this file names a real library path, and `withHarness` is the
 * only way a test gets a root -- so a test that forgot to clean up would
 * have had to write its own `mkdtemp` to do it.
 *
 * **The copy is injectable and the default is not.** `copyFile` is a seam
 * for the two things a real `copyFile` will not do on demand: fail *part
 * way through*, writing some bytes and then throwing, and occupy the
 * destination in the instant between the copy and the rename. **Five of the
 * 33 tests here inject one** -- the two atomicity tests, the two errno
 * tests, and the clobber-race test; the other twenty-eight run the real
 * `node:fs/promises` copy, so the default path is exercised rather than
 * mocked away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadEntry, DownloadedFile, ImportOutcome, ImportRefusalCode, TokenValues } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createLibraryImporter } from '../../src/media/import.ts';
import type { CopyFile } from '../../src/media/import.ts';

const PLUGIN_ID = 'tv';
const TV_SHAPE = '{series}/Season {season}/{series} - S{season}E{episode}.{ext}';
const SOURCE_BYTES = 'the finished download';

/**
 * A segment no real path has, so a test can prove a refusal or a log line
 * carries nothing from the path by searching the whole serialised value --
 * the shape `openmetadata`'s own "carries no path" test uses, which catches
 * a leak under a renamed key as well as under the expected one.
 */
const PATH_MARKER = 'PICKARR-PATH-MARKER-7c41ab';

interface Harness {
  raw: DatabaseSync;
  /** The temporary directory everything below lives under. */
  dir: string;
  /** `<dir>/library`, created unless a test says otherwise. */
  root: string;
  /** The file standing in for a finished download. Created, with {@link SOURCE_BYTES}. */
  source: string;
  /** A `DownloadedFile` for `source`, matched to media item 42 unless overridden. */
  file: (over?: Partial<DownloadedFile>) => DownloadedFile;
  /** Writes the plugin's destination row directly, so a test names exactly the fields it is about. */
  destination: (row: { root?: string; shape?: string; unmatchedDir?: string }) => void;
  place: (
    file: DownloadedFile,
    values: TokenValues | (() => Promise<TokenValues>),
  ) => Promise<ImportOutcome>;
  /** Replaces the copy for the next importer built. Only the atomicity tests use it. */
  withCopyFile: (copyFile: CopyFile) => Harness['place'];
  /** An entry for a plain-file download: the file itself, under its own basename. */
  entryFor: (file: DownloadedFile) => DownloadEntry;
  /** `place` with an explicit entry. */
  placeEntry: (file: DownloadedFile, entry: DownloadEntry, values: TokenValues) => Promise<ImportOutcome>;
  list: (file: DownloadedFile) => ReturnType<ReturnType<typeof createLibraryImporter>['list']>;
}

/** The entry `list` gives a plain-file download: the file itself, under its own basename. */
function entryFor(file: DownloadedFile): DownloadEntry {
  return { path: file.path, relativePath: basename(file.path), sizeBytes: file.sizeBytes };
}

async function withHarness(
  options: { createRoot?: boolean },
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-import-'));
  try {
    const { raw } = openTestDatabase();
    migrateHost(raw);
    const root = join(dir, 'library');
    if (options.createRoot !== false) await mkdir(root);
    const source = join(dir, 'downloads', `${PATH_MARKER}.mkv`);
    await mkdir(join(dir, 'downloads'));
    await writeFile(source, SOURCE_BYTES);

    function destination(over: { root?: string; shape?: string; unmatchedDir?: string }): void {
      raw.prepare(`
        INSERT INTO plugin_destination
          (plugin_id, root, shape, unmatched_dir, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 1)
        ON CONFLICT (plugin_id) DO UPDATE SET
          root = excluded.root, shape = excluded.shape, unmatched_dir = excluded.unmatched_dir
      `).run(PLUGIN_ID, over.root ?? root, over.shape ?? TV_SHAPE, over.unmatchedDir ?? '_unmatched');
    }

    function placeWith(copyFile?: CopyFile): Harness['place'] {
      const importer = copyFile === undefined
        ? createLibraryImporter({ raw, pluginId: PLUGIN_ID })
        : createLibraryImporter({ raw, pluginId: PLUGIN_ID, copyFile });
      return async (file, values) => importer.place(
        file,
        entryFor(file),
        typeof values === 'function' ? values : async () => values,
      );
    }
    const importer = createLibraryImporter({ raw, pluginId: PLUGIN_ID });

    const harness: Harness = {
      raw,
      dir,
      root,
      source,
      file: (over) => ({
        path: source,
        sizeBytes: SOURCE_BYTES.length,
        downloadClientId: 1,
        rssItemId: 7,
        mediaItemId: 42,
        ...over,
      }),
      destination,
      place: placeWith(),
      withCopyFile: (copyFile) => placeWith(copyFile),
      entryFor,
      placeEntry: async (file, entry, values) => importer.place(file, entry, async () => values),
      list: async (file) => importer.list(file),
    };
    await run(harness);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Everything under `dir`, relative and sorted, so a test can assert "nothing was written". */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .toSorted();
}

/** Whether anything at all is at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asserts the whole refusal, `errno` included, and that nothing in it came
 * from a path.
 *
 * `deepEqual` on the object rather than a read of `.refusal`, the shape
 * `media/shape.test.ts` uses and for the same reason: a refusal that grew a
 * field carrying the offending path would redden every one of these rather
 * than none of them.
 */
function assertRefusal(outcome: ImportOutcome, code: ImportRefusalCode): void {
  assert.deepEqual(outcome, { refusal: code, errno: null });
  assert.ok(!JSON.stringify(outcome).includes(PATH_MARKER), 'the refusal carries the path');
}

/** The resolved values the television shape above needs, already padded. */
const TV_VALUES: TokenValues = { series: 'Severance', season: '02', episode: '03', ext: 'mkv' };

test('spec 8.2: a matched episode lands at exactly the path the shape names, directories and all', async () => {
  await withHarness({}, async (h) => {
    h.destination({});

    const outcome = await h.place(h.file(), TV_VALUES);

    assert.deepEqual(outcome, { placed: 'library' });
    assert.deepEqual(await tree(h.root), [join('Severance', 'Season 02', 'Severance - S02E03.mkv')]);
    assert.equal(
      await readFile(join(h.root, 'Severance', 'Season 02', 'Severance - S02E03.mkv'), 'utf8'),
      SOURCE_BYTES,
    );
  });
});

test('spec 4 and 9: the source is still there afterwards, byte for byte, and nothing else in the download directory moved', async () => {
  await withHarness({}, async (h) => {
    h.destination({});

    await h.place(h.file(), TV_VALUES);

    // Copy, never move: design spec §4. Both halves are asserted, because a
    // `rename` from the download directory would leave the library right and
    // the source gone, and only the second assertion sees that.
    assert.deepEqual(await tree(join(h.dir, 'downloads')), [`${PATH_MARKER}.mkv`]);
    assert.equal(await readFile(h.source, 'utf8'), SOURCE_BYTES);
  });
});

test('spec 7: a copy that fails part way leaves no file at the final path', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const final = join(h.root, 'Severance', 'Season 02', 'Severance - S02E03.mkv');
    // The seam, because a real `copyFile` cannot be asked to write half a
    // file and then fail. This writes to whatever path the importer hands
    // it -- so if the importer ever copies straight to the final name, the
    // partial bytes land there and the assertion below reddens. That is the
    // whole of this test.
    const place = h.withCopyFile(async (_source, target) => {
      await writeFile(target, 'half of ');
      throw Object.assign(new Error('the volume went away'), { code: 'EIO' });
    });

    const outcome = await place(h.file(), TV_VALUES);

    assert.deepEqual(outcome, { refusal: 'copy-failed', errno: 'EIO' });
    assert.ok(!(await exists(final)), 'a partial file is sitting at the final path');
    // And the partial one really was written, so the test is not passing
    // because the copy never ran at all.
    const written = await tree(h.root);
    assert.equal(written.length, 1, `expected one temporary, found ${written.join(', ')}`);
    assert.ok(written[0]?.endsWith('.pickarr-import-tmp'), `not a temporary: ${written[0] ?? ''}`);
  });
});

test('spec 4: the temporary is in the destination directory, so the rename into place is same-directory', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const targets: string[] = [];
    const place = h.withCopyFile(async (_source, target) => {
      targets.push(target);
      await writeFile(target, SOURCE_BYTES);
    });

    await place(h.file(), TV_VALUES);

    const [target] = targets;
    assert.ok(target !== undefined, 'the copy was never called');
    const expectedDir = join(h.root, 'Severance', 'Season 02');
    assert.equal(
      target.slice(0, target.lastIndexOf('/')),
      expectedDir,
      'the temporary is not beside the file it becomes, so the rename can cross a filesystem',
    );
    assert.notEqual(target, join(expectedDir, 'Severance - S02E03.mkv'));
  });
});

test('spec 5: a destination that already exists is refused, and nothing at it changes', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const dir = join(h.root, 'Severance', 'Season 02');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'Severance - S02E03.mkv'), 'the copy already there');

    const outcome = await h.place(h.file(), TV_VALUES);

    assertRefusal(outcome, 'destination-exists');
    assert.equal(await readFile(join(dir, 'Severance - S02E03.mkv'), 'utf8'), 'the copy already there');
    // No temporary either: the refusal is reached before anything is copied.
    assert.deepEqual(await tree(h.root), [join('Severance', 'Season 02', 'Severance - S02E03.mkv')]);
  });
});

test('spec 5: a destination that appears *during* the copy is refused, and the file that appeared is not replaced', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const final = join(h.root, 'Severance', 'Season 02', 'Severance - S02E03.mkv');
    const ALREADY_THERE = 'the copy that arrived while this one was running';
    // The window the module doc argues at length -- `rename(2)` replaces an
    // existing destination silently, so the occupied-destination check is
    // made a second time immediately before the rename. The test above
    // reaches only the *first* check and says so; this is the only way to
    // reach the second, because the destination has to be empty when the
    // first runs and occupied when the rename would fire. The `copyFile`
    // seam is what supplies that instant: a real copy gives a test nothing
    // between the two checks.
    const place = h.withCopyFile(async (_source, temporary) => {
      await writeFile(final, ALREADY_THERE);
      await writeFile(temporary, SOURCE_BYTES);
    });

    const outcome = await place(h.file(), TV_VALUES);

    assertRefusal(outcome, 'destination-exists');
    // Delete the second check and this line is what reddens: the rename
    // succeeds, `{ placed: 'library' }` comes back, and the bytes below are
    // the download's. `contract/src/library.ts` says `destination-exists`
    // exists because "overwriting destroys whichever copy was better with
    // nothing recorded", and that is exactly this.
    assert.equal(await readFile(final, 'utf8'), ALREADY_THERE,
      'the rename replaced a file that appeared during the copy, and reported success');
  });
});

test('spec 5: a dangling symlink at the destination is something already there, and is not replaced', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const dir = join(h.root, 'Severance', 'Season 02');
    await mkdir(dir, { recursive: true });
    const final = join(dir, 'Severance - S02E03.mkv');
    // A link whose target does not exist. `stat` follows the link and
    // reports `ENOENT`, so a check written with `stat` calls this
    // destination empty and lets the rename replace the link; `lstat` sees
    // the link itself. The link is a library entry someone made, and the
    // volume it points at being unmounted is exactly when an import runs
    // against it.
    await symlink(join(h.dir, 'not-mounted', 'Severance - S02E03.mkv'), final);

    const outcome = await h.place(h.file(), TV_VALUES);

    assertRefusal(outcome, 'destination-exists');
    assert.ok((await lstat(final)).isSymbolicLink(),
      'the import replaced a symlink it should have treated as an occupied destination');
    await assert.rejects(() => readFile(final, 'utf8'), { code: 'ENOENT' },
      'the link is no longer dangling, so something was written at or through it');
  });
});

test('spec 7: a destination root that does not exist is refused and is not created', async () => {
  await withHarness({ createRoot: false }, async (h) => {
    h.destination({});

    const outcome = await h.place(h.file(), TV_VALUES);

    assertRefusal(outcome, 'missing-root');
    assert.ok(!(await exists(h.root)), 'the importer created the root it was told not to');
    // Not one level of it, either -- an importer that invented `<root>/Severance`
    // and stopped would pass an assertion about the root alone.
    assert.deepEqual(await tree(h.dir), [join('downloads', `${PATH_MARKER}.mkv`)]);
  });
});

test('spec 7: a root that exists but is a file is refused the same way, and is not overwritten', async () => {
  await withHarness({ createRoot: false }, async (h) => {
    await writeFile(h.root, 'not a directory');
    h.destination({});

    const outcome = await h.place(h.file(), TV_VALUES);

    assertRefusal(outcome, 'missing-root');
    assert.equal(await readFile(h.root, 'utf8'), 'not a directory');
  });
});

test('spec 4.3: an unmatched single-file download lands in its own directory, named for the file without its extension', async () => {
  await withHarness({}, async (h) => {
    h.destination({ unmatchedDir: '_pickarr/unmatched' });

    const outcome = await h.place(h.file({ mediaItemId: null }), TV_VALUES);

    assert.deepEqual(outcome, { placed: 'unmatched' });
    // Nested is allowed (design spec §6) and the whole source filename is
    // kept -- the shape is not consulted at all, so `Severance` appears
    // nowhere.
    assert.deepEqual(await tree(h.root), [join('_pickarr', 'unmatched', PATH_MARKER, `${PATH_MARKER}.mkv`)]);
  });
});

test('spec 6: an unmatched release lands in `_unmatched` when the destination was saved without one', async () => {
  await withHarness({}, async (h) => {
    // Through the real writer, not a literal: `_unmatched` is
    // `saveDestination`'s default and the column has none, so a test that
    // wrote the string itself would pin this file's idea of the default
    // rather than the host's.
    const { saveDestination } = await import('../../src/media/destinations.ts');
    const saved = saveDestination(
      { raw: h.raw, now: () => 1, tokensFor: () => ['series', 'season', 'episode', 'ext'] },
      PLUGIN_ID,
      { root: h.root, shape: TV_SHAPE, unmatchedDir: undefined },
    );
    assert.ok(!('refusal' in saved), 'the destination this test needs was refused');

    const outcome = await h.place(h.file({ mediaItemId: null }), TV_VALUES);

    assert.deepEqual(outcome, { placed: 'unmatched' });
    assert.deepEqual(await tree(h.root), [join('_unmatched', PATH_MARKER, `${PATH_MARKER}.mkv`)]);
  });
});

test('spec 6: tokens are not resolved at all for an unmatched release', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    let calls = 0;

    await h.place(h.file({ mediaItemId: null }), async () => {
      calls += 1;
      return TV_VALUES;
    });

    // The plugin would be querying its own tables for a title no row holds.
    // `LibraryImporter.place` takes a function rather than a map precisely so
    // this branch can decline to call it.
    assert.equal(calls, 0, 'the unmatched branch resolved tokens it cannot use');
  });
});

test('spec 6: an unmatched directory stored as `.` is refused rather than filling the library root', async () => {
  await withHarness({}, async (h) => {
    // `.`, `./` and `a/.` are accepted by `saveDestination` today -- found by
    // the destinations review, and its fix to make. Re-checked here at the
    // point of use rather than trusted, because the same check has to exist
    // for the resolved shape anyway and this validator was demonstrably
    // wrong once.
    for (const unmatchedDir of ['.', './', './.']) {
      h.destination({ unmatchedDir });

      // eslint-disable-next-line no-await-in-loop -- each iteration asserts the filesystem is still empty, which the next one would otherwise race
      const outcome = await h.place(h.file({ mediaItemId: null }), TV_VALUES);

      assertRefusal(outcome, 'unmatched-dir-is-root');
      // eslint-disable-next-line no-await-in-loop -- see above
      assert.deepEqual(await tree(h.root), [], `"${unmatchedDir}" put a file in the library root`);
    }
  });
});

test('spec 6: an unmatched directory that escapes the root is refused, under either separator', async () => {
  await withHarness({}, async (h) => {
    for (const unmatchedDir of ['../elsewhere', '/absolute', '..\\elsewhere', 'a/../..']) {
      h.destination({ unmatchedDir });

      // eslint-disable-next-line no-await-in-loop -- the assertion after each one is about the filesystem, which the next iteration would disturb
      const outcome = await h.place(h.file({ mediaItemId: null }), TV_VALUES);

      assertRefusal(outcome, 'escapes-root');
      // eslint-disable-next-line no-await-in-loop -- see above
      assert.deepEqual(await tree(h.dir), [join('downloads', `${PATH_MARKER}.mkv`)]);
    }
  });
});

test('a plugin with no destination row is refused, so a destination saved later takes effect next tick', async () => {
  await withHarness({}, async (h) => {
    const outcome = await h.place(h.file(), TV_VALUES);

    assertRefusal(outcome, 'no-destination');
    assert.deepEqual(await tree(h.root), []);
  });
});

test("another plugin's destination is not this plugin's", async () => {
  await withHarness({}, async (h) => {
    h.raw.prepare(`
      INSERT INTO plugin_destination (plugin_id, root, shape, unmatched_dir, created_at, updated_at)
      VALUES ('movie', ?, '{title}.{ext}', '_unmatched', 1, 1)
    `).run(h.root);

    const outcome = await h.place(h.file(), TV_VALUES);

    assertRefusal(outcome, 'no-destination');
  });
});

test('a root that is not absolute is refused, rather than resolved against whatever directory the host is in', async () => {
  await withHarness({}, async (h) => {
    h.destination({ root: 'relative/library' });

    assertRefusal(await h.place(h.file(), TV_VALUES), 'not-absolute-root');
  });
});

test('a stored root that is not the directory it resolves to is refused here too, not as an escape', async () => {
  // The import half of the pair `test/media/destinations.test.ts` holds the
  // save half of. Both call `rootRefusal`, so a root the save refuses
  // cannot arrive here under a different name -- and a row written before
  // that rule existed gets the same answer rather than the `escapes-root`
  // these used to produce. `escapes-root` means reaching *outside* the
  // root (`contract/src/library.ts`), and nothing had.
  //
  // The trailing-slash case is the one the save no longer produces:
  // `canonicalRoot` stores `${h.root}` for it. It stays here precisely
  // because this side must still answer for a row the save did not write
  // -- one stored before that rule, or edited in the database by hand.
  await withHarness({}, async (h) => {
    for (const root of ['/', '//', '/lib/../..', `${h.root}/`]) {
      h.destination({ root });

      // eslint-disable-next-line no-await-in-loop -- each iteration asserts the filesystem is untouched, which the next one would race
      const outcome = await h.place(h.file(), TV_VALUES);

      assertRefusal(outcome, 'unusable-root');
      // eslint-disable-next-line no-await-in-loop -- see above
      assert.deepEqual(await tree(h.dir), [join('downloads', `${PATH_MARKER}.mkv`)],
        `"${root}" wrote something`);
    }
  });
});

test("the resolver's refusals arrive under their own names, before anything is copied", async () => {
  const cases: readonly { values: TokenValues; shape?: string; code: ImportRefusalCode }[] = [
    { values: { ...TV_VALUES, series: 'AC/DC' }, code: 'separator-in-value' },
    { values: { ...TV_VALUES, series: '..' }, code: 'escapes-root' },
    { values: {}, code: 'unknown-token' },
    { values: { series: 'Severance' }, shape: '{series}/{title', code: 'malformed-shape' },
    { values: { series: 'Severance' }, shape: '{series}\\x.mkv', code: 'backslash-in-shape' },
    { values: { series: 'Severance', ext: null }, shape: '{series}/{ext}', code: 'empty-filename' },
  ];

  for (const { values, shape, code } of cases) {
    // eslint-disable-next-line no-await-in-loop -- one temporary directory per case, and each asserts its own filesystem is untouched
    await withHarness({}, async (h) => {
      h.destination(shape === undefined ? {} : { shape });

      const outcome = await h.place(h.file(), values);

      assertRefusal(outcome, code);
      assert.deepEqual(await tree(h.root), [], `${code} copied something`);
    });
  }
});

test('a control character in a resolved value is refused before the copy, on both destination branches', async () => {
  const NUL = String.fromCodePoint(0);
  await withHarness({}, async (h) => {
    h.destination({});

    // The shape branch: a NUL makes `node:fs` throw `ERR_INVALID_ARG_VALUE`
    // whose message quotes the whole path back -- measured on this tree --
    // and `deliverCompleted` logs an escaping error's message. Refusing here
    // is what keeps that message from ever being produced.
    assertRefusal(await h.place(h.file(), { ...TV_VALUES, series: `Sever${NUL}ance` }), 'control-character');
    assert.deepEqual(await tree(h.root), []);
  });

  await withHarness({}, async (h) => {
    // The unmatched branch, which never touches the resolver -- so a check
    // living in `media/shape.ts` would not cover it.
    h.destination({ unmatchedDir: `_un${NUL}matched` });

    assertRefusal(await h.place(h.file({ mediaItemId: null }), TV_VALUES), 'control-character');
    assert.deepEqual(await tree(h.root), []);
  });
});

test('a filesystem fault is a refusal carrying an errno and nothing else, never a throw', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const place = h.withCopyFile(async () => {
      // A real `node:fs` rejection quotes both paths into `message`. Nothing
      // but `code` may survive into the refusal.
      throw Object.assign(
        new Error(`ENOSPC: no space left on device, copyfile '${h.source}' -> '${h.root}/x'`),
        { code: 'ENOSPC' },
      );
    });

    const outcome = await place(h.file(), TV_VALUES);

    assert.deepEqual(outcome, { refusal: 'copy-failed', errno: 'ENOSPC' });
    assert.ok(!JSON.stringify(outcome).includes(PATH_MARKER), 'the refusal carries the source path');
  });
});

test('an errno that is not a plain symbolic code is dropped, so nothing smuggles a path out as one', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const place = h.withCopyFile(async () => {
      throw Object.assign(new Error('nope'), { code: `/library/${PATH_MARKER}` });
    });

    const outcome = await place(h.file(), TV_VALUES);

    assert.deepEqual(outcome, { refusal: 'copy-failed', errno: null });
  });
});

test('a resolver that throws is not swallowed: a fault is not a refusal', async () => {
  await withHarness({}, async (h) => {
    h.destination({});

    await assert.rejects(
      () => h.place(h.file(), async () => { throw new Error('the plugin database is gone'); }),
      /the plugin database is gone/,
    );
  });
});

/** A directory download under `<dir>/downloads/<name>/`, holding `files` (relative path -> bytes). */
async function directoryDownload(h: Harness, name: string, files: Record<string, string>): Promise<DownloadedFile> {
  const root = join(h.dir, 'downloads', name);
  for (const [relativePath, bytes] of Object.entries(files)) {
    const path = join(root, ...relativePath.split('/'));
    // eslint-disable-next-line no-await-in-loop -- fixture setup, order irrelevant
    await mkdir(join(path, '..'), { recursive: true });
    // eslint-disable-next-line no-await-in-loop -- see above
    await writeFile(path, bytes);
  }
  return h.file({ path: root, sizeBytes: 4096 });
}

test('list: a plain file lists as itself, under its own basename', async () => {
  await withHarness({}, async (h) => {
    assert.deepEqual(await h.list(h.file()), [
      { path: h.source, relativePath: `${PATH_MARKER}.mkv`, sizeBytes: SOURCE_BYTES.length },
    ]);
  });
});

test('list: a directory lists every regular file below it, nested, sorted, with sizes', async () => {
  await withHarness({}, async (h) => {
    const file = await directoryDownload(h, 'Release', { 'b.mkv': 'bb', 'a.nfo': 'a', 'Sub/c.srt': 'ccc' });
    assert.deepEqual(await h.list(file), [
      { path: join(file.path, 'Sub', 'c.srt'), relativePath: 'Sub/c.srt', sizeBytes: 3 },
      { path: join(file.path, 'a.nfo'), relativePath: 'a.nfo', sizeBytes: 1 },
      { path: join(file.path, 'b.mkv'), relativePath: 'b.mkv', sizeBytes: 2 },
    ]);
  });
});

test('list: the order is plain code-unit order over the whole relative path, across directory boundaries', async () => {
  await withHarness({}, async (h) => {
    // `.` (U+002E) sorts before `/` (U+002F), so `a.nfo` precedes `a/x.mkv`
    // even though a walk meets directory `a` first wherever `readdir`
    // answers in name order; and `Z` precedes `a`, which a locale-aware
    // comparison would reverse.
    const file = await directoryDownload(h, 'Release', { 'a/x.mkv': 'x', 'a.nfo': 'n', 'Z.srt': 'z' });
    const listed = await h.list(file);
    assert.ok(!('refusal' in listed));
    assert.deepEqual(listed.map((entry) => entry.relativePath), ['Z.srt', 'a.nfo', 'a/x.mkv']);
  });
});

test('list: a download root that is itself a symlink is followed', async () => {
  await withHarness({}, async (h) => {
    // A client may hand over a symlinked download; the root alone is read
    // with `stat`, so the link is looked through rather than skipped.
    const real = await directoryDownload(h, 'Real', { 'a.mkv': 'a' });
    const link = join(h.dir, 'downloads', 'Linked');
    await symlink(real.path, link);
    const listed = await h.list(h.file({ path: link }));
    assert.deepEqual(listed, [{ path: join(link, 'a.mkv'), relativePath: 'a.mkv', sizeBytes: 1 }]);
  });
});

test('list: a symlink inside the download is skipped, not followed', async () => {
  await withHarness({}, async (h) => {
    const file = await directoryDownload(h, 'Release', { 'a.mkv': 'a' });
    await symlink(h.source, join(file.path, 'link.mkv'));
    await mkdir(join(h.dir, 'elsewhere'));
    await writeFile(join(h.dir, 'elsewhere', 'x.mkv'), 'x');
    await symlink(join(h.dir, 'elsewhere'), join(file.path, 'linkdir'));
    const listed = await h.list(file);
    assert.ok(!('refusal' in listed));
    assert.deepEqual(listed.map((entry) => entry.relativePath), ['a.mkv']);
  });
});

test('list: a download that is not there refuses list-failed with an errno and no path', async () => {
  await withHarness({}, async (h) => {
    const outcome = await h.list(h.file({ path: join(h.dir, 'downloads', `${PATH_MARKER}-gone`) }));
    assert.deepEqual(outcome, { refusal: 'list-failed', errno: 'ENOENT' });
    assert.ok(!JSON.stringify(outcome).includes(PATH_MARKER));
  });
});

test('spec 9: the Swiss Family Robinson iso, placed from inside its directory, lands at the shaped path', async () => {
  await withHarness({}, async (h) => {
    h.destination({ shape: '{title}.{ext}' });
    const file = await directoryDownload(h, 'Swiss.Family.Robinson.1960.WIDESCREEN.NTSC.USA.DVD9-AndreMor', {
      'Swiss Family Robinson (1960) (USA).iso': 'iso bytes',
      'Swiss Family Robinson (1960) (USA).mds.mds': 'mds',
    });
    const listed = await h.list(file);
    assert.ok(!('refusal' in listed));
    const iso = listed.find((entry) => entry.relativePath.endsWith('.iso'));
    assert.ok(iso !== undefined);

    const outcome = await h.placeEntry(file, iso, { title: 'Swiss Family Robinson', ext: 'iso' });

    assert.deepEqual(outcome, { placed: 'library' });
    assert.equal(await readFile(join(h.root, 'Swiss Family Robinson.iso'), 'utf8'), 'iso bytes');
  });
});

test('spec 4.3: an unmatched directory download keeps its layout under a directory named as the download is', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const file = await directoryDownload(h, 'Some.Release.2020-GRP', { 'a.mkv': 'a', 'Sub/b.srt': 'b' });
    const listed = await h.list(file);
    assert.ok(!('refusal' in listed));
    for (const entry of listed) {
      // eslint-disable-next-line no-await-in-loop -- sequential, as the engine places them
      assert.deepEqual(await h.placeEntry(h.file({ ...file, mediaItemId: null }), entry, TV_VALUES), { placed: 'unmatched' });
    }
    // The dots in the directory name are kept: it is not a filename, so
    // nothing is taken off it as an extension.
    assert.deepEqual(await tree(h.root), [
      join('_unmatched', 'Some.Release.2020-GRP', 'Sub', 'b.srt'),
      join('_unmatched', 'Some.Release.2020-GRP', 'a.mkv'),
    ]);
  });
});

test('an entry that is not inside the download is refused foreign-entry, and nothing is copied', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const file = await directoryDownload(h, 'Release', { 'a.mkv': 'a' });
    const outside: DownloadEntry = { path: h.source, relativePath: 'a.mkv', sizeBytes: 1 };
    const lying: DownloadEntry = { path: join(file.path, 'a.mkv'), relativePath: 'b.mkv', sizeBytes: 1 };
    const escaping: DownloadEntry = { path: h.source, relativePath: `../${PATH_MARKER}.mkv`, sizeBytes: 1 };
    for (const entry of [outside, lying, escaping]) {
      // eslint-disable-next-line no-await-in-loop -- each asserts an empty library
      assertRefusal(await h.placeEntry(file, entry, TV_VALUES), 'foreign-entry');
    }
    // A plain-file download whose entry names another basename is foreign too.
    assertRefusal(
      await h.placeEntry(h.file(), { path: h.source, relativePath: 'other.mkv', sizeBytes: 1 }, TV_VALUES),
      'foreign-entry',
    );
    assert.deepEqual(await tree(h.root), []);
  });
});

test('spec 4.3: a directory download whose release name is `..` or `.` is refused, not written into the library root', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    for (const tail of ['..', '.']) {
      // A directory-shaped download: `basename` of it is `..` / `.` (measured),
      // and `join` normalises the entry path, so the entry is genuinely
      // inside it and passes the ownership check. Only the release-name rule
      // stands between this and `_unmatched/../x.mkv`, which resolves to
      // `<root>/x.mkv` -- inside the root, so the final `startsWith` check
      // would let it through.
      const path = `${join(h.dir, 'downloads')}/${tail}`;
      const file = h.file({ path, mediaItemId: null });
      const entry: DownloadEntry = { path: join(path, 'x.mkv'), relativePath: 'x.mkv', sizeBytes: 1 };
      // eslint-disable-next-line no-await-in-loop -- each asserts an empty library
      assertRefusal(await h.placeEntry(file, entry, TV_VALUES), 'escapes-root');
    }
    assert.deepEqual(await tree(h.root), []);
  });
});
