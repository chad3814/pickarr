import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneRelease } from '../src/parse.ts';
import { planSceneImport } from '../src/plan-import.ts';
import { DEFAULT_PATH_TEMPLATE, renderPath, templateValues } from '../src/path-template.ts';

const FILES = [{ absolutePath: '/d/x.mp4', relativePath: 'x.mp4', sizeBytes: 9 }];

function parsed(name: string, sites: string[] = []) {
  const result = parseSceneRelease(name, { sites });
  assert.ok(result !== null, name);
  return result;
}

function path(name: string, pathTemplate?: string, sites: string[] = []): string {
  const plan = planSceneImport(
    parsed(name, sites),
    FILES,
    pathTemplate === undefined ? {} : { pathTemplate },
  );
  assert.ok(plan !== null);
  return plan.files[0]?.destination ?? '';
}

const BANGBROS = 'Bangbros.Chloe.Upgrades.her.Butt.2026.08.03.2160p.MP4-WRB';

// --- The default must not move an existing library ---------------------------

test('the default template reproduces the layout that shipped before it', () => {
  assert.equal(path(BANGBROS, undefined, ['Bang Bros']), 'Bang Bros/2026-08-03 - Chloe Upgrades Her Butt.mp4');
  assert.equal(path('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB'), 'Brazzers/2023-04-15 - Alex Coal.mp4');
  assert.equal(path('InTheCrack.E1178.Tracy.Gold.XXX.2160p.MP4-KTR'), 'Inthecrack/E1178 - Tracy Gold.mp4');
  assert.equal(
    path('TripForFuck - Hiyori JAPANESE 2', undefined, ['Trip For Fuck']),
    'Trip For Fuck/Hiyori Japanese 2.mp4',
  );
});

// --- Every placeholder --------------------------------------------------------

test('each placeholder renders its documented form', () => {
  const values = templateValues(parsed(BANGBROS, ['Bang Bros']));
  assert.deepEqual(values, {
    site: 'bang bros',
    Site: 'Bang Bros',
    sitename: 'bangbros',
    SiteName: 'BangBros',
    title: 'chloe upgrades her butt',
    Title: 'Chloe Upgrades Her Butt',
    date: '2026-08-03',
    year: '2026',
    episode: '',
    resolution: '2160p',
    container: 'mp4',
    group: 'WRB',
  });
});

test('sitename matches how the metadata service spells short_name', () => {
  // The whole reason the run-together form exists: it is what TPDB calls the
  // site, so a library keyed on it lines up with other tooling.
  assert.equal(templateValues(parsed(BANGBROS, ['Bang Bros'])).sitename, 'bangbros');
});

test('a template can nest and reorder freely', () => {
  assert.equal(
    path(BANGBROS, '{sitename}/{year}/{title} [{resolution} {group}]', ['Bang Bros']),
    'bangbros/2026/chloe upgrades her butt [2160p WRB].mp4',
  );
});

test('an episode fills the same slot a date would', () => {
  assert.equal(
    path('InTheCrack.E1178.Tracy.Gold.XXX.2160p.MP4-KTR', '{SiteName}/{date}{episode} {Title}'),
    'Inthecrack/E1178 Tracy Gold.mp4',
  );
});

// --- Empty values -------------------------------------------------------------

test('a missing value takes its separator with it', () => {
  // Most releases have no episode and some have no date; the literal text
  // around an empty placeholder would otherwise be left stranded.
  assert.equal(
    path('TripForFuck - Hiyori JAPANESE 2', '{Site}/{date}{episode} - {Title}', ['Trip For Fuck']),
    'Trip For Fuck/Hiyori Japanese 2.mp4',
  );
});

test('a segment that renders empty is dropped, not left nameless', () => {
  // `{group}/` on a release with no group must not create a directory called
  // nothing at the top of the library.
  assert.equal(
    path('Anal.Only.Getting.In.Booty.2022.09.29.2160p', '{group}/{Site}/{Title}'),
    'Anal/Only Getting In Booty.mp4',
  );
});

test('a template that renders away entirely still yields a filename', () => {
  assert.equal(path(BANGBROS, '{group}', ['Bang Bros']), 'WRB.mp4');
  assert.equal(path('Anal.Only.Getting.In.Booty.2022.09.29.2160p', '{episode}'), 'Unknown.mp4');
});

// --- Safety --------------------------------------------------------------------

test('a value can never introduce a path separator or escape upward', () => {
  const media = parsed(BANGBROS, ['Bang Bros']);
  // Values come from the identity key, whose alphabet is [a-z0-9-], so this is
  // belt and braces — but the template is user-supplied and the importer's
  // containment check should never be the only thing standing here.
  const rendered = renderPath('{Site}/{Title}', media, '.mp4');
  assert.ok(!rendered.includes('..'));
  assert.equal(rendered.split('/').length, 2);
});

test('a traversal written into the template itself is dropped', () => {
  assert.equal(path(BANGBROS, '../{Site}/{Title}', ['Bang Bros']), 'Bang Bros/Chloe Upgrades Her Butt.mp4');
  assert.equal(path(BANGBROS, '{Site}/./{Title}', ['Bang Bros']), 'Bang Bros/Chloe Upgrades Her Butt.mp4');
});

test('an unknown placeholder is left visible rather than silently dropped', () => {
  // A typo that vanished would shorten every path in the library without
  // saying so.
  assert.equal(path(BANGBROS, '{Site}/{titel}', ['Bang Bros']), 'Bang Bros/{titel}.mp4');
});

// --- One scene, one path --------------------------------------------------------

test('two encodes of one scene render one path under any template', () => {
  const templates = [DEFAULT_PATH_TEMPLATE, '{sitename}/{title}', '{SiteName}/{year}/{Title}'];
  for (const template of templates) {
    assert.equal(
      path('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB', template),
      path('Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP', template),
      template,
    );
  }
});

test('two different scenes never render one path', () => {
  // The component boundary the parser emits has to survive every template, or
  // the second scene can never import — the destination is already occupied.
  for (const template of [DEFAULT_PATH_TEMPLATE, '{sitename}/{title}', '{Site}/{Title}']) {
    assert.notEqual(
      path('[Vixen] Kylie - Page Turner - 2023-07-19', template),
      path('[Vixen] Kylie Page - Turner - 2023-07-19', template),
      template,
    );
  }
});
