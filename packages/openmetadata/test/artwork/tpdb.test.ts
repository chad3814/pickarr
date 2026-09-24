import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostFetch } from '@pickarr/contract';
import { createTpdbSource } from '../../src/artwork/tpdb.ts';

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

/** A `HostFetch` that records every call and answers from a queue of bodies. */
function recordingFetch(bodies: readonly unknown[]): { fetch: HostFetch; sent: Sent[] } {
  const remaining = [...bodies];
  const sent: Sent[] = [];
  const fetch: HostFetch = {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      sent.push({ url, init });
      const next = remaining.shift();
      if (next === undefined) throw new Error(`recordingFetch: nothing scripted for ${url}`);
      return next as T;
    },
    async bytes(): Promise<Uint8Array> {
      throw new Error('recordingFetch: bytes is not used by tpdb artwork');
    },
  };
  return { fetch, sent };
}

/** Resolves to `key`, and counts how many times it was asked -- so an "asks nothing" test can prove it, not just infer it from the absence of an HTTP call. */
function countingResolver(key: string): { resolveSecret: (name: string) => Promise<string>; count(): number } {
  let calls = 0;
  return {
    resolveSecret: async () => {
      calls += 1;
      return key;
    },
    count: () => calls,
  };
}

interface SizesInit {
  full?: string | null;
  large?: string | null;
  medium?: string | null;
  small?: string | null;
}

function sizes(init: SizesInit = {}): Record<string, string | null> {
  return { full: null, large: null, medium: null, small: null, ...init };
}

interface PerformerInit {
  image?: string | null;
  thumbnail?: string | null;
  face?: string | null;
  parent?: Record<string, unknown> | null;
}

function performer(id: string, init: PerformerInit = {}): Record<string, unknown> {
  return {
    id,
    name: 'Test Performer',
    image: null,
    thumbnail: null,
    face: null,
    parent: null,
    ...init,
  };
}

function sceneBody(fields: {
  posters?: Record<string, string | null> | null;
  background?: Record<string, string | null> | null;
  performers?: readonly Record<string, unknown>[];
}): unknown {
  return {
    data: {
      // Present in the live payload, unused by this source -- see the
      // design's poster/background-object-only mapping. Included so a
      // narrower reader than this one would still see them.
      image: null,
      poster: null,
      posters: fields.posters ?? null,
      background: fields.background ?? null,
      background_back: sizes(),
      performers: fields.performers ?? [],
    },
  };
}

const TOKEN = 'super-secret-tpdb-token';
const SCENE_REF = 'e0885f19-0000-0000-0000-000000000000';

test('maps a scene\'s posters and background, preferring large over medium and full', async () => {
  const { fetch, sent } = recordingFetch([
    sceneBody({
      posters: sizes({ full: 'https://cdn.test/poster-full.jpg', large: 'https://cdn.test/poster-large.jpg', medium: 'https://cdn.test/poster-medium.jpg' }),
      background: sizes({ full: 'https://cdn.test/bg-full.jpg', medium: 'https://cdn.test/bg-medium.jpg' }),
    }),
  ]);
  const source = createTpdbSource({ fetch, resolveSecret: async () => TOKEN });

  const answer = await source.imagesFor('scene', SCENE_REF, []);

  assert.deepEqual(answer.media.posters, [{ url: 'https://cdn.test/poster-large.jpg', language: null, score: 0 }]);
  // No `large`, so `medium` is the fallback.
  assert.deepEqual(answer.media.backgrounds, [{ url: 'https://cdn.test/bg-medium.jpg', language: null, score: 0 }]);
  assert.deepEqual(answer.media.logos, [], 'no endpoint answers a logo for this provider');

  // The url is spelled literally: an expectation built from the code under
  // test cannot see the code change.
  assert.equal(sent[0]?.url, `https://api.theporndb.net/scenes/${SCENE_REF}`);
  const headers = new Headers(sent[0]?.init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(headers.get('accept'), 'application/json');
  // The bearer header carries the token; no recorded url may.
  for (const call of sent) {
    assert.ok(!call.url.includes(TOKEN), `url leaked the token: ${call.url}`);
  }
});

test('matches a person by ref against the embedded performer, preferring face over thumbnail and image', async () => {
  const personRef = 'db2a49dc-0000-0000-0000-000000000000';
  const { fetch } = recordingFetch([
    sceneBody({
      performers: [
        performer(personRef, {
          image: 'https://cdn.test/person-image.jpg',
          thumbnail: 'https://cdn.test/person-thumbnail.jpg',
          face: 'https://cdn.test/person-face.jpg',
        }),
      ],
    }),
  ]);
  const source = createTpdbSource({ fetch, resolveSecret: async () => TOKEN });

  const answer = await source.imagesFor('scene', SCENE_REF, [personRef]);

  assert.deepEqual(
    answer.people.get(personRef),
    [{ url: 'https://cdn.test/person-face.jpg', language: null, score: 0 }],
  );
});

test('falls back to the embedded performer\'s parent when its own image fields are all null', async () => {
  const personRef = 'db2a49dc-1111-1111-1111-111111111111';
  const { fetch } = recordingFetch([
    sceneBody({
      performers: [
        performer(personRef, {
          image: null,
          thumbnail: null,
          face: null,
          parent: { image: null, thumbnail: null, face: 'https://cdn.test/parent-face.jpg' },
        }),
      ],
    }),
  ]);
  const source = createTpdbSource({ fetch, resolveSecret: async () => TOKEN });

  const answer = await source.imagesFor('scene', SCENE_REF, [personRef]);

  assert.deepEqual(
    answer.people.get(personRef),
    [{ url: 'https://cdn.test/parent-face.jpg', language: null, score: 0 }],
  );
});

test('a person whose embedded entry has no image anywhere -- own or parent -- omits the key', async () => {
  const personRef = 'no-picture-0000-0000-0000-000000000000';
  const missingRef = 'not-in-the-cast-0000-0000-000000000000';
  const { fetch } = recordingFetch([
    sceneBody({ performers: [performer(personRef)] }),
  ]);
  const source = createTpdbSource({ fetch, resolveSecret: async () => TOKEN });

  const answer = await source.imagesFor('scene', SCENE_REF, [personRef, missingRef]);

  assert.equal(answer.people.has(personRef), false);
  assert.equal(answer.people.has(missingRef), false);
  assert.equal(answer.people.size, 0);
});

test('one scene call answers a whole cast: exactly one HTTP call for several performers', async () => {
  const refs = ['a-0000-0000-0000-000000000000', 'b-0000-0000-0000-000000000000', 'c-0000-0000-0000-000000000000'];
  const { fetch, sent } = recordingFetch([
    sceneBody({
      performers: refs.map((ref) => performer(ref, { face: `https://cdn.test/${ref}.jpg` })),
    }),
  ]);
  const source = createTpdbSource({ fetch, resolveSecret: async () => TOKEN });

  const answer = await source.imagesFor('scene', SCENE_REF, refs);

  // This is the property the whole seam exists for: one request served the
  // scene's own artwork and every one of its performers'.
  assert.equal(sent.length, 1);
  assert.equal(answer.people.size, refs.length);
  for (const ref of refs) {
    assert.deepEqual(answer.people.get(ref), [{ url: `https://cdn.test/${ref}.jpg`, language: null, score: 0 }]);
  }
});

test('a kind this provider has no endpoint for asks nothing at all -- no fetch, no secret resolution', async () => {
  const { fetch, sent } = recordingFetch([sceneBody({})]);
  const resolver = countingResolver(TOKEN);
  const source = createTpdbSource({ fetch, resolveSecret: resolver.resolveSecret });

  const answer = await source.imagesFor('movie', SCENE_REF, ['someone']);

  assert.equal(sent.length, 0);
  assert.equal(resolver.count(), 0);
  assert.deepEqual(answer, { media: { posters: [], backgrounds: [], logos: [] }, people: new Map() });
});

test('no key answers no images and never throws', async () => {
  const { fetch, sent } = recordingFetch([sceneBody({})]);
  const source = createTpdbSource({
    fetch,
    resolveSecret: async () => {
      throw new Error('no value for secret "tpdb-api-key"');
    },
  });

  const answer = await source.imagesFor('scene', SCENE_REF, ['someone']);

  assert.equal(sent.length, 0, 'a missing key must not reach the network');
  assert.deepEqual(answer, { media: { posters: [], backgrounds: [], logos: [] }, people: new Map() });
});
