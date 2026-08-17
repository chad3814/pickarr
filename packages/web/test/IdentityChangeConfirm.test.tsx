import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { IdentityChangeConfirm } from '../src/components/IdentityChangeConfirm.tsx';
import type { IdentityPlanView } from '../src/api/client.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM behind and every later `getBy*` sees two
// copies of the dialog, turning one real failure into a cascade of fake ones.
afterEach(cleanup);

const MERGE: IdentityPlanView = {
  groupId: 1,
  identityKey: 'site:2026-08-14:title',
  kind: 'merge',
  mergeInto: { id: 2, title: 'Title Of Scene' },
  releasesMoving: 1,
  downloadsMoving: 1,
  pick: { surviving: { releaseId: 1, score: 1080, side: 'source' }, superseded: null },
  renames: [{ importedFileId: 1, from: '/library/Old/a.mp4', to: '/library/New/a.mp4' }],
  trashing: [],
  warnings: [],
  blockers: [],
  digest: 'abc',
};

test('it names the group being merged into and every file that moves', () => {
  render(<IdentityChangeConfirm plan={MERGE} onConfirm={() => {}} onCancel={() => {}} />);

  assert.ok(screen.getByText(/Title Of Scene/));
  assert.ok(screen.getByText('/library/Old/a.mp4'));
  assert.ok(screen.getByText('/library/New/a.mp4'));
});

test('it reports which pick survives and which is superseded', () => {
  render(
    <IdentityChangeConfirm
      plan={{
        ...MERGE,
        pick: {
          surviving: { releaseId: 2, score: 2160, side: 'target' },
          superseded: { releaseId: 1, score: 1080 },
        },
        trashing: [{ importedFileId: 1, path: '/library/Old/a.mp4' }],
        renames: [],
      }}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(screen.getByText(/2160/));
  assert.ok(screen.getByText(/1080/));
  assert.ok(screen.getByText('/library/Old/a.mp4'));
});

test('confirm is disabled while the plan has blockers', () => {
  render(
    <IdentityChangeConfirm
      plan={{ ...MERGE, blockers: ['/library/New/a.mp4 is occupied'] }}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

  const confirm = screen.getByRole('button', { name: /confirm/i });
  assert.equal((confirm as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText(/is occupied/));
});

test('cancel calls back without confirming', () => {
  let confirmed = false;
  let cancelled = false;
  render(
    <IdentityChangeConfirm
      plan={MERGE}
      onConfirm={() => {
        confirmed = true;
      }}
      onCancel={() => {
        cancelled = true;
      }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

  assert.equal(cancelled, true);
  assert.equal(confirmed, false);
});

// The defect these three pin, reported 2026-08-17: a user read this dialog as
// an error message and did not confirm, so their merge silently never happened.
// Every test above passes on a dialog nobody can identify — they query by role
// and by text, and `role`/`aria-label` are invisible. What was missing was any
// assertion that a *sighted* user is told what this is, which is why the
// stylesheet had no `.confirm` rule at all and the only title was an
// `aria-label`. The dialog renders directly under the page's own error banner
// (`Picks.tsx`), so "unlabelled block of text" reads as "something went wrong".
test('it shows a visible heading, not just an accessible one', () => {
  render(<IdentityChangeConfirm plan={MERGE} onConfirm={() => {}} onCancel={() => {}} />);

  // getByRole('heading') rather than getByText: a heading is what makes this
  // readable as a titled dialog rather than as prose that happens to contain
  // the words.
  assert.ok(screen.getByRole('heading', { name: 'Confirm identity change' }));
});

test("the dialog's accessible name is its visible heading, so the two cannot drift", () => {
  render(<IdentityChangeConfirm plan={MERGE} onConfirm={() => {}} onCancel={() => {}} />);

  const dialog = screen.getByRole('dialog', { name: 'Confirm identity change' });
  const heading = screen.getByRole('heading', { name: 'Confirm identity change' });
  // The name has to come FROM the heading, not merely equal it: an `aria-label`
  // that duplicates the heading's words is exactly how the visible title and
  // the announced one end up saying different things later.
  assert.equal(dialog.getAttribute('aria-label'), null);
  assert.equal(dialog.getAttribute('aria-labelledby'), heading.id);
  assert.notEqual(heading.id, '');
});

test('it asks a question rather than presenting a verdict', () => {
  render(<IdentityChangeConfirm plan={MERGE} onConfirm={() => {}} onCancel={() => {}} />);

  // The buttons are the other half of "this is a question". Pinned here
  // because the report was that the dialog looked like a failure, and a
  // failure has nothing to accept.
  assert.ok(screen.getByRole('button', { name: 'Confirm' }));
  assert.ok(screen.getByRole('button', { name: 'Cancel' }));
});
