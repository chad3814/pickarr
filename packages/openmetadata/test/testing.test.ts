import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeLookupService,
  createRecordingMedia,
  refusedEnvelope,
  unresolvedEnvelope,
} from '../src/testing.ts';

test('answers a batch in request order, with no echoed name', async () => {
  const service = createFakeLookupService({
    batch: new Map([
      ['a.mkv', unresolvedEnvelope({ lookupId: 'lookup-a' })],
      ['b.mkv', refusedEnvelope({ lookupId: 'lookup-b', refusal: 'a subtitle' })],
    ]),
    polls: new Map(),
  });

  const body = await service.fetch.json<{ results: readonly Record<string, unknown>[] }>(
    'https://openmetadata.test/api/v1/lookup',
    { method: 'POST', body: JSON.stringify({ items: [{ category: 'tv', name: 'b.mkv' }, { category: 'tv', name: 'a.mkv' }] }) },
  );

  assert.deepEqual(body.results.map((entry) => entry['lookupId']), ['lookup-b', 'lookup-a']);
  assert.ok(!('name' in (body.results[0] ?? {})), 'a real batch entry carries no name');
  assert.deepEqual(service.batchRequests, [['b.mkv', 'a.mkv']]);
});

test('answers successive polls for one lookup id', async () => {
  const service = createFakeLookupService({
    batch: new Map(),
    polls: new Map([['lookup-a', [
      unresolvedEnvelope({ lookupId: 'lookup-a' }),
      refusedEnvelope({ lookupId: 'lookup-a', refusal: 'a sidecar' }),
    ]]]),
  });

  const first = await service.fetch.json<Record<string, unknown>>('https://openmetadata.test/api/v1/lookup/lookup-a');
  const second = await service.fetch.json<Record<string, unknown>>('https://openmetadata.test/api/v1/lookup/lookup-a');

  assert.equal(first['state'], 'unresolved');
  assert.equal(second['refusal'], 'a sidecar');
  assert.deepEqual(service.pollRequests, ['lookup-a', 'lookup-a']);
});

test('throws for a name nothing scripted, rather than inventing an answer', async () => {
  const service = createFakeLookupService({ batch: new Map(), polls: new Map() });
  await assert.rejects(
    () => service.fetch.json('https://openmetadata.test/api/v1/lookup', {
      method: 'POST',
      body: JSON.stringify({ items: [{ category: 'tv', name: 'unscripted.mkv' }] }),
    }),
    /unscripted\.mkv/,
  );
});

test('records the category a batch POST asked under, one entry per request', async () => {
  const service = createFakeLookupService({
    batch: new Map([
      ['a.mkv', unresolvedEnvelope({ lookupId: 'lookup-a' })],
    ]),
    polls: new Map(),
  });

  await service.fetch.json('https://openmetadata.test/api/v1/lookup', {
    method: 'POST',
    body: JSON.stringify({ items: [{ category: 'movies', name: 'a.mkv' }] }),
  });

  assert.deepEqual(service.batchCategories, ['movies']);
});

test('throws when a batch request disagrees with itself about category', async () => {
  const service = createFakeLookupService({
    batch: new Map([
      ['a.mkv', unresolvedEnvelope({ lookupId: 'lookup-a' })],
      ['b.mkv', unresolvedEnvelope({ lookupId: 'lookup-b' })],
    ]),
    polls: new Map(),
  });

  await assert.rejects(
    () => service.fetch.json('https://openmetadata.test/api/v1/lookup', {
      method: 'POST',
      body: JSON.stringify({ items: [{ category: 'movies', name: 'a.mkv' }, { category: 'tv', name: 'b.mkv' }] }),
    }),
    /category/,
  );
});

test('the recording writer hands back rising ids and records its calls', async () => {
  const media = createRecordingMedia();
  const first = await media.writer.createMediaItem({
    pluginId: 'tv', title: 'One', releaseDate: null, description: null,
  });
  const second = await media.writer.createMediaItem({
    pluginId: 'tv', title: 'Two', releaseDate: null, description: null,
  });

  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(media.items.get(1)?.title, 'One');
  assert.deepEqual(media.calls.map((call) => call.method), ['createMediaItem', 'createMediaItem']);
});

test('a lost claim reports the winner and the caller row as dropped', async () => {
  const media = createRecordingMedia();
  const mine = await media.writer.createMediaItem({
    pluginId: 'tv', title: 'One', releaseDate: null, description: null,
  });
  media.loseNextClaim(42);

  assert.deepEqual(await media.writer.claimProviderRef(mine, 'tmdb', 'tmdb:movie:1'), {
    kept: 42,
    dropped: mine,
  });
});
