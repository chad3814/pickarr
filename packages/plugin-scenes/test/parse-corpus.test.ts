import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneRelease } from '../src/parse.ts';

/**
 * The corpus is the specification for the date-boundary parser.
 *
 * Individual cases are not the point — a list of ten passing strings is what
 * the previous three fix rounds each produced, and each one relocated the bug
 * rather than closing it. What is asserted here are *properties over the whole
 * table*: that scenes marked as one scene always collapse to one key, that
 * scenes marked as different never do, that no accepted name loses part of its
 * title, and that every key stays inside the alphabet destinations are derived
 * from. Adding a row therefore strengthens every invariant at once, and a new
 * boundary rule that satisfies the named rows but breaks the class still fails.
 */
interface Entry {
  /** The release name as it arrives from an RSS feed. */
  readonly name: string;
  /**
   * Scene identity. Rows sharing a `scene` are different encodes, spellings,
   * or layouts of one scene and MUST share an `identityKey`. Rows with
   * different `scene` values are genuinely different content and MUST NOT.
   */
  readonly scene: string;
  /** The exact key expected, pinning the round trip. */
  readonly key: string;
  /** The exact display title expected, pinning against truncation. */
  readonly title: string;
  /** True where the previous (XXX-marker) parser refused or mis-parsed this. */
  readonly isNew: boolean;
}

const CORPUS: Entry[] = [
  // --- The canonical dotted form, in every spelling it arrives in -----------
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.2160p60.WEB-DL.H.265.10bit.HDR.DDP5.1.MP4-G',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
  {
    name: 'brazzers 23 04 15 alex coal XXX 1080p MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'alex coal',
    isNew: false,
  },
  {
    name: 'Brazzers_23_04_15_Alex_Coal_XXX_1080p_MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
  {
    name: 'Brazzers-23-04-15-Alex-Coal-XXX-1080p-MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex-Coal',
    isNew: false,
  },
  {
    name: 'Brazzers.2023.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },

  // --- Preprocessing: website prefixes and appended file extensions ---------
  {
    name: 'www.site.com - Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: true,
  },
  {
    name: '[www.pornsite.net] Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: true,
  },
  {
    name: 'www.Site.com.Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: true,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB.mp4',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: true,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP.mkv',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: true,
  },

  // --- Concatenated dates ---------------------------------------------------
  {
    name: 'Blacked.20180428.Alex.Coal.XXX.1080p.MP4-KTR',
    scene: 'blacked/alex-coal',
    key: 'blacked:2018-04-28:alex-coal',
    title: 'Alex Coal',
    isNew: true,
  },
  {
    name: 'Blacked.180428.Alex.Coal.XXX.1080p.MP4-KTR',
    scene: 'blacked/alex-coal',
    key: 'blacked:2018-04-28:alex-coal',
    title: 'Alex Coal',
    isNew: true,
  },
  {
    name: 'Blacked.18.04.28.Alex.Coal.XXX.2160p.HEVC.MP4-KTR',
    scene: 'blacked/alex-coal',
    key: 'blacked:2018-04-28:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },

  // --- Dot-attached release group ------------------------------------------
  {
    name: 'Tushy.24.01.09.Emily.Willis.XXX.1080p.HEVC.x265.PRT',
    scene: 'tushy/emily-willis',
    key: 'tushy:2024-01-09:emily-willis',
    title: 'Emily Willis',
    isNew: true,
  },
  {
    name: 'Tushy.24.01.09.Emily.Willis.XXX.2160p.HEVC.x265.PRT',
    scene: 'tushy/emily-willis',
    key: 'tushy:2024-01-09:emily-willis',
    title: 'Emily Willis',
    isNew: true,
  },
  {
    name: 'Tushy.24.01.09.Emily.Willis.XXX.1080p.HEVC.x265-PRT',
    scene: 'tushy/emily-willis',
    key: 'tushy:2024-01-09:emily-willis',
    title: 'Emily Willis',
    isNew: false,
  },

  // --- VR and similar layout tags ------------------------------------------
  {
    name: 'SexBabesVR.23.04.15.Alex.Coal.XXX.1080p.VR.MP4-G',
    scene: 'sexbabesvr/alex-coal',
    key: 'sexbabesvr:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: true,
  },
  {
    name: 'SexBabesVR.23.04.15.Alex.Coal.XXX.2160p.VR.SBS.MP4-G',
    scene: 'sexbabesvr/alex-coal',
    key: 'sexbabesvr:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: true,
  },

  // --- The bracketed / dash-delimited listing form -------------------------
  // Note the two layouts: the Vixen row puts the date first and the performer
  // before the title; the reversed row puts the title first and the date
  // third. They are one scene and must collate.
  {
    name: '[Vixen] 19-07-2023 - Alex Coal - Beautiful Episode 2160p {SLUT}',
    scene: 'vixen/alex-coal-beautiful-episode',
    key: 'vixen:2023-07-19:alex-coal-beautiful-episode',
    title: 'Alex Coal - Beautiful Episode',
    isNew: true,
  },
  {
    name: '[Vixen] Beautiful Episode - Alex Coal - 2023-07-19 - 1080p',
    scene: 'vixen/alex-coal-beautiful-episode',
    key: 'vixen:2023-07-19:alex-coal-beautiful-episode',
    title: 'Beautiful Episode - Alex Coal',
    isNew: true,
  },
  {
    name: '[Vixen] 19.07.2023 - Alex Coal - Beautiful Episode [1080p]',
    scene: 'vixen/alex-coal-beautiful-episode',
    key: 'vixen:2023-07-19:alex-coal-beautiful-episode',
    title: 'Alex Coal - Beautiful Episode',
    isNew: true,
  },
  {
    name: '[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 1080p',
    scene: 'tushy/alex-coal-beautiful-episode',
    key: 'tushy:2023-07-22:alex-coal-beautiful-episode',
    title: 'Beautiful Episode - Alex Coal',
    isNew: true,
  },
  {
    name: '[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 2160p HEVC',
    scene: 'tushy/alex-coal-beautiful-episode',
    key: 'tushy:2023-07-22:alex-coal-beautiful-episode',
    title: 'Beautiful Episode - Alex Coal',
    isNew: true,
  },
  // A different scene on the same site and day: the title segment differs, so
  // the sorted-component slug still separates them.
  {
    name: '[Tushy] Different Episode - Alex Coal - 2023-07-22 - 1080p',
    scene: 'tushy/alex-coal-different-episode',
    key: 'tushy:2023-07-22:alex-coal-different-episode',
    title: 'Different Episode - Alex Coal',
    isNew: true,
  },

  // --- Written-month date in parentheses -----------------------------------
  {
    name: 'Pure Taboo - Sarah Arabic, Lily LaBeau - A Costly Divorce (June 24, 2025) [1080p HEVC x265]',
    scene: 'pure-taboo/a-costly-divorce',
    key: 'pure-taboo:2025-06-24:a-costly-divorce-sarah-arabic-lily-labeau',
    title: 'Sarah Arabic, Lily LaBeau - A Costly Divorce',
    isNew: true,
  },
  {
    name: 'Pure Taboo - A Costly Divorce - Sarah Arabic, Lily LaBeau - 2025-06-24 - 2160p',
    scene: 'pure-taboo/a-costly-divorce',
    key: 'pure-taboo:2025-06-24:a-costly-divorce-sarah-arabic-lily-labeau',
    title: 'A Costly Divorce - Sarah Arabic, Lily LaBeau',
    isNew: true,
  },
  {
    name: 'Pure Taboo - Sarah Arabic - A Different Divorce (Jun 24, 2025) [1080p]',
    scene: 'pure-taboo/a-different-divorce',
    key: 'pure-taboo:2025-06-24:a-different-divorce-sarah-arabic',
    title: 'Sarah Arabic - A Different Divorce',
    isNew: true,
  },

  // --- Regression: an XXX release group must not move the boundary ----------
  {
    name: 'TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX',
    scene: 'teamskeet/jane-doe',
    key: 'teamskeet:2024-01-02:jane-doe',
    title: 'Jane Doe',
    isNew: false,
  },
  {
    name: 'TeamSkeet.24.01.02.Jane.Doe.XXX.2160p.HEVC.MP4-XXX',
    scene: 'teamskeet/jane-doe',
    key: 'teamskeet:2024-01-02:jane-doe',
    title: 'Jane Doe',
    isNew: false,
  },
  {
    name: 'TeamSkeet.24.01.02.John.Smith.XXX.1080p.MP4-XXX',
    scene: 'teamskeet/john-smith',
    key: 'teamskeet:2024-01-02:john-smith',
    title: 'John Smith',
    isNew: false,
  },

  // --- Regression: an in-title XXX must not truncate the title -------------
  {
    name: 'Site.23.04.15.Anniversary.XXX.1080p.MP4-G',
    scene: 'site/anniversary',
    key: 'site:2023-04-15:anniversary',
    title: 'Anniversary',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.Edition.XXX.1080p.MP4-G',
    scene: 'site/anniversary-edition',
    key: 'site:2023-04-15:anniversary-xxx-edition',
    title: 'Anniversary XXX Edition',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.Edition.XXX.2160p.HEVC.MP4-G',
    scene: 'site/anniversary-edition',
    key: 'site:2023-04-15:anniversary-xxx-edition',
    title: 'Anniversary XXX Edition',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.Web.Party.XXX.MP4-GRP1',
    scene: 'site/anniversary-web-party',
    key: 'site:2023-04-15:anniversary-xxx-web-party',
    title: 'Anniversary XXX Web Party',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.Web.Party.XXX.1080p.MP4-GRP2',
    scene: 'site/anniversary-web-party',
    key: 'site:2023-04-15:anniversary-xxx-web-party',
    title: 'Anniversary XXX Web Party',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.Web.Bash.XXX.MP4-GRP2',
    scene: 'site/anniversary-web-bash',
    key: 'site:2023-04-15:anniversary-xxx-web-bash',
    title: 'Anniversary XXX Web Bash',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.4K.Party.XXX.MP4-GRP1',
    scene: 'site/anniversary-4k-party',
    key: 'site:2023-04-15:anniversary-xxx-4k-party',
    title: 'Anniversary XXX 4K Party',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Gala.XXX.MP4.Madness.XXX.1080p.MP4-G',
    scene: 'site/gala-mp4-madness',
    key: 'site:2023-04-15:gala-xxx-mp4-madness',
    title: 'Gala XXX MP4 Madness',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Gala.XXX.MP4.Mayhem.XXX.1080p.MP4-G',
    scene: 'site/gala-mp4-mayhem',
    key: 'site:2023-04-15:gala-xxx-mp4-mayhem',
    title: 'Gala XXX MP4 Mayhem',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.XXX.Anniversary.XXX.1080p.MP4-GRP',
    scene: 'site/xxx-anniversary',
    key: 'site:2023-04-15:xxx-anniversary',
    title: 'XXX Anniversary',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.XXXtreme.Makeover.XXX.1080p.MP4-GRP',
    scene: 'site/xxxtreme-makeover',
    key: 'site:2023-04-15:xxxtreme-makeover',
    title: 'XXXtreme Makeover',
    isNew: false,
  },

  // --- Regression: weak encode words inside a title ------------------------
  {
    name: 'Site.23.04.15.Girls.Of.Web.1080p.MP4-G',
    scene: 'site/girls-of-web',
    key: 'site:2023-04-15:girls-of-web',
    title: 'Girls Of Web',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Girls.Of.Print.1080p.MP4-G',
    scene: 'site/girls-of-print',
    key: 'site:2023-04-15:girls-of-print',
    title: 'Girls Of Print',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.The.1080.Club.XXX.1080p.MP4-G',
    scene: 'site/the-1080-club',
    key: 'site:2023-04-15:the-1080-club',
    title: 'The 1080 Club',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Agent.007.Undercover.XXX.1080p.MP4-G',
    scene: 'site/agent-007-undercover',
    key: 'site:2023-04-15:agent-007-undercover',
    title: 'Agent 007 Undercover',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Agent.007.Overcover.XXX.1080p.MP4-G',
    scene: 'site/agent-007-overcover',
    key: 'site:2023-04-15:agent-007-overcover',
    title: 'Agent 007 Overcover',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Miss.AVI.XXX.1080p.MP4-G',
    scene: 'site/miss-avi',
    key: 'site:2023-04-15:miss-avi',
    title: 'Miss AVI',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Miss.MKV.XXX.1080p.MP4-G',
    scene: 'site/miss-mkv',
    key: 'site:2023-04-15:miss-mkv',
    title: 'Miss MKV',
    isNew: false,
  },
  {
    name: '[Site] 2023-01-01 - Girls Of Web',
    scene: 'site/girls-of-web-listing',
    key: 'site:2023-01-01:girls-of-web',
    title: 'Girls Of Web',
    isNew: true,
  },
  {
    name: '[Site] 2023-01-01 - Episode 2 4K',
    scene: 'site/episode-2',
    key: 'site:2023-01-01:episode-2',
    title: 'Episode 2',
    isNew: true,
  },
  {
    name: '[Site] 2023-01-01 - Episode 3 4K',
    scene: 'site/episode-3',
    key: 'site:2023-01-01:episode-3',
    title: 'Episode 3',
    isNew: true,
  },

  // --- No marker at all, and marker-only encode sections -------------------
  {
    name: 'Site.23.04.15.Alex.Coal.1080p.MP4-WRB',
    scene: 'site/alex-coal',
    key: 'site:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Alex.Coal.XXX.MP4-GRP',
    scene: 'site/alex-coal',
    key: 'site:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Alex.Coal.XXX.MKV-GRP',
    scene: 'site/alex-coal',
    key: 'site:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Alex.Coal.XXX.WMV',
    scene: 'site/alex-coal',
    key: 'site:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Alex.Coal.XXX',
    scene: 'site/alex-coal',
    key: 'site:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },

  // --- The site is whatever precedes the date, with no vocabulary judgement -
  // A studio whose own name is built from encode words is exactly the case the
  // old whole-name boundary scan could corrupt.
  {
    name: '4K.Media.23.04.15.Alex.Coal.XXX.1080p.MP4-G',
    scene: '4k-media/alex-coal',
    key: '4k-media:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
  {
    name: 'WebYoung.23.04.15.Alex.Coal.XXX.1080p.MP4-G',
    scene: 'webyoung/alex-coal',
    key: 'webyoung:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
  {
    name: 'Tushy.com.23.04.15.Emily.Willis.XXX.1080p-G',
    scene: 'tushy-com/emily-willis',
    key: 'tushy-com:2023-04-15:emily-willis',
    title: 'Emily Willis',
    isNew: false,
  },
  {
    name: 'Vintage.1979.Collection.23.04.15.Alex.Coal.XXX.1080p.MP4-G',
    scene: 'vintage-1979-collection/alex-coal',
    key: 'vintage-1979-collection:2023-04-15:alex-coal',
    title: 'Alex Coal',
    isNew: false,
  },
];

/**
 * Inputs the parser deliberately refuses. `null` writes a visible
 * `parse_error` row — a worklist — whereas a guess writes a wrong group that
 * nothing surfaces. Each entry below is ambiguous in a way where the plausible
 * guesses disagree about the *identity*, so refusing is the correct answer,
 * not a gap. Pinned so the refusal set cannot silently widen either.
 */
const REFUSED: [string, string][] = [
  ['', 'nothing to parse'],
  [
    'Some.Random.Movie.2023.1080p.BluRay-GRP',
    'no date: a bare year is not a release date, and without one there is no site/title boundary',
  ],
  [
    '23.04.15.Alex.Coal.XXX.1080p.MP4-G',
    'the date is first, so there is no site; every scene on that day would share a key',
  ],
  ['Site.23.13.45.Name.XXX.1080p.MP4-G', 'month 13 and day 45 are not a calendar date'],
  ['Site.23.02.30.Name.XXX.1080p.MP4-G', 'February 30 does not exist'],
  [
    'Site.23.04.15.Alex.Coal',
    'no encode section at all: nothing marks where the title stops, so "Alex Coal" and "Alex Coal 1080p" cannot be told apart',
  ],
  [
    'Site.23.04.15.Alex.Coal.MP4-G',
    'the only encode evidence is a container, which is also an ordinary title word here (cf. "Gala XXX MP4 Madness")',
  ],
  [
    'Site.23.04.15.Girls.Of.Web.MP4-G',
    'same: "Web" and "MP4" are both weak, and eating them would truncate the title to "Girls Of"',
  ],
  [
    'Site.23.04.15.The.1080p.Club.MP4-G',
    'the anchor sits mid-title, so the encode run does not reach the end and no boundary is trustworthy',
  ],
  [
    'Site.23.04.15.Name.XXX.1080p.Uncut.MP4-G',
    'an edit tag interrupts the encode run; guessing would merge the uncut and cut versions',
  ],
  [
    'Site.23.04.15.Name.XXX.1080p.Uncut',
    'a dot-attached trailing word in mixed case is an edit tag, not a release group',
  ],
  [
    'Site.23.04.15.XXX.1080p.MP4-G',
    'the title is only the marker, which carries no discriminating content: two unrelated scenes that day would collide',
  ],
  [
    'SexBabesVR.23.04.15.Alex.Coal.XXX.2160p.VR.LR.180.MP4-G',
    'a bare "180" is not in the encode vocabulary and a bare number is a plausible title word, so the run is treated as interrupted',
  ],
  [
    '[Vixen] Alex Coal - Beautiful Episode',
    'delimited listing with no date: the anchor the whole rule rests on is absent',
  ],
  [
    '19-07-2023 - Alex Coal - Beautiful Episode 1080p',
    'delimited listing whose first segment is the date, leaving no site',
  ],
];

const KEY_SHAPE = /^[a-z0-9-]+:\d{4}-\d{2}-\d{2}:[a-z0-9-]+$/;

function parsed(name: string) {
  const result = parseSceneRelease(name);
  assert.ok(result !== null, `expected ${JSON.stringify(name)} to parse`);
  return result;
}

test('corpus: every accepted name round-trips to its pinned identity key', () => {
  for (const entry of CORPUS) {
    assert.equal(parsed(entry.name).identityKey, entry.key, entry.name);
  }
});

test('corpus: parsing is deterministic across repeated calls', () => {
  // Guards against stateful regexes (a `g` flag carries `lastIndex` between
  // calls), which would make the first parse of a feed differ from the second.
  for (const entry of CORPUS) {
    const first = parsed(entry.name);
    const second = parsed(entry.name);
    assert.deepEqual(second, first, entry.name);
  }
});

test('corpus: every encode, spelling, and layout of one scene shares a key', () => {
  const keysByScene = new Map<string, Map<string, string>>();
  for (const entry of CORPUS) {
    const keys = keysByScene.get(entry.scene) ?? new Map<string, string>();
    keys.set(parsed(entry.name).identityKey, entry.name);
    keysByScene.set(entry.scene, keys);
  }
  for (const [scene, keys] of keysByScene) {
    assert.equal(
      keys.size,
      1,
      `${scene} split into ${JSON.stringify(Object.fromEntries(keys))}`,
    );
  }
});

test('corpus: no two distinct scenes ever share an identity key', () => {
  const owner = new Map<string, string>();
  for (const entry of CORPUS) {
    const key = parsed(entry.name).identityKey;
    const existing = owner.get(key);
    assert.ok(
      existing === undefined || existing === entry.scene,
      `${entry.name} (${entry.scene}) over-collated with ${existing} on ${key}`,
    );
    owner.set(key, entry.scene);
  }
});

test('corpus: no title is silently truncated', () => {
  for (const entry of CORPUS) {
    assert.equal(parsed(entry.name).display.title, entry.title, entry.name);
  }
});

test('corpus: every key stays inside the alphabet destinations are derived from', () => {
  // `planSceneImport` splits `identityKey` on ":" and title-cases the slugs
  // back into a path, so a key must always be exactly three fields and the
  // slugs must never carry a character outside [a-z0-9-].
  for (const entry of CORPUS) {
    const key = parsed(entry.name).identityKey;
    assert.match(key, KEY_SHAPE, entry.name);
    assert.equal(key.split(':').length, 3, entry.name);
  }
});

test('corpus: the display date always agrees with the key', () => {
  for (const entry of CORPUS) {
    const release = parsed(entry.name);
    assert.equal(release.display.date, release.identityKey.split(':')[1], entry.name);
  }
});

test('corpus: the new shapes really are new coverage', () => {
  // A guard on the corpus itself: if this ever reaches zero the table has been
  // reduced back to what the old marker-based parser already handled.
  assert.ok(CORPUS.filter((entry) => entry.isNew).length >= 20);
});

test('refusal set: ambiguous names are refused rather than guessed', () => {
  for (const [name, why] of REFUSED) {
    assert.equal(parseSceneRelease(name), null, `expected ${name || "''"} to be refused: ${why}`);
  }
});

// --- The seven regressions the three earlier fix rounds paid for ------------
// Each is asserted here by name as well as inside the table above, so a future
// change cannot quietly undo one by deleting a row.

test('regression 1: two encodes of one scene share a key, two scenes never do', () => {
  const a = parsed('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const b = parsed('Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP');
  const c = parsed('Brazzers.23.04.15.Jane.Doe.XXX.1080p.MP4-WRB');
  assert.equal(a.identityKey, b.identityKey);
  assert.notEqual(a.identityKey, c.identityKey);
});

test('regression 2: a release group literally named XXX does not move the boundary', () => {
  const a = parsed('TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX');
  const b = parsed('TeamSkeet.24.01.02.Jane.Doe.XXX.2160p.HEVC.MP4-XXX');
  assert.equal(a.identityKey, b.identityKey);
  assert.equal(a.display.title, 'Jane Doe');
});

test('regression 3: an in-title XXX neither collapses nor truncates the title', () => {
  const plain = parsed('Site.23.04.15.Anniversary.XXX.1080p.MP4-G');
  const edition = parsed('Site.23.04.15.Anniversary.XXX.Edition.XXX.1080p.MP4-G');
  assert.notEqual(plain.identityKey, edition.identityKey);
  assert.equal(edition.display.title, 'Anniversary XXX Edition');
});

test('regression 4: separator and case differences never split a group', () => {
  const spellings = [
    'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    'brazzers 23 04 15 alex coal XXX 1080p MP4-WRB',
    'Brazzers_23_04_15_Alex_Coal_XXX_1080p_MP4-WRB',
    'Brazzers-23-04-15-Alex-Coal-XXX-1080p-MP4-WRB',
  ];
  const keys = new Set(spellings.map((name) => parsed(name).identityKey));
  assert.equal(keys.size, 1, JSON.stringify([...keys]));
});

test('regression 5: an underscore name yields the same quality tokens as its dotted twin', () => {
  // `\b` does not match beside `_`, so an unnormalized haystack loses
  // resolution, source, codec and container at once — which inverted upgrade
  // ranking inside a group that collates both spellings by design.
  const pairs: [string, string][] = [
    [
      'Site.23.01.01.Name.XXX.2160p.WEB-DL.H.265.MKV-G',
      'Site_23_01_01_Name_XXX_2160p_WEB_DL_H_265_MKV-G',
    ],
    [
      'Site.23.01.01.Name.XXX.720p.WEBRip.x264.AVI-G',
      'Site_23_01_01_Name_XXX_720p_WEBRip_x264_AVI-G',
    ],
    [
      'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-KTR',
      'Brazzers 23 04 15 Alex Coal XXX 1080p MP4-KTR',
    ],
  ];
  for (const [dotted, variant] of pairs) {
    const expected = parsed(dotted);
    const actual = parsed(variant);
    assert.equal(actual.identityKey, expected.identityKey, variant);
    assert.deepEqual(actual.quality, expected.quality, variant);
  }
});

test('regression 6: an invalid calendar date returns null', () => {
  assert.equal(parseSceneRelease('Site.23.13.45.Name.XXX.1080p.MP4-G'), null);
  assert.equal(parseSceneRelease('Site.23.02.30.Name.XXX.1080p.MP4-G'), null);
  assert.equal(parseSceneRelease('Site.20231345.Name.XXX.1080p.MP4-G'), null);
});

test('regression 7: a website prefix does not split a group', () => {
  const bare = parsed('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const prefixed = [
    'www.site.com - Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    '[www.pornsite.net] Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    'www.Site.com.Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
  ];
  for (const name of prefixed) {
    assert.equal(parsed(name).identityKey, bare.identityKey, name);
  }
});

/**
 * The multi-part listing shapes put performers and title on either side of
 * each other depending on the tracker, so the identity slug is built from the
 * *sorted* component slugs while the display title keeps source order.
 *
 * The alternative — preserving order — was rejected: it under-collates every
 * time one site is scraped by two indexers with different layouts, and
 * under-collation here is silent (two cards that look identical) rather than
 * self-evident. Sorting cannot raise the collision risk in the way word-level
 * normalisation would, because it reorders whole components and never merges
 * them: two scenes that share performers still differ in their title
 * component, and the sorted join of a different multiset is a different
 * string. Two scenes on one site and day whose component multisets are exact
 * permutations of each other are the same scene.
 */
test('listing layout order does not change the identity key', () => {
  const layouts = [
    '[Vixen] 19-07-2023 - Alex Coal - Beautiful Episode 2160p {SLUT}',
    '[Vixen] Beautiful Episode - Alex Coal - 2023-07-19 - 1080p',
    '[Vixen] 19.07.2023 - Alex Coal - Beautiful Episode [1080p]',
  ];
  const keys = new Set(layouts.map((name) => parsed(name).identityKey));
  assert.equal(keys.size, 1, JSON.stringify([...keys]));

  // ...while sharing a performer is not enough to collide.
  assert.notEqual(
    parsed('[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 1080p').identityKey,
    parsed('[Tushy] Different Episode - Alex Coal - 2023-07-22 - 1080p').identityKey,
  );
});
