import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneRelease } from '../src/parse.ts';

test('parses the canonical Site.YY.MM.DD.Names.XXX.quality-GROUP form', () => {
  const parsed = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  assert.ok(parsed);
  assert.equal(parsed.identityKey, 'brazzers:2023-04-15:alex-coal');
  assert.equal(parsed.display.title, 'Alex Coal');
  assert.equal(parsed.display.subtitle, 'Brazzers');
  assert.equal(parsed.display.date, '2023-04-15');
  assert.equal(parsed.quality.resolution, 1080);
  assert.equal(parsed.quality.releaseGroup, 'WRB');
  assert.equal(parsed.quality.extras?.['container'], 'mp4');
});

test('two encodes of the same scene share an identity key', () => {
  const a = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const b = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP');
  assert.ok(a && b);
  assert.equal(a.identityKey, b.identityKey);
  assert.notEqual(a.quality.resolution, b.quality.resolution);
});

test('different scenes on the same site and day do not collate', () => {
  const a = parseSceneRelease('TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX');
  const b = parseSceneRelease('TeamSkeet.24.01.02.John.Smith.XXX.1080p.MP4-XXX');
  assert.ok(a && b);
  assert.notEqual(a.identityKey, b.identityKey);
});

test('separator and case differences do not split a group', () => {
  const a = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const b = parseSceneRelease('brazzers 23 04 15 alex coal XXX 1080p MP4-WRB');
  assert.ok(a && b);
  assert.equal(a.identityKey, b.identityKey);
});

test('extracts resolution from every common token', () => {
  const cases: [string, number][] = [
    ['Site.23.01.01.Name.XXX.480p.MP4-G', 480],
    ['Site.23.01.01.Name.XXX.720p.MP4-G', 720],
    ['Site.23.01.01.Name.XXX.1080p.MP4-G', 1080],
    ['Site.23.01.01.Name.XXX.2160p.MP4-G', 2160],
    ['Site.23.01.01.Name.XXX.4K.MP4-G', 2160],
  ];
  for (const [name, expected] of cases) {
    assert.equal(parseSceneRelease(name)?.quality.resolution, expected, name);
  }
});

test('extracts video codec and source', () => {
  const parsed = parseSceneRelease('Site.23.01.01.Name.XXX.1080p.WEB-DL.H265.MP4-G');
  assert.equal(parsed?.quality.videoCodec, 'h265');
  assert.equal(parsed?.quality.source, 'web-dl');
});

test('a two-digit year maps into the 2000s', () => {
  assert.equal(parseSceneRelease('Site.99.12.31.Name.XXX.1080p.MP4-G')?.display.date, '2099-12-31');
});

test('a four-digit year is accepted', () => {
  assert.equal(
    parseSceneRelease('Site.2023.04.15.Name.XXX.1080p.MP4-G')?.display.date,
    '2023-04-15',
  );
});

test('a release with no XXX marker still parses using the first quality token', () => {
  const parsed = parseSceneRelease('Site.23.04.15.Alex.Coal.1080p.MP4-WRB');
  assert.ok(parsed);
  assert.equal(parsed.identityKey, 'site:2023-04-15:alex-coal');
  assert.equal(parsed.quality.resolution, 1080);
});

test('a name with no date returns null', () => {
  assert.equal(parseSceneRelease('Some.Random.Movie.2023.1080p.BluRay-GRP'), null);
});

test('an empty name returns null', () => {
  assert.equal(parseSceneRelease(''), null);
});

test('a name with a date but no site returns null', () => {
  assert.equal(parseSceneRelease('23.04.15.Alex.Coal.XXX.1080p.MP4-G'), null);
});

test('an invalid calendar date returns null', () => {
  assert.equal(parseSceneRelease('Site.23.13.45.Name.XXX.1080p.MP4-G'), null);
});

test('display fields carry site and performers', () => {
  const parsed = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const labels = parsed?.display.fields.map((field) => field.label);
  assert.deepEqual(labels, ['Site', 'Date', 'Scene']);
});

test('two scenes differing only by content after an in-title XXX get different identity keys', () => {
  const a = parseSceneRelease('Site.23.04.15.Anniversary.XXX.1080p.MP4-G');
  const b = parseSceneRelease('Site.23.04.15.Anniversary.XXX.Edition.XXX.1080p.MP4-G');
  assert.ok(a && b);
  assert.notEqual(a.identityKey, b.identityKey);
});

test('an in-title XXX scene keeps its full title instead of being truncated', () => {
  const parsed = parseSceneRelease('Site.23.04.15.Anniversary.XXX.Edition.XXX.1080p.MP4-G');
  assert.equal(parsed?.display.title, 'Anniversary XXX Edition');
});

test('two encodes of a scene with an XXX release group still share an identity key', () => {
  const a = parseSceneRelease('TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX');
  const b = parseSceneRelease('TeamSkeet.24.01.02.Jane.Doe.XXX.2160p.HEVC.MP4-XXX');
  assert.ok(a && b);
  assert.equal(a.identityKey, b.identityKey);
});
