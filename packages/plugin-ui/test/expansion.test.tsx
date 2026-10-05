/**
 * The expander, which every card composes and none writes.
 *
 * **Why this is shared and `ReleaseList` is the precedent (issue #106).**
 * `plugin-ui` exists on the argument in the plugin-cards design spec §3:
 * three plugins owning a card body means three sets of accessibility
 * decisions, and "that hazard is paid once per component, so the components
 * are shared". It shipped sharing the release list and *not* the expander --
 * so `aria-expanded`, the one obligation a plugin could get wrong entirely
 * on its own, was the one written three times.
 *
 * `CLAUDE.md`'s longest hazard is exactly that failure: a component whose
 * `role` and `aria-*` satisfied every query while nothing was usable. A
 * fourth plugin that omitted `aria-expanded`, or set it to a string, would
 * pass every `getByRole('button', { name })` its author was likely to write.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CardHeading, useExpansion } from '../src/expansion.tsx';

afterEach(cleanup);

/** A card as thin as the real ones: the hook, the heading, and its own gate. */
function Harness({ headline, onExpandedChange }: { headline: string; onExpandedChange: (expanded: boolean) => void }) {
  const { expanded, toggle } = useExpansion(onExpandedChange);
  return (
    <>
      <CardHeading headline={headline} expanded={expanded} onToggle={toggle} />
      {expanded && <p>body</p>}
    </>
  );
}

test('the heading announces its state through aria-expanded, and the announcement moves', () => {
  // Spelled as the literal strings `'false'` and `'true'`, not as a boolean
  // read back through `expanded`: an attribute compared against the value
  // that produced it cannot detect that value changing (`CLAUDE.md`'s
  // `groupAnchor` entry). React renders the attribute as text either way.
  render(<Harness headline="Arrival" onExpandedChange={() => {}} />);

  const button = screen.getByRole('button', { name: 'Arrival' });
  assert.equal(button.getAttribute('aria-expanded'), 'false', 'a fresh card is closed');

  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'opening announces open');

  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-expanded'), 'false', 'closing announces closed');
});

test('the headline is the button’s accessible name, and it is a real heading', () => {
  // Both halves, because `CLAUDE.md` is explicit that the accessibility tree
  // is satisfied by attributes a sighted reader never receives: an
  // `aria-label` would pass the name assertion while the row rendered
  // nothing legible. The name has to come from the text inside a heading.
  render(<Harness headline="Jo Jo’s Bizarre Adventure S02E47 Dio’s World(3)" onExpandedChange={() => {}} />);

  const heading = screen.getByRole('heading', { level: 2 });
  assert.match(heading.textContent ?? '', /Dio’s World\(3\)/, 'the headline is rendered text, not an attribute');
  assert.ok(
    screen.getByRole('button', { name: 'Jo Jo’s Bizarre Adventure S02E47 Dio’s World(3)' }),
    'and it is what names the button',
  );
});

test('the full headline is reachable as a title, and names nothing it is attached to', () => {
  // Web truncates this span to one line with an ellipsis so a card's
  // trailing label stays visible, so the full headline has to be
  // reachable some other way -- the `title`.
  //
  // **What this test proves, and what it cannot.** It proves the
  // attribute is there, that it is the same string the span renders,
  // and that the button's composed two-part name is what it was. It
  // does **not** exercise the hazard its own subject suggests -- that
  // `title` is the last fallback in the accessible-name algorithm and
  // must not outrank the subtree's content -- because `title` and the
  // text node come from one prop, so both branches of the algorithm
  // yield the same name and no assertion can separate them. The pin is
  // aimed at the day they diverge: a `title` carrying anything but the
  // rendered headline breaks the equality assertion below, and a name
  // recomputed from a winning `title` breaks the composed one above.
  // The corresponding pair in `ReleaseList.test.tsx` has the same
  // limitation for the same reason.
  //
  // The name is spelled as a literal rather than built from the two
  // props, and the trailing label is present rather than omitted: with
  // one child there is no composition to get wrong, and composition is
  // what a differing `title` would replace.
  const long = 'Some.Release.Nobody.Recognises.2024.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.Atmos.mkv';
  render(
    <CardHeading
      headline={long}
      trailing="Nightly torrents"
      expanded={false}
      onToggle={() => {}}
    />,
  );

  const button = screen.getByRole('button', {
    name: 'Some.Release.Nobody.Recognises.2024.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.Atmos.mkv Nightly torrents',
  });
  const span = button.querySelector('span');
  assert.ok(span !== null, 'the headline is in a span of its own for the stylesheet to reach');
  assert.equal(span.getAttribute('title'), long, 'and carries the whole headline as its title');
  assert.equal(span.textContent, long, 'which is the same string it renders, not a second copy of it');
});

test('every transition is reported, closing included, with the new value', () => {
  // The half a plugin could most easily get wrong by itself, and the reason
  // this is a hook rather than three hand-written `onClick`s. An earlier
  // version of this seam signalled only the opening, and web left 72
  // subscriptions live for 24 cards nobody had left open.
  const seen: boolean[] = [];
  render(<Harness headline="Arrival" onExpandedChange={(expanded) => seen.push(expanded)} />);

  const button = screen.getByRole('button', { name: 'Arrival' });
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.click(button);

  assert.deepEqual(seen, [true, false, true], 'the sequence of values, not just the count');
});

test('the card body follows the hook, so a card gates its own content', () => {
  // What the hook hands back has to be usable for the thing each card does
  // differently. `plugin-ui` renders no release list here; the harness's own
  // `<p>` stands in for one.
  render(<Harness headline="Arrival" onExpandedChange={() => {}} />);
  assert.ok(!screen.queryByText('body'), 'a closed card shows no body');

  fireEvent.click(screen.getByRole('button', { name: 'Arrival' }));
  assert.ok(screen.getByText('body'), 'an open one does');
});

test('no plugin writes aria-expanded itself', async () => {
  // Issue #106 is not "the markup was duplicated" -- three correct copies
  // are harmless. It is that the obligation was *available* to get wrong in
  // three places, and a fourth plugin would have hand-written a fourth.
  // This is what makes that unrepresentable rather than merely discouraged,
  // and it is the reason the refactor is worth more than the lines it saves.
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const packages = join(import.meta.dirname, '../..');
  const plugins = (await readdir(packages)).filter((name) => /^plugin-(?!ui$|api$)/.test(name));
  assert.ok(plugins.length >= 3, `expected the shipped plugins, found ${JSON.stringify(plugins)}`);

  // **Comments are stripped before matching, and that is not a detail.**
  // Each card's docblock *names* `aria-expanded` to explain that it does not
  // write one, so a plain text match flags the documentation and the scan
  // reports the opposite of the truth. `CLAUDE.md` records the same trap in
  // `scripts/check-test-hygiene.ts`, which "parses rather than
  // pattern-matches, because this very section documents the hazard by
  // quoting it". Verified by writing those docblocks first and watching this
  // test flag all three files before the stripping went in.
  const withoutComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const offenders: string[] = [];
  for (const plugin of plugins) {
    const src = join(packages, plugin, 'src');
    let names: string[];
    try {
      names = await readdir(src);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue;
      const text = withoutComments(await readFile(join(src, name), 'utf8'));
      if (text.includes('aria-expanded')) offenders.push(`${plugin}/src/${name}`);
    }
  }

  assert.deepEqual(offenders, [], 'a plugin hand-wrote aria-expanded instead of composing CardHeading');
});

test('useExpansion starts closed unless told otherwise, and reports the first toggle either way', () => {
  const seen: boolean[] = [];
  function Probe({ initiallyExpanded }: { initiallyExpanded?: boolean }): ReactElement {
    const { expanded, toggle } = useExpansion((next) => { seen.push(next); }, initiallyExpanded);
    return <button type="button" aria-pressed={expanded} onClick={toggle}>toggle</button>;
  }
  render(<Probe />);
  assert.equal(screen.getByRole('button').getAttribute('aria-pressed'), 'false', 'closed by default');
  cleanup();
  render(<Probe initiallyExpanded />);
  const button = screen.getByRole('button');
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'open when asked');
  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(seen, [false], 'the toggle reports the new state; opening on mount is not a change');
});

test('a headlineId lands on the headline span, so a control beside the card can be named by it', () => {
  render(<CardHeading headline="Some.Release.mkv" headlineId="rel-1" expanded={false} onToggle={() => {}} />);
  const span = document.getElementById('rel-1');
  assert.ok(span !== null && span.textContent === 'Some.Release.mkv', 'the id is on the span carrying the headline');
});
