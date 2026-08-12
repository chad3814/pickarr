import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GroupIdentity } from '@pickarr/plugin-api';
import { sceneMetadataQuery } from '../src/metadata.ts';

const DATED: GroupIdentity = {
  identityKey: 'naughtyoffice:2021-11-15:smokin-hot-brunette',
  display: {
    title: 'Smokin Hot Brunette', subtitle: 'Naughty Office', date: '2021-11-15',
    fields: [],
  },
};

test('a dated group asks by title, narrowed by site and date', () => {
  const query = sceneMetadataQuery(DATED);
  assert.deepEqual(query?.queries, ['Smokin Hot Brunette']);
  assert.equal(query?.siteName, 'Naughty Office');
  assert.equal(query?.date, '2021-11-15');
});

test('a group with no site is not askable', () => {
  const query = sceneMetadataQuery({
    identityKey: ':2021-11-15:x',
    display: { title: 'Some Scene', fields: [] },
  });
  assert.equal(query, null, 'a title-only search across every site confirms the wrong scene');
});

test('a group with an empty-string subtitle is not askable either', () => {
  const query = sceneMetadataQuery({
    identityKey: ':2021-11-15:x',
    display: { title: 'Some Scene', subtitle: '', fields: [] },
  });
  assert.equal(query, null, 'an empty subtitle is still no site, not a site named ""');
});

test('a dateless group still asks, and omits date rather than sending undefined', () => {
  const query = sceneMetadataQuery({
    identityKey: 'bralessforever::emma-g',
    display: { title: 'Emma G And Rocky Beach Days', subtitle: 'Braless Forever', fields: [] },
  });
  assert.equal(query?.date, undefined);
  assert.ok(!('date' in (query ?? {})), 'exactOptionalPropertyTypes: omit, do not set undefined');
});
