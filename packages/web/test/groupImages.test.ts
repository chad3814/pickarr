import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupImages, slotImage } from '../src/api/groupImages.ts';
import type { GroupView, MetadataView, PerformerView } from '../src/api/client.ts';

const BASE: GroupView = {
  id: 7,
  plugin: 'scenes',
  display: { title: 'Alpha Scene', fields: [] },
  state: 'new',
  pickedReleaseId: null,
  upgradeReleaseId: null,
  listRankAt: 0,
  releases: [],
  metadata: { state: 'absent' },
};

function withMetadata(metadata: MetadataView): GroupView {
  return { ...BASE, metadata };
}

const CONFIRMED = {
  state: 'confirmed',
  title: null,
  releaseDate: null,
  durationSeconds: null,
  synopsis: null,
  hasPoster: false,
  hasBackground: false,
} satisfies Extract<MetadataView, { state: 'confirmed' }>;

function performer(over: Partial<PerformerView>): PerformerView {
  return { id: 1, name: 'Alice Maze', url: 'https://example/alice', hasAvatar: true, hasImage: true, ...over };
}

test('the list runs poster, background, then each performer with a full image', () => {
  const images = groupImages(
    withMetadata({
      ...CONFIRMED,
      hasPoster: true,
      hasBackground: true,
      performers: [performer({ id: 4, name: 'Alice Maze' }), performer({ id: 5, name: 'Bea Vale' })],
    }),
  );
  assert.deepEqual(
    images.map((image) => image.src),
    [
      '/api/groups/7/poster',
      '/api/groups/7/background',
      '/api/performers/4/image',
      '/api/performers/5/image',
    ],
  );
});

test('a performer with no full image is not in the list', () => {
  const images = groupImages(
    withMetadata({ ...CONFIRMED, performers: [performer({ id: 4, hasImage: false })] }),
  );
  assert.deepEqual(images, []);
});

test('each image carries its own alt text, so a portrait is never announced as a poster', () => {
  const images = groupImages(
    withMetadata({
      ...CONFIRMED,
      hasPoster: true,
      hasBackground: true,
      performers: [performer({ id: 4, name: 'Alice Maze' })],
    }),
  );
  // Literals, not values read back from the fixture: both ends agreeing on a
  // wrong string is the failure this style of assertion exists to catch.
  assert.deepEqual(
    images.map((image) => image.alt),
    ['Poster for Alpha Scene', 'Background for Alpha Scene', 'Alice Maze'],
  );
  assert.deepEqual(images.map((image) => image.label), ['Poster', 'Background', 'Alice Maze']);
});

test('a group with no scene answer still lists its performers', () => {
  // `performers` sits outside the state union on purpose: the performer search
  // exists for groups whose scene lookup settled without a cast.
  const images = groupImages(withMetadata({ state: 'none', performers: [performer({ id: 9 })] }));
  assert.deepEqual(images.map((image) => image.src), ['/api/performers/9/image']);
});

test('a group with nothing has an empty list and no slot image', () => {
  assert.deepEqual(groupImages(withMetadata({ state: 'absent' })), []);
  assert.equal(slotImage(withMetadata({ state: 'absent' })), null);
});

test('the slot takes the poster when there is one', () => {
  const image = slotImage(withMetadata({ ...CONFIRMED, hasPoster: true, hasBackground: true }));
  assert.equal(image?.src, '/api/groups/7/poster');
});

test('the slot skips the background entirely and falls to the first performer', () => {
  // The asymmetry this whole file exists to keep visible: the modal's list
  // includes the background second, the slot never shows it at all.
  const group = withMetadata({
    ...CONFIRMED,
    hasBackground: true,
    performers: [performer({ id: 4, name: 'Alice Maze' }), performer({ id: 5, name: 'Bea Vale' })],
  });
  assert.equal(slotImage(group)?.src, '/api/performers/4/image');
  assert.equal(groupImages(group)[0]?.src, '/api/groups/7/background');
});

test('the slot takes the first performer in cast order who has a full image', () => {
  const image = slotImage(
    withMetadata({
      ...CONFIRMED,
      performers: [performer({ id: 4, hasImage: false }), performer({ id: 5, name: 'Bea Vale' })],
    }),
  );
  assert.equal(image?.src, '/api/performers/5/image');
});

test('a background with no performer leaves the slot empty rather than cropping it', () => {
  assert.equal(slotImage(withMetadata({ ...CONFIRMED, hasBackground: true })), null);
});
