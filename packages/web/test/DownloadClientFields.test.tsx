import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DownloadClientFields } from '../src/components/settings/DownloadClientFields.tsx';
import type { ClientDraft } from '../src/components/settings/ConfigForm.tsx';
import type { EditableDownloadClient } from '../src/api/client.ts';

afterEach(cleanup);

const ON_DISK: EditableDownloadClient[] = [
  {
    id: 'sab',
    type: 'sabnzbd',
    url: 'http://sabnzbd:8080',
    apiKey: { kind: 'set' },
    category: 'pickarr',
    importMode: 'move',
    pathMappings: [{ from: '/downloads', to: '/data/downloads' }],
  },
];

function draft(): ClientDraft[] {
  return [
    {
      id: 'sab',
      type: 'sabnzbd',
      url: 'http://sabnzbd:8080',
      apiKey: { kind: 'keep' },
      category: 'pickarr',
      importMode: 'move',
      pathMappings: [{ from: '/downloads', to: '/data/downloads' }],
    },
  ];
}

test('an existing client offers to keep its key; an added one cannot', () => {
  let next = draft();
  const { rerender } = render(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  assert.equal(screen.getAllByText(/set/i).length, 1);

  fireEvent.click(screen.getByRole('button', { name: /add sabnzbd client/i }));
  rerender(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );

  assert.equal(next.length, 2);
  // The new row starts with an empty literal: there is no key on disk for it,
  // so `keep` would be refused by the server.
  assert.deepEqual(next[1]?.apiKey, { kind: 'literal', value: '' });
  assert.equal(screen.queryAllByRole('button', { name: /keep existing/i }).length, 0);
});

// `addClient` used to push the module-level `blankClient` object itself, so
// two added rows started out sharing the exact same `pathMappings` array
// reference. Editing one field of one of them (`{ ...client, id: 'x' }`)
// shallow-copies that shared reference into the new object rather than
// cloning it, so the two rows would still point at one array under the hood.
test('two added download clients do not share a pathMappings array', () => {
  let next: ClientDraft[] = [];
  const { rerender } = render(
    <DownloadClientFields clients={next} onDisk={[]} onChange={(value) => { next = value; }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /add sabnzbd client/i }));
  rerender(<DownloadClientFields clients={next} onDisk={[]} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add sabnzbd client/i }));
  rerender(<DownloadClientFields clients={next} onDisk={[]} onChange={(value) => { next = value; }} />);

  assert.equal(next.length, 2);
  assert.notEqual(next[0]?.pathMappings, next[1]?.pathMappings);
});

test('removing a client drops exactly that row, leaving the others in order', () => {
  // Three rows so a bug that always drops the first or last row, regardless
  // of which button was clicked, cannot pass by accident: the middle row is
  // the one under test here.
  let next = [...draft(), { ...draft()[0]!, id: 'sab2' }, { ...draft()[0]!, id: 'sab3' }];
  render(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  // Named by id rather than /remove/i: several buttons on the page contain
  // "remove" ("Remove download client" per client, "Remove path mapping" per
  // mapping), and this query would fail to resolve to a single element - and
  // so fail the test - if the per-row aria-label were ever removed.
  fireEvent.click(screen.getByRole('button', { name: /remove download client sab2/i }));
  assert.deepEqual(next.map((client) => client.id), ['sab', 'sab3']);
});

test('a path mapping can be added and edited', () => {
  let next = draft();
  const { rerender } = render(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  // Named by its own client id rather than /add path mapping/i: several of
  // these render when there is more than one client, and this query would
  // fail to resolve to a single element - failing the test - if the per-row
  // aria-label were ever removed.
  fireEvent.click(screen.getByRole('button', { name: 'Add path mapping to sab' }));
  rerender(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  assert.equal(next[0]?.pathMappings.length, 2);
  assert.deepEqual(next[0]?.pathMappings[1], { from: '', to: '' });
});

test('a path mapping is named by its own from/to, so several on one client are not identical', () => {
  let next: ClientDraft[] = [
    {
      ...draft()[0]!,
      pathMappings: [
        { from: '/downloads', to: '/data/downloads' },
        { from: '/incomplete', to: '/data/incomplete' },
      ],
    },
  ];
  render(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  // As above: this would fail to resolve to a single button - failing the
  // test - if the mapping's own from/to were not carried in its aria-label.
  fireEvent.click(screen.getByRole('button', { name: /remove path mapping \/incomplete/i }));
  assert.deepEqual(next[0]?.pathMappings, [{ from: '/downloads', to: '/data/downloads' }]);
});

// --- Adding a client of either type ------------------------------------------
//
// Until this existed, `blankClient` was hardcoded to sabnzbd and the only way
// to get a qBittorrent client was to hand-edit config.json and restart — an odd
// seam in a form that configures everything else.

test('a qBittorrent client can be added, and starts in copy mode', () => {
  let next: ClientDraft[] = [];
  render(
    <DownloadClientFields clients={next} onDisk={[]} onChange={(value) => { next = value; }} />,
  );

  fireEvent.click(screen.getByRole('button', { name: /add qbittorrent client/i }));

  assert.equal(next.length, 1);
  const added = next[0]!;
  assert.equal(added.type, 'qbittorrent');
  // `copy`, not the sabnzbd default of `move`: parseConfig refuses `move` for a
  // torrent client, so a blank that defaulted to it would be born invalid on a
  // field the operator never chose.
  assert.equal(added.importMode, 'copy');
});

test('adding a sabnzbd client still yields a sabnzbd client', () => {
  let next: ClientDraft[] = [];
  render(
    <DownloadClientFields clients={next} onDisk={[]} onChange={(value) => { next = value; }} />,
  );

  fireEvent.click(screen.getByRole('button', { name: /add sabnzbd client/i }));

  assert.equal(next[0]?.type, 'sabnzbd');
  assert.equal(next[0]?.importMode, 'move');
});

test('an added qBittorrent client carries exactly one credential', () => {
  let next: ClientDraft[] = [];
  render(
    <DownloadClientFields clients={next} onDisk={[]} onChange={(value) => { next = value; }} />,
  );

  fireEvent.click(screen.getByRole('button', { name: /add qbittorrent client/i }));

  const added = next[0]!;
  assert.equal(added.type, 'qbittorrent');
  // parseConfig refuses both-or-neither, so a blank carrying an apiKey *and* a
  // login would be rejected on save with nothing the operator did wrong.
  assert.deepEqual(added.apiKey, { kind: 'literal', value: '' });
  assert.equal(added.username, null);
  assert.equal(added.password, null);
});
