import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastRefusalReason, parseSceneRelease, sceneSiteCandidates } from '../src/parse.ts';
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
  assert.equal(result.identityKey, 'analonly:2022-09-29:getting-in-savannahs-booty-savannah-bond');
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

test('the configured spelling decides the directory but no longer the key', () => {
  // This test used to assert the opposite of its second half: `Anal Only` gave
  // `anal-only` and `ANALONLY` gave `analonly`, so re-spelling a site in config
  // — or having `learnSites` discover it mid-run — moved every scene's key.
  // Matching was already separator-insensitive; only the key was not. Now both
  // are, so the two spellings are one identity.
  const spaced = parsed(ANAL_ONLY, ['Anal Only']);
  const solid = parsed(ANAL_ONLY, ['ANALONLY']);
  assert.equal(spaced.identityKey.split(':')[0], 'analonly');
  assert.equal(solid.identityKey.split(':')[0], 'analonly');

  // What the configured spelling still decides is everything the user sees,
  // which is what the library path is rendered from — see `path-template.ts`.
  assert.equal(spaced.display.subtitle, 'Anal Only');
  assert.equal(solid.display.subtitle, 'ANALONLY');
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
  assert.equal(keys[0], 'bangbros:2026-08-03:chloe-upgrades-her-butt');
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
    'bangbros:2026-08-03:ass-parade-chloe-upgrades-her-butt-toy-to-chevalier-a-bbc-chloe-chevalier',
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
  assert.equal(result.identityKey, 'sitenamehere:2022-09-29:bonus');
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
  assert.equal(result.identityKey, 'bralessforever::emma-g-and-rocky-beach-days');
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

test('the resolution is an anchor: content before it, format and group after', () => {
  // The rule that makes the permissive trailing-tag test safe. Extra content
  // is named before the resolution, so it lands in the identity; only format
  // and a group tag follow the resolution, so a trailing tag can be taken as
  // a group without inspecting the word at all.
  const scene = parsed('Site.23.04.15.Name.XXX.1080p.MP4-WRB').identityKey;

  for (const word of ['Bonus', 'bonus', 'BTS', 'Extras', 'Deleted']) {
    const before = parsed(`Site.23.04.15.Name.${word}.XXX.1080p.MP4-WRB`);
    assert.notEqual(before.identityKey, scene, `${word} before the resolution is content`);
    assert.equal(before.identityKey, `site:2023-04-15:name-${word.toLowerCase()}`);

    const after = parsed(`Site.23.04.15.Name.XXX.1080p.MP4-${word}`);
    assert.equal(after.identityKey, scene, `${word} after the resolution is a group`);
    assert.equal(after.quality.releaseGroup, word);
  }
});

test('a group spelled to look like a word is still a group', () => {
  // B0NUS is a real group. No list of words can guard this position, which is
  // why the position itself is what decides.
  const result = parsed('Site.23.04.15.Name.XXX.1080p.MP4-B0NUS');
  assert.equal(result.identityKey, 'site:2023-04-15:name');
  assert.equal(result.quality.releaseGroup, 'B0NUS');
});

test('one group posting several cuts at one resolution collates them', () => {
  // Same scene, same resolution, different short trailing tags — they are
  // versions of one scene and belong on one shelf.
  const keys = ['WRB', 'WRBx2', 'a1b2c3', 'Zsex3i'].map(
    (tag) => parsed(`Site.23.04.15.Name.XXX.1080p.MP4-${tag}`).identityKey,
  );
  assert.equal(new Set(keys).size, 1, JSON.stringify(keys));
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

test('a dateless name with no encode section parses when the site is known', () => {
  // This used to be refused: no date and no encode meant no boundary at all.
  // A confirmed site supplies one, from the other end.
  const result = parsed('Brazzers.Alex.Coal', ['Brazzers']);
  assert.equal(result.identityKey, 'brazzers::alex-coal');
  assert.equal(result.display.title, 'Alex Coal');
  assert.equal(parseSceneRelease('Brazzers.Alex.Coal'), null, 'still needs the site');
});

test('a dateless name with nothing left for a title is refused', () => {
  assert.equal(parseSceneRelease('Brazzers.1080p.MP4-WRB', { sites: ['Brazzers'] }), null);
});

test('site matching sees every token up to the encode boundary, not just the ones the title keeps', () => {
  // Real corpus regression: `datelessPrefixTokens` once sliced `before` at
  // `titleEnd`, the vocabulary walk's own boundary. But `before` is not the
  // title here — `matchSitePrefix` and `sceneSiteCandidates` read it — so
  // trimming it at `titleEnd` only ever cost site matching tokens it needed.
  // `128825778` and `456239169` are both numeric ids the walk drops as suffix
  // vocabulary; a site name that happens to span them (as a per-performer
  // OnlyFans "site" can) must still be reachable.
  //
  // The site takes every token but the ids, so the ids are what is left to be
  // the title — see `titleEndOffsetAfterSite`. Sliced at `titleEnd` the site
  // could not match at all, and the name refused as
  // `no date, and the site is not in the known list`.
  const name = 'OF.E.Part1_Ekaterina.Enokaeva_.128825778_456239169_720p';
  const result = parsed(name, ['OF E Part1 Ekaterina Enokaeva']);
  assert.equal(result.display.subtitle, 'OF E Part1 Ekaterina Enokaeva');
  assert.equal(result.display.title, '128825778 456239169');
  assert.equal(parseSceneRelease(name), null, 'and it still needs the site to be known');
  assert.equal(lastRefusalReason(), 'no date, and the site is not in the known list');
});

test('the dateless shape drops its suffix too, which is this feature\'s own example', () => {
  // `parseDatelessForm` bounded the title at `name.length - prefix.tail.length`
  // — the *encode* boundary — so `titleEnd` was computed and thrown away, and
  // this name came back as `Hiyori Suzuki Solo 42466` on this branch and on its
  // base. Both indices are carried now, and this shape reads the right one.
  const result = parsed('TripForFuck.Hiyori.Suzuki.Solo.42466.1080p.MP4-WRB', ['TripForFuck']);
  assert.equal(result.identityKey, 'tripforfuck::hiyori-suzuki');
  assert.equal(result.display.title, 'Hiyori Suzuki');
  assert.equal(result.quality.resolution, 1080, 'the encode still comes from the encode boundary');
  assert.equal(result.quality.releaseGroup, 'WRB');
});

test('two dateless scenes differing only in dropped tokens collate, as the dated ones do', () => {
  // What the line above costs, and the same accepted class. A dateless key
  // already carries an empty date segment and this shape already over-collates
  // by design; trimming the id widens that. Pinned so the widening is on record
  // rather than a surprise.
  const sites = ['TripForFuck'];
  assert.equal(
    parsed('TripForFuck.Hiyori.Suzuki.Solo.42466.1080p.MP4-WRB', sites).identityKey,
    parsed('TripForFuck.Hiyori.Suzuki.Solo.42467.1080p.MP4-WRB', sites).identityKey,
  );
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

// --- Interlaced --------------------------------------------------------------

test('an interlaced encode is recorded and ranks below progressive', () => {
  const result = parsed('Pantyhosed4U.16.07.20.Heidi.Bush.Tease.XXX.1080i.MP4-KTR');
  assert.equal(result.quality.resolution, 1080, '1080i still claims 1080');
  assert.equal(result.quality.extras?.['interlaced'], true);

  const progressive = scoreScene({ resolution: 1080 });
  const interlaced = scoreScene({ resolution: 1080, extras: { interlaced: true } });
  assert.ok(interlaced < progressive, `expected ${interlaced} < ${progressive}`);
});

test('an interlaced encode still beats a lower progressive resolution', () => {
  const interlaced1080 = scoreScene({ resolution: 1080, extras: { interlaced: true } });
  for (const resolution of [480, 540, 720]) {
    assert.ok(interlaced1080 > scoreScene({ resolution, source: 'remux', videoCodec: 'av1' }));
  }
});

test('upscaled and interlaced penalties add rather than collapse', () => {
  const both = scoreScene({ resolution: 2160, extras: { upscaled: true, interlaced: true } });
  const upscaledOnly = scoreScene({ resolution: 2160, extras: { upscaled: true } });
  const interlacedOnly = scoreScene({ resolution: 2160, extras: { interlaced: true } });
  assert.ok(both < upscaledOnly && both < interlacedOnly);
  assert.ok(both > scoreScene({ resolution: 1440 }), 'still beats a lower resolution');
});

test('a progressive encode records no interlaced extra', () => {
  const result = parsed('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  assert.equal(result.quality.extras?.['interlaced'], undefined);
});

// --- Not video ---------------------------------------------------------------

test('an image set is refused rather than collated with the scene it depicts', () => {
  // These carry a date, site and title and parse cleanly on shape alone. Left
  // to do so, a zip of photographs becomes one of the video's "versions" and
  // the user can pick it; planSceneImport then refuses the download long
  // after the choice was made.
  for (const name of [
    '21Sextreme.com_17.01.13.Emily.Thorne.Wreckless.In.The.Rec.Room.XXX.IMAGESET-FuGLi',
    'BigTitsAtSchool.com_16.12.12.Brenna.Sparks.Bunk.Bed.XXX.iMAGESET-YAPG',
    'Site.23.04.15.Alex.Coal.XXX.PHOTOSET-G',
  ]) {
    assert.equal(parseSceneRelease(name), null, name);
  }
});

test('the XXX marker ends the title even when nothing after it is encode', () => {
  const result = parsed('Site.23.04.15.Alex.Coal.XXX.SomeTrailingJunk');
  assert.equal(result.identityKey, 'site:2023-04-15:alex-coal');
  assert.equal(result.display.title, 'Alex Coal');
});

// --- Indexer noise around a good name ----------------------------------------

test("an indexer's trailing runtime stamp is stripped", () => {
  // It sits behind the group tag, so the encode run stops reaching the end
  // and the whole name is refused over three characters of metadata.
  const result = parsed('Bang.Surprise.19.10.29.Katya.Rodriguez.XXX.1080p.MP4-KTR [06:32:12]');
  assert.equal(result.identityKey, 'bangsurprise:2019-10-29:katya-rodriguez');
  assert.equal(result.quality.releaseGroup, 'KTR');
  assert.equal(
    result.identityKey,
    parsed('Bang.Surprise.19.10.29.Katya.Rodriguez.XXX.1080p.MP4-KTR').identityKey,
    'with and without the stamp must be one scene',
  );
});

test('bracketed text is only stripped when it is a runtime stamp', () => {
  // The delimited form depends on `[Vixen] ...` surviving.
  const result = parsed('[Vixen] Alex Coal - Beautiful Episode - 2023-07-19');
  assert.equal(result.display.subtitle, 'Vixen');
});

test('the delimited form does not run the vocabulary walk, so a dropped token cannot collide two scenes', () => {
  // `splitSegment` deliberately keeps the single, unsplit
  // `findEncodeSuffixStart` cut rather than `findTitleBoundary` — a part's
  // title here has no fixed order, so a trailing content-type tag or numeric
  // id is not reliably suffix the way it is in the dotted form. Running the
  // walk here once let it consume an entire part: `Hardcore` is itself a
  // content-type term, so the walk crossed it and the numeric id behind it,
  // and `Hardcore 42466 1080p` / `Hardcore 42467 1080p` both collapsed to
  // nothing, losing the whole part that distinguished the two scenes.
  //
  // The four-digit year is load-bearing, not incidental: it is what routes the
  // name through the delimited parser (`YMD_PATTERN`/`DMY_PATTERN`) rather than
  // the dotted form's date-at-end shape. What is excluded from the walk is this
  // code path, not the listing shape — see the two-digit-year test below.
  const a = parsed('[Site] Alex - Hardcore 42466 1080p - 2026-08-05');
  const b = parsed('[Site] Alex - Hardcore 42467 1080p - 2026-08-05');
  assert.notEqual(
    a.identityKey,
    b.identityKey,
    'two distinct scenes must never share an identity key',
  );
});

test('the same listing with a two-digit year is not a listing to the parser, and does run the walk', () => {
  // `26.08.05` matches `DOTTED_DATE_RUN`, so the delimited reader declines and
  // the date-at-end shape reads it — where the walk does run and does drop
  // `Hardcore` and the id, so these two parts collapse onto one key. Same
  // scenes, same names, one character of date format apart, opposite outcome
  // from the test above.
  //
  // That collision is inside the class `docs/known-issues.md` accepts: one
  // site, one date, titles differing only in dropped tokens. It is pinned here
  // because the comment in `splitSegment` used to read as though the listing
  // shape itself were excluded, and this is the counter-example.
  const a = parsed('[Site] Alex - Hardcore 42466 1080p - 26.08.05');
  const b = parsed('[Site] Alex - Hardcore 42467 1080p - 26.08.05');
  assert.equal(a.identityKey, 'site:2026-08-05:alex');
  assert.equal(a.identityKey, b.identityKey);
});

test('a hyphen-attached group inside a quality segment is a group, not title text', () => {
  // `- 1080p-GRP -` is quality material with the group stuck on the end of it,
  // and the segment carries no encode cut of its own: the backward walk in
  // `findEncodeSuffixStart` stops immediately on `GRP`, which is not encode
  // vocabulary. So the whole segment used to survive into `titleParts` — the
  // resolution never reached `extractQuality` and a group tag sat in the
  // identity key, which read `site:2023-07-19:1080p-grp--alex-coal--deep`.
  const result = parsed('[Site] Alex Coal - Deep - 1080p-GRP - 2023-07-19');
  assert.equal(result.identityKey, 'site:2023-07-19:alex-coal--deep');
  assert.equal(result.display.title, 'Alex Coal - Deep');
  assert.equal(result.quality.resolution, 1080);
  assert.equal(result.quality.releaseGroup, 'GRP');
});

test('a listing collates with and without the group stamped on its quality segment', () => {
  // The collation the defect broke, and the reason it matters: two encodes of
  // one scene, one of them carrying the group that made it, are one scene.
  assert.equal(
    parsed('[Site] Alex Coal - Deep - 1080p-GRP - 2023-07-19').identityKey,
    parsed('[Site] Alex Coal - Deep - 1080p - 2023-07-19').identityKey,
    'with and without the group tag must be one scene',
  );
});

test('a hyphen inside a title segment stays punctuation, not a group separator', () => {
  // `detachReleaseGroup`'s hyphen branch is permissive on purpose —
  // `docs/known-issues.md` explains why no shape rule tells `-Throat` from
  // `-GRP` — so the detach above is accepted only when `findEncodeSuffixStart`
  // reads what is left as encode information from its very first token, which
  // is to say only when the segment contributed no title at all. `Deep` is
  // title material, so the detach is discarded here. This passes with or
  // without the gate; it is pinned so that widening the gate has to break a
  // test rather than quietly rename a scene.
  const result = parsed('[Site] Alex Coal - Deep-Throat - 1080p - 2023-07-19');
  assert.equal(result.display.title, 'Alex Coal - Deep-Throat');
  assert.equal(result.quality.releaseGroup, undefined);
});

test('VERTICAL and F4V are encode information, not title words', () => {
  assert.equal(
    parsed('FoxxedUp.23.07.19.Buns.And.Boobs.Joi.XXX.VERTICAL.XviD-iPT Team').identityKey,
    'foxxedup:2023-07-19:buns-and-boobs-joi',
  );
  const f4v = parsed('MyFirstSexTeacher.09.11.16.Darla.Crane.XXX.1080p.F4V-CuMBuCKeTS');
  assert.equal(f4v.identityKey, 'myfirstsexteacher:2009-11-16:darla-crane');
  assert.equal(f4v.quality.extras?.['container'], 'f4v');
});

// --- The date at the very end, with the encode before it ---------------------

test('a date at the very end parses, with the encode ahead of it', () => {
  // site _ performer _ title - resolution - date. The date-at-end reader wants
  // the encode *after* the date; here it comes first, so the same shape read
  // from the other side.
  const result = parsed('teensexmania_mishelle-klein_babe-loves-sperm-as-coffee-2160p-18.12.18');
  assert.equal(
    result.identityKey,
    'teensexmania:2018-12-18:mishelle-klein-babe-loves-sperm-as-coffee',
  );
  assert.equal(result.display.subtitle, 'teensexmania');
  assert.equal(result.quality.resolution, 2160, 'the encode still has to be read');
});

test('the encode before a trailing date is not left in the title', () => {
  const result = parsed('hookuphotshot_della-cate_episode-411-2160p-25.01.31');
  assert.equal(result.display.title, 'della-cate episode-411');
  assert.equal(result.quality.resolution, 2160);
});

test('a trailing date works with dots as well as dashes', () => {
  const result = parsed(
    'Alterotic.Viviana.Rose.Ava.Holt.Enjoy.the.Sensual.Performance.2160p.23.07.26',
  );
  assert.equal(result.display.subtitle, 'Alterotic');
  assert.equal(result.identityKey.split(':')[1], '2023-07-26');
});

test('a configured site still splits a trailing-date name', () => {
  const result = parsed(
    'teensexmania_mishelle-klein_babe-loves-sperm-as-coffee-2160p-18.12.18',
    ['Teen Sex Mania'],
  );
  assert.equal(result.display.subtitle, 'Teen Sex Mania');
});

test('a trailing date with no encode before it is still refused', () => {
  // Nothing separates site from title *or* title from encode, so there is no
  // boundary to work from and guessing would truncate the title.
  assert.equal(parseSceneRelease('somesite_a-scene-title-18.12.18'), null);
});

// --- The two indices a trailing date needs -----------------------------------

test('a trailing-date title stops at the suffix, not at the end of the site-matching run', () => {
  // The plain statement of the rule in this shape: `Solo` is suffix here just
  // as it is after a leading date, so it leaves the title even though the
  // encode section — and therefore the run `matchSitePrefix` reads — extends
  // past it.
  const result = parsed('ClubSweethearts.Remido.Solo.1080p.18.12.18');
  assert.equal(result.identityKey, 'clubsweethearts:2018-12-18:remido');
  assert.equal(result.quality.resolution, 1080, 'the encode is still read from the boundary');
});

test('a trailing-date site is looked up across the tokens the walk dropped', () => {
  // Corpus regression, the trailing-date twin of the dateless one below.
  // `before` is what `matchSitePrefix` and `sceneSiteCandidates` read, and it
  // once stopped at `titleEnd` — so a site spanning a dropped numeric id was
  // neither askable nor matchable. `Bang Bros` is two tokens; the queries are
  // built from `before`, so this is `before` reaching the encode boundary.
  const candidates = sceneSiteCandidates('Bang.Bros.42466.1080p.18.12.18');
  assert.deepEqual(candidates?.queries, ['Bang Bros', 'Bang']);
});

test('a trailing-date site that matches past the suffix takes the site, not the first word', () => {
  // What the slice above cost: `matchSitePrefix` never consumes every token it
  // is given, so with `before` cut to `[Bang, Bros]` the two-token site could
  // not match at all and the site silently degraded to `Bang` with `Bros` — a
  // word of the site's own name — as the title. Both of these then keyed as
  // `bang:2018-12-18:bros`: two different scenes on one key, and a configured
  // site split across two library directories.
  //
  // With the site matched, what follows it is nothing but the suffix, so the
  // suffix *is* the title — see `titleEndOffsetAfterSite`. A bare id is a poor
  // thing to ask a metadata service and a perfectly good identity, and it keeps
  // these two scenes apart.
  const a = parsed('Bang.Bros.42466.1080p.18.12.18', ['Bang Bros']);
  const b = parsed('Bang.Bros.Hardcore.1080p.18.12.18', ['Bang Bros']);
  assert.equal(a.display.subtitle, 'Bang Bros');
  assert.equal(b.display.subtitle, 'Bang Bros');
  assert.equal(a.identityKey, 'bangbros:2018-12-18:42466');
  assert.equal(b.identityKey, 'bangbros:2018-12-18:hardcore');
});

test('with the site unconfigured the two collide, which is the accepted class and not the site defect', () => {
  // Unconfigured, the site is the first-token guess, so it is `Bang` for both
  // and the titles differ only in the tokens the walk drops. That is exactly
  // the over-collation `docs/known-issues.md` accepts — one site, one date,
  // nothing but dropped tokens between them — and it is a different failure
  // from the one above, where the site itself was wrong. Pinned rather than
  // guarded so a change here surfaces as a failing test.
  const a = parsed('Bang.Bros.42466.1080p.18.12.18');
  const b = parsed('Bang.Bros.Hardcore.1080p.18.12.18');
  assert.equal(a.display.subtitle, 'Bang');
  assert.equal(b.display.subtitle, 'Bang');
  assert.equal(a.identityKey, b.identityKey);
});

test('a trailing-date name keeps the title the walk leaves, with the site matched across the rest', () => {
  // Both indices doing their separate jobs on one name: `Bang Bros` is matched
  // out of a `before` that runs to the encode boundary, and the title stops at
  // `Alex Coal` rather than carrying the `Hardcore 42466` that `before` still
  // holds.
  const result = parsed('Bang.Bros.Alex.Coal.Hardcore.42466.1080p.18.12.18', ['Bang Bros']);
  assert.equal(result.identityKey, 'bangbros:2018-12-18:alex-coal');
  assert.equal(result.display.subtitle, 'Bang Bros');
  assert.equal(result.display.title, 'Alex Coal');
});

test('the trailing-date and dateless readings of one name agree', () => {
  // The real corpus name the dateless test above was written for, with a
  // trailing date added. Two different code paths reading the same site and the
  // same title, and they used to disagree: the dated one read the site as `OF`
  // because its `before` was cut at `titleEnd`, while the dateless one read the
  // whole configured site. Now both read the site, and both keep the id run as
  // the title because the site leaves nothing else.
  const sites = ['OF E Part1 Ekaterina Enokaeva'];
  const dated = parsed('OF.E.Part1_Ekaterina.Enokaeva_.128825778_456239169_720p-18.12.18', sites);
  const dateless = parsed('OF.E.Part1_Ekaterina.Enokaeva_.128825778_456239169_720p', sites);
  assert.equal(dated.display.subtitle, 'OF E Part1 Ekaterina Enokaeva');
  assert.equal(dated.display.title, dateless.display.title);
  assert.equal(dated.identityKey, 'ofepart1ekaterinaenokaeva:2018-12-18:128825778-456239169');
  assert.equal(dateless.identityKey, 'ofepart1ekaterinaenokaeva::128825778-456239169');

  // Unconfigured the site is a guess of one token, so the walk leaves a title
  // and the ids go.
  assert.equal(
    parsed('OF.E.Part1_Ekaterina.Enokaeva_.128825778_456239169_720p-18.12.18').display.title,
    'E Part1 Ekaterina Enokaeva',
  );
});

test('the whole suffix run survives when the site leaves nothing else, not just one token of it', () => {
  // Two real corpus posts from one OnlyFans "site" whose *first* id is shared
  // and whose second is not. Keeping one token of the suffix — the tidy reading
  // of "the title may not end before the site does" — collapses both onto
  // `ofepart1ekaterinaenokaeva::128825778`, which is two distinct scenes on one
  // identity key: the failure this parser must never produce. Keeping the whole
  // run costs a longer title and keeps them apart.
  const sites = ['OF E Part1 Ekaterina Enokaeva'];
  const a = parsed('OF.E.Part1_Ekaterina.Enokaeva_.128825778_456239169_720p', sites);
  const b = parsed('OF.E.Part1_Ekaterina.Enokaeva_.128825778_456239173_480p', sites);
  assert.equal(a.display.title, '128825778 456239169');
  assert.equal(b.display.title, '128825778 456239173');
  assert.notEqual(a.identityKey, b.identityKey);
});

test('a date with the encode behind it keeps its suffix, which is an asymmetry on purpose', () => {
  // The other branch of this shape — date near the end, encode *after* it — has
  // no suffix run between the title and the date, so no walk runs and nothing is
  // trimmed at all. Behind a *leading* date the same tokens do reach the walk,
  // and `42466` goes; `Solo` survives there only because `minIndex: 1` floors
  // the walk one token in, not because the vocabulary spared it. Where the date
  // sits decides how much is trimmed. The reason the first is left alone is in
  // `dateAtEndPrefixTokens`: recognising the suffix there would mean recognising
  // it with no encode run adjacent, which is the guessing the inverted boundary
  // search removed. Pinned so the inconsistency is visible rather than lurking.
  const behind = parsed('Bang.Bros.Solo.42466.18.12.18.1080p.MP4-WRB', ['Bang Bros']);
  assert.equal(behind.identityKey, 'bangbros:2018-12-18:solo-42466');
  const leading = parsed('Bang.Bros.18.12.18.Solo.42466.1080p.MP4-WRB', ['Bang Bros']);
  assert.equal(leading.identityKey, 'bangbros:2018-12-18:solo');
});

test('a title made only of suffix vocabulary is kept rather than refused', () => {
  // Real corpus name, and the plainest case of the rule: with `Ex Appeal`
  // configured, everything after the site is a language tag. `FRENCH` is a poor
  // title and an honest one — nothing is invented — and a refusal here is a
  // release the user has to repair by hand. `clubseventeen ...` is the same
  // shape with a trailing date and a content-type tag instead.
  assert.equal(parsed('Ex.Appeal.FRENCH.XXX.2160p.WEBRip.MP4-COCKiNE', ['Ex Appeal']).display.title, 'FRENCH');
  const dated = parsed('clubseventeen_tiny-teen,eva-elfie_solo-2160p-19.05.08', [
    'clubseventeen tiny teen,eva elfie',
  ]);
  assert.equal(dated.display.subtitle, 'clubseventeen tiny teen,eva elfie');
  assert.equal(dated.display.title, 'solo');
});

// --- Day-first dates with a four-digit year ----------------------------------

test('a DD.MM.YYYY date is read day-first', () => {
  // The dotted reader knew YY.MM.DD and YYYY.MM.DD but not day-first with a
  // four-digit year, which European sites use.
  const result = parsed('WoodmanCastingX.com.Kendra.Star.19.04.2014.2160p');
  assert.equal(result.identityKey.split(':')[1], '2014-04-19');
  // The `.com` only leaves the title once the site is confirmed, since the
  // TLD rule deliberately runs behind a confirmation and nothing else.
  assert.equal(
    parsed('WoodmanCastingX.com.Kendra.Star.19.04.2014.2160p', ['Woodman Casting X']).display.title,
    'Kendra Star',
  );
});

test('day-first is the convention even when the day could be a month', () => {
  // 04.08.2026 is 4 August, not 8 April. Ambiguous by construction; the
  // delimited reader already resolves it this way, so both agree.
  assert.equal(
    parsed('LadyboyGold.Lita.Yellow.Pantie.Party.04.08.2026.2160p').identityKey.split(':')[1],
    '2026-08-04',
  );
});

test('an existing date shape is unaffected by the day-first rule', () => {
  // Checked because findSceneDate takes the first valid date it finds, so a
  // new pattern can quietly capture a position an older one used to.
  const pairs: [string, string][] = [
    ['Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB', '2023-04-15'],
    ['Brazzers.2023.04.15.Alex.Coal.XXX.1080p.MP4-WRB', '2023-04-15'],
    ['Blacked.20180428.Alex.Coal.XXX.1080p.MP4-KTR', '2018-04-28'],
    ['Blacked.180428.Alex.Coal.XXX.1080p.MP4-KTR', '2018-04-28'],
  ];
  for (const [name, iso] of pairs) {
    assert.equal(parsed(name).identityKey.split(':')[1], iso, name);
  }
});

test('a day-first date that is not a calendar date is still refused', () => {
  assert.equal(parseSceneRelease('Site.32.04.2014.Name.XXX.1080p.MP4-G'), null);
  assert.equal(parseSceneRelease('Site.30.02.2014.Name.XXX.1080p.MP4-G'), null);
});

// --- A four-digit year repeated after a YY.MM.DD date ------------------------

test('a year repeated after the short date is not left in the title', () => {
  // ManyVids.26.08.02.2026.August.Heat.2 states the year twice. The year-first
  // reader stopped after DD, so 2026 became the first word of the identity —
  // parsing, but wrong, and the same scene posted without the repeat would key
  // differently.
  const result = parsed('ManyVids.26.08.02.2026.August.Heat.2.XXX.1080p.MP4-P0RNL0V3R');
  assert.equal(result.identityKey, 'manyvids:2026-08-02:august-heat-2');
  assert.equal(result.display.title, 'August Heat 2');
});

test('the repeat is only swallowed when it agrees with the short date', () => {
  // A year that is not the date's year is title material, not a restatement.
  const result = parsed('Site.26.08.02.1999.Party.Classics.XXX.1080p.MP4-G');
  assert.equal(result.identityKey, 'site:2026-08-02:1999-party-classics');
});

test('with and without the repeated year are one scene', () => {
  assert.equal(
    parsed('ManyVids.26.07.26.2026.Ruth.Lee.XXX.1080p.MP4-P0RNL0V3R').identityKey,
    parsed('ManyVids.26.07.26.Ruth.Lee.XXX.1080p.MP4-P0RNL0V3R').identityKey,
  );
});

// --- Poster signatures -------------------------------------------------------

test("a poster's trailing signature is stripped", () => {
  const result = parsed('WoodmanCastingX.com.Kendra.Star.19.04.2014._2160p_iris2_by_cdrw69');
  assert.equal(result.identityKey.split(':')[1], '2014-04-19');
  assert.equal(result.quality.resolution, 2160, 'the encode ahead of it still reads');
});

test('a signature is only stripped at the end', () => {
  // "by am" mid-title is ordinary words.
  const result = parsed('Site.23.04.15.Stand.by.am.Friend.XXX.1080p.MP4-G');
  assert.equal(result.display.title, 'Stand by am Friend');
});

// --- A confirmed site replaces the encode boundary ---------------------------

test('a dateless name with no encode section parses once its site is known', () => {
  // TripForFuck - Hiyori JAPANESE 2 has no date and no encode vocabulary at
  // all, so there was no boundary to work from. A confirmed site is the
  // boundary: everything after it is the title.
  const result = parsed('TripForFuck - Hiyori JAPANESE 2', ['Trip For Fuck']);
  assert.equal(result.identityKey, 'tripforfuck::hiyori-japanese-2');
  assert.equal(result.display.subtitle, 'Trip For Fuck');
  assert.equal(result.display.title, 'Hiyori JAPANESE 2');
});

test('the no-boundary path keeps its whole remainder, suffix vocabulary and all', () => {
  // The one path with no encode boundary at all, and therefore no title bound
  // to compute: the walk is deliberately not run here. What licenses it
  // elsewhere is adjacency to a *recognised* encode section — that is the
  // evidence the tokens it crosses are metadata — and there is none here, which
  // is what brought the name to this path. `Hiyori JAPANESE` keeps its tag for
  // the same reason a dated name with no encode vocabulary keeps its whole
  // remainder. If the walk is ever extended here this becomes `Hiyori`, and
  // that must be a decision with a measurement behind it, not a side effect.
  const result = parsed('TripForFuck - Hiyori JAPANESE', ['Trip For Fuck']);
  assert.equal(result.display.title, 'Hiyori JAPANESE');
  assert.equal(result.identityKey, 'tripforfuck::hiyori-japanese');
});

test('two episodes of one dateless site stay separate', () => {
  const sites = ['Trip For Fuck'];
  assert.notEqual(
    parsed('TripForFuck - Hiyori JAPANESE 2', sites).identityKey,
    parsed('TripForFuck - Hiyori JAPANESE 3', sites).identityKey,
  );
});

test('the site still has to be confirmed, boundary or not', () => {
  assert.equal(parseSceneRelease('TripForFuck - Hiyori JAPANESE 2'), null);
  assert.equal(parseSceneRelease('Some.Random.Thing.With.No.Site', { sites: ['Trip For Fuck'] }), null);
});

test('a dateless name with an encode section still strips it', () => {
  // The encode path is tried first; the site-only path is the fallback.
  const result = parsed('BralessForever.com.Emma.G.Beach.Days.2160p', ['Braless Forever']);
  assert.equal(result.identityKey, 'bralessforever::emma-g-beach-days');
  assert.equal(result.quality.resolution, 2160);
});

test('a dateless name asks for a site lookup even with no encode boundary', () => {
  const candidates = sceneSiteCandidates('TripForFuck - Hiyori JAPANESE 2');
  assert.deepEqual(candidates?.queries, ['TripForFuck Hiyori', 'TripForFuck']);
});

// --- The bare-4K poster -------------------------------------------------------

test('a name that opens with a bare 4K is filed under the site it comes from', () => {
  const result = parsed('4K.kleo.34ans.de.clapiers');
  assert.equal(result.identityKey, 'jacquieetmicheltv::kleo-34ans-de-clapiers');
  assert.equal(result.display.title, 'kleo 34ans de clapiers');
  assert.equal(result.quality.resolution, 2160, 'the 4K is still the resolution');
});

test('the bare-4K poster shares a directory with that site\'s named releases', () => {
  // The whole point of naming the real site rather than inventing a bucket.
  const bare = parsed('4K.kleo.34ans.de.clapiers');
  const named = parsed('JacquieEtMichelTV.26.06.02.Lena.XXX.2160p.MP4-NABL0G');
  assert.equal(bare.identityKey.split(':')[0], named.identityKey.split(':')[0]);
});

test('a configured spelling wins, so the two never split apart', () => {
  const sites = ['Jacquie Et Michel TV'];
  const bare = parsed('4K.kleo.34ans.de.clapiers', sites);
  const named = parsed('JacquieEtMichelTV.26.06.02.Lena.XXX.2160p.MP4-NABL0G', sites);
  assert.equal(bare.display.subtitle, 'Jacquie Et Michel TV');
  assert.equal(bare.identityKey.split(':')[0], named.identityKey.split(':')[0]);
});

test('two of that poster stay separate', () => {
  assert.notEqual(
    parsed('4K.ruby.24ans.de.nimes').identityKey,
    parsed('4K.ruby.rossini.30ans.de.rouen').identityKey,
  );
});

test('a leading 4K only counts at the very start', () => {
  // 4K appears mid-name constantly and Tiny4K is a real site. Neither of
  // these may be swept into the poster's bucket, whether they parse or not:
  // TINY.4K.DAKOTA.BLUE.14.12.2017 is refused for its own reason — its 4K is
  // mid-name, so there is no encode *suffix* to cut at.
  assert.equal(parseSceneRelease('TINY.4K.DAKOTA.BLUE.14.12.2017'), null);
  assert.equal(parsed('Brazzers.23.04.15.Alex.Coal.XXX.4K.MP4-WRB').display.subtitle, 'Brazzers');
});

test('the bare-4K poster is never looked up', () => {
  assert.equal(sceneSiteCandidates('4K.kleo.34ans.de.clapiers'), null);
});

test('a configured spelling reaches every shape, not just the ones that look sites up', () => {
  // The dated form takes its site verbatim from the text and never consulted
  // the list, so configuring a site split it in two: dated releases under one
  // slug, date-at-end and dateless ones under another.
  const sites = ['Jacquie Et Michel TV'];
  const keys = [
    'JacquieEtMichelTV.26.06.02.Lena.XXX.2160p.MP4-NABL0G',
    'JacquieEtMichelTV.Fanny.Double.Jump.2026.07.29.1080p',
    '4K.kleo.34ans.de.clapiers',
  ].map((name) => parsed(name, sites).identityKey.split(':')[0]);
  assert.equal(new Set(keys).size, 1, JSON.stringify(keys));
  assert.equal(keys[0], 'jacquieetmicheltv');
});

test('a bare-domain-led listing still asks for no site lookup', () => {
  // `sceneSiteCandidates` declines on anything `parseDelimitedForm` accepts,
  // and stripping the stamp leaves a listing, so the answer is `null` with the
  // site list and without it. It has to be: the candidate list is generated
  // from the same stripped name the parser reads, and a list built from a
  // differently-stripped name would ask for prefixes the parser can never use.
  const name = 'pornsite.net - Vixen - Alex Coal - Deep - 2023-07-19';
  assert.equal(sceneSiteCandidates(name), null);
  assert.equal(sceneSiteCandidates(name, { sites: ['Vixen'] }), null);
});

test('the delimited form canonicalises its site too', () => {
  assert.equal(
    parsed('[Vixen] Alex Coal - Beautiful Episode - 2023-07-19', ['VIXEN']).display.subtitle,
    'VIXEN',
  );
});
