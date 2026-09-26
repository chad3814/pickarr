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

/**
 * Mimics `Secrets.get`'s rejection for a credential nobody configured.
 * The `name` is the whole signal: `packages/host/src/secrets/names.ts`
 * exports it as `SecretNotFound.name`, and the source narrows on it rather
 * than on `instanceof`, which this package cannot reach.
 */
function missingSecretResolver(): (name: string) => Promise<string> {
  return async () => {
    const error = new Error('no value for secret "tpdb-api-key"');
    error.name = 'SecretNotFound';
    throw error;
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

  const answer = await source.imagesFor('scene', SCENE_REF, [], []);

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

test('matches a person by ref against the embedded performer, preferring the full image over the crops', async () => {
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

  const answer = await source.imagesFor('scene', SCENE_REF, [personRef], []);

  // **`image`, not `face`, and this expectation was the other way round.**
  // Measured on one real performer: `image` is 633x950 at 74 KB, `face` is
  // a 500x500 smart crop at 46 KB. Preferring `face` put a square head in
  // the gallery where the provider shows a portrait, for 28 KB -- and
  // `job.ts`'s 8 MiB cap is what actually bounds a download.
  assert.deepEqual(
    answer.people.get(personRef),
    [{ url: 'https://cdn.test/person-image.jpg', language: null, score: 0 }],
  );
});

test('a performer with no full image falls back to the thumbnail, and only then to the square crop', async () => {
  // The order matters below `image` too: `thumbnail` is 200x300 -- small
  // but the right shape -- where `face` is a square crop. A crop of the
  // right person still beats no picture, so it stays last rather than
  // being dropped.
  const thumbRef = 'db2a49dc-3333-3333-3333-333333333333';
  const faceRef = 'db2a49dc-4444-4444-4444-444444444444';
  const { fetch } = recordingFetch([
    sceneBody({
      performers: [
        performer(thumbRef, { image: null, thumbnail: 'https://cdn.test/t.jpg', face: 'https://cdn.test/f.jpg' }),
        performer(faceRef, { image: null, thumbnail: null, face: 'https://cdn.test/only-face.jpg' }),
      ],
    }),
  ]);
  const source = createTpdbSource({ fetch, resolveSecret: async () => TOKEN });

  const answer = await source.imagesFor('scene', SCENE_REF, [thumbRef, faceRef], []);

  assert.deepEqual(
    answer.people.get(thumbRef),
    [{ url: 'https://cdn.test/t.jpg', language: null, score: 0 }],
    'the thumbnail beats the crop',
  );
  assert.deepEqual(
    answer.people.get(faceRef),
    [{ url: 'https://cdn.test/only-face.jpg', language: null, score: 0 }],
    'and the crop is still better than nothing',
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

  const answer = await source.imagesFor('scene', SCENE_REF, [personRef], []);

  assert.deepEqual(
    answer.people.get(personRef),
    [{ url: 'https://cdn.test/parent-face.jpg', language: null, score: 0 }],
  );
});

test('a person ref matches the performer\'s PARENT id, which is the one openmetadata sends', async () => {
  // **The shape that made every xxx performer picture-less.** Read live
  // from ThePornDB: a scene's `performers[].id` is a scene-specific
  // record, and the id openmetadata hands over as `people[].providerRef`
  // is `performers[].parent.id`, the canonical performer. Matching on
  // `id` alone therefore never matched anything, so no adult release ever
  // stored a cast picture.
  //
  // Both uuids below are the real pair for one performer on one real
  // scene, copied rather than invented:
  //   openmetadata ref / parent.id  7a7a5268-c6be-48fb-9e27-96f9f9144201
  //   performers[].id               bb98a9ae-2d8f-492a-8198-f6349d9d194e
  const canonicalRef = '7a7a5268-c6be-48fb-9e27-96f9f9144201';
  const sceneSpecificId = 'bb98a9ae-2d8f-492a-8198-f6349d9d194e';
  const { fetch } = recordingFetch([
    sceneBody({
      performers: [
        performer(sceneSpecificId, {
          face: 'https://cdn.test/scene-face.jpg',
          parent: { id: canonicalRef, image: null, thumbnail: null, face: null },
        }),
      ],
    }),
  ]);
  const source = createTpdbSource({ fetch, resolveSecret: async () => TOKEN });

  const answer = await source.imagesFor('scene', SCENE_REF, [canonicalRef], []);

  assert.deepEqual(
    answer.people.get(canonicalRef),
    [{ url: 'https://cdn.test/scene-face.jpg', language: null, score: 0 }],
    'the picture is keyed by the ref openmetadata sent, not by the scene-specific id',
  );
});

test('a performer whose own id IS the ref still matches, so nothing that worked stops working', async () => {
  const ref = 'c0ffee00-2222-2222-2222-222222222222';
  const { fetch } = recordingFetch([
    sceneBody({ performers: [performer(ref, { face: 'https://cdn.test/own.jpg' })] }),
  ]);
  const source = createTpdbSource({ fetch, resolveSecret: async () => TOKEN });

  const answer = await source.imagesFor('scene', SCENE_REF, [ref], []);

  assert.deepEqual(
    answer.people.get(ref),
    [{ url: 'https://cdn.test/own.jpg', language: null, score: 0 }],
  );
});

test('a person whose embedded entry has no image anywhere -- own or parent -- omits the key', async () => {
  const personRef = 'no-picture-0000-0000-0000-000000000000';
  const missingRef = 'not-in-the-cast-0000-0000-000000000000';
  const { fetch } = recordingFetch([
    sceneBody({ performers: [performer(personRef)] }),
  ]);
  const source = createTpdbSource({ fetch, resolveSecret: async () => TOKEN });

  const answer = await source.imagesFor('scene', SCENE_REF, [personRef, missingRef], []);

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

  const answer = await source.imagesFor('scene', SCENE_REF, refs, []);

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

  const answer = await source.imagesFor('movie', SCENE_REF, ['someone'], []);

  assert.equal(sent.length, 0);
  assert.equal(resolver.count(), 0);
  assert.deepEqual(answer, { media: { posters: [], backgrounds: [], logos: [] }, people: new Map() });
});

test('no key answers no images and never throws', async () => {
  const { fetch, sent } = recordingFetch([sceneBody({})]);
  const source = createTpdbSource({ fetch, resolveSecret: missingSecretResolver() });

  const answer = await source.imagesFor('scene', SCENE_REF, ['someone'], []);

  assert.equal(sent.length, 0, 'a missing key must not reach the network');
  assert.deepEqual(answer, {
    media: { posters: [], backgrounds: [], logos: [] },
    people: new Map(),
    noCredential: true,
  });
});

test('a secret-resolution failure that is not "no key configured" still propagates', async () => {
  // `SecretsFileUnreadable` is the one that matters and it is not
  // hypothetical: `README.md` records `/run/secrets` being root-owned in
  // Docker as a live failure, and the host raises that distinct name so a
  // permissions problem is not mistaken for an unconfigured credential.
  // Swallowed here, it would read as "artwork is turned off" and the real
  // fault would surface nowhere.
  const { fetch, sent } = recordingFetch([sceneBody({})]);
  const source = createTpdbSource({
    fetch,
    resolveSecret: async () => {
      const error = new Error('the secrets directory could not be read');
      error.name = 'SecretsFileUnreadable';
      throw error;
    },
  });

  await assert.rejects(() => source.imagesFor('scene', SCENE_REF, ['someone'], []), /could not be read/);
  assert.equal(sent.length, 0);
});
