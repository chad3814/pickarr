import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTitle } from '../src/api/groupTitle.ts';
import type { GroupView, MetadataView } from '../src/api/client.ts';

const BASE: GroupView = {
  id: 7,
  plugin: 'scenes',
  display: { title: 'Parsed Title', subtitle: 'Brazzers', fields: [] },
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
  title: 'Provider Title',
  releaseDate: null,
  durationSeconds: null,
  synopsis: null,
  hasPoster: false,
  hasBackground: false,
} satisfies Extract<MetadataView, { state: 'confirmed' }>;

test('the provider title wins when there is one', () => {
  assert.equal(groupTitle(withMetadata(CONFIRMED)), 'Provider Title');
});

test('a confirmed answer with no title falls back to the parsed one', () => {
  // Not only unanswered groups: `title` is `string | null` inside the
  // confirmed variant, so a confirmed answer can carry nothing to show.
  assert.equal(groupTitle(withMetadata({ ...CONFIRMED, title: null })), 'Parsed Title');
});

test('an empty provider title falls back too', () => {
  // `maybeStr` in `db/row.ts` folds only NULL and undefined, so an empty
  // column reaches the view as `''` and would render a heading with no text.
  assert.equal(groupTitle(withMetadata({ ...CONFIRMED, title: '' })), 'Parsed Title');
});

test('every unconfirmed state falls back, since the provider fields are not reachable', () => {
  for (const metadata of [{ state: 'absent' }, { state: 'none' }, { state: 'pending' }] satisfies MetadataView[]) {
    assert.equal(groupTitle(withMetadata(metadata)), 'Parsed Title', `state ${metadata.state}`);
  }
});
