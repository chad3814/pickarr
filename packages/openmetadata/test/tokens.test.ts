/**
 * The token resolvers every plugin built on this engine shares.
 *
 * Here rather than in each plugin package for the reason
 * `host/test/plugins/tokens.test.ts` gives about the lists: this is the one
 * place that can see the shared implementations on their own, and a test
 * inside `plugin-tv` asserting `{ext}` would be asserting a function
 * `plugin-movie` also uses without being able to say so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadedFile, PluginContext } from '@pickarr/contract';
import { createTestHarness } from '../src/testing.ts';
import {
  resolveExtension,
  resolveFilename,
  resolveReleaseDate,
  resolveTitle,
  resolveYear,
} from '../src/tokens.ts';

function downloaded(over: Partial<DownloadedFile> = {}): DownloadedFile {
  return {
    path: '/downloads/The.Bear.S03E01.1080p.MKV',
    sizeBytes: 10,
    downloadClientId: 1,
    rssItemId: 7,
    mediaItemId: 1,
    ...over,
  };
}

/** A harness whose recording writer already holds one media item. */
async function withMediaItem(fields: { title: string; releaseDate: string | null }): Promise<PluginContext> {
  const harness = createTestHarness();
  const id = await harness.ctx.media.createMediaItem({
    pluginId: 'xxx', title: fields.title, releaseDate: fields.releaseDate, description: null,
  });
  assert.equal(id, 1, 'the recording writer numbers from 1, which `downloaded()` assumes');
  return harness.ctx;
}

test('the title is the shared media item row, not anything a plugin holds', async () => {
  const ctx = await withMediaItem({ title: 'Tomorrow', releaseDate: '2024-06-26' });

  assert.equal(await resolveTitle(downloaded(), ctx), 'Tomorrow');
});

test('a blank title is the same hole a missing one is', async () => {
  const ctx = await withMediaItem({ title: '', releaseDate: null });

  // `''` and `null` are one answer: an absent path segment and a blank one
  // are the same hole, and `resolveShape` drops both (design spec §8.8).
  // Reported as `null` here so the resolver has one spelling for it.
  assert.equal(await resolveTitle(downloaded(), ctx), null);
});

test('the release date is the service\'s own ISO string, and the year is its first four characters', async () => {
  const ctx = await withMediaItem({ title: 'Arrival', releaseDate: '2016-11-11' });

  assert.equal(await resolveReleaseDate(downloaded(), ctx), '2016-11-11');
  assert.equal(await resolveYear(downloaded(), ctx), '2016');
});

test('the year is sliced, never parsed, so a date does not shift a film into the previous one', async () => {
  // `new Date('2009-01-01').getFullYear()` is 2008 anywhere west of UTC.
  // The column is a `yyyy-mm-dd` string and stays one.
  const ctx = await withMediaItem({ title: '9', releaseDate: '2009-01-01' });

  assert.equal(await resolveYear(downloaded(), ctx), '2009');
});

test('a film with no release date has no year, rather than a year invented from nothing', async () => {
  const ctx = await withMediaItem({ title: 'Untitled', releaseDate: null });

  assert.equal(await resolveReleaseDate(downloaded(), ctx), null);
  assert.equal(await resolveYear(downloaded(), ctx), null);
});

test('a release date that is not shaped like one contributes no year', async () => {
  const ctx = await withMediaItem({ title: 'Untitled', releaseDate: 'soon' });

  assert.equal(await resolveYear(downloaded(), ctx), null);
});

test('the filename is the source stem and the extension is lowercased, so the two recompose the source name', async () => {
  const ctx = await withMediaItem({ title: 'Tomorrow', releaseDate: null });
  const file = downloaded();

  const stem = await resolveFilename(file, ctx);
  const extension = await resolveExtension(file, ctx);

  assert.equal(stem, 'The.Bear.S03E01.1080p');
  // Lowercased unconditionally, 1.x's `plan-import.ts` rule: `scene.MP4` and
  // `scene.mp4` must resolve to one destination, or the same release
  // imported twice under two spellings lands as two files and neither is a
  // duplicate of the other.
  assert.equal(extension, 'mkv');
  assert.equal(`${stem}.${extension}`, 'The.Bear.S03E01.1080p.mkv');
});

test('a source path with no extension has a filename and no ext, and a dotfile is all filename', async () => {
  const ctx = await withMediaItem({ title: 'Tomorrow', releaseDate: null });

  assert.equal(await resolveFilename(downloaded({ path: '/downloads/noext' }), ctx), 'noext');
  assert.equal(await resolveExtension(downloaded({ path: '/downloads/noext' }), ctx), null);
  // A leading dot is not an extension separator: `.hidden` is the whole name.
  assert.equal(await resolveFilename(downloaded({ path: '/downloads/.hidden' }), ctx), '.hidden');
  assert.equal(await resolveExtension(downloaded({ path: '/downloads/.hidden' }), ctx), null);
});

test('the source name is the last segment under either separator, so a directory is never part of it', async () => {
  const ctx = await withMediaItem({ title: 'Tomorrow', releaseDate: null });

  assert.equal(await resolveFilename(downloaded({ path: 'D:\\downloads\\pack\\a.mkv' }), ctx), 'a');
  assert.equal(await resolveExtension(downloaded({ path: 'D:\\downloads\\pack\\a.mkv' }), ctx), 'mkv');
});


test('a token resolved for a release nothing matched is a hole, not a query for row zero', async () => {
  const ctx = await withMediaItem({ title: 'Tomorrow', releaseDate: '2024-06-26' });
  const unmatched = downloaded({ mediaItemId: null });

  // The real importer never resolves a token for an unmatched release
  // (design spec §6), so nothing reaches these with a null media item
  // today. They answer for it anyway rather than defaulting the id to `0`,
  // which is the spelling that compiles and silently asks for a row that
  // does not exist.
  assert.equal(await resolveTitle(unmatched, ctx), null);
  assert.equal(await resolveReleaseDate(unmatched, ctx), null);
  assert.equal(await resolveYear(unmatched, ctx), null);
  // The two that come from the path are unaffected by the match.
  assert.equal(await resolveExtension(unmatched, ctx), 'mkv');
});
