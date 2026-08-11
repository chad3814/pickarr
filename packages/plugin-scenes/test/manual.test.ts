import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ManualField, ParsedRelease } from '@pickarr/plugin-api';
import {
  canonicalSiteName,
  parseSceneRelease,
  sceneSlugFromParts,
  siteComparisonKey,
} from '../src/parse.ts';
import createScenesPlugin from '../src/index.ts';
import {
  sceneManualFields,
  sceneFromManualValues,
  sceneToManualValues,
  sceneSuggestManualValues,
} from '../src/manual.ts';

// 'Trip For Fuck' must be here: the dateless shape has no first-token
// fallback, so without it that name parses to null and the loop below fails
// before it has tested anything.
const OPTIONS = { sites: ['Bang Bros', 'Brazzers', 'Trip For Fuck'] };

// A second view of the world for the checks that must hold under any of them.
// `learnSites` grows the site list from the metadata service on every feed
// batch, so the list a prefill is built against is routinely not the one the
// release was parsed under — and a check run against a single list cannot tell
// a value read off the identity key from one copied out of the display.
// `In The Crack` is the interesting entry: it canonicalises the release's own
// `InTheCrack` to a spelling that *slugs* differently. That no longer moves the
// key — the key's site segment deletes separators — which is the point: the
// prefill has to keep working under a list that re-spells a site, and now it
// does so without the fallback firing.
const MORE_OPTIONS = {
  sites: [...OPTIONS.sites, 'Vixen', 'In The Crack', 'Swallowed', 'Blacked', 'Site'],
};
const SITE_LISTS = [OPTIONS, MORE_OPTIONS];

// One name per shape the parser can produce a key with, so the round trip is
// exercised against every way an identity key gets built.
const NAMES = [
  'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
  'InTheCrack.E1178.Tracy.Gold.XXX.2160p.MP4-KTR',
  'Bangbros.Chloe.Upgrades.her.Butt.2026.08.03.2160p.MP4-WRB',
  'TripForFuck - Hiyori JAPANESE 2',
  '[Vixen] Kylie - Page Turner - 2023-07-19',
  'Swallowed.26.08.06.Skyler.Nicole.XXX.1080p.MP4-P0RNL0V3R',
  // The shape that makes `titleOrder` necessary: display title 'Alex - Coal',
  // scene slug 'alex-coal' with no component boundary. Split it and the
  // release is silently re-keyed to 'coal--alex'.
  'Site.23.04.15.Alex.-.Coal.XXX.1080p.MP4-WRB',

  // The names above between them carry only container, resolution and
  // releaseGroup, so the remaining quality fields could be deleted from the
  // schema without a test noticing — and every human edit would then drop
  // them. One name per uncovered token:
  'Site.23.04.15.Alex.Coal.XXX.VR.2160p.MKX200.MP4-VRP', // extras.vr
  'Site.23.04.15.Alex.Coal.XXX.4K.UPSCALED.MP4-AI', // extras.upscaled
  'Site.23.04.15.Alex.Coal.XXX.1080i.WMV-GRP', // extras.interlaced
  'Site.23.04.15.Alex.Coal.XXX.720p.WEB-DL.H264.MP4-KTR', // source + videoCodec
  // Source order reversed against its sorted key `vixen:2023-07-19:alpha--zoe`;
  // the Kylie name above has both parts already alphabetical. Asserted
  // absolutely in the next test, not here — see the note there.
  '[Vixen] Zoe - Alpha - 2023-07-19',

  // A listing part carrying the part separator *inside* it. `prettify` turns
  // `.-.` and `_-_` into ` - `, so before `collapsePartSeparator` these two
  // rendered the display title `Kylie - Page - Turner` — byte-identical to the
  // three-part `[Vixen] Kylie - Page - Turner - 2023-07-19` above it, which is
  // a different scene with a different key. The round trip splits that title
  // back into parts, so it recovered the *other* scene's multiset and a no-op
  // save re-keyed the group onto it. Both separators are here because they
  // reach `prettify` by different characters, and the second also puts the
  // collision in a non-leading part.
  '[Vixen] Kylie.-.Page - Turner - 2023-07-19',
  '[Blacked] Zoe_-_Alpha - Beta Gamma - 2023-07-19',
];

test('values taken from a parsed release rebuild that release exactly', () => {
  // The property that keeps a hand-edited scene in the same group, and on the
  // same library path, as its parsed siblings.
  for (const name of NAMES) {
    const parsed = parseSceneRelease(name, OPTIONS);
    assert.ok(parsed !== null, name);

    const rebuilt = sceneFromManualValues(sceneToManualValues(parsed, OPTIONS), OPTIONS);
    assert.ok('media' in rebuilt, `${name}: ${'error' in rebuilt ? rebuilt.error : ''}`);
    assert.deepEqual(rebuilt.media, parsed, name);
  }
});

test('title order is read off the key, not guessed from punctuation', () => {
  const listing = parseSceneRelease('[Vixen] Kylie - Page Turner - 2023-07-19', OPTIONS);
  const dotted = parseSceneRelease('Site.23.04.15.Alex.-.Coal.XXX.1080p.MP4-WRB', OPTIONS);
  assert.ok(listing !== null && dotted !== null);

  assert.equal(sceneToManualValues(listing, OPTIONS)['titleOrder'], 'any');
  assert.equal(sceneToManualValues(dotted, OPTIONS)['titleOrder'], 'fixed');
  assert.ok(listing.identityKey.includes('--'));
  assert.ok(!dotted.identityKey.includes('--'));
});

test('a reordered title rebuilds the same sorted key, not merely a matching one', () => {
  // Absolute keys, because the round-trip test above structurally cannot pin
  // the sort or the `--` boundary: both directions now go through the parser's
  // one `sceneSlugFromParts`, so a change to it moves parse and rebuild
  // together and `deepEqual` still holds. Deduplicating the helper is right —
  // it is what keeps a hand-entered release in its parsed siblings' group —
  // but it costs the redundancy a round trip was implicitly checking, so the
  // expected string has to be written down somewhere. Here.
  const reversed = parseSceneRelease('[Vixen] Zoe - Alpha - 2023-07-19', OPTIONS);
  assert.ok(reversed !== null);
  assert.equal(reversed.identityKey, 'vixen:2023-07-19:alpha--zoe');
  assert.equal(reversed.display.title, 'Zoe - Alpha');

  const rebuilt = sceneFromManualValues(sceneToManualValues(reversed, OPTIONS), OPTIONS);
  assert.ok('media' in rebuilt);
  assert.equal(rebuilt.media.identityKey, 'vixen:2023-07-19:alpha--zoe');

  // And a human typing the other order reaches the same group.
  const typed = sceneFromManualValues(
    {
      site: 'Vixen',
      anchorKind: 'date',
      date: '2023-07-19',
      title: 'Alpha - Zoe',
      titleOrder: 'any',
    },
    OPTIONS,
  );
  assert.ok('media' in typed);
  assert.equal(typed.media.identityKey, 'vixen:2023-07-19:alpha--zoe');
});

test('a part containing the part separator keeps its own key through an edit', () => {
  // Absolute keys for the same reason the test above uses them: both
  // directions run through `sceneSlugFromParts`, so `deepEqual` on a round
  // trip moves with any change to it. What has to hold is that these two
  // remain *two* scenes.
  //
  // `display.title` is what the edit form is prefilled with and what
  // `sceneFromManualValues` splits back into parts, so the join has to be
  // injective on the parts. `prettify` broke that by rewriting `.-.` as ` - `
  // inside a part; `collapsePartSeparator` writes `Kylie-Page` instead, which
  // slugs identically and splits correctly.
  const inner = parseSceneRelease('[Vixen] Kylie.-.Page - Turner - 2023-07-19', OPTIONS);
  const outer = parseSceneRelease('[Vixen] Kylie - Page - Turner - 2023-07-19', OPTIONS);
  assert.ok(inner !== null && outer !== null);

  assert.equal(inner.identityKey, 'vixen:2023-07-19:kylie-page--turner');
  assert.equal(outer.identityKey, 'vixen:2023-07-19:kylie--page--turner');
  assert.equal(inner.display.title, 'Kylie-Page - Turner');
  assert.equal(outer.display.title, 'Kylie - Page - Turner');

  // The no-op save: the prefill, submitted with nothing changed.
  for (const parsed of [inner, outer]) {
    const rebuilt = sceneFromManualValues(sceneToManualValues(parsed, OPTIONS), OPTIONS);
    assert.ok('media' in rebuilt);
    assert.equal(rebuilt.media.identityKey, parsed.identityKey);
  }
});

test('a display stored by the pre-fix parser still rebuilds its own key', () => {
  // Hand-written rather than parsed, and that is the whole point: the parser
  // can no longer produce this pair, but `media_groups.display` is written
  // once by the first ingest and never rewritten, so rows written before
  // `collapsePartSeparator` landed still hold exactly this — a three-part
  // title beside a two-part key. Every other test in the suite seeds from the
  // fixed parser and so cannot see it.
  const stored: ParsedRelease = {
    identityKey: 'vixen:2023-07-19:kylie-page--turner',
    display: {
      title: 'Kylie - Page - Turner',
      subtitle: 'Vixen',
      date: '2023-07-19',
      fields: [
        { label: 'Site', value: 'Vixen' },
        { label: 'Date', value: '2023-07-19' },
        { label: 'Scene', value: 'Kylie - Page - Turner' },
      ],
    },
    quality: { extras: {} },
  };

  const values = sceneToManualValues(stored, OPTIONS);
  const rebuilt = sceneFromManualValues(values, OPTIONS);
  assert.ok('media' in rebuilt);

  // Trusting the stored title here keyed the group as `kylie--page--turner`:
  // a different scene, and a different library directory.
  assert.equal(rebuilt.media.identityKey, stored.identityKey);

  // The cost of not trusting it, asserted so it is a decision and not a
  // surprise: the parts come back in slug form, for the human to correct.
  assert.equal(values['title'], 'kylie-page - turner');
});

test('a stored site that disagrees with its own key does not re-key the group', () => {
  // The site's version of the test above, and hand-written for the same reason:
  // `media_groups.display` is written once by the first ingest and never
  // rewritten, so a row can hold a subtitle that no longer rebuilds the key
  // beside it. Copying that subtitle into the form and saving it back
  // unchanged then moves the group — and, on the no-merge-target path, the
  // library directory under it — with nothing on screen to say so.
  const stored: ParsedRelease = {
    identityKey: 'bangbros:2026-08-03:chloe-upgrades-her-butt',
    display: {
      title: 'Chloe Upgrades her Butt',
      subtitle: 'Bang Bros',
      date: '2026-08-03',
      fields: [
        { label: 'Site', value: 'Bang Bros' },
        { label: 'Date', value: '2026-08-03' },
        { label: 'Scene', value: 'Chloe Upgrades her Butt' },
      ],
    },
    quality: { extras: {} },
  };

  // `Bang Bros` and `bangbros` are no longer a disagreement: the key's site
  // segment is separator-free, so the stored subtitle rebuilds it and the
  // prefill can offer the real name. This used to fall through to the key's
  // own spelling, because `slug('Bang Bros')` was `bang-bros`.
  const values = sceneToManualValues(stored, { sites: [] });
  assert.equal(values['site'], 'Bang Bros');

  const rebuilt = sceneFromManualValues(values, { sites: [] });
  assert.ok('media' in rebuilt);
  assert.equal(rebuilt.media.identityKey, stored.identityKey);

  // A subtitle that disagrees about more than separators still has to be
  // caught — `media_groups.display` is written once and never rewritten, so a
  // row edited into this state stays that way. The key's own spelling is the
  // prefill that rebuilds it.
  const wrong = sceneToManualValues(
    { ...stored, display: { ...stored.display, subtitle: 'Brazzers' } },
    { sites: [] },
  );
  assert.equal(wrong['site'], 'bangbros');
  const rebuiltWrong = sceneFromManualValues(wrong, { sites: [] });
  assert.ok('media' in rebuiltWrong);
  assert.equal(rebuiltWrong.media.identityKey, stored.identityKey);

  // A missing subtitle is the same failure with nothing to copy: before the
  // check it produced an empty required field, which the form rejects.
  const blank = sceneToManualValues(
    { ...stored, display: { ...stored.display, subtitle: '' } },
    { sites: [] },
  );
  assert.equal(blank['site'], 'bangbros');
});

test('a site spelling learned after ingest does not move the key through a prefill', () => {
  // The reviewer's case. It used to be a documented hole and is now closed.
  //
  // These two parse with no site list at all, so they key under the spelling
  // their own release names use. `learnSites` then adds the metadata service's
  // `Bang Bros` on some later feed batch, and the Edit form opens against that
  // longer list. Matching has always been on `siteComparisonKey`, which deletes
  // separators; the key used to be built with `slug`, which keeps them as `-`,
  // so the two spellings were one site for matching and two for keying and a
  // no-op save re-keyed the group from `bangbros` to `bang-bros`. The key's
  // site segment is `siteComparisonKey` now, so both spellings reduce to the
  // one identity and there is nothing for the prefill to lose.
  const learned = { sites: ['Bang Bros'] };
  const cases: [string, string][] = [
    ['Bangbros.Chloe.Upgrades.her.Butt.2026.08.03.2160p.MP4-WRB', 'Bangbros'],
    ['[BangBros] Kylie - Page Turner - 2023-07-19', 'BangBros'],
  ];

  for (const [name, subtitle] of cases) {
    const parsed = parseSceneRelease(name, { sites: [] });
    assert.ok(parsed !== null, name);
    assert.equal(parsed.display.subtitle, subtitle, name);

    const segment = parsed.identityKey.split(':')[0] ?? '';
    // The test of whether *any* value could hold the key, applied to the one
    // value that works if one does — see the proof in `siteForKeySegment`. It
    // has to spell the segment the way `buildRelease` does, or it answers about
    // a slug the key no longer holds.
    const recoverable = siteComparisonKey(canonicalSiteName(segment, learned.sites)) === segment;
    assert.equal(recoverable, true, name);

    // The learned spelling reaches the field, because it is now the one that
    // both displays correctly and rebuilds the key.
    const values = sceneToManualValues(parsed, learned);
    assert.equal(values['site'], subtitle, name);

    const rebuilt = sceneFromManualValues(values, learned);
    assert.ok('media' in rebuilt, name);
    assert.equal(rebuilt.media.identityKey, parsed.identityKey, name);
  }
});

test('the exact case that motivated the third fallback stays on the display spelling', () => {
  // The reported bug that opened issue #39, driven end to end: a release
  // parsed before ThePornDB confirmed its site, whose group is read back for
  // editing after `learnSites` added the confirmed spelling to the list. Under
  // the old key shape (`slug`) no value of the site field could reproduce this
  // group's key, so `siteForKeySegment` needed a third answer — return the
  // subtitle anyway — for exactly this shape of input. That branch is gone
  // now; this proves it was never needed for this case, rather than assuming
  // it from the algebra alone.
  const name =
    'TouchMyWife.25.02.07.Anna.Claire.Clouds.Wife.Makes.Dirty.Video.For.Hubby.XXX.2160p.MP4-VSEX';
  const stored = parseSceneRelease(name, { sites: [] });
  assert.ok(stored !== null);
  assert.equal(stored.display.subtitle, 'TouchMyWife');
  assert.equal(stored.identityKey, 'touchmywife:2025-02-07:anna-claire-clouds-wife-makes-dirty-video-for-hubby');

  const learned = { sites: ['Touch My Wife'] };
  const values = sceneToManualValues(stored, learned);

  // The property the round trip has to keep: opening this group's Edit form
  // after the site was learned and pressing Save without touching a field
  // must not move it. Asserted below by rebuilding, but the key segment being
  // separator-free is what makes the assertion meaningful — under the old key
  // shape this exact save is what silently re-keyed `touchmywife` groups to
  // `touch-my-wife`.
  const rebuilt = sceneFromManualValues(values, learned);
  assert.ok('media' in rebuilt);
  assert.equal(rebuilt.media.identityKey, stored.identityKey);

  // The fallback this test is really about: if either probe had failed here,
  // `siteForKeySegment` would have emitted the bare key segment
  // (`touchmywife`) rather than the stored display spelling (`TouchMyWife`).
  // Distinguishable only because they differ in case — which is exactly what
  // a human would notice on an Edit form that had quietly started showing
  // slugs instead of names.
  assert.equal(values['site'], 'TouchMyWife');
  assert.notEqual(values['site'], stored.identityKey.split(':')[0]);
});

test('the key-derived fallbacks do not fire on a well-formed release', () => {
  // The fallbacks trade spelling for safety, so they must be unreachable for
  // anything the fixed parser produces — otherwise every Edit form on a healthy
  // library opens showing slugs instead of titles and site names.
  //
  // Run under more than one site list because that is the variable the site
  // check reads: a prefill built against a list the release was not parsed
  // under is the normal case once `learnSites` has run.
  let fired = 0;
  for (const options of SITE_LISTS) {
    for (const name of NAMES) {
      const parsed = parseSceneRelease(name, options);
      assert.ok(parsed !== null, name);
      const values = sceneToManualValues(parsed, options);

      if (values['title'] !== parsed.display.title) fired += 1;
      if (values['site'] !== parsed.display.subtitle) fired += 1;

      // Firing is not the only way to be wrong; not firing when it should have
      // is the other. Asserted here so the count above cannot be kept at zero
      // by a check that never runs.
      const rebuilt = sceneFromManualValues(values, options);
      assert.ok('media' in rebuilt, name);
      assert.equal(rebuilt.media.identityKey, parsed.identityKey, `${name} @ ${options.sites}`);
    }
  }
  assert.equal(fired, 0);
});

test('a delimited display title splits back into the parts its key was built from', () => {
  // Asserted directly, over every name, rather than inferred from a round trip
  // passing: this is the property `display.title` has to keep for the join on
  // ` - ` to stay injective, and it is what a future change to how titles are
  // spelled would trip over.
  for (const name of NAMES) {
    const parsed = parseSceneRelease(name, OPTIONS);
    assert.ok(parsed !== null, name);
    const sceneSlug = parsed.identityKey.split(':')[2] ?? '';
    if (!sceneSlug.includes('--')) continue;

    const parts = parsed.display.title.split(' - ');
    assert.equal(sceneSlugFromParts(parts), sceneSlug, name);
    for (const part of parts) {
      assert.ok(part.length > 0, `${name}: empty title part`);
      assert.ok(!/^[\s-]|[\s-]$/.test(part), `${name}: '${part}' has a space or hyphen at an edge`);
    }
  }
});

test('every declared field has a scope, and identity fields alone build an identity', () => {
  const fields = sceneManualFields();

  // Spelled out rather than counted, because the failure this guards is a
  // field quietly going missing: a quality token with no field is dropped by
  // every human edit, and nothing else in the suite would notice. This list is
  // spec §5's table — name, scope and order.
  assert.deepEqual(
    fields.map((field) => [field.name, field.scope]),
    [
      ['site', 'identity'],
      ['anchorKind', 'identity'],
      ['date', 'identity'],
      ['episode', 'identity'],
      ['title', 'identity'],
      ['titleOrder', 'identity'],
      ['resolution', 'quality'],
      ['source', 'quality'],
      ['videoCodec', 'quality'],
      ['audioCodec', 'quality'],
      ['releaseGroup', 'quality'],
      ['container', 'quality'],
      ['vr', 'quality'],
      ['upscaled', 'quality'],
      ['interlaced', 'quality'],
    ],
  );

  for (const field of fields) {
    if (field.type === 'select') assert.ok(Array.isArray(field.options), field.name);
  }

  // Core sends only identity values when editing a group, so this must work.
  const identityOnly = sceneFromManualValues(
    { site: 'Brazzers', anchorKind: 'date', date: '2023-04-15', title: 'Alex Coal' },
    OPTIONS,
  );
  assert.ok('media' in identityOnly);
  assert.equal(identityOnly.media.identityKey, 'brazzers:2023-04-15:alex-coal');
});

test('a configured site spelling wins over what was typed', () => {
  // Same rule the parser follows: the canonical name decides the library
  // directory, so typing 'bangbros' must not open a second one.
  const result = sceneFromManualValues(
    { site: 'bangbros', anchorKind: 'none', title: 'Some Scene' },
    OPTIONS,
  );
  assert.ok('media' in result);
  assert.equal(result.media.display.subtitle, 'Bang Bros');
  assert.equal(result.media.identityKey, 'bangbros::some-scene');
});

test('each rejection names the field at fault', () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ site: '', anchorKind: 'none', title: 'T' }, /site/i],
    [{ site: 'S', anchorKind: 'none', title: '' }, /title/i],
    [{ site: 'S', anchorKind: 'date', date: '15-04-2023', title: 'T' }, /date/i],
    [{ site: 'S', anchorKind: 'date', date: '2023-02-30', title: 'T' }, /date/i],
    // Real days, but outside the range `toIsoDate` accepts. A typo like 9023
    // would otherwise open a group no parsed release can ever join.
    [{ site: 'S', anchorKind: 'date', date: '1899-06-01', title: 'T' }, /date/i],
    [{ site: 'S', anchorKind: 'date', date: '9023-04-15', title: 'T' }, /date/i],
    [{ site: 'S', anchorKind: 'episode', episode: 'eleven', title: 'T' }, /episode/i],
    // A select value the schema does not list is refused, not ignored: built
    // silently, each of these yields a release missing the very token the
    // human supplied.
    [{ site: 'S', anchorKind: 'none', title: 'T', resolution: '1080' }, /resolution/i],
    [{ site: 'S', anchorKind: 'none', title: 'T', vr: 'true' }, /vr/i],
    [{ site: 'S', anchorKind: 'none', title: 'T', upscaled: 'YES' }, /upscaled/i],
    [{ site: 'S', anchorKind: 'none', title: 'T', interlaced: '1' }, /interlaced/i],
    [{ site: 'S', anchorKind: 'none', title: 'T', titleOrder: 'sorted' }, /title order/i],
    [{ site: 'S', anchorKind: 'weekly', title: 'T' }, /anchor/i],
  ];
  for (const [values, pattern] of cases) {
    const result = sceneFromManualValues(values, OPTIONS);
    assert.ok('error' in result, JSON.stringify(values));
    assert.match(result.error, pattern);
  }
});

test('the declared schema cannot be edited by whoever asks for it', () => {
  // `readonly` is erased at runtime, so nothing but a freeze stops a caller
  // from mutating the schema every later caller reads.
  const fields = sceneManualFields();
  assert.throws(() => (fields as ManualField[]).push(fields[0] as ManualField));
});

test('an audio codec survives the round trip the parser cannot produce', () => {
  // No release name yields `quality.audioCodec` — the parser never sets it —
  // so the NAMES loop cannot cover this field, and without this the field
  // could be deleted from the schema with the suite still green.
  const built = sceneFromManualValues(
    { site: 'Site', anchorKind: 'none', title: 'Scene', audioCodec: 'aac' },
    OPTIONS,
  );
  assert.ok('media' in built);
  assert.equal(built.media.quality.audioCodec, 'aac');

  const rebuilt = sceneFromManualValues(sceneToManualValues(built.media, OPTIONS), OPTIONS);
  assert.ok('media' in rebuilt);
  assert.deepEqual(rebuilt.media, built.media);
});

test('an episode is normalised the way the parser normalises it', () => {
  const result = sceneFromManualValues(
    { site: 'InTheCrack', anchorKind: 'episode', episode: 'E1178', title: 'Tracy Gold' },
    OPTIONS,
  );
  assert.ok('media' in result);
  assert.equal(result.media.identityKey, 'inthecrack:e1178:tracy-gold');
  assert.ok(result.media.display.fields.some((f) => f.label === 'Episode' && f.value === 'E1178'));
});

test('a suggestion for an unparseable name offers what it can and invents nothing', () => {
  // Runs on names the parser already refused, so little or nothing is normal —
  // but it must never throw, and must not fabricate a title.
  const values = sceneSuggestManualValues('agmx.084.4k', OPTIONS);
  assert.equal(typeof values, 'object');
  assert.equal(values['title'] ?? '', '');
});

test('the hooks see a site learned after the plugin was built', () => {
  // `learnSites` reassigns the options object, so a hook that captured it at
  // construction keeps the empty list forever — and every hand-entered release
  // is then keyed under the spelling the human typed instead of the canonical
  // one, opening a second library directory for a site the plugin already
  // knows. Nothing about that fails loudly, so it is asserted here.
  const plugin = createScenesPlugin({ sites: [] });
  plugin.learnSites?.(['Bang Bros']);

  const result = plugin.fromManualValues?.({
    site: 'bangbros',
    anchorKind: 'none',
    title: 'Some Scene',
  });
  assert.ok(result !== undefined && 'media' in result);
  assert.equal(result.media.display.subtitle, 'Bang Bros');
  assert.equal(result.media.identityKey, 'bangbros::some-scene');

  // `toManualValues` used to need the list for the opposite reason: it
  // checked the site it was about to prefill against the key that site had to
  // rebuild, and a captured-at-construction list could make that check answer
  // differently once `learnSites` grew it — the empty list would fail the
  // check and fall back to the key's own spelling where the current list
  // would have kept the display name. It no longer can: `siteForKeySegment`'s
  // answer does not depend on which list it runs under, per the proof there,
  // so there is nothing left for a stale list to get wrong. This only shows
  // the hook still returns the display spelling when called after
  // `learnSites`, not that a stale list would have mattered.
  const stored: ParsedRelease = {
    identityKey: 'bangbros:2023-04-15:alex-coal',
    display: { title: 'Alex Coal', subtitle: 'Bangbros', date: '2023-04-15', fields: [] },
    quality: { extras: {} },
  };
  assert.equal(plugin.toManualValues?.(stored)['site'], 'Bangbros');
});
