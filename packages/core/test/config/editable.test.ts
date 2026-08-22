import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config/load.ts';
import { toEditableConfig, applyEdits, type SubmittedConfig } from '../../src/config/editable.ts';
import { asJsonArray, asJsonObject, type JsonObject, type JsonValue } from '../../src/json.ts';

const VALID = {
  server: { port: 8080 },
  database: { path: '/config/pickarr.db' },
  trashDir: '/data/trash',
  plugins: {
    '@pickarr/plugin-scenes': {
      libraryRoot: '/media/scenes',
      sites: ['Vixen', 'Bangbros'],
      strict: true,
      retries: 3,
    },
  },
  downloadClients: [
    {
      id: 'sab',
      type: 'sabnzbd',
      url: 'http://sabnzbd:8080',
      apiKey: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
      category: 'pickarr',
      importMode: 'move',
      pathMappings: [{ from: '/downloads', to: '/data/downloads' }],
    },
  ],
  feeds: [
    { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900 },
  ],
  metadata: { enabled: true, intervalSeconds: 5, perTick: 5 },
};

function editableOf(over: (document: typeof VALID) => void = () => {}) {
  const document = structuredClone(VALID);
  over(document);
  return toEditableConfig(parseConfig(document as unknown as JsonValue, 'test'));
}

test('a literal api key becomes `set` and its value never appears', () => {
  const editable = editableOf();
  assert.deepEqual(editable.downloadClients[0]?.apiKey, { kind: 'set' });
  assert.doesNotMatch(JSON.stringify(editable), /0f1e2d3c4b5a69788796a5b4c3d2e1f0/);
});

test('a file: reference is projected as its path, because a path is not a secret', () => {
  const editable = editableOf((document) => {
    document.downloadClients[0]!.apiKey = 'file:/run/secrets/sabnzbd_api_key';
  });
  assert.deepEqual(editable.downloadClients[0]?.apiKey, {
    kind: 'file',
    path: '/run/secrets/sabnzbd_api_key',
  });
});

test('an absent siteLookup is null rather than missing', () => {
  assert.equal(editableOf().siteLookup, null);
});

test('a present siteLookup carries its defaulted baseUrl and a redacted key', () => {
  const editable = editableOf((document) => {
    Object.assign(document, { siteLookup: { type: 'theporndb', apiKey: 'tpdb-secret-key-value' } });
  });
  assert.equal(editable.siteLookup?.baseUrl, 'https://api.theporndb.net');
  assert.deepEqual(editable.siteLookup?.apiKey, { kind: 'set' });
  assert.doesNotMatch(JSON.stringify(editable), /tpdb-secret-key-value/);
});

test('metadata defaults are shown, and an absent artworkDir is null', () => {
  const editable = editableOf();
  assert.deepEqual(editable.metadata, {
    enabled: true,
    intervalSeconds: 5,
    perTick: 5,
    artworkDir: null,
  });
});

test('all four plugin value types survive the projection', () => {
  const plugin = editableOf().plugins['@pickarr/plugin-scenes'];
  assert.equal(plugin?.['libraryRoot'], '/media/scenes');
  assert.deepEqual(plugin?.['sites'], ['Vixen', 'Bangbros']);
  assert.equal(plugin?.['strict'], true);
  assert.equal(plugin?.['retries'], 3);
});

test('mutating an array in the projection does not affect the source config', () => {
  const editable = editableOf();
  const pluginRecord = editable.plugins['@pickarr/plugin-scenes'];
  const sitesValue = pluginRecord?.['sites'];
  assert.ok(Array.isArray(sitesValue));
  sitesValue.push('NewSite');
  const sourceSites = (VALID.plugins['@pickarr/plugin-scenes'] as Record<string, unknown>)[
    'sites'
  ] as string[];
  assert.deepEqual(sourceSites, ['Vixen', 'Bangbros']);
});

function submission(over: (draft: SubmittedConfig) => void = () => {}): SubmittedConfig {
  const draft: SubmittedConfig = {
    server: { port: 8080 },
    database: { path: '/config/pickarr.db' },
    trashDir: '/data/trash',
    plugins: {
      '@pickarr/plugin-scenes': {
        libraryRoot: '/media/scenes',
        sites: ['Vixen', 'Bangbros'],
        strict: true,
        retries: 3,
      },
    },
    downloadClients: [
      {
        id: 'sab',
        type: 'sabnzbd',
        url: 'http://sabnzbd:8080',
        apiKey: { kind: 'keep' },
        category: 'pickarr',
        importMode: 'move',
        pathMappings: [{ from: '/downloads', to: '/data/downloads' }],
      },
    ],
    feeds: [{ id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', downloadClient: 'sab', intervalSeconds: 900, backfill: null }],
    siteLookup: null,
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: null },
  };
  over(draft);
  return draft;
}

function applied(
  document: JsonValue,
  over: (draft: SubmittedConfig) => void = () => {},
): JsonObject {
  const result = applyEdits(document, submission(over));
  assert.ok('document' in result, 'error' in result ? result.error : 'expected a document');
  return result.document;
}

test('a kept secret keeps the exact value on disk', () => {
  const document = applied(structuredClone(VALID) as unknown as JsonValue);
  const clients = asJsonArray(document['downloadClients']);
  assert.equal(asJsonObject(clients[0])?.['apiKey'], '0f1e2d3c4b5a69788796a5b4c3d2e1f0');
});

test('a literal secret replaces what was on disk', () => {
  const document = applied(structuredClone(VALID) as unknown as JsonValue, (draft) => {
    draft.downloadClients[0]!.apiKey = { kind: 'literal', value: 'aaaabbbbccccddddeeee' };
  });
  const clients = asJsonArray(document['downloadClients']);
  assert.equal(asJsonObject(clients[0])?.['apiKey'], 'aaaabbbbccccddddeeee');
});

test('a file secret is written back with its prefix', () => {
  const document = applied(structuredClone(VALID) as unknown as JsonValue, (draft) => {
    draft.downloadClients[0]!.apiKey = { kind: 'file', path: '/run/secrets/key' };
  });
  const clients = asJsonArray(document['downloadClients']);
  assert.equal(asJsonObject(clients[0])?.['apiKey'], 'file:/run/secrets/key');
});

// The whole point of folding edits over the document rather than serialising a
// fresh object: a field this form does not model must survive a save.
test('a key the form does not model survives, and key order is unchanged', () => {
  const onDisk = structuredClone(VALID) as unknown as JsonObject;
  onDisk['futureSetting'] = { nested: ['a', 'b'] };
  const before = Object.keys(onDisk);

  const document = applied(onDisk);
  assert.deepEqual(document['futureSetting'], { nested: ['a', 'b'] });
  assert.deepEqual(Object.keys(document), before);
});

// The top-level version of this guarantee is not enough: `next['database']`
// etc. used to be freshly built objects, so a key nested *inside* one of them
// was dropped even though a sibling top-level key survived.
test('a key nested inside a known block survives, alongside its client and feed', () => {
  const onDisk = structuredClone(VALID) as unknown as JsonObject;
  asJsonObject(onDisk['database'])!['futureOption'] = 'kept';
  asJsonObject(onDisk['server'])!['futureOption'] = 'kept';
  asJsonObject(asJsonArray(onDisk['downloadClients'])[0])!['futureOption'] = 'kept';
  asJsonObject(asJsonArray(onDisk['feeds'])[0])!['futureOption'] = 'kept';
  onDisk['siteLookup'] = { type: 'theporndb', apiKey: 'tpdb-secret-key-value', futureOption: 'kept' };

  const document = applied(onDisk, (draft) => {
    draft.siteLookup = { type: 'theporndb', apiKey: { kind: 'keep' }, baseUrl: 'https://x.invalid' };
  });

  assert.equal(asJsonObject(document['database'])?.['futureOption'], 'kept');
  assert.equal(asJsonObject(document['server'])?.['futureOption'], 'kept');
  assert.equal(asJsonObject(asJsonArray(document['downloadClients'])[0])?.['futureOption'], 'kept');
  assert.equal(asJsonObject(asJsonArray(document['feeds'])[0])?.['futureOption'], 'kept');
  assert.equal(asJsonObject(document['siteLookup'])?.['futureOption'], 'kept');
});

// A nested unknown key must survive only alongside the block's *known*
// fields — it must not let a stale on-disk value leak back in once the
// submission removes it, the way merging naively could for `artworkDir`.
test('merging a nested unknown key into metadata does not resurrect a removed artworkDir', () => {
  const onDisk = structuredClone(VALID) as unknown as JsonObject;
  onDisk['metadata'] = { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: '/old/art', futureOption: 'kept' };
  const document = applied(onDisk);
  const metadata = asJsonObject(document['metadata']);
  assert.equal(metadata?.['futureOption'], 'kept');
  assert.equal(metadata?.['artworkDir'], undefined);
});

test('keeping a secret for a renamed client is refused, not guessed', () => {
  const result = applyEdits(
    structuredClone(VALID) as unknown as JsonValue,
    submission((draft) => {
      draft.downloadClients[0]!.id = 'sab-renamed';
    }),
  );
  assert.ok('error' in result);
  assert.match(result.error, /sab-renamed/);
  assert.match(result.error, /api key/i);
});

test('an absent artworkDir is deleted rather than written as an empty string', () => {
  const onDisk = structuredClone(VALID) as unknown as JsonObject;
  onDisk['metadata'] = { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: '/old/art' };
  const document = applied(onDisk);
  assert.equal(asJsonObject(document['metadata'])?.['artworkDir'], undefined);
});

test('a null siteLookup removes the block entirely', () => {
  const onDisk = structuredClone(VALID) as unknown as JsonObject;
  onDisk['siteLookup'] = { type: 'theporndb', apiKey: 'tpdb-secret-key-value' };
  const document = applied(onDisk);
  assert.equal(document['siteLookup'], undefined);
});

test('a kept siteLookup secret survives an edit to its baseUrl', () => {
  const onDisk = structuredClone(VALID) as unknown as JsonObject;
  onDisk['siteLookup'] = { type: 'theporndb', apiKey: 'tpdb-secret-key-value' };
  const document = applied(onDisk, (draft) => {
    draft.siteLookup = {
      type: 'theporndb',
      apiKey: { kind: 'keep' },
      baseUrl: 'https://mirror.invalid',
    };
  });
  const siteLookup = asJsonObject(document['siteLookup']);
  assert.equal(siteLookup?.['apiKey'], 'tpdb-secret-key-value');
  assert.equal(siteLookup?.['baseUrl'], 'https://mirror.invalid');
});

test('keeping a siteLookup secret that does not exist on disk is refused', () => {
  const result = applyEdits(
    structuredClone(VALID) as unknown as JsonValue,
    submission((draft) => {
      draft.siteLookup = { type: 'theporndb', apiKey: { kind: 'keep' }, baseUrl: 'https://x.invalid' };
    }),
  );
  assert.ok('error' in result);
  assert.match(result.error, /siteLookup/);
});

test('a document that is not a JSON object is refused', () => {
  const result = applyEdits(['not', 'an', 'object'], submission());
  assert.ok('error' in result);
});

test('a feed backfill block is projected for the form to edit', () => {
  const document = structuredClone(VALID) as unknown as JsonObject;
  const feed = asJsonObject(asJsonArray(document['feeds'])[0]);
  assert.ok(feed !== null);
  feed['backfill'] = { style: 'newznab', pageSize: 50, pagesPerPass: 3, maxPages: 20 };

  const editable = toEditableConfig(parseConfig(document as unknown as JsonValue, 'test'));

  assert.deepEqual(editable.feeds[0]?.backfill, {
    style: 'newznab',
    pageSize: 50,
    pagesPerPass: 3,
    maxPages: 20,
  });
});

test('a feed that is not backfilling projects null, not a missing key', () => {
  // `null` the way `siteLookup` and `artworkDir` say absent, so the form has one
  // shape to render rather than two.
  const editable = editableOf();
  assert.equal(editable.feeds[0]?.backfill, null);
});

test('a renamed feed keeps its backfill block', () => {
  // The bug this change exists to fix. `applyEdits` merges a feed with the
  // on-disk entry of the same id, so while `backfill` was a key the form did not
  // model, renaming a feed had nothing to merge with and dropped it silently —
  // the walk would restart from page one and nobody would be told. Carried
  // through the submission, the rename keeps it.
  const document = structuredClone(VALID) as unknown as JsonObject;
  const feed = asJsonObject(asJsonArray(document['feeds'])[0]);
  assert.ok(feed !== null);
  feed['backfill'] = { style: 'page', pageSize: 100, pagesPerPass: 2, maxPages: 100 };

  const saved = applied(document, (draft) => {
    draft.feeds[0] = {
      ...draft.feeds[0]!,
      id: 'renamed',
      backfill: { style: 'page', pageSize: 100, pagesPerPass: 2, maxPages: 100 },
    };
  });

  const savedFeed = asJsonObject(asJsonArray(saved['feeds'])[0]);
  assert.equal(savedFeed?.['id'], 'renamed');
  assert.deepEqual(savedFeed?.['backfill'], {
    style: 'page',
    pageSize: 100,
    pagesPerPass: 2,
    maxPages: 100,
  });
});

test('turning backfill off deletes the block rather than writing null', () => {
  // The `artworkDir` rule: absence is a missing key, because `feedBackfillSchema`
  // is `.optional()` and would refuse a null outright. Deleted *after* the merge,
  // since omitting it from the patch would let the on-disk block survive and the
  // form would not be able to turn the feature off at all.
  const document = structuredClone(VALID) as unknown as JsonObject;
  const feed = asJsonObject(asJsonArray(document['feeds'])[0]);
  assert.ok(feed !== null);
  feed['backfill'] = { style: 'newznab', pageSize: 100, pagesPerPass: 2, maxPages: 100 };

  const saved = applied(document, (draft) => {
    draft.feeds[0] = { ...draft.feeds[0]!, backfill: null };
  });

  const savedFeed = asJsonObject(asJsonArray(saved['feeds'])[0]);
  assert.ok(savedFeed !== null);
  assert.equal('backfill' in savedFeed, false);
});

// The form must show the client that is actually in use, not a blank standing
// for "whichever comes first" — a blank is what a user would then save, and
// `feedSchema` refuses an empty string.
test('a feed naming no download client projects the first configured one', () => {
  assert.equal(editableOf().feeds[0]?.downloadClient, 'sab');
});

test('a feed naming a download client projects that one', () => {
  const editable = editableOf((document) => {
    document.downloadClients.push({
      ...document.downloadClients[0]!,
      id: 'sab-b',
      category: 'pickarr-b',
    });
    Object.assign(document.feeds[0]!, { downloadClient: 'sab-b' });
  });
  assert.equal(editable.feeds[0]?.downloadClient, 'sab-b');
});

// The same guarantee `backfill` above makes, and the reason `downloadClient`
// had to be modelled by the form at all rather than left as an unknown key the
// merge preserves: `applyEdits` matches feeds by id, so a rename has nothing to
// merge with and would silently send the feed's picks back to
// `downloadClients[0]`.
test('a renamed feed keeps its download client', () => {
  const document = structuredClone(VALID) as unknown as JsonObject;
  const feed = asJsonObject(asJsonArray(document['feeds'])[0]);
  assert.ok(feed !== null);
  feed['downloadClient'] = 'sab-b';

  const saved = applied(document, (draft) => {
    draft.feeds[0] = { ...draft.feeds[0]!, id: 'renamed', downloadClient: 'sab-b' };
  });

  const savedFeed = asJsonObject(asJsonArray(saved['feeds'])[0]);
  assert.equal(savedFeed?.['id'], 'renamed');
  assert.equal(savedFeed?.['downloadClient'], 'sab-b');
});
