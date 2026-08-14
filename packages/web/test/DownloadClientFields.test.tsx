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

  fireEvent.click(screen.getByRole('button', { name: /add download client/i }));
  rerender(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );

  assert.equal(next.length, 2);
  // The new row starts with an empty literal: there is no key on disk for it,
  // so `keep` would be refused by the server.
  assert.deepEqual(next[1]?.apiKey, { kind: 'literal', value: '' });
  assert.equal(screen.queryAllByRole('button', { name: /keep existing/i }).length, 0);
});

test('removing a client drops exactly that row', () => {
  let next = [...draft(), { ...draft()[0]!, id: 'sab2' }];
  render(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[1]!);
  assert.deepEqual(next.map((client) => client.id), ['sab']);
});

test('a path mapping can be added and edited', () => {
  let next = draft();
  const { rerender } = render(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /add path mapping/i }));
  rerender(
    <DownloadClientFields clients={next} onDisk={ON_DISK} onChange={(value) => { next = value; }} />,
  );
  assert.equal(next[0]?.pathMappings.length, 2);
  assert.deepEqual(next[0]?.pathMappings[1], { from: '', to: '' });
});
