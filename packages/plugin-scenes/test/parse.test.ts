import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneRelease } from '../src/parse.ts';

test('parses the canonical Site.YY.MM.DD.Names.XXX.quality-GROUP form', () => {
  const parsed = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  assert.ok(parsed);
  assert.equal(parsed.identityKey, 'brazzers:2023-04-15:alex-coal');
  assert.equal(parsed.display.title, 'Alex Coal');
  assert.equal(parsed.display.subtitle, 'Brazzers');
  assert.equal(parsed.display.date, '2023-04-15');
  assert.equal(parsed.quality.resolution, 1080);
  assert.equal(parsed.quality.releaseGroup, 'WRB');
  assert.equal(parsed.quality.extras?.['container'], 'mp4');
});

test('two encodes of the same scene share an identity key', () => {
  const a = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const b = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP');
  assert.ok(a && b);
  assert.equal(a.identityKey, b.identityKey);
  assert.notEqual(a.quality.resolution, b.quality.resolution);
});

test('different scenes on the same site and day do not collate', () => {
  const a = parseSceneRelease('TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX');
  const b = parseSceneRelease('TeamSkeet.24.01.02.John.Smith.XXX.1080p.MP4-XXX');
  assert.ok(a && b);
  assert.notEqual(a.identityKey, b.identityKey);
});

test('separator and case differences do not split a group', () => {
  const a = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const b = parseSceneRelease('brazzers 23 04 15 alex coal XXX 1080p MP4-WRB');
  assert.ok(a && b);
  assert.equal(a.identityKey, b.identityKey);
});

test('extracts resolution from every common token', () => {
  const cases: [string, number][] = [
    ['Site.23.01.01.Name.XXX.480p.MP4-G', 480],
    ['Site.23.01.01.Name.XXX.720p.MP4-G', 720],
    ['Site.23.01.01.Name.XXX.1080p.MP4-G', 1080],
    ['Site.23.01.01.Name.XXX.2160p.MP4-G', 2160],
    ['Site.23.01.01.Name.XXX.4K.MP4-G', 2160],
  ];
  for (const [name, expected] of cases) {
    assert.equal(parseSceneRelease(name)?.quality.resolution, expected, name);
  }
});

test('extracts video codec and source', () => {
  const parsed = parseSceneRelease('Site.23.01.01.Name.XXX.1080p.WEB-DL.H265.MP4-G');
  assert.equal(parsed?.quality.videoCodec, 'h265');
  assert.equal(parsed?.quality.source, 'web-dl');
});

test('a two-digit year maps into the 2000s', () => {
  assert.equal(parseSceneRelease('Site.99.12.31.Name.XXX.1080p.MP4-G')?.display.date, '2099-12-31');
});

test('a four-digit year is accepted', () => {
  assert.equal(
    parseSceneRelease('Site.2023.04.15.Name.XXX.1080p.MP4-G')?.display.date,
    '2023-04-15',
  );
});

test('a release with no XXX marker still parses using the first quality token', () => {
  const parsed = parseSceneRelease('Site.23.04.15.Alex.Coal.1080p.MP4-WRB');
  assert.ok(parsed);
  assert.equal(parsed.identityKey, 'site:2023-04-15:alex-coal');
  assert.equal(parsed.quality.resolution, 1080);
});

test('a name with no date returns null', () => {
  assert.equal(parseSceneRelease('Some.Random.Movie.2023.1080p.BluRay-GRP'), null);
});

test('an empty name returns null', () => {
  assert.equal(parseSceneRelease(''), null);
});

test('a name with a date but no site returns null', () => {
  assert.equal(parseSceneRelease('23.04.15.Alex.Coal.XXX.1080p.MP4-G'), null);
});

test('an invalid calendar date returns null', () => {
  assert.equal(parseSceneRelease('Site.23.13.45.Name.XXX.1080p.MP4-G'), null);
});

test('display fields carry site and performers', () => {
  const parsed = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const labels = parsed?.display.fields.map((field) => field.label);
  assert.deepEqual(labels, ['Site', 'Date', 'Scene']);
});

test('two scenes differing only by content after an in-title XXX get different identity keys', () => {
  const a = parseSceneRelease('Site.23.04.15.Anniversary.XXX.1080p.MP4-G');
  const b = parseSceneRelease('Site.23.04.15.Anniversary.XXX.Edition.XXX.1080p.MP4-G');
  assert.ok(a && b);
  assert.notEqual(a.identityKey, b.identityKey);
});

test('an in-title XXX scene keeps its full title instead of being truncated', () => {
  const parsed = parseSceneRelease('Site.23.04.15.Anniversary.XXX.Edition.XXX.1080p.MP4-G');
  assert.equal(parsed?.display.title, 'Anniversary XXX Edition');
});

test('two encodes of a scene with an XXX release group still share an identity key', () => {
  const a = parseSceneRelease('TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX');
  const b = parseSceneRelease('TeamSkeet.24.01.02.Jane.Doe.XXX.2160p.HEVC.MP4-XXX');
  assert.ok(a && b);
  assert.equal(a.identityKey, b.identityKey);
});

test('two scenes differing only by content after an in-title XXX followed by an encode-like word get different identity keys', () => {
  const a = parseSceneRelease('Site.23.04.15.Anniversary.XXX.Web.Party.XXX.1080p.MP4-G');
  const b = parseSceneRelease('Site.23.04.15.Anniversary.XXX.Web.Bash.XXX.1080p.MP4-G');
  assert.ok(a && b);
  assert.notEqual(a.identityKey, b.identityKey);
  assert.equal(a.display.title, 'Anniversary XXX Web Party');
  assert.equal(b.display.title, 'Anniversary XXX Web Bash');
});

// --- Invariants -------------------------------------------------------------
// The three properties below are what collation quality actually depends on.
// They are asserted over a corpus rather than one input each, so a new
// boundary rule that happens to satisfy the named cases but breaks the class
// still fails here.

/** Names that are all genuinely different scenes. None may share a key. */
const DISTINCT_SCENES = [
  'Site.23.04.15.Anniversary.XXX.1080p.MP4-G',
  'Site.23.04.15.Anniversary.XXX.Edition.XXX.1080p.MP4-G',
  'Site.23.04.15.Anniversary.XXX.Web.Party.XXX.MP4-GRP1',
  'Site.23.04.15.Anniversary.XXX.Web.Bash.XXX.MP4-GRP2',
  'Site.23.04.15.Anniversary.XXX.4K.Party.XXX.MP4-GRP1',
  'Site.23.04.15.Anniversary.XXX.4K.Bash.XXX.MP4-GRP2',
  'Site.23.04.15.Gala.XXX.MP4.Madness.XXX.1080p.MP4-G',
  'Site.23.04.15.Gala.XXX.MP4.Mayhem.XXX.1080p.MP4-G',
  'Site.23.04.15.Triple.XXX.Threat.XXX.720p.MP4-GRP',
  'Site.23.04.15.Triple.XXX.Tease.XXX.720p.MP4-GRP',
  'Site.23.04.15.XXX.Anniversary.XXX.1080p.MP4-GRP',
  'Site.23.04.15.XXXtreme.Makeover.XXX.1080p.MP4-GRP',
  'Site.23.04.15.Miss.AVI.XXX.1080p.MP4-G',
  'Site.23.04.15.Miss.MKV.XXX.1080p.MP4-G',
  'Site.23.04.15.Girls.Of.Web.1080p.MP4-G',
  'Site.23.04.15.Girls.Of.Print.1080p.MP4-G',
  'Site.23.04.15.Agent.007.Undercover.XXX.1080p.MP4-G',
  'Site.23.04.15.Agent.007.Overcover.XXX.1080p.MP4-G',
  'TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX',
  'TeamSkeet.24.01.02.John.Smith.XXX.1080p.MP4-XXX',
];

/** Each group is one scene, released at several encodes. */
const ENCODE_GROUPS = [
  [
    'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    'Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP',
    'Brazzers.23.04.15.Alex.Coal.XXX.2160p60.WEB-DL.H.265.10bit.HDR.DDP5.1.MP4-G',
    'Brazzers.23.04.15.Alex.Coal.XXX.SD.480p.XviD.AVI-G',
    'brazzers 23 04 15 alex coal XXX 1080p MP4-WRB',
    'Brazzers_23_04_15_Alex_Coal_XXX_1080p_MP4-WRB',
    'Brazzers-23-04-15-Alex-Coal-XXX-1080p-MP4-WRB',
  ],
  [
    'TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX',
    'TeamSkeet.24.01.02.Jane.Doe.XXX.2160p.HEVC.MP4-XXX',
  ],
  [
    'Site.23.04.15.Alex.Coal.XXX.MP4-GRP',
    'Site.23.04.15.Alex.Coal.XXX.MKV-GRP',
    'Site.23.04.15.Alex.Coal.XXX.WMV',
    'Site.23.04.15.Alex.Coal.XXX',
  ],
  [
    'Site.23.04.15.Anniversary.XXX.Web.Party.XXX.MP4-GRP1',
    'Site.23.04.15.Anniversary.XXX.Web.Party.XXX.1080p.MP4-GRP2',
  ],
];

/** The full scene text each name carries, which must survive intact. */
const FULL_TITLES: [string, string][] = [
  ['Site.23.04.15.Anniversary.XXX.Web.Party.XXX.MP4-GRP1', 'Anniversary XXX Web Party'],
  ['Site.23.04.15.Anniversary.XXX.4K.Party.XXX.MP4-GRP1', 'Anniversary XXX 4K Party'],
  ['Site.23.04.15.Gala.XXX.MP4.Madness.XXX.1080p.MP4-G', 'Gala XXX MP4 Madness'],
  ['Site.23.04.15.XXX.Anniversary.XXX.1080p.MP4-GRP', 'XXX Anniversary'],
  ['Site.23.04.15.The.1080.Club.XXX.1080p.MP4-G', 'The 1080 Club'],
  ['Site.23.04.15.Agent.007.Undercover.XXX.1080p.MP4-G', 'Agent 007 Undercover'],
  ['Site.23.04.15.Girls.Of.Web.1080p.MP4-G', 'Girls Of Web'],
  ['Site.23.04.15.Alex.Coal.XXX.MP4-GRP', 'Alex Coal'],
];

/**
 * Inputs the parser deliberately refuses. Each is ambiguous in a way where a
 * guess could merge two different scenes, so `null` (a visible parse_error)
 * is the intended answer. Pinned so the refusal set cannot silently widen.
 */
const REFUSED = [
  '',
  'Some.Random.Movie.2023.1080p.BluRay-GRP',
  '23.04.15.Alex.Coal.XXX.1080p.MP4-G',
  'Site.23.13.45.Name.XXX.1080p.MP4-G',
  'Site.23.02.30.Name.XXX.1080p.MP4-G',
  // `Site.23.04.15.Alex.Coal` used to sit here. It carries no encode
  // vocabulary at all, so there is no run to mistake for title and nothing to
  // guess — it parses, and collates with the same scene listed with its
  // encode information. The rows below still refuse because each *does* carry
  // a weak encode token, which is exactly what makes them ambiguous.
  'Site.23.04.15.Alex.Coal.MP4-G',
  'Site.23.04.15.Girls.Of.Web.MP4-G',
  'Site.23.04.15.The.1080p.Club.MP4-G',
  'Site.23.04.15.Name.XXX.1080p.Uncut.MP4-G',
];

/**
 * One release, spelled with each separator the scene conventions allow. These
 * collate into a single group by design, so they are compared against each
 * other on *score inputs* too: two spellings of one release that disagree
 * about resolution or source produce two wildly different scores inside one
 * group, which is all it takes for a 480p release to read as an upgrade over
 * a 1080p one — and for a genuinely better release to never flag at all.
 */
const SEPARATOR_SPELLINGS: string[][] = [
  [
    'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-KTR',
    'Brazzers_23_04_15_Alex_Coal_XXX_1080p_MP4-KTR',
    'Brazzers 23 04 15 Alex Coal XXX 1080p MP4-KTR',
  ],
  [
    'Site.23.01.01.Name.XXX.2160p.WEB-DL.H.265.MKV-G',
    'Site_23_01_01_Name_XXX_2160p_WEB_DL_H_265_MKV-G',
  ],
  ['Site.23.01.01.Name.XXX.720p.WEBRip.x264.AVI-G', 'Site_23_01_01_Name_XXX_720p_WEBRip_x264_AVI-G'],
];

test('invariant: separator spelling never changes the quality tokens', () => {
  for (const [canonical, ...variants] of SEPARATOR_SPELLINGS) {
    const expected = parseSceneRelease(canonical ?? '');
    assert.ok(expected, `expected ${canonical} to parse`);
    for (const variant of variants) {
      const parsed = parseSceneRelease(variant);
      assert.ok(parsed, `expected ${variant} to parse`);
      assert.equal(parsed.identityKey, expected.identityKey, variant);
      assert.deepEqual(parsed.quality, expected.quality, variant);
    }
  }
});

test('invariant: no two distinct scenes ever share an identity key', () => {
  const seen = new Map<string, string>();
  for (const name of DISTINCT_SCENES) {
    const parsed = parseSceneRelease(name);
    assert.ok(parsed, `expected ${name} to parse`);
    const clash = seen.get(parsed.identityKey);
    assert.equal(clash, undefined, `${name} collided with ${clash} on ${parsed.identityKey}`);
    seen.set(parsed.identityKey, name);
  }
});

test('invariant: every encode of one scene collapses to a single identity key', () => {
  for (const group of ENCODE_GROUPS) {
    const keys = group.map((name) => {
      const parsed = parseSceneRelease(name);
      assert.ok(parsed, `expected ${name} to parse`);
      return parsed.identityKey;
    });
    assert.equal(new Set(keys).size, 1, `group split into ${JSON.stringify(keys)}`);
  }
});

test('invariant: a title is never silently truncated at an in-title marker or encode word', () => {
  for (const [name, expected] of FULL_TITLES) {
    const parsed = parseSceneRelease(name);
    assert.ok(parsed, `expected ${name} to parse`);
    assert.equal(parsed.display.title, expected, name);
  }
});

test('invariant: ambiguous names are refused rather than guessed', () => {
  for (const name of REFUSED) {
    assert.equal(parseSceneRelease(name), null, `expected ${name || "''"} to be refused`);
  }
});
