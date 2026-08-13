import { test } from 'node:test';
import assert from 'node:assert/strict';
import createScenesPlugin from '../src/index.ts';

const plugin = createScenesPlugin({});

/** The parsed title, or the refusal reason, for readable assertions. */
function titleOf(name: string): string {
  const parsed = plugin.parse(name);
  return parsed === null ? `REFUSED: ${plugin.refusalReason?.() ?? '?'}` : parsed.display.title;
}

test('a bare digit inside the encode run does not refuse the name', () => {
  // DDP5.1 tokenizes to DDP5 + 1. An earlier design stopped the walk at that
  // digit, left the boundary mid-encode, and refused the whole release.
  const parsed = plugin.parse(
    'Brazzers.23.04.15.Alex.Coal.XXX.2160p60.WEB-DL.H.265.10bit.HDR.DDP5.1.MP4-G');
  assert.ok(parsed !== null);
  assert.equal(parsed.display.title, 'Alex Coal');
});

test('a title word after an audio token survives', () => {
  // `DD` is Dolby Digital, so isEncodeToken('DD') is true. An earlier design
  // read the token after it as a release-group tag and ate it.
  assert.equal(
    titleOf('PornMegaLoad.26.07.31.DD.White.Hardcore.42617.XXX.1080p.MP4-WRB'),
    'DD White',
  );
});

test('a content-type tag and an id both leave the title', () => {
  assert.equal(titleOf('PornMegaLoad.26.08.05.Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB'),
    'Suki Sin');
  assert.equal(titleOf('PornMegaLoad.26.07.31.DD.White.Hardcore.42617.XXX.1080p.MP4-WRB'),
    'DD White');
});

test('a content-type tag alone leaves the title', () => {
  assert.equal(titleOf('ClubSweethearts.26.08.05.Remido.Solo.XXX.1080p.MP4-WRB'), 'Remido');
  assert.equal(
    titleOf('AllOver30.26.08.03.Diana.V.And.Lauren.De.Graaf.Lesbian.XXX.1080p.MP4-WRB'),
    'Diana V And Lauren De Graaf',
  );
});

test('a language tag leaves the title, whatever its case', () => {
  assert.equal(
    titleOf('HollandschePassie.26.08.06.Alessandra.Sweet.Hardcore.DUTCH.XXX.1080p.MP4-WRB'),
    'Alessandra Sweet',
  );
});

test('the quality still parses once the suffix is longer', () => {
  const parsed = plugin.parse('PornMegaLoad.26.08.05.Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB');
  assert.ok(parsed !== null);
  assert.equal(parsed.quality.resolution, 1080);
  assert.equal(parsed.quality.releaseGroup, 'WRB');
});

test('a sequel number, a year and an episode number all stay', () => {
  assert.equal(titleOf('Site.26.08.05.Summer.Renee.Sarasota.4.XXX.1080p.MP4-WRB'),
    'Summer Renee Sarasota 4');
  assert.equal(titleOf('Site.26.08.05.Gianna.Dior.TOTM.March.2020.XXX.1080p.MP4-WRB'),
    'Gianna Dior TOTM March 2020');
  assert.equal(titleOf('Site.26.08.05.Violet.Voss.Episode.466.XXX.1080p.MP4-WRB'),
    'Violet Voss Episode 466');
});

test('a title that is a real word from the non-language half keeps it', () => {
  assert.equal(titleOf('Site.26.08.05.Leona.Mia.Beauty.In.Full.XXX.1080p.MP4-WRB'),
    'Leona Mia Beauty In Full');
  assert.equal(titleOf('Site.26.08.05.Alaina.Dawson.Compilation.XXX.1080p.MP4-WRB'),
    'Alaina Dawson Compilation');
});

test('a mid-title tag is untouched', () => {
  assert.equal(titleOf('Site.26.08.05.The.Hardcore.Truth.XXX.1080p.MP4-WRB'),
    'The Hardcore Truth');
});

/**
 * The nine real corpus titles that carry a content-type tag away from the
 * end. `findTitleEnd` only ever walks from the end of the token list — see
 * its docstring — so these mid-title occurrences are never at risk from this
 * feature, but a rule that reached them would be deleting real title words,
 * and that is exactly the failure mode a synthetic test cannot catch.
 *
 * Extracted from the corpus with the probe script described in the task
 * brief. The probe actually returned ten matches: the tenth,
 * `PornMegaLoad.26.07.16.Alexya.Solo.42559.XXX.2160p.MP4-WRBPornMegaLoad.26.07.16.Kamille.Amora.Solo.42515.XXX.2160p.MP4-WRB`,
 * is two complete release names concatenated with no separator — a missing
 * newline in `uhd2.txt` (line 1991), not a real single release name any
 * caller produces. `uhd.txt` carries the clean first half of the same pair
 * on its own line. That one is excluded here as a corpus data artifact
 * rather than a mid-title case.
 */
test('nine real corpus titles with a mid-title content-type tag are untouched', () => {
  assert.equal(
    titleOf('Seventeen Collected Hardcore 32 cd 1 - 010126 - Seventeen_Collected_Hardcore_32_cd1.part008.rar'),
    'Seventeen Collected Hardcore 32 cd1 part008 rar',
  );
  assert.equal(
    titleOf('Hegre.26.08.11.Nyx.And.Syrena.Lesbian.Leisure.Part.1.XXX.2160p.MP4-WRB'),
    'Nyx And Syrena Lesbian Leisure Part 1',
  );
  // This fixture also carries a stray lowercase `mp4` between `-GAPFiLL` and
  // the `XXX` marker — a corpus artifact, not a content-type tag. The old
  // shared-predicate walk stripped it because it recognised encode
  // vocabulary directly; the vocabulary-only walk does not, and correctly
  // so: `mp4` sits outside the run `findEncodeSuffixStart` anchors (the
  // marker sits between it and that run), so treating it as suffix would be
  // the same adjacency-proxy guessing that caused the two defects this
  // change fixes. It stays in the title.
  assert.equal(
    titleOf('JuliaAnnLive.26.07.24.Jelena.Jensen.Tantalizing.Lesbian.MILFs.-GAPFiLL.mp4.XXX.1080p.MP4-P0RNL0V3R'),
    'Jelena Jensen Tantalizing Lesbian MILFs -GAPFiLL mp4',
  );
  assert.equal(
    titleOf('SweetheartVideo.26.07.20.Hazel.Moore.And.Elizabeth.Skylar.Lesbian.Students.XXX.1080p.MP4-WRB'),
    'Hazel Moore And Elizabeth Skylar Lesbian Students',
  );
  assert.equal(
    titleOf('Girlfriends.16.07.16.Kari.And.Kira.Intimate.Lesbian.Artistry.XXX.1080p.MP4-KTR'),
    'Kari And Kira Intimate Lesbian Artistry',
  );
  assert.equal(
    titleOf('SlutInspection.23.09.25.Lesbian.Soulmates.Alona.Bloom.And.Suzanne.Ferrari.XXX.XviD-iPT Team'),
    'Lesbian Soulmates Alona Bloom And Suzanne Ferrari',
  );
  assert.equal(
    titleOf('PrimeLesbian.23.10.02.Shrima.Malati.And.Baby.Nicols.Lesbian.Strap-On.Fucking.XXX.XviD-iPT Team'),
    'Shrima Malati And Baby Nicols Lesbian Strap-On Fucking',
  );
  assert.equal(
    titleOf('MassageSins.23.07.20.Nancy.A.And.Tiffany.Tatum.Sexy.Lesbian.Massage.And.Orgasms.XXX.XviD-iPT Team'),
    'Nancy A And Tiffany Tatum Sexy Lesbian Massage And Orgasms',
  );
  assert.equal(
    titleOf('Manyvids.SweetieFox.24.02.21.Dirty.Talk.Deep.Hardcore.Blowjob.Video.Sweetie.Fox.2160p'),
    'Dirty Talk Deep Hardcore Blowjob Video Sweetie Fox',
  );
});
