import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoResolutionOf } from '../src/videoResolution.ts';

test('the common scan heights are read off a release name, whatever separates them', () => {
  assert.equal(videoResolutionOf('The.Bear.S03E01.2160p.WEB.h265-GROUP.mkv'), '2160p');
  assert.equal(videoResolutionOf('Some Film 2024 1080p BluRay x264.mkv'), '1080p');
  assert.equal(videoResolutionOf('show_s01e02_720p_hdtv.mkv'), '720p');
  assert.equal(videoResolutionOf('Old.Show.S01E01.[480p].avi'), '480p');
  assert.equal(videoResolutionOf('Film.2001.576p.PAL-GROUP'), '576p');
  assert.equal(videoResolutionOf('Concert.1080i.HDTV.ts'), '1080i');
});

test('case does not matter', () => {
  assert.equal(videoResolutionOf('SHOW.S01E01.1080P.WEB'), '1080p');
});

test('4K and UHD with no scan height read as 2160p', () => {
  assert.equal(videoResolutionOf('Some.Film.2024.4K.HDR.mkv'), '2160p');
  assert.equal(videoResolutionOf('Some.Film.2024.UHD.BluRay.mkv'), '2160p');
});

test('an explicit scan height wins over a 4K or UHD tag in the same name', () => {
  // Real names carry both: `UHD.BluRay.1080p` is a 1080p encode of a UHD source.
  assert.equal(videoResolutionOf('Some.Film.2024.UHD.BluRay.1080p.x264'), '1080p');
});

test('digits that are only part of a longer token are not a resolution', () => {
  assert.equal(videoResolutionOf('Film.21080p.mkv'), null, 'a longer number');
  assert.equal(videoResolutionOf('Film.1080px.mkv'), null, 'a longer word');
  assert.equal(videoResolutionOf('Film.4Kids.mkv'), null, 'a word starting 4K');
  assert.equal(videoResolutionOf('Film.2024.mkv'), null, 'a year alone');
});

test('a name with no resolution in it answers null', () => {
  assert.equal(videoResolutionOf('the.thing.mkv'), null);
  assert.equal(videoResolutionOf(''), null);
});
