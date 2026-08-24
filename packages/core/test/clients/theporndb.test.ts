import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backgroundFromCrop,
  BACKGROUND_CROP_MARKER,
  createTpdbClient,
  isBackgroundCrop,
  PROVIDER_REQUEST_TIMEOUT_MS,
  RateLimited,
  readScenes,
  type FetchImpl,
} from '../../src/clients/theporndb.ts';
import type { SiteLookupConfig } from '../../src/config/schema.ts';
import type { MetadataCandidate } from '@pickarr/plugin-api';
import { stubAbortTimeout } from '../abort-timeout.ts';

const API_KEY = 'tpdb-secret-key-0123456789abcdef';

const CONFIG: SiteLookupConfig = {
  type: 'theporndb',
  apiKey: API_KEY,
  baseUrl: 'https://api.theporndb.net',
};

/**
 * `urls` records every request made through this fake, in order — needed by
 * tests that assert on the query string built (e.g. `site_id=`) or on how
 * many requests a single search cost.
 */
function respondWith(body: unknown, init?: ResponseInit): FetchImpl & { urls: string[] } {
  const urls: string[] = [];
  const impl: FetchImpl = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  };
  return Object.assign(impl, { urls });
}

function site(name: string, shortName: string): Record<string, unknown> {
  return {
    uuid: `uuid-${shortName}`,
    id: 42,
    name,
    short_name: shortName,
    url: 'https://example.test',
  };
}

test('results are returned with both spellings intact', async () => {
  const client = createTpdbClient(CONFIG, respondWith({ data: [site('Bang Bros', 'bangbros')] }));
  assert.deepEqual(await client.searchSites('bangbros'), [
    { name: 'Bang Bros', shortName: 'bangbros', sourceUuid: 'uuid-bangbros', sourceId: 42 },
  ]);
});

test('every result is returned, not just ones resembling the query', async () => {
  // Deciding which result is the site needs the release name, which this
  // client does not have. Filtering here would discard "2 Chicks Same Time"
  // because the query was "2 Chicks".
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [site('2 Chicks Same Time', '2chickssametime'), site('2 Chicks 1 Dick', '2chicks1dick')],
    }),
  );
  assert.equal((await client.searchSites('2 chicks')).length, 2);
});

test("the site's uuid is carried through", async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [{ name: 'S', short_name: 's', id: 108995, uuid: 'u-1' }] }),
  );
  const [result] = await client.searchSites('s');
  assert.equal(result?.sourceUuid, 'u-1');
});

test('a site search captures the integer id alongside the uuid', async () => {
  // GET /scenes?site_id= accepts only the integer form, never the uuid, which
  // is why both are kept even though /sites/<id> and /sites/<uuid> return the
  // same record.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ name: 'Naughty Office', short_name: 'naughtyoffice', uuid: 'site-uuid', id: 1 }],
    }),
  );
  const [site] = await client.searchSites('naughty office');
  assert.equal(site?.sourceUuid, 'site-uuid');
  assert.equal(site?.sourceId, 1);
});

test('a non-integer or missing id is null rather than invented', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [
        { name: 'A', short_name: 'a', uuid: 'u-a' },
        { name: 'B', short_name: 'b', uuid: 'u-b', id: 'not-a-number' },
        { name: 'C', short_name: 'c', uuid: 'u-c', id: 1.5 },
      ],
    }),
  );
  const results = await client.searchSites('x');
  assert.deepEqual(
    results.map((r) => r.sourceId),
    [null, null, null],
  );
});

test('a missing or empty uuid is null rather than invented', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [{ name: 'S', short_name: 's', uuid: '' }, { name: 'T', short_name: 't' }] }),
  );
  const results = await client.searchSites('s');
  assert.equal(results[0]?.name, 'S', 'the site is still usable without an identifier');
  assert.equal(results[0]?.sourceUuid, null);
  assert.equal(results[1]?.sourceUuid, null);
});

test('an empty result set is a negative, not an error', async () => {
  const client = createTpdbClient(CONFIG, respondWith({ data: [], meta: { total: 0 } }));
  assert.deepEqual(await client.searchSites('bangbros ass'), []);
});

// --- Paging ------------------------------------------------------------------

/** Serves `total` generated sites, honouring page and per_page. */
function pagedFetch(total: number): FetchImpl & { pages: number[] } {
  const pages: number[] = [];
  const impl = async (url: string) => {
    const page = Number(new URL(url).searchParams.get('page'));
    const perPage = Number(new URL(url).searchParams.get('per_page'));
    pages.push(page);
    const start = (page - 1) * perPage;
    const data = Array.from({ length: Math.max(0, Math.min(perPage, total - start)) }, (_, i) => ({
      name: `Site ${start + i}`,
      short_name: `site${start + i}`,
    }));
    return new Response(JSON.stringify({ data, meta: { total } }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return Object.assign(impl, { pages });
}

test('a single short page costs exactly one request', async () => {
  const fetchImpl = pagedFetch(6);
  await createTpdbClient(CONFIG, fetchImpl).searchSites('free use');
  assert.deepEqual(fetchImpl.pages, [1]);
});

test('a result set larger than one page is followed to the end', async () => {
  // q="free" reports 149 matches; the site being looked for can sit past the
  // first hundred, and the service caps per_page at 100.
  const fetchImpl = pagedFetch(149);
  const results = await createTpdbClient(CONFIG, fetchImpl).searchSites('free');
  assert.deepEqual(fetchImpl.pages, [1, 2]);
  assert.equal(results.length, 149);
  assert.equal(results.at(-1)?.name, 'Site 148');
});

test('a long but realistic result set is walked to the end', async () => {
  // Measured live: anal=352, teen=349, big=649. All must be reachable.
  for (const total of [352, 649]) {
    const fetchImpl = pagedFetch(total);
    const results = await createTpdbClient(CONFIG, fetchImpl).searchSites('big');
    assert.equal(results.length, total, `total=${total}`);
    assert.equal(results.at(-1)?.name, `Site ${total - 1}`);
  }
});

test('a query too broad to be a site name is not walked past the first page', async () => {
  // q="a" reports 87,955 matches. Paging that to look for an exact name is
  // pointless work; page one still gets examined because an exact match
  // tends to rank first.
  const fetchImpl = pagedFetch(87_955);
  const results = await createTpdbClient(CONFIG, fetchImpl).searchSites('a');
  assert.deepEqual(fetchImpl.pages, [1]);
  assert.equal(results.length, 100);
});

test('paging is bounded even when the service keeps offering full pages', async () => {
  const fetchImpl = pagedFetch(999);
  const results = await createTpdbClient(CONFIG, fetchImpl).searchSites('x');
  assert.equal(fetchImpl.pages.length, 10, 'MAX_PAGES caps the walk');
  assert.equal(results.length, 999);
});

test('an exactly-full single page does not provoke a second request', async () => {
  const fetchImpl = pagedFetch(100);
  await createTpdbClient(CONFIG, fetchImpl).searchSites('x');
  assert.deepEqual(fetchImpl.pages, [1], 'meta.total says 100, so page 1 is everything');
});

test('a full page with no usable total still terminates', async () => {
  let calls = 0;
  const client = createTpdbClient(CONFIG, async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ data: Array.from({ length: 100 }, (_, i) => site(`S${i}`, `s${i}`)) }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  const results = await client.searchSites('x');
  assert.equal(calls, 10, 'without a total it pages to the cap and stops');
  assert.equal(results.length, 1000);
});

test('the query is sent url-encoded with the documented parameters', async () => {
  let seen = '';
  const client = createTpdbClient(CONFIG, async (url) => {
    seen = url;
    return new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  await client.searchSites('anal only');
  assert.equal(seen, 'https://api.theporndb.net/sites?q=anal%20only&page=1&per_page=100');
});

test('the key is sent as a bearer token and never in the url', async () => {
  let seenUrl = '';
  let seenAuth: string | null = null;
  const client = createTpdbClient(CONFIG, async (url, init) => {
    seenUrl = url;
    seenAuth = new Headers(init?.headers).get('authorization');
    return new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  await client.searchSites('anal only');
  assert.equal(seenAuth, `Bearer ${API_KEY}`);
  assert.ok(!seenUrl.includes(API_KEY), 'the api key must never appear in the request url');
});

// --- The key must not escape into an error ----------------------------------

test('a transport failure that echoes the key does not leak it', async () => {
  const client = createTpdbClient(CONFIG, async () => {
    throw new Error(`connect ECONNREFUSED (sent Authorization: Bearer ${API_KEY})`);
  });
  const error = await client.searchSites('anal only').then(
    () => null,
    (thrown: Error) => thrown,
  );
  assert.ok(error !== null);
  assert.ok(!error.message.includes(API_KEY), `leaked the key: ${error.message}`);
  assert.ok(error.message.includes('ECONNREFUSED'), 'the rest must stay legible');
});

test('an unreadable body that echoes the key does not leak it', async () => {
  const client = createTpdbClient(CONFIG, async () => {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.reject(new Error(`bad json near Bearer ${API_KEY}`)),
    } as unknown as Response;
  });
  const error = await client.searchSites('anal only').then(
    () => null,
    (thrown: Error) => thrown,
  );
  assert.ok(error !== null);
  assert.ok(!error.message.includes(API_KEY), `leaked the key: ${error.message}`);
});

test('an http error names the status and carries no key', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({ message: 'Unauthenticated.' }, { status: 401, statusText: 'Unauthorized' }),
  );
  const error = await client.searchSites('anal only').then(
    () => null,
    (thrown: Error) => thrown,
  );
  assert.ok(error !== null);
  assert.ok(error.message.includes('401'), error.message);
  assert.ok(!error.message.includes(API_KEY));
});

// --- Malformed responses are "no match", never a confirmation ---------------

test('a structurally wrong body yields no match rather than throwing', async () => {
  for (const body of [null, {}, { data: null }, { data: {} }, { data: [null, 3, 'x'] }, []]) {
    const client = createTpdbClient(CONFIG, respondWith(body));
    assert.deepEqual(await client.searchSites('anal only'), [], JSON.stringify(body));
  }
});

test('unknown extra fields on a site do not prevent it being read', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [{ ...site('Anal Only', 'analonly'), some_new_field: { a: 1 } }] }),
  );
  assert.deepEqual(await client.searchSites('anal only'), [
    { name: 'Anal Only', shortName: 'analonly', sourceUuid: 'uuid-analonly', sourceId: 42 },
  ]);
});

test('an empty query is refused without a request', async () => {
  let called = false;
  const client = createTpdbClient(CONFIG, async () => {
    called = true;
    return new Response('{}');
  });
  assert.deepEqual(await client.searchSites('   '), []);
  assert.equal(called, false);
});

test('a trailing slash on the base url does not double up', async () => {
  let seen = '';
  const client = createTpdbClient({ ...CONFIG, baseUrl: 'https://api.theporndb.net/' }, async (url) => {
    seen = url;
    return new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  await client.searchSites('x');
  assert.ok(seen.startsWith('https://api.theporndb.net/sites?'), seen);
});

// --- Scene search ------------------------------------------------------------

const SCENE_BODY = {
  data: [{
    id: 'd284e2a0-789d-4e6c-beb9-6e61c24e8b84',
    _id: 0,
    title: 'Smokin Hot Brunette Silvia Saige',
    description: "Silvia Saige has been Sam's therapist for a while",
    date: '2021-11-15',
    duration: 1000,
    poster: 'https://thumb.theporndb.net/office-couch.jpg',
    posters: { full: 'https://cdn/full.jpg', large: 'https://cdn/large.jpg' },
    image: 'https://images1.naughtycdn.com/h.jpg',
    performers: [{
      id: 'performer-uuid', slug: 'jessica-jaymes',
      name: 'Jessica Jaymes', full_name: 'Jessica Jaymes (2005)',
    }],
    site: { uuid: 'site-uuid', id: 1, name: 'Naughty Office', short_name: 'naughtyoffice' },
  }],
  meta: { total: 1, per_page: 25, current_page: 1, last: 1 },
};

test('a scene search maps the documented payload', async () => {
  const client = createTpdbClient(CONFIG, respondWith(SCENE_BODY));
  const [scene] = await client.searchScenes('Smokin Hot Brunette', 1);

  assert.equal(scene?.sourceUuid, 'd284e2a0-789d-4e6c-beb9-6e61c24e8b84',
    'a scene id is the uuid string; _id is the integer');
  assert.equal(scene?.siteId, 1);
  assert.equal(scene?.siteUuid, 'site-uuid');
  assert.equal(scene?.date, '2021-11-15');
  assert.equal(scene?.durationSeconds, 1000);
  assert.deepEqual(scene?.performers, [{
    sourceUuid: 'performer-uuid',
    slug: 'jessica-jaymes',
    name: 'Jessica Jaymes',
    kind: 'performer-site',
    faceUrl: null,
    imageUrl: null,
  }], 'name, not full_name, which carries a disambiguation suffix');
  assert.equal(scene?.posterUrl, 'https://cdn/large.jpg', 'posters.large is preferred');
});

test('the site id narrows the query and is omitted when unknown', async () => {
  const withId = respondWith(SCENE_BODY);
  const client = createTpdbClient(CONFIG, withId);
  await client.searchScenes('x', 1);
  assert.ok(withId.urls[0]?.includes('site_id=1'));

  const without = respondWith(SCENE_BODY);
  await createTpdbClient(CONFIG, without).searchScenes('x', null);
  assert.ok(!without.urls[0]?.includes('site_id'));
});

test('only one page is requested', async () => {
  const full = { ...SCENE_BODY, meta: { total: 210, per_page: 25, current_page: 1, last: 10 } };
  const fetchImpl = respondWith(full);
  await createTpdbClient(CONFIG, fetchImpl).searchScenes('x', 1);
  assert.equal(fetchImpl.urls.length, 1,
    'a title plus a site filter ranks the match on page one or the rule rejects it anyway');
});

test('a structurally broken entry yields no candidate rather than a partial one', async () => {
  const client = createTpdbClient(CONFIG, respondWith({ data: [{ id: 5 }, null, 'nonsense'] }));
  assert.deepEqual(await client.searchScenes('x', null), []);
});

test('further malformed shapes are tolerated: a bare number, and a site given as a string', async () => {
  // Guards readScenes against exactly the shapes the brief calls out: an
  // entry that is a bare number, and a `site` that is not an object at all.
  // Neither may throw or produce a half-populated candidate.
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [7, { title: 'Only A Title', site: 'not-an-object' }] }),
  );
  const results = await client.searchScenes('x', null);
  assert.deepEqual(results, [{
    sourceUuid: null,
    title: 'Only A Title',
    siteUuid: null,
    siteId: null,
    siteName: '',
    date: null,
    performers: [],
    durationSeconds: null,
    synopsis: null,
    posterUrl: null,
    backgroundUrl: null,
    slug: null,
  }]);
});

// --- Synthesised portrait posters --------------------------------------------

/**
 * A real row from this library's database, kept verbatim rather than trimmed.
 * The awkward parts are the point: the `filters:` segment carries a
 * `watermark(...)` argument holding its own percent-encoded path, so anything
 * that counts path segments from the left recovers the site's logo instead of
 * the scene's background.
 */
const CROP =
  'https://thumb.theporndb.net/6lTbCMl9aBGSuDkuuUA3ucoAKyU=/800x1200/smart/' +
  'filters:sharpen():upscale():watermark(sites%2F4b%2F4b%2F8a%2F3d0384f4e2ca36ac5ff275029d5c746' +
  '%2Flogo%2Fcreampieangels-logo.png,-10,-10,25,50)/' +
  'scene%2Ff9%2F84%2F16%2F55aa1763635d4e5bb83d6f63f8f5639%2Fbackground' +
  '%2Fbg-creampieangels-dude-fixes-blonde-pussy-on-a-chair.jpg';

const BACKGROUND =
  'https://cdn.theporndb.net/scene/f9/84/16/55aa1763635d4e5bb83d6f63f8f5639/background/' +
  'bg-creampieangels-dude-fixes-blonde-pussy-on-a-chair.jpg';

function sceneWith(over: Record<string, unknown>): Record<string, unknown> {
  return { data: [{ id: 'scene-uuid', title: 'A Scene', ...over }] };
}

/** Drives the scene reader directly, synchronously, from a partial record. */
function parseScene(over: Record<string, unknown>): MetadataCandidate {
  const [scene] = readScenes(sceneWith(over));
  if (scene === undefined) throw new Error('sceneWith always yields exactly one entry');
  return scene;
}

test('a crop url yields the background it was cut from, not the watermark logo', () => {
  assert.ok(isBackgroundCrop(CROP));
  assert.ok(CROP.includes(BACKGROUND_CROP_MARKER));
  assert.equal(backgroundFromCrop(CROP), BACKGROUND);
});

test('a poster that is not a crop is left alone', () => {
  const real = 'https://cdn.theporndb.net/scene/e2/b4/poster/c/poster-daytime-delight-large.jpg';
  assert.equal(isBackgroundCrop(real), false);
  assert.equal(backgroundFromCrop(real), null, 'nothing to recover from a genuine poster');
});

test('a foreign origin smuggled into the encoded segment is refused', () => {
  // The decoded text steers a fetch and names a file on disk, so resolving it
  // against the CDN must not be allowed to adopt a different host.
  const hostile = `https://thumb.theporndb.net/hash=${BACKGROUND_CROP_MARKER}https%3A%2F%2Fevil.example%2Fx.jpg`;
  assert.equal(backgroundFromCrop(hostile), null);

  const protocolRelative = `https://thumb.theporndb.net/hash=${BACKGROUND_CROP_MARKER}%2F%2Fevil.example%2Fx.jpg`;
  assert.equal(backgroundFromCrop(protocolRelative), null);
});

test('an undecodable or empty segment yields nothing rather than a guess', () => {
  assert.equal(backgroundFromCrop(`https://thumb.theporndb.net/h=${BACKGROUND_CROP_MARKER}%zz.jpg`), null);
  assert.equal(backgroundFromCrop(`https://thumb.theporndb.net/h=${BACKGROUND_CROP_MARKER}`), null);
  assert.equal(backgroundFromCrop('not a url at all'), null);
});

test('a synthesised crop yields no poster candidate, and its source as the background', () => {
  const crop = `https://thumb.theporndb.net/abc=/800x1200/smart/filters:watermark(sites%2Fx%2Flogo.png,0,0,0)/scene%2Faa%2Fbb%2Fbackground%2Fbg-x.jpg`;
  const scene = parseScene({ posters: { large: crop } });
  assert.equal(scene.posterUrl, null);
  assert.equal(scene.backgroundUrl, 'https://cdn.theporndb.net/scene/aa/bb/background/bg-x.jpg');
});

test('a real poster and a background are both read, independently', () => {
  const scene = parseScene({
    posters: { large: 'https://cdn.theporndb.net/scene/aa/poster/p.jpg' },
    background: { full: 'https://cdn.theporndb.net/scene/aa/background/b.jpg' },
  });
  assert.equal(scene.posterUrl, 'https://cdn.theporndb.net/scene/aa/poster/p.jpg');
  assert.equal(scene.backgroundUrl, 'https://cdn.theporndb.net/scene/aa/background/b.jpg');
});

test('the studio image field is a background candidate, not a poster one', () => {
  // The client's own comment records this field as 1279x719, so it has never
  // been safe to call it a poster.
  const scene = parseScene({ image: 'https://studio.example/still.jpg' });
  assert.equal(scene.posterUrl, null);
  assert.equal(scene.backgroundUrl, 'https://studio.example/still.jpg');
});

test('the posters set prefers large over full, and falls through to the bare poster field', () => {
  assert.equal(
    parseScene({
      posters: { large: 'https://cdn.theporndb.net/a/poster/l.jpg', full: 'https://cdn.theporndb.net/a/poster/f.jpg' },
    }).posterUrl,
    'https://cdn.theporndb.net/a/poster/l.jpg',
  );
  assert.equal(
    parseScene({ poster: 'https://cdn.theporndb.net/a/poster/p.jpg' }).posterUrl,
    'https://cdn.theporndb.net/a/poster/p.jpg',
  );
});

test("the payload's own background is preferred over a crop of it", () => {
  const scene = parseScene({
    posters: { large: CROP, full: CROP },
    background: {
      full: BACKGROUND,
      large: 'https://cdn.theporndb.net/scene/f9/84/16/large.jpg',
    },
  });
  assert.equal(scene.posterUrl, null, 'a crop is never filed as a poster, no matter what else is offered');
  assert.equal(
    scene.backgroundUrl,
    BACKGROUND,
    'full, not large: this branch exists because a downscaled rendition was the problem',
  );
});

test('a crop with no background object falls back to decoding the crop url', () => {
  const scene = parseScene({ posters: { large: CROP } });
  assert.equal(scene.posterUrl, null);
  assert.equal(scene.backgroundUrl, BACKGROUND);
});

test('a background that is itself a crop is not trusted', () => {
  const scene = parseScene({ posters: { large: CROP }, background: { full: CROP } });
  assert.equal(scene.posterUrl, null);
  assert.equal(scene.backgroundUrl, BACKGROUND);
});

test('an unrecoverable crop is stored as neither poster nor background', () => {
  // Previously this was "kept" as the poster, so the card at least had an
  // image and the repair script could still find it by its marker. Neither
  // reader returns a raw crop under either name now: a crop is never a
  // poster, and a background recovered from nothing is not a background.
  const undecodable = `https://thumb.theporndb.net/h=${BACKGROUND_CROP_MARKER}%zz.jpg`;
  const scene = parseScene({ posters: { large: undecodable } });
  assert.equal(scene.posterUrl, null);
  assert.equal(scene.backgroundUrl, null);
});

test('a genuine poster is never rewritten, background object or not', () => {
  const real = 'https://cdn.theporndb.net/scene/e2/b4/poster/c/poster-large.jpg';
  const scene = parseScene({ posters: { large: real }, background: { full: BACKGROUND } });
  assert.equal(scene.posterUrl, real, 'a real poster is never displaced by a background, offered or not');
  assert.equal(scene.backgroundUrl, BACKGROUND, 'and the background is read independently, into its own column');
});

// Shapes taken from a live `GET /scenes?per_page=1`, trimmed to the fields
// this reads. The nesting is the point: `image`, `thumbnail` and `face` are
// null on the site performer and populated on its parent, so a reader that
// trusts the outer object renders no avatars at all.
const PERFORMER_BODY = {
  data: [{
    id: 'scene-uuid', _id: 1, title: 'T', date: '2025-02-07',
    slug: 'futilestruggles-alice-maze-first-time-day-1-episode-1',
    url: 'https://www.futilestruggles.com/trial/gallery.php?id=2583',
    site: { uuid: 'site-uuid', id: 6061, name: 'Futile Struggles' },
    performers: [{
      id: 'site-performer-uuid', _id: 2750085, slug: '6061-alice-maze',
      site_id: 6061, name: 'Alice Maze',
      image: null, thumbnail: null, face: null,
      parent: {
        id: 'parent-uuid', _id: 165140, slug: 'alice-maze', name: 'Alice Maze',
        image: 'https://cdn.theporndb.net/p/alice-maze.jpg',
        thumbnail: 'https://cdn.theporndb.net/p/c/alice-maze-thumb.jpg',
        face: 'https://thumb.theporndb.net/x/500x500/smart/alice-maze.jpg',
      },
    }],
  }],
  meta: { total: 1, per_page: 25, current_page: 1, last: 1 },
};

test('a performer is read from its parent, which is where the images are', async () => {
  const client = createTpdbClient(CONFIG, respondWith(PERFORMER_BODY));
  const [scene] = await client.searchScenes('x', 1);

  assert.deepEqual(scene?.performers, [{
    sourceUuid: 'parent-uuid',
    slug: 'alice-maze',
    name: 'Alice Maze',
    kind: 'performer',
    faceUrl: 'https://thumb.theporndb.net/x/500x500/smart/alice-maze.jpg',
    imageUrl: 'https://cdn.theporndb.net/p/alice-maze.jpg',
  }], 'the parent uuid and slug, not the site-prefixed ones');
});

test('a parentless performer falls back to itself and is a site performer', async () => {
  const body = structuredClone(PERFORMER_BODY);
  delete (body.data[0]!.performers[0] as { parent?: unknown }).parent;
  const client = createTpdbClient(CONFIG, respondWith(body));
  const [scene] = await client.searchScenes('x', 1);

  // `kind` is what decides the URL namespace later: /performer-sites/, not
  // /performers/, because the site-prefixed slug is not a performer page.
  assert.deepEqual(scene?.performers, [{
    sourceUuid: 'site-performer-uuid',
    slug: '6061-alice-maze',
    name: 'Alice Maze',
    kind: 'performer-site',
    faceUrl: null,
    imageUrl: null,
  }]);
});

test('a performer with no usable identity is dropped, not half-read', async () => {
  // No slug means no link and no stable key. A row keyed on '' would collide
  // with every other such performer under UNIQUE (source, source_uuid).
  const body = structuredClone(PERFORMER_BODY);
  const performer = body.data[0]!.performers[0] as Record<string, unknown>;
  delete performer['parent'];
  performer['slug'] = '';
  const client = createTpdbClient(CONFIG, respondWith(body));
  const [scene] = await client.searchScenes('x', 1);
  assert.deepEqual(scene?.performers, []);
});

test('the scene slug is captured and the studio url is not mistaken for it', async () => {
  const client = createTpdbClient(CONFIG, respondWith(PERFORMER_BODY));
  const [scene] = await client.searchScenes('x', 1);
  assert.equal(scene?.slug, 'futilestruggles-alice-maze-first-time-day-1-episode-1');
});

test('a scene search failure redacts the bearer token', async () => {
  const client = createTpdbClient(CONFIG, () => {
    throw new Error(`connect failed with Bearer ${CONFIG.apiKey}`);
  });
  await assert.rejects(client.searchScenes('x', null), (error: Error) => {
    assert.ok(!error.message.includes(CONFIG.apiKey));
    return true;
  });
});

test('a 429 raises RateLimited rather than a generic error', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({ message: 'Too Many Attempts.' }, { status: 429, headers: { 'retry-after': '30' } }),
  );
  await assert.rejects(client.searchScenes('x', null), (error: unknown) => {
    assert.ok(error instanceof RateLimited);
    assert.equal(error.retryAfterMs, 30_000);
    return true;
  });
});

test('a 429 with no usable retry-after defaults to a minute', async () => {
  const client = createTpdbClient(CONFIG, respondWith({}, { status: 429 }));
  await assert.rejects(client.searchScenes('x', null), (error: unknown) => {
    assert.ok(error instanceof RateLimited);
    assert.equal(error.retryAfterMs, 60_000);
    return true;
  });
});

test('an empty scene query is refused without a request', async () => {
  const fetchImpl = respondWith(SCENE_BODY);
  const client = createTpdbClient(CONFIG, fetchImpl);
  assert.deepEqual(await client.searchScenes('   ', null), []);
  assert.equal(fetchImpl.urls.length, 0);
});

// --- Timeouts ----------------------------------------------------------------
//
// A host that accepts the connection and then sends nothing must not hang
// these calls forever: the metadata worker runs its pass under a `tryRun`
// mutex, so one hung lookup silently stops every metadata lookup after it
// (see the comment on PROVIDER_REQUEST_TIMEOUT_MS). `fetchImpl` below never
// settles and never looks at `init.signal` — the worst case, a test double
// that is not even aware a timeout exists — so a passing test here proves
// the deadline is enforced by this client itself, not merely honoured by a
// cooperative fetch implementation. Node's fake timers stand in for real
// time so the test resolves instantly rather than actually waiting out the
// deadline, and the explicit per-test `timeout` bounds the test in case the
// deadline is not actually enforced and the promise never settles.

test(
  'a site search that never gets a response is abandoned rather than hung forever',
  { timeout: 2_000 },
  async (t) => {
    const timeout = stubAbortTimeout(t);
    const client = createTpdbClient(CONFIG, () => new Promise(() => undefined));

    const pending = assert.rejects(client.searchSites('bangbros'));
    assert.deepEqual(
      timeout.requested,
      [PROVIDER_REQUEST_TIMEOUT_MS],
      'the deadline is asked for before the request, and is the documented one',
    );
    timeout.fire();
    await pending;
  },
);

test(
  'a scene search that never gets a response is abandoned rather than hung forever, ' +
    'and is not mistaken for a rate limit',
  { timeout: 2_000 },
  async (t) => {
    const timeout = stubAbortTimeout(t);
    const client = createTpdbClient(CONFIG, () => new Promise(() => undefined));

    const pending = assert.rejects(client.searchScenes('bangbros', null), (error: unknown) => {
      // A slow host must defer one row, not abort the whole pass the way a
      // 429 does — so a timeout must never surface as RateLimited.
      assert.ok(!(error instanceof RateLimited), 'a timeout must not be treated as a rate limit');
      return true;
    });
    assert.deepEqual(timeout.requested, [PROVIDER_REQUEST_TIMEOUT_MS]);
    timeout.fire();
    await pending;
  },
);

// --- Performer search ---------------------------------------------------------

test('searchPerformers reads a top-level result as a canonical performer', async () => {
  // `is_parent` is the whole point of this test. `readPerformers` derives kind
  // from a nested `parent`, which a scene's site-performers have and a top-level
  // /performers result does not — it *is* the parent. Reusing that reader here
  // would stamp every linked performer `performer-site` and point them all at
  // alias pages, which is invisible until a user clicks one.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{
        id: '32aa4b68-4dbe-49f2-92a5-0e54e5074f4b',
        slug: 'jessica-jaymes',
        name: 'Jessica Jaymes',
        full_name: 'Jessica Jaymes (2005)',
        is_parent: true,
        aliases: ['Jessi Jaymes'],
        image: 'https://cdn.invalid/image.jpg',
        face: 'https://cdn.invalid/face.jpg',
      }],
      meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  const page = await client.searchPerformers('Jessica Jaymes');

  assert.equal(page.truncated, false);
  assert.equal(page.results.length, 1);
  assert.deepEqual(page.results[0]?.performer, {
    sourceUuid: '32aa4b68-4dbe-49f2-92a5-0e54e5074f4b',
    slug: 'jessica-jaymes',
    // `name`, never `full_name`: the latter carries a disambiguation suffix that
    // could never equal a two-word query.
    name: 'Jessica Jaymes',
    kind: 'performer',
    faceUrl: 'https://cdn.invalid/face.jpg',
    imageUrl: 'https://cdn.invalid/image.jpg',
  });
  assert.deepEqual(page.results[0]?.aliases, ['Jessi Jaymes']);
});

test('the performer search asks the documented endpoint for a full page, query encoded', async () => {
  // The url is pinned rather than left to the payload assertions above, because
  // every one of those passes against a typo in it. `per_page=100` in particular
  // is a correctness requirement and not a throughput one: the match rule turns
  // on *how many* candidates match exactly, so a narrower page hides a second
  // exact match and converts an ambiguity — link nothing — into a confident
  // wrong link. A dropped `encodeURIComponent` is the other invisible one; a
  // bare space in a query string is a malformed request, and the two-word query
  // this whole feature is built on always has one.
  const fetchImpl = respondWith({
    data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true }],
    meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
  });
  const client = createTpdbClient(CONFIG, fetchImpl);

  await client.searchPerformers('Jessica Jaymes');

  const url = fetchImpl.urls[0] ?? '';
  assert.ok(url.startsWith('https://api.theporndb.net/performers?'), `wrong endpoint: ${url}`);
  assert.ok(url.includes('per_page=100'), `page not asked in full: ${url}`);
  assert.ok(url.includes('page=1'), `first page not named: ${url}`);
  // Spelled literally rather than rebuilt with `encodeURIComponent`, which is
  // the helper under test here: an expectation computed by the code under test
  // cannot detect that code being dropped.
  assert.ok(url.includes('q=Jessica%20Jaymes'), `query not encoded: ${url}`);
});

test('a provider reporting more pages than were read is reported as truncated', () => {
  // The match rule turns on *how many* candidates match exactly. A second exact
  // match sitting on page two would turn "link nothing, this is ambiguous" into
  // a confident wrong link, so the caller has to be able to say it judged on a
  // partial set rather than doing so in silence.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true }],
      meta: { total: 210, per_page: 100, current_page: 1, last: 3 },
    }),
  );

  return client.searchPerformers('N').then((page) => assert.equal(page.truncated, true));
});

test('a body with no meta block is not treated as truncated', () => {
  // `truncated` is a claim that more pages exist. An absent `meta` is not
  // evidence of that, and defaulting it to true would log a truncation warning
  // on every search against a provider that stops sending the block.
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true }] }),
  );

  return client.searchPerformers('N').then((page) => assert.equal(page.truncated, false));
});

test('a result without is_parent is a site alias, not a canonical performer', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ id: 'u1', slug: '6061-alice-maze', name: 'Alice Maze', is_parent: false }],
      meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.equal(
    (await client.searchPerformers('Alice Maze')).results[0]?.performer.kind,
    'performer-site',
  );
});

test('a non-boolean is_parent is "not stated", not silently truthy', async () => {
  // `1` and `'true'` are both truthy, and a coercing reader would call each of
  // these canonical. `is_parent` is compared against `true` precisely so a
  // provider that changes the field's type reads as "not stated" and falls to
  // the alias namespace — where `pickPerformer` declines to link it — rather
  // than quietly stamping an alias page as the canonical identity.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [
        { id: 'u1', slug: 'one', name: 'One', is_parent: 1 },
        { id: 'u2', slug: 'two', name: 'Two', is_parent: 'true' },
        { id: 'u3', slug: 'three', name: 'Three', is_parent: null },
      ],
      meta: { total: 3, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.deepEqual(
    (await client.searchPerformers('x')).results.map((r) => r.performer.kind),
    ['performer-site', 'performer-site', 'performer-site'],
  );
});

test('an empty alias is dropped rather than carried as a matchable empty string', async () => {
  // An empty alias would normalise to the empty string, and so would a query
  // that normalised away entirely — `pickPerformer` refuses an empty query for
  // that reason, but the alias side has to hold up its own end rather than rely
  // on it.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true, aliases: ['', 'x', 7, null] }],
      meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.deepEqual((await client.searchPerformers('x')).results[0]?.aliases, ['x']);
});

test('a result missing its slug or uuid is dropped rather than stored empty', async () => {
  // The slug is the whole link, and an absent uuid collides with every other
  // such row under UNIQUE (source, source_uuid) — the same reason
  // `readPerformers` drops these.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [
        { id: 'u1', name: 'No Slug', is_parent: true },
        { slug: 'no-uuid', name: 'No Uuid', is_parent: true },
        { id: 'u2', slug: 'fine', name: 'Fine Person', is_parent: true },
      ],
      meta: { total: 3, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.deepEqual(
    (await client.searchPerformers('x')).results.map((r) => r.performer.name),
    ['Fine Person'],
  );
});

test('missing aliases read as an empty list, not undefined', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true }],
      meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.deepEqual((await client.searchPerformers('x')).results.map((r) => r.aliases), [[]]);
});

test('an empty query never reaches the provider', async () => {
  let called = false;
  const client = createTpdbClient(
    CONFIG,
    async (url) => { called = true; return respondWith({ data: [] })(url); },
  );

  assert.deepEqual(await client.searchPerformers('   '), { results: [], truncated: false });
  assert.equal(called, false);
});

test('the api key never appears in a searchPerformers error', async () => {
  const client = createTpdbClient(
    CONFIG,
    async () => { throw new Error(`connect ECONNREFUSED with Bearer ${API_KEY}`); },
  );

  await assert.rejects(
    () => client.searchPerformers('Jessica Jaymes'),
    (error: Error) => !error.message.includes(API_KEY),
  );
});

test('a 429 from searchPerformers is RateLimited with the Retry-After', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({}, { status: 429, headers: { 'Retry-After': '120' } }),
  );

  await assert.rejects(() => client.searchPerformers('x'), (error: Error) => {
    assert.ok(error instanceof RateLimited);
    assert.equal(error.retryAfterMs, 120_000);
    return true;
  });
});
