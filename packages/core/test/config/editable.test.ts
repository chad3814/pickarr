import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config/load.ts';
import {
  toEditableConfig,
  applyEdits,
  type EditableConfig,
  type SecretEdit,
  type SecretView,
  type SubmittedConfig,
} from '../../src/config/editable.ts';
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

// A qBittorrent client configured the way most installations can be: cookie
// login, because the api key needs v5.2.0. `importMode` is 'copy' because
// parseConfig refuses 'move' for this type — a move would take the file out
// from under the torrent and stop the seed.
const QBITTORRENT = {
  id: 'qb',
  type: 'qbittorrent',
  url: 'http://qbittorrent:8080',
  username: 'admin',
  password: 'hunter2-not-a-real-password',
  category: 'pickarr',
  importMode: 'copy',
  pathMappings: [],
};

function withQbittorrent(): JsonObject {
  const document = structuredClone(VALID) as unknown as JsonObject;
  asJsonArray(document['downloadClients']).push(structuredClone(QBITTORRENT) as unknown as JsonValue);
  return document;
}

/**
 * What the Settings form submits when the user changed nothing about a client:
 * a `file:` path comes back as itself because it is editable text, and anything
 * else comes back as `keep`. This is `keepOrPath` from `ConfigForm.tsx`, which
 * lives in the web package and cannot be imported here — restating it is what
 * makes these round-trip tests exercise the actual save the form performs
 * rather than a submission invented to suit the assertion.
 */
function keepOrPath(view: SecretView): SecretEdit {
  return view.kind === 'file' ? { kind: 'file', path: view.path } : { kind: 'keep' };
}

function resubmit(editable: EditableConfig): SubmittedConfig {
  return {
    server: { port: editable.server.port },
    database: { path: editable.database.path },
    trashDir: editable.trashDir,
    plugins: editable.plugins,
    downloadClients: editable.downloadClients.map((client) =>
      client.type === 'sabnzbd'
        ? { ...client, apiKey: keepOrPath(client.apiKey) }
        : {
            ...client,
            apiKey: client.apiKey === null ? null : keepOrPath(client.apiKey),
            password: client.password === null ? null : keepOrPath(client.password),
          },
    ),
    feeds: editable.feeds,
    siteLookup:
      editable.siteLookup === null
        ? null
        : { ...editable.siteLookup, apiKey: keepOrPath(editable.siteLookup.apiKey) },
    metadata: editable.metadata,
  };
}

test('a qbittorrent password is redacted, and its username is not', () => {
  const editable = toEditableConfig(parseConfig(withQbittorrent() as unknown as JsonValue, 'test'));
  const client = editable.downloadClients[1];
  assert.ok(client?.type === 'qbittorrent');
  assert.deepEqual(client.password, { kind: 'set' });
  assert.doesNotMatch(JSON.stringify(editable), /hunter2-not-a-real-password/);
  // Shown in the clear on purpose — see the comment on `EditableQbittorrentClient.username`.
  assert.equal(client.username, 'admin');
  // Absent, not an empty view: this client authenticates by login.
  assert.equal(client.apiKey, null);
});

// The test this whole task exists for. `applyEdits` rebuilds the client list
// from the submission alone, so a client the form could not represent used to
// be rewritten in SABnzbd's shape — losing both halves of its login to a save
// that changed something else entirely.
test('a qbittorrent client survives a Settings save that changed something else', () => {
  const onDisk = withQbittorrent();
  const editable = toEditableConfig(parseConfig(onDisk as unknown as JsonValue, 'test'));
  const submitted = { ...resubmit(editable), trashDir: '/new/trash' };

  const result = applyEdits(onDisk, submitted);
  assert.ok('document' in result, 'error' in result ? result.error : 'expected a document');
  const saved = result.document;

  assert.equal(saved['trashDir'], '/new/trash');
  const client = asJsonObject(asJsonArray(saved['downloadClients'])[1]);
  assert.equal(client?.['type'], 'qbittorrent');
  assert.equal(client?.['username'], 'admin');
  assert.equal(client?.['password'], 'hunter2-not-a-real-password', 'the password must survive');
  assert.equal('apiKey' in (client ?? {}), false, 'and no empty apiKey is invented');
  // The strongest form of the same question, and the one a subtly wrong
  // implementation fails: a password written back as `''`, dropped entirely,
  // or joined by an invented `apiKey` all produce a document the very
  // `parseConfig` this save is about to be handed refuses.
  assert.doesNotThrow(() => parseConfig(saved, 'test'));
});

test('a qbittorrent api key survives the same save, and no login is invented', () => {
  const onDisk = withQbittorrent();
  const qb = asJsonObject(asJsonArray(onDisk['downloadClients'])[1]);
  assert.ok(qb !== null);
  delete qb['username'];
  delete qb['password'];
  qb['apiKey'] = 'qbt_abcdefghijklmnopqrstuvwxyz01';

  const editable = toEditableConfig(parseConfig(onDisk as unknown as JsonValue, 'test'));
  const result = applyEdits(onDisk, resubmit(editable));
  assert.ok('document' in result, 'error' in result ? result.error : 'expected a document');

  const client = asJsonObject(asJsonArray(result.document['downloadClients'])[1]);
  assert.equal(client?.['apiKey'], 'qbt_abcdefghijklmnopqrstuvwxyz01');
  assert.equal('username' in (client ?? {}), false);
  assert.equal('password' in (client ?? {}), false);
  assert.doesNotThrow(() => parseConfig(result.document, 'test'));
});

test('a qbittorrent password held in a file is projected as its path and written back with the prefix', () => {
  const onDisk = withQbittorrent();
  const qb = asJsonObject(asJsonArray(onDisk['downloadClients'])[1]);
  assert.ok(qb !== null);
  qb['password'] = 'file:/run/secrets/qbittorrent_password';

  const editable = toEditableConfig(parseConfig(onDisk as unknown as JsonValue, 'test'));
  const client = editable.downloadClients[1];
  assert.ok(client?.type === 'qbittorrent');
  assert.deepEqual(client.password, { kind: 'file', path: '/run/secrets/qbittorrent_password' });

  const result = applyEdits(onDisk, resubmit(editable));
  assert.ok('document' in result, 'error' in result ? result.error : 'expected a document');
  const saved = asJsonObject(asJsonArray(result.document['downloadClients'])[1]);
  assert.equal(saved?.['password'], 'file:/run/secrets/qbittorrent_password');
});

// The same guarantee `mergeKnownFields` already gives the SABnzbd member, which
// a second member written as a freshly built object would quietly not have.
test('a key the form does not model survives inside a qbittorrent client', () => {
  const onDisk = withQbittorrent();
  asJsonObject(asJsonArray(onDisk['downloadClients'])[1])!['futureOption'] = 'kept';

  const editable = toEditableConfig(parseConfig(onDisk as unknown as JsonValue, 'test'));
  const result = applyEdits(onDisk, resubmit(editable));
  assert.ok('document' in result, 'error' in result ? result.error : 'expected a document');
  assert.equal(asJsonObject(asJsonArray(result.document['downloadClients'])[1])?.['futureOption'], 'kept');
});

// Swapping a login for an api key has to *remove* what it replaced. A patch
// that only ever adds keys would leave the username and password beside the new
// key, and `parseConfig`'s exactly-one rule would refuse the file the save just
// wrote — the `artworkDir` rule, applied to a credential.
test('switching a qbittorrent client to an api key deletes the login it replaced', () => {
  const onDisk = withQbittorrent();
  const editable = toEditableConfig(parseConfig(onDisk as unknown as JsonValue, 'test'));
  const submitted = resubmit(editable);
  const client = submitted.downloadClients[1];
  assert.ok(client?.type === 'qbittorrent');
  client.apiKey = { kind: 'literal', value: 'qbt_abcdefghijklmnopqrstuvwxyz01' };
  client.username = null;
  client.password = null;

  const result = applyEdits(onDisk, submitted);
  assert.ok('document' in result, 'error' in result ? result.error : 'expected a document');
  const saved = asJsonObject(asJsonArray(result.document['downloadClients'])[1]);
  assert.equal(saved?.['apiKey'], 'qbt_abcdefghijklmnopqrstuvwxyz01');
  assert.equal('username' in (saved ?? {}), false);
  assert.equal('password' in (saved ?? {}), false);
  assert.doesNotThrow(() => parseConfig(result.document, 'test'));
});

// `editedSecret`'s refusal names the field it could not keep, and a password
// refused with "enter the key" would send the user to the wrong control.
test('keeping a password for a renamed qbittorrent client is refused, and says so as a password', () => {
  const onDisk = withQbittorrent();
  const editable = toEditableConfig(parseConfig(onDisk as unknown as JsonValue, 'test'));
  const submitted = resubmit(editable);
  submitted.downloadClients[1]!.id = 'qb-renamed';

  const result = applyEdits(onDisk, submitted);
  assert.ok('error' in result);
  assert.match(result.error, /qb-renamed/);
  assert.match(result.error, /password/i);
  assert.doesNotMatch(result.error, /api key/i);
});

// `username` has to be *modelled*, not left to the merge. The merge would
// happily resurrect the on-disk one and hide the omission for as long as
// nobody edited it — right up until someone did.
test('changing a qbittorrent username saves the new one', () => {
  const onDisk = withQbittorrent();
  const editable = toEditableConfig(parseConfig(onDisk as unknown as JsonValue, 'test'));
  const submitted = resubmit(editable);
  const client = submitted.downloadClients[1];
  assert.ok(client?.type === 'qbittorrent');
  client.username = 'operator';

  const result = applyEdits(onDisk, submitted);
  assert.ok('document' in result, 'error' in result ? result.error : 'expected a document');
  assert.equal(asJsonObject(asJsonArray(result.document['downloadClients'])[1])?.['username'], 'operator');
});

// The rename hazard `EditableFeed`'s comment records, at credential scale:
// `applyEdits` matches clients by id, so a renamed client has no on-disk entry
// to merge with and every field it keeps must have come through the form. The
// password is the one thing a rename cannot carry — `editedSecret` refuses a
// `keep` it cannot match — so the user re-enters it, and the username must
// still arrive on its own.
test('a renamed qbittorrent client keeps its login', () => {
  const onDisk = withQbittorrent();
  const editable = toEditableConfig(parseConfig(onDisk as unknown as JsonValue, 'test'));
  const submitted = resubmit(editable);
  const client = submitted.downloadClients[1];
  assert.ok(client?.type === 'qbittorrent');
  client.id = 'qb-renamed';
  client.password = { kind: 'literal', value: 'hunter2-not-a-real-password' };

  const result = applyEdits(onDisk, submitted);
  assert.ok('document' in result, 'error' in result ? result.error : 'expected a document');
  const saved = asJsonObject(asJsonArray(result.document['downloadClients'])[1]);
  assert.equal(saved?.['id'], 'qb-renamed');
  assert.equal(saved?.['username'], 'admin');
  assert.equal(saved?.['password'], 'hunter2-not-a-real-password');
  assert.equal('apiKey' in (saved ?? {}), false);
  assert.doesNotThrow(() => parseConfig(result.document, 'test'));
});
