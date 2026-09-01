import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { FailedCard } from '../src/components/FailedCard.tsx';
import type { FailedItemView, ManualField } from '../src/api/client.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its card behind, and every later query sees two.
afterEach(cleanup);

/** The card element itself, the same lookup `MediaCard.test.tsx` uses for its own. */
function card(rawTitle: string): HTMLElement {
  const element = screen.getByText(rawTitle).closest('article');
  assert.ok(element !== null, `no card for ${rawTitle}`);
  return element;
}

const ITEM: FailedItemView = {
  id: 1,
  feedId: 'scenes-daily',
  plugin: 'scenes',
  rawTitle: 'Alpha.RAW.1080p',
  link: 'http://feed.invalid/1',
  parseError: 'no anchor in Alpha.RAW.1080p',
  firstSeenAt: 1700,
  publishedAt: null,
  suggestedValues: { site: 'brazzers' },
  dismissedAt: null,
};

const FIELDS: ManualField[] = [
  { name: 'site', label: 'Site', type: 'text', scope: 'identity', required: true },
  { name: 'title', label: 'Title', type: 'text', scope: 'identity', required: true },
];

test('the card names the refused title, its reason, and its feed', () => {
  render(<FailedCard item={ITEM} fields={FIELDS} onFix={() => {}} onDismiss={() => {}} />);

  const element = card(ITEM.rawTitle);
  assert.ok(within(element).getByText(ITEM.parseError), 'no reason shown');
  assert.ok(within(element).getByText(`Feed: ${ITEM.feedId}`), 'no feed shown');
});

test('the reason renders in the error colour, not as plain body text', () => {
  render(<FailedCard item={ITEM} fields={FIELDS} onFix={() => {}} onDismiss={() => {}} />);

  const reason = screen.getByText(ITEM.parseError);
  // `.failed-reason` is what carries `--color-error` in `card.css`; a plain
  // paragraph with no class reads as ordinary body text instead.
  assert.equal(reason.className, 'failed-reason');
});

test('Fix… appears only when the plugin offers fields', () => {
  render(<FailedCard item={ITEM} fields={FIELDS} onFix={() => {}} onDismiss={() => {}} />);
  assert.ok(within(card(ITEM.rawTitle)).getByRole('button', { name: /fix/i }));
  cleanup();

  render(<FailedCard item={ITEM} onFix={() => {}} onDismiss={() => {}} />);
  assert.equal(within(card(ITEM.rawTitle)).queryAllByRole('button', { name: /fix/i }).length, 0);
});

test('an item whose plugin has no fields still offers Dismiss', () => {
  // Dismissing is core's own bookkeeping and stays available with no schema.
  render(<FailedCard item={ITEM} onFix={() => {}} onDismiss={() => {}} />);
  assert.ok(within(card(ITEM.rawTitle)).getByRole('button', { name: /dismiss/i }));
});

test('Fix… opens the form seeded with the suggested values', () => {
  render(<FailedCard item={ITEM} fields={FIELDS} onFix={() => {}} onDismiss={() => {}} />);

  fireEvent.click(screen.getByRole('button', { name: /fix/i }));

  assert.equal((screen.getByLabelText('Site') as HTMLInputElement).value, 'brazzers');
  assert.equal((screen.getByLabelText('Title') as HTMLInputElement).value, '');
});

test('submitting the form calls onFix with the typed values', () => {
  const submitted: Record<string, string>[] = [];
  render(
    <FailedCard item={ITEM} fields={FIELDS} onFix={(values) => submitted.push(values)} onDismiss={() => {}} />,
  );

  fireEvent.click(screen.getByRole('button', { name: /fix/i }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  assert.deepEqual(submitted, [{ site: 'brazzers', title: 'A Thing' }]);
});

test('Cancel closes the form without calling onFix', () => {
  const submitted: Record<string, string>[] = [];
  render(
    <FailedCard item={ITEM} fields={FIELDS} onFix={(values) => submitted.push(values)} onDismiss={() => {}} />,
  );

  fireEvent.click(screen.getByRole('button', { name: /fix/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  assert.equal(screen.queryAllByLabelText('Site').length, 0);
  assert.equal(submitted.length, 0);
});

test('a dismissed item shows the Dismissed badge instead of a Dismiss button', () => {
  // Dismissing it again is a 409; it is listed at all only because showing it
  // is how it stays fixable.
  render(
    <FailedCard item={{ ...ITEM, dismissedAt: 1800 }} fields={FIELDS} onFix={() => {}} onDismiss={() => {}} />,
  );

  const element = card(ITEM.rawTitle);
  assert.ok(within(element).getByText('Dismissed'));
  assert.equal(within(element).queryAllByRole('button', { name: /dismiss/i }).length, 0);
});

test('Dismiss calls onDismiss', () => {
  let dismissed = 0;
  render(<FailedCard item={ITEM} onFix={() => {}} onDismiss={() => dismissed++} />);

  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

  assert.equal(dismissed, 1);
});

test('the poster slot holds a placeholder at the media card geometry', () => {
  // So an interleaved list does not alternate between two card heights.
  render(<FailedCard item={ITEM} fields={FIELDS} onFix={() => {}} onDismiss={() => {}} />);

  const placeholder = card(ITEM.rawTitle).querySelector('.failed-poster');
  assert.ok(placeholder !== null, 'no poster placeholder rendered');
  assert.equal(placeholder?.getAttribute('aria-hidden'), 'true');
});
