import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneRelease, sceneSiteCandidates } from '../src/parse.ts';
import { scoreScene } from '../src/score.ts';

const ANAL_ONLY = 'Anal.Only.Getting.In.Savannahs.Booty.Savannah.Bond.2022.09.29.Upscaled.2160p';
const BANGBROS =
  'Bangbros.Ass.Parade.Chloe.Upgrades.her.Butt.Toy.to.Chevalier.a.BBC.Chloe.Chevalier.2026.08.03.2160p';

function parsed(name: string, sites?: readonly string[]) {
  const result = parseSceneRelease(name, sites === undefined ? undefined : { sites });
  assert.ok(result !== null, `expected ${JSON.stringify(name)} to parse`);
  return result;
}

// --- The configured site list ------------------------------------------------

test('a configured site is matched as a prefix and split off from the title', () => {
  const result = parsed(ANAL_ONLY, ['Anal Only']);
  assert.equal(result.identityKey, 'anal-only:2022-09-29:getting-in-savannahs-booty-savannah-bond');
  assert.equal(result.display.subtitle, 'Anal Only');
  assert.equal(result.display.title, 'Getting In Savannahs Booty Savannah Bond');
});

test('the longest matching site wins, so a sub-site beats its parent', () => {
  // Both match at position 0. Taking the shorter one would file every Ass
  // Parade scene under Bangbros and leave "Ass Parade" repeated in the title.
  const result = parsed(BANGBROS, ['Bangbros', 'Bangbros Ass Parade']);
  assert.equal(result.display.subtitle, 'Bangbros Ass Parade');
  assert.equal(
    result.display.title,
    'Chloe Upgrades her Butt Toy to Chevalier a BBC Chloe Chevalier',
  );
});

test('a site only matches at the start, never mid-name', () => {
  // "Ass Parade" occurs at token 1, not token 0. Matching it there would drop
  // "Bangbros" from the name entirely.
  const result = parsed(BANGBROS, ['Ass Parade']);
  assert.equal(result.display.subtitle, 'Bangbros');
});

test('site matching ignores case and the separators the configured name uses', () => {
  // Every spelling recognises the site and takes both of its tokens, so the
  // title is the scene rather than "Only Getting In ...".
  for (const spelling of ['Anal Only', 'anal only', 'Anal.Only', 'ANALONLY', '  Anal   Only  ']) {
    assert.equal(
      parsed(ANAL_ONLY, [spelling]).display.title,
      'Getting In Savannahs Booty Savannah Bond',
      spelling,
    );
  }
});

test('the configured spelling is the canonical one and decides the key', () => {
  // Matching is separator-insensitive, but the key is not invented — it comes
  // from how the site is configured. Configure it solid and you get a solid
  // directory; the tradeoff is stated in the README rather than guessed at.
  assert.equal(parsed(ANAL_ONLY, ['Anal Only']).identityKey.split(':')[0], 'anal-only');
  assert.equal(parsed(ANAL_ONLY, ['ANALONLY']).identityKey.split(':')[0], 'analonly');
});

test('one site written several ways by different releases collates to one group', () => {
  // The case that forced canonical naming. TPDB calls the site "Bang Bros";
  // most releases write the short_name as one token and a minority split it.
  // Keyed on the release's own spelling these are three sites.
  const sites = ['Bang Bros'];
  const keys = [
    'Bangbros.Chloe.Upgrades.her.Butt.2026.08.03.2160p',
    'BangBros.Chloe.Upgrades.her.Butt.2026.08.03.2160p',
    'bangbros.Chloe.Upgrades.her.Butt.2026.08.03.2160p',
    'Bang.Bros.Chloe.Upgrades.her.Butt.2026.08.03.2160p',
  ].map((name) => parsed(name, sites).identityKey);

  assert.equal(new Set(keys).size, 1, `expected one key, got ${JSON.stringify(keys)}`);
  assert.equal(keys[0], 'bang-bros:2026-08-03:chloe-upgrades-her-butt');
});

test('the canonical spelling is used even when the release is written solid', () => {
  const result = parsed('Bangbros.Chloe.Upgrades.her.Butt.2026.08.03.2160p', ['Bang Bros']);
  assert.equal(result.display.subtitle, 'Bang Bros');
  assert.equal(result.display.title, 'Chloe Upgrades her Butt');
});

test('a solid-written site is still found when only its spaced name is known', () => {
  // The lookup returns "Bang Bros" for a query of "Bangbros"; the matcher has
  // to accept that answer against the token that produced the query, or the
  // confirmed site is learned and then never used.
  assert.equal(
    parsed(BANGBROS, ['Bang Bros']).identityKey,
    'bang-bros:2026-08-03:ass-parade-chloe-upgrades-her-butt-toy-to-chevalier-a-bbc-chloe-chevalier',
  );
});

test('an unmatched name falls back to the first token rather than refusing', () => {
  const result = parsed(ANAL_ONLY, ['Vixen', 'Brazzers']);
  assert.equal(result.display.subtitle, 'Anal');
  assert.equal(result.display.title, 'Only Getting In Savannahs Booty Savannah Bond');
});

test('a site that would consume the whole name leaves a title instead of an empty one', () => {
  // The configured site covers every pre-date token. Consuming all of them
  // would leave no scene slug at all, so the match is rejected and the
  // fallback applies.
  const result = parsed('Anal.Only.2022.09.29.2160p', ['Anal Only']);
  assert.equal(result.display.subtitle, 'Anal');
  assert.equal(result.display.title, 'Only');
});

test('an empty or whitespace-only configured site never matches', () => {
  const result = parsed(ANAL_ONLY, ['', '   ', '...']);
  assert.equal(result.display.subtitle, 'Anal');
});

test('the site list does not disturb the ordinary date-in-the-middle form', () => {
  const result = parsed('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB', ['Anal Only', 'Brazzers']);
  assert.equal(result.identityKey, 'brazzers:2023-04-15:alex-coal');
  assert.equal(result.display.title, 'Alex Coal');
});

test('changing the site list changes the path but never merges two scenes', () => {
  // The whole pre-date run reaches the key either way, so moving the split
  // cannot make two different scenes collide — the property that makes the
  // fallback guess safe to ship.
  const withList = parsed(ANAL_ONLY, ['Anal Only']);
  const without = parsed(ANAL_ONLY);
  assert.notEqual(withList.identityKey, without.identityKey);

  const otherScene = 'Anal.Only.A.Different.Scene.2022.09.29.2160p';
  for (const sites of [undefined, ['Anal Only'], ['Anal']]) {
    assert.notEqual(parsed(ANAL_ONLY, sites).identityKey, parsed(otherScene, sites).identityKey);
  }
});

// --- Declining the shape -----------------------------------------------------

test('a single non-encode token after the date rules the shape out', () => {
  // "Bonus" is title material, so this is the ordinary form with a three-word
  // site — not a date-at-end name whose title is "Site Name Here". The two
  // readings disagree about the identity, which is why the shape test has to
  // be positive rather than a count.
  const result = parsed('Site.Name.Here.2022.09.29.Bonus.2160p', ['Site Name']);
  assert.equal(result.identityKey, 'site-name-here:2022-09-29:bonus');
  assert.equal(result.display.subtitle, 'Site Name Here');
  assert.equal(result.display.title, 'Bonus');
});

test('more after the date than before it rules the shape out', () => {
  // Every token after the date is encode information here, so only the count
  // separates this from the date-at-end shape.
  assert.equal(parseSceneRelease('Site.2022.09.29.1080p.MP4'), null);
});

test('the ordinary form is unaffected when its title is long and its encode short', () => {
  const result = parsed('Brazzers.23.04.15.A.Very.Long.Scene.Title.Here.XXX.1080p');
  assert.equal(result.display.subtitle, 'Brazzers');
  assert.equal(result.display.title, 'A Very Long Scene Title Here');
});

// --- No date at all ----------------------------------------------------------

const BRALESS = 'BralessForever.com.Emma.G.and.Rocky.Beach.Days.2160p';

test('a dateless release parses once its site is known', () => {
  const result = parsed(BRALESS, ['Braless Forever']);
  assert.equal(result.identityKey, 'braless-forever::emma-g-and-rocky-beach-days');
  assert.equal(result.display.subtitle, 'Braless Forever');
  assert.equal(result.display.title, 'Emma G and Rocky Beach Days');
});

test('a dateless release is refused while its site is unknown', () => {
  // No first-token fallback here, unlike the date-at-end shape. The date was
  // also the evidence that a name is a scene release at all.
  assert.equal(parseSceneRelease(BRALESS), null);
  assert.equal(parseSceneRelease(BRALESS, { sites: ['Vixen'] }), null);
});

test('an arbitrary release with the same shape stays refused', () => {
  // Site, then title, then encode — structurally identical to a dateless
  // scene. Only the site requirement separates them.
  for (const name of [
    'Some.Random.Movie.2023.1080p.BluRay-GRP',
    'Ubuntu.Desktop.Live.ISO.amd64',
    'Some.Band.Live.At.Wembley.1080p.WEB-DL',
  ]) {
    assert.equal(parseSceneRelease(name, { sites: ['Braless Forever', 'Brazzers'] }), null, name);
  }
});

test('a word-shaped trailing tag is now a group, and the listed ones still are not', () => {
  // Casing was abandoned as a signal, so -Ghost and -rartv parse. The cost is
  // that -Bonus does too, collating a bonus reel into the scene as a version.
  // What still holds is NON_GROUP_TERMS, and its job is the tags where merging
  // destroys something rather than merely annoying.
  const base = 'Site.23.04.15.Name.XXX.1080p.MP4';
  const reference = parsed(`${base}-WRB`).identityKey;

  for (const tag of ['Ghost', 'rartv', 'xpost', 'Rarbg', 'Bonus', 'bonus']) {
    assert.equal(parsed(`${base}-${tag}`).identityKey, reference, tag);
  }

  // Halves of one scene: merging these means picking one believing it whole.
  for (const [a, b] of [
    ['Part1', 'Part2'],
    ['CD1', 'CD2'],
    ['DISC1', 'DISC2'],
    ['PT1', 'PT2'],
  ]) {
    assert.equal(parseSceneRelease(`${base}-${a}`), null, a);
    assert.equal(parseSceneRelease(`${base}-${b}`), null, b);
  }

  // Different cuts of one scene, in any casing the list is matched against.
  for (const tag of ['UNCUT', 'Uncut', 'uncut', 'UNCENSORED', 'Directors', 'FRENCH']) {
    assert.equal(parseSceneRelease(`${base}-${tag}`), null, tag);
  }
});

test('a bare TLD after a confirmed site is part of the domain, not the title', () => {
  assert.equal(parsed(BRALESS, ['Braless Forever']).display.title, 'Emma G and Rocky Beach Days');
  assert.equal(
    parsed('Vixen.net.Kylie.Rocket.Page.Turner.2023.07.19.1080p', ['Vixen']).display.title,
    'Kylie Rocket Page Turner',
    'the same rule applies to the date-at-end shape',
  );
});

test('a TLD-shaped word is kept when no site was confirmed', () => {
  // The rule only ever runs behind a confirmation, which is what keeps it
  // away from `Bang.com - Alex Coal` and friends.
  const result = parsed('Site.Co.Star.Alex.Coal.2023.07.19.1080p');
  assert.equal(result.display.subtitle, 'Site');
  assert.equal(result.display.title, 'Co Star Alex Coal');
});

test('a dateless release keeps its quality and group', () => {
  const result = parsed('Brazzers.Alex.Coal.XXX.1080p.MP4-WRB', ['Brazzers']);
  assert.equal(result.identityKey, 'brazzers::alex-coal');
  assert.equal(result.quality.resolution, 1080);
  assert.equal(result.quality.releaseGroup, 'WRB');
  assert.equal(result.quality.extras?.['container'], 'mp4');
});

test('two encodes of one dateless scene collate; a dated one stays separate', () => {
  const sites = ['Brazzers'];
  const a = parsed('Brazzers.Alex.Coal.XXX.1080p.MP4-WRB', sites);
  const b = parsed('Brazzers.Alex.Coal.XXX.2160p.HEVC.MP4-GRP', sites);
  assert.equal(a.identityKey, b.identityKey);

  const dated = parsed('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB', sites);
  assert.notEqual(
    a.identityKey,
    dated.identityKey,
    'a dateless key cannot claim to be the same scene as a dated one',
  );
});

test('a dateless release carries no date rather than a blank one', () => {
  const result = parsed(BRALESS, ['Braless Forever']);
  assert.equal(result.display.date, undefined);
  assert.ok(
    !result.display.fields.some((field) => field.label === 'Date'),
    'an empty Date row would render as a gap in the UI',
  );
});

test('dateless names ask for a site lookup too', () => {
  const candidates = sceneSiteCandidates(BRALESS);
  assert.deepEqual(candidates?.queries, ['BralessForever com', 'BralessForever']);
  assert.ok(candidates?.prefixes.includes('BralessForever'));
});

test('a dateless name whose site is already configured asks for nothing', () => {
  assert.equal(sceneSiteCandidates(BRALESS, { sites: ['Braless Forever'] }), null);
});

test('a name with no encode section is still refused, date or not', () => {
  assert.equal(parseSceneRelease('Brazzers.Alex.Coal', { sites: ['Brazzers'] }), null);
});

test('a dateless name with nothing left for a title is refused', () => {
  assert.equal(parseSceneRelease('Brazzers.1080p.MP4-WRB', { sites: ['Brazzers'] }), null);
});

// --- Upscaled ----------------------------------------------------------------

test('Upscaled is consumed as encode information, not left in the title', () => {
  // Before it was known, this name parsed with "Upscaled" as its entire title
  // and the full pre-date run as its site — a successful-looking wrong answer.
  const result = parsed(ANAL_ONLY);
  assert.equal(result.display.title, 'Only Getting In Savannahs Booty Savannah Bond');
  assert.equal(result.quality.extras?.['upscaled'], true);
});

test('an upscale and the native release of one scene collate into the same group', () => {
  assert.equal(
    parsed(ANAL_ONLY).identityKey,
    parsed('Anal.Only.Getting.In.Savannahs.Booty.Savannah.Bond.2022.09.29.2160p').identityKey,
  );
});

test('a release with no upscale tag records no upscaled extra', () => {
  const result = parsed('Anal.Only.Getting.In.Savannahs.Booty.Savannah.Bond.2022.09.29.2160p');
  assert.equal(result.quality.extras?.['upscaled'], undefined);
});

test('an upscale ranks below the native release at the same resolution', () => {
  const native = scoreScene({ resolution: 2160 });
  const upscaled = scoreScene({ resolution: 2160, extras: { upscaled: true } });
  assert.ok(upscaled < native, `expected ${upscaled} < ${native}`);
});

test('an upscale still ranks above every lower resolution', () => {
  // The penalty has to be smaller than one resolution step, or a 2160p
  // upscale would lose to a 1080p native and the upgrade path would prefer
  // the smaller file.
  const upscaled2160 = scoreScene({ resolution: 2160, extras: { upscaled: true } });
  for (const resolution of [480, 540, 720, 1080, 1440]) {
    const lower = scoreScene({ resolution, source: 'remux', videoCodec: 'av1' });
    assert.ok(upscaled2160 > lower, `2160p upscale should beat a native ${resolution}p`);
  }
});

test('the upscale penalty outweighs every source and codec advantage', () => {
  // Otherwise an upscale in a preferred codec would displace a native file
  // through the upgrade path, which trashes the better copy.
  const bestUpscale = scoreScene({
    resolution: 2160,
    source: 'remux',
    videoCodec: 'av1',
    sizeBytes: 500_000_000_000,
    extras: { upscaled: true },
  });
  const worstNative = scoreScene({ resolution: 2160, source: 'cam', videoCodec: 'divx' });
  assert.ok(bestUpscale < worstNative, `expected ${bestUpscale} < ${worstNative}`);
});
