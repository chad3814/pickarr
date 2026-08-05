import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadedFile } from '@pickarr/plugin-api';
import { parseSceneRelease } from '../src/parse.ts';
import { planSceneImport } from '../src/plan-import.ts';

const MEDIA = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB')!;

function file(relativePath: string, sizeBytes: number): DownloadedFile {
  return { absolutePath: `/downloads/release/${relativePath}`, relativePath, sizeBytes };
}

test('picks the largest video file and names it from the parsed media', () => {
  const plan = planSceneImport(MEDIA, [
    file('scene.mp4', 4_000_000_000),
    file('scene.nfo', 2_000),
    file('poster.jpg', 500_000),
  ]);
  assert.deepEqual(plan, {
    files: [
      {
        source: '/downloads/release/scene.mp4',
        destination: 'Brazzers/2023-04-15 - Alex Coal.mp4',
      },
    ],
  });
});

test('skips sample, proof, and screens files even when they are large', () => {
  const plan = planSceneImport(MEDIA, [
    file('sample/sample.mp4', 9_000_000_000),
    file('proof.mkv', 8_000_000_000),
    file('screens.mp4', 7_000_000_000),
    file('scene.mp4', 1_000_000_000),
  ]);
  assert.equal(plan?.files[0]?.source, '/downloads/release/scene.mp4');
});

test('preserves the source extension', () => {
  const plan = planSceneImport(MEDIA, [file('scene.mkv', 4_000_000_000)]);
  assert.match(plan?.files[0]?.destination ?? '', /\.mkv$/);
});

test('returns null when there is no video file', () => {
  assert.equal(planSceneImport(MEDIA, [file('readme.txt', 100)]), null);
});

test('returns null for an empty listing', () => {
  assert.equal(planSceneImport(MEDIA, []), null);
});

test('sanitizes path separators and reserved characters out of the destination', () => {
  const media = parseSceneRelease('Bad/Site:Name.23.04.15.A*B?C.XXX.1080p.MP4-G')!;
  const plan = planSceneImport(media, [file('scene.mp4', 1_000)]);
  const destination = plan?.files[0]?.destination ?? '';
  assert.doesNotMatch(destination.replace(/\//g, ''), /[/\\:*?"<>|]/);
  assert.equal(destination.split('/').length, 2);
});

test('a destination can never escape the library root', () => {
  const media = parseSceneRelease('...23.04.15.....XXX.1080p.MP4-G');
  if (media === null) return;
  const plan = planSceneImport(media, [file('scene.mp4', 1_000)]);
  assert.doesNotMatch(plan?.files[0]?.destination ?? '', /\.\./);
});
