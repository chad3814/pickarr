import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneRelease } from '../src/parse.ts';
import { DEFAULT_PATH_TEMPLATE, renderPath, templateValues } from '../src/path-template.ts';

const NAME =
  'TouchMyWife.25.02.07.Anna.Claire.Clouds.Wife.Makes.Dirty.Video.For.Hubby.XXX.2160p.MP4-VSEX';

test('learning a site later does not move the key', () => {
  // The reported bug: the 2160p arrived before ThePornDB confirmed the site and
  // the 1080p after, so they keyed differently and never collated.
  const before = parseSceneRelease(NAME, { sites: [] });
  const after = parseSceneRelease(NAME, { sites: ['Touch My Wife'] });
  assert.ok(before !== null && after !== null);
  assert.equal(after.identityKey, before.identityKey);
});

test('every spelling of one site produces one key', () => {
  // The same set `siteComparisonKey` already treats as one site.
  const keys = new Set(
    ['Touch My Wife', 'TouchMyWife', 'touchmywife', 'Touch.My.Wife', 'TOUCH-MY-WIFE'].map(
      (site) => parseSceneRelease(NAME, { sites: [site] })?.identityKey,
    ),
  );
  assert.equal(keys.size, 1, [...keys].join(' | '));
});

test('the canonical spelling still reaches the display', () => {
  // Only the key loses the separators. What the user sees, and what the path
  // template renders, is the site's real name.
  const parsed = parseSceneRelease(NAME, { sites: ['Touch My Wife'] });
  assert.equal(parsed?.display.subtitle, 'Touch My Wife');
  assert.ok(parsed?.identityKey.startsWith('touchmywife:'));
});

// --- Rendered paths do not move ----------------------------------------------
//
// This change ships against populated databases whose files are already on
// disk under paths rendered from the old key. Every string below was captured
// from the code as it stood *before* the key changed, by running
// `templateValues` and `renderPath` over this same release, and pasted here
// unaltered. Byte-identical output is what makes the change safe; asserting it
// against captured literals is what makes "byte-identical" checkable rather
// than believed.

test('the default template renders a multi-word site exactly as it did before', () => {
  const parsed = parseSceneRelease(NAME, { sites: ['Touch My Wife'] });
  assert.ok(parsed !== null);
  assert.equal(
    renderPath(DEFAULT_PATH_TEMPLATE, parsed, '.mp4'),
    'touchmywife/touchmywife.2025.02.07.anna.claire.clouds.wife.makes.dirty.video.for.hubby.2160p-VSEX.mp4',
  );
});

test('every placeholder renders a multi-word site exactly as it did before', () => {
  // The default only uses `{sitename}`, whose value was already separator-free
  // and so could not move. `{site}`, `{Site}` and `{SiteName}` are the ones at
  // risk — derived from the key they would now give `touchmywife`,
  // `Touchmywife` and `Touchmywife` — so a template using any of them is what
  // a default-only test would miss.
  const parsed = parseSceneRelease(NAME, { sites: ['Touch My Wife'] });
  assert.ok(parsed !== null);
  assert.deepEqual(templateValues(parsed), {
    site: 'touch my wife',
    Site: 'Touch My Wife',
    sitename: 'touchmywife',
    SiteName: 'TouchMyWife',
    title: 'anna claire clouds wife makes dirty video for hubby',
    Title: 'Anna Claire Clouds Wife Makes Dirty Video For Hubby',
    titledots: 'anna.claire.clouds.wife.makes.dirty.video.for.hubby',
    TitleDots: 'Anna.Claire.Clouds.Wife.Makes.Dirty.Video.For.Hubby',
    date: '2025.02.07',
    isodate: '2025-02-07',
    year: '2025',
    episode: '',
    resolution: '2160p',
    container: 'mp4',
    group: 'VSEX',
  });

  assert.equal(
    renderPath('{Site}/{Site}.{date}.{TitleDots}.{resolution}-{group}', parsed, '.mp4'),
    'Touch My Wife/Touch My Wife.2025.02.07.Anna.Claire.Clouds.Wife.Makes.Dirty.Video.For.Hubby.2160p-VSEX.mp4',
  );
  assert.equal(
    renderPath('{site}/{SiteName}.{title}', parsed, '.mkv'),
    'touch my wife/TouchMyWife.anna claire clouds wife makes dirty video for hubby.mkv',
  );
});

test('a group with no subtitle still renders a path rather than nothing', () => {
  // `subtitle` is optional on `DisplayFields`, and `planImport` builds its
  // `ParsedRelease` from a `media_groups` row that a migration or another
  // writer may have left without one. The key's segment is then all there is;
  // the site loses its word boundaries but the path is still a path.
  const parsed = parseSceneRelease(NAME, { sites: ['Touch My Wife'] });
  assert.ok(parsed !== null);
  const noSubtitle = { ...parsed, display: { title: parsed.display.title, fields: [] } };
  assert.equal(templateValues(noSubtitle).Site, 'Touchmywife');
  assert.equal(
    renderPath('{Site}/{titledots}', noSubtitle, '.mp4'),
    'Touchmywife/anna.claire.clouds.wife.makes.dirty.video.for.hubby.mp4',
  );
});
