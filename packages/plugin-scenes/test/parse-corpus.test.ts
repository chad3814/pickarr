import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QualityTokens } from '@pickarr/plugin-api';
import { parseSceneRelease } from '../src/parse.ts';
import { scoreScene } from '../src/score.ts';

function qualitySignature(quality: QualityTokens): string {
  return [
    quality.resolution ?? '-',
    quality.source ?? '-',
    quality.videoCodec ?? '-',
    quality.extras?.['container'] ?? '-',
    quality.extras?.['vr'] === true ? 'vr' : '-',
    quality.extras?.['upscaled'] === true ? 'up' : '-',
    quality.releaseGroup ?? '-',
  ].join('|');
}

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
  /**
   * `resolution|source|codec|container|vr|upscaled|group`, `-` for absent.
   *
   * Quality is pinned per row because identity is not the only thing that has
   * to survive a shape change. Two encodes of one scene collate into a single
   * group *by design*, and the group is ranked by these tokens: a shape that
   * parses to the right key but drops its resolution puts a 480p and a 2160p
   * on one shelf with the same score, which inverts upgrade detection. That is
   * a silent failure with no key to inspect, so it needs its own assertion.
   *
   * `upscaled` is here for a reason worth stating, because it was missing and
   * the omission hid exactly the failure this field exists to catch. An upscale
   * and a native encode of one scene share a resolution, so every other column
   * agrees and the two rows pinned *byte-identical* signatures — while
   * `scoreScene` separated them only if the parser had recognised the upscale in
   * the first place. Nothing in the table could tell whether it had. Recording
   * it here means dropping the recognition changes a pinned string, which is
   * the whole mechanism by which this table catches a silent quality loss.
   */
  readonly quality: string;
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
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: false,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '2160|-|h265|mp4|-|-|GRP',
    isNew: false,
  },
  // --- Shape 1b: the date at the *end*, immediately before the encode --------
  //
  // `Site.Title.And.Performers.YYYY.MM.DD.Encode`. Everything before the date
  // is site and title with no separator between them, so with no configured
  // site list the first token is taken as the site. That is a guess about the
  // library *path*; the whole pre-date run still reaches the identity key, so
  // it cannot merge two different scenes.
  {
    name: 'Anal.Only.Getting.In.Savannahs.Booty.Savannah.Bond.2022.09.29.Upscaled.2160p',
    scene: 'anal/only-getting-in-savannahs-booty-savannah-bond',
    key: 'anal:2022-09-29:only-getting-in-savannahs-booty-savannah-bond',
    title: 'Only Getting In Savannahs Booty Savannah Bond',
    quality: '2160|-|-|-|-|up|-',
    isNew: true,
  },
  {
    name: 'Anal.Only.Getting.In.Savannahs.Booty.Savannah.Bond.2022.09.29.2160p',
    scene: 'anal/only-getting-in-savannahs-booty-savannah-bond',
    key: 'anal:2022-09-29:only-getting-in-savannahs-booty-savannah-bond',
    title: 'Only Getting In Savannahs Booty Savannah Bond',
    quality: '2160|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: 'Bangbros.Ass.Parade.Chloe.Upgrades.her.Butt.Toy.to.Chevalier.a.BBC.Chloe.Chevalier.2026.08.03.2160p',
    scene: 'bangbros/ass-parade-chloe-upgrades-her-butt-toy-to-chevalier-a-bbc-chloe-chevalier',
    key: 'bangbros:2026-08-03:ass-parade-chloe-upgrades-her-butt-toy-to-chevalier-a-bbc-chloe-chevalier',
    title: 'Ass Parade Chloe Upgrades her Butt Toy to Chevalier a BBC Chloe Chevalier',
    quality: '2160|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: 'Vixen.Kylie.Rocket.Page.Turner.2023.07.19.1080p.MP4-WRB',
    scene: 'vixen/kylie-rocket-page-turner',
    key: 'vixen:2023-07-19:kylie-rocket-page-turner',
    title: 'Kylie Rocket Page Turner',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: true,
  },
  // --- Group tags that are not all-caps -------------------------------------
  //
  // Both from real feeds. Scene groups style themselves freely, and the caps
  // rule refused every one that is not shouting.
  {
    name: 'Hentaied.26.01.20.Emiri.Momota.MILFa.Vs.Cumboro.XXX.2160p.MP4-FETiSH',
    scene: 'hentaied/emiri-momota',
    key: 'hentaied:2026-01-20:emiri-momota-milfa-vs-cumboro',
    title: 'Emiri Momota MILFa Vs Cumboro',
    quality: '2160|-|-|mp4|-|-|FETiSH',
    isNew: true,
  },
  {
    name: 'OperationEscort.17.10.27.Kenzie.Reeves.XXX.2160p.MP4-Zsex3i',
    scene: 'operationescort/kenzie-reeves',
    key: 'operationescort:2017-10-27:kenzie-reeves',
    title: 'Kenzie Reeves',
    quality: '2160|-|-|mp4|-|-|Zsex3i',
    isNew: true,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-inSaNe',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|inSaNe',
    isNew: true,
  },
  // --- Names the encode vocabulary nearly missed ----------------------------
  //
  // `26282` is PornMegaLoad's own content id, the same shape as `42466` in
  // the suffix-parse tests, and the title suffix walk now drops it with the
  // rest of the trailing run instead of leaving it in the scene title.
  {
    name: 'PornMegaLoad.24.03.17.Cherry.Brady.26282.XXX.REMASTERED.XviD-iPT Team',
    scene: 'pornmegaload/cherry-brady',
    key: 'pornmegaload:2024-03-17:cherry-brady',
    title: 'Cherry Brady',
    quality: '-|-|xvid|-|-|-|iPT Team',
    isNew: true,
  },
  // --- Content-type and language tags, pinned inside the corpus table -------
  //
  // Before this pair the corpus carried no entry ending in a content-type or
  // language token at all, so `corpus: no two distinct scenes ever share an
  // identity key` never actually exercised a name the vocabulary walk trims —
  // it could not have caught a merge caused by this feature no matter what
  // broke. Two encodes of the same `Solo`-tagged scene, so the walk's
  // trimming is checked against both the collision and the shares-a-key
  // invariants at once.
  {
    name: 'PornMegaLoad.26.08.05.Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB',
    scene: 'pornmegaload/suki-sin',
    key: 'pornmegaload:2026-08-05:suki-sin',
    title: 'Suki Sin',
    quality: '1080|-|-|mp4|-|WRB',
    isNew: true,
  },
  {
    name: 'PornMegaLoad.26.08.05.Suki.Sin.Solo.42466.XXX.2160p.HEVC.MP4-GRP',
    scene: 'pornmegaload/suki-sin',
    key: 'pornmegaload:2026-08-05:suki-sin',
    title: 'Suki Sin',
    quality: '2160|-|h265|mp4|-|GRP',
    isNew: true,
  },
  {
    name: 'HollandschePassie.26.08.06.Alessandra.Sweet.Hardcore.DUTCH.XXX.1080p.MP4-WRB',
    scene: 'hollandschepassie/alessandra-sweet',
    key: 'hollandschepassie:2026-08-06:alessandra-sweet',
    title: 'Alessandra Sweet',
    quality: '1080|-|-|mp4|-|WRB',
    isNew: true,
  },
  {
    name: 'Pantyhosed4U.16.07.20.Heidi.Bush.V.Tight.Tease.And.Tear.XXX.1080i.MP4-KTR',
    scene: 'pantyhosed4u/heidi-bush-v-tight-tease-and-tear',
    key: 'pantyhosed4u:2016-07-20:heidi-bush-v-tight-tease-and-tear',
    title: 'Heidi Bush V Tight Tease And Tear',
    quality: '1080|-|-|mp4|-|-|KTR',
    isNew: true,
  },
  // --- A name that carries no encode information at all ---------------------
  //
  // Nothing marks where the title stops because nothing needs to: not one
  // token after the date is encode vocabulary, so there is no run to mistake
  // for title or title to mistake for a run. The whole remainder is the scene.
  {
    name: 'KarupsPC.com_13.10.14.Chelsey.Lanette',
    scene: 'karupspc-com/chelsey-lanette',
    key: 'karupspccom:2013-10-14:chelsey-lanette',
    title: 'Chelsey Lanette',
    quality: '-|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: 'Pornmegaload.16.08.11.Amanda.Verhooks.Anal.Three-way',
    scene: 'pornmegaload/amanda-verhooks-anal-three-way',
    key: 'pornmegaload:2016-08-11:amanda-verhooks-anal-three-way',
    title: 'Amanda Verhooks Anal Three-way',
    quality: '-|-|-|-|-|-|-',
    isNew: true,
  },
  // It collates with the same scene listed *with* encode information, which
  // refusing could never do.
  {
    name: 'Brazzers.23.04.15.Alex.Coal',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '-|-|-|-|-|-|-',
    isNew: true,
  },
  // --- Episode numbers, where a date would be -------------------------------
  //
  // Sites that number episodes instead of dating them. `E141` sits exactly
  // where the date sits and is recognised the same way — by shape, not by
  // vocabulary — so it anchors the site/title boundary just as well and needs
  // no site lookup to do it.
  {
    name: 'HeavyOnHotties.E141.Daniela.Pechotes.Fuck.Me.Silly.XXX.1080p.MP4-KTR',
    scene: 'heavyonhotties/daniela-pechotes',
    key: 'heavyonhotties:e141:daniela-pechotes-fuck-me-silly',
    title: 'Daniela Pechotes Fuck Me Silly',
    quality: '1080|-|-|mp4|-|-|KTR',
    isNew: true,
  },
  {
    name: 'InTheCrack.E1178.Tracy.Gold.XXX.2160p.MP4-KTR',
    scene: 'inthecrack/tracy-gold',
    key: 'inthecrack:e1178:tracy-gold',
    title: 'Tracy Gold',
    quality: '2160|-|-|mp4|-|-|KTR',
    isNew: true,
  },
  {
    name: 'GirlsDoPorn.E380.20.Years.Old.XXX.720p.MP4-KTR',
    scene: 'girlsdoporn/20-years-old',
    key: 'girlsdoporn:e380:20-years-old',
    title: '20 Years Old',
    quality: '720|-|-|mp4|-|-|KTR',
    isNew: true,
  },
  // Two encodes of one episode collate, exactly as two encodes of one dated
  // scene do.
  {
    name: 'InTheCrack.E1178.Tracy.Gold.XXX.1080p.MP4-P0RNL0V3R',
    scene: 'inthecrack/tracy-gold',
    key: 'inthecrack:e1178:tracy-gold',
    title: 'Tracy Gold',
    quality: '1080|-|-|mp4|-|-|P0RNL0V3R',
    isNew: true,
  },
  // --- Release groups whose name contains a space ---------------------------
  //
  // `iPT Team` alone accounted for 65% of every refusal across a 6,800-title
  // corpus. A multi-token group is only detached directly behind encode
  // information, which is what stops it eating title words.
  {
    name: 'HotCrazyMess.19.09.13.Cadence.Lux.My.Friends.Boyfriend.XXX.XviD-iPT Team',
    scene: 'hotcrazymess/cadence-lux-my-friends-boyfriend',
    key: 'hotcrazymess:2019-09-13:cadence-lux-my-friends-boyfriend',
    title: 'Cadence Lux My Friends Boyfriend',
    quality: '-|-|xvid|-|-|-|iPT Team',
    isNew: true,
  },
  {
    name: 'Seska 22 07 26 A Cuckold Quickie XXX XviD-iPT Team',
    scene: 'seska/a-cuckold-quickie',
    key: 'seska:2022-07-26:a-cuckold-quickie',
    title: 'A Cuckold Quickie',
    quality: '-|-|xvid|-|-|-|iPT Team',
    isNew: true,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-iPT Team',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|iPT Team',
    isNew: true,
  },
  // --- A multi-token group attached with the name's own separator -----------
  //
  // The mirror of `iPT Team`: a group of more than one token, attached with a
  // dot instead of a hyphen — here the group plus the model it was run through.
  // Only the hyphen spelling had a branch, so this refused outright, and the
  // refusal is the informative part: `XXX`, `2160p` and `MP4` are all present
  // and correctly classified, but an undetached tail stops the trailing encode
  // run reaching the end of the name, and the marker behind it can then never
  // be seen.
  //
  // The group is `NBQ`, not `NBQ.realesrgan`: the upscaler is a stamp, so both
  // rows below report one group and the pair collates as the one scene it is.
  // They are the reason `qualitySignature` carries `upscaled` at all — the two
  // agree on every other column, so without it this pair pinned the same string
  // twice and the table could not tell an upscale from the native encode it
  // collates with.
  {
    name: 'Nympho.24.03.04.Bianca.Bangs.And.Myra.Moans.XXX.2160p.MP4.NBQ.realesrgan',
    scene: 'nympho/bianca-bangs-and-myra-moans',
    key: 'nympho:2024-03-04:bianca-bangs-and-myra-moans',
    title: 'Bianca Bangs And Myra Moans',
    quality: '2160|-|-|mp4|-|up|NBQ',
    isNew: true,
  },
  {
    name: 'Nympho.24.03.04.Bianca.Bangs.And.Myra.Moans.XXX.2160p.MP4-NBQ',
    scene: 'nympho/bianca-bangs-and-myra-moans',
    key: 'nympho:2024-03-04:bianca-bangs-and-myra-moans',
    title: 'Bianca Bangs And Myra Moans',
    quality: '2160|-|-|mp4|-|-|NBQ',
    isNew: false,
  },
  // --- Split markers, as they actually occur --------------------------------
  //
  // Sampled from 2,310 real indexer titles containing cd/part/disc markers:
  // none put one after a resolution in a hyphen-attached group position. What
  // does occur is this — the marker inside the title, where it stays part of
  // the identity and the two halves keep separate keys with no rule needed.
  {
    name: 'DeviceBondage - Lindsey Grant - 19-06-2010 - Altered State.part1',
    scene: 'devicebondage/altered-state-part1',
    key: 'devicebondage:2010-06-19:altered-state-part1--lindsey-grant',
    title: 'Lindsey Grant - Altered State part1',
    quality: '-|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: 'DeviceBondage - Lindsey Grant - 19-06-2010 - Altered State.part2',
    scene: 'devicebondage/altered-state-part2',
    key: 'devicebondage:2010-06-19:altered-state-part2--lindsey-grant',
    title: 'Lindsey Grant - Altered State part2',
    quality: '-|-|-|-|-|-|-',
    isNew: true,
  },
  // --- The resolution is an anchor ------------------------------------------
  //
  // Extra content is named *before* the resolution; only format and a group
  // tag follow it. So `Bonus` here is part of the scene's identity and these
  // are three different pieces of content, not three encodes of one.
  {
    name: 'Brazzers.23.04.15.Alex.Coal.Bonus.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal-bonus',
    key: 'brazzers:2023-04-15:alex-coal-bonus',
    title: 'Alex Coal Bonus',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: true,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.BTS.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal-bts',
    key: 'brazzers:2023-04-15:alex-coal-bts',
    title: 'Alex Coal BTS',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: true,
  },
  // ...and the same word *after* the resolution is a group. `B0NUS` is a real
  // one, which is the whole argument against guarding this position with a
  // list of words: a group can be spelled to look like anything.
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-B0NUS',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|B0NUS',
    isNew: true,
  },
  // Group tags of 9-12 characters. The cap was 8, which refused these outright
  // and made them the single largest source of parse_error rows against a real
  // feed. They collate with the rows above: same scene, different group.
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-P0RNL0V3R',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|P0RNL0V3R',
    isNew: true,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-EVILANGEL',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|EVILANGEL',
    isNew: true,
  },
  // No length cap: `-DIGITALPLAYGROUND` used to be refused for being too long.
  // Position decides instead, and after the encode section only a group can be.
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-DIGITALPLAYGROUND',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|DIGITALPLAYGROUND',
    isNew: true,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-TWELVECHARSX',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|TWELVECHARSX',
    isNew: true,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.2160p60.WEB-DL.H.265.10bit.HDR.DDP5.1.MP4-G',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '2160|web-dl|h265|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'brazzers 23 04 15 alex coal XXX 1080p MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'alex coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: false,
  },
  {
    name: 'Brazzers_23_04_15_Alex_Coal_XXX_1080p_MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: false,
  },
  {
    name: 'Brazzers-23-04-15-Alex-Coal-XXX-1080p-MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex-Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: false,
  },
  {
    name: 'Brazzers.2023.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: false,
  },

  // --- Preprocessing: website prefixes and appended file extensions ---------
  {
    name: 'www.site.com - Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: true,
  },
  {
    name: '[www.pornsite.net] Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: true,
  },
  {
    name: 'www.Site.com.Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: true,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB.mp4',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: true,
  },
  {
    name: 'Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP.mkv',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '2160|-|h265|mp4|-|-|GRP',
    isNew: true,
  },

  // --- Concatenated dates ---------------------------------------------------
  {
    name: 'Blacked.20180428.Alex.Coal.XXX.1080p.MP4-KTR',
    scene: 'blacked/alex-coal',
    key: 'blacked:2018-04-28:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|KTR',
    isNew: true,
  },
  {
    name: 'Blacked.180428.Alex.Coal.XXX.1080p.MP4-KTR',
    scene: 'blacked/alex-coal',
    key: 'blacked:2018-04-28:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|KTR',
    isNew: true,
  },
  {
    name: 'Blacked.18.04.28.Alex.Coal.XXX.2160p.HEVC.MP4-KTR',
    scene: 'blacked/alex-coal',
    key: 'blacked:2018-04-28:alex-coal',
    title: 'Alex Coal',
    quality: '2160|-|h265|mp4|-|-|KTR',
    isNew: false,
  },

  // --- Dot-attached release group ------------------------------------------
  {
    name: 'Tushy.24.01.09.Emily.Willis.XXX.1080p.HEVC.x265.PRT',
    scene: 'tushy/emily-willis',
    key: 'tushy:2024-01-09:emily-willis',
    title: 'Emily Willis',
    quality: '1080|-|x265|-|-|-|PRT',
    isNew: true,
  },
  {
    name: 'Tushy.24.01.09.Emily.Willis.XXX.2160p.HEVC.x265.PRT',
    scene: 'tushy/emily-willis',
    key: 'tushy:2024-01-09:emily-willis',
    title: 'Emily Willis',
    quality: '2160|-|x265|-|-|-|PRT',
    isNew: true,
  },
  {
    name: 'Tushy.24.01.09.Emily.Willis.XXX.1080p.HEVC.x265-PRT',
    scene: 'tushy/emily-willis',
    key: 'tushy:2024-01-09:emily-willis',
    title: 'Emily Willis',
    quality: '1080|-|x265|-|-|-|PRT',
    isNew: false,
  },

  // --- VR and similar layout tags ------------------------------------------
  {
    name: 'SexBabesVR.23.04.15.Alex.Coal.XXX.1080p.VR.MP4-G',
    scene: 'sexbabesvr/alex-coal',
    key: 'sexbabesvr:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|vr|-|G',
    isNew: true,
  },
  {
    name: 'SexBabesVR.23.04.15.Alex.Coal.XXX.2160p.VR.SBS.MP4-G',
    scene: 'sexbabesvr/alex-coal',
    key: 'sexbabesvr:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '2160|-|-|mp4|vr|-|G',
    isNew: true,
  },

  // --- The bracketed / dash-delimited listing form -------------------------
  // Note the two layouts: the Vixen row puts the date first and the performer
  // before the title; the reversed row puts the title first and the date
  // third. They are one scene and must collate.
  {
    name: '[Vixen] 19-07-2023 - Alex Coal - Beautiful Episode 2160p {SLUT}',
    scene: 'vixen/alex-coal-beautiful-episode',
    key: 'vixen:2023-07-19:alex-coal--beautiful-episode',
    title: 'Alex Coal - Beautiful Episode',
    quality: '2160|-|-|-|-|-|SLUT',
    isNew: true,
  },
  {
    name: '[Vixen] Beautiful Episode - Alex Coal - 2023-07-19 - 1080p',
    scene: 'vixen/alex-coal-beautiful-episode',
    key: 'vixen:2023-07-19:alex-coal--beautiful-episode',
    title: 'Beautiful Episode - Alex Coal',
    quality: '1080|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: '[Vixen] 19.07.2023 - Alex Coal - Beautiful Episode [1080p]',
    scene: 'vixen/alex-coal-beautiful-episode',
    key: 'vixen:2023-07-19:alex-coal--beautiful-episode',
    title: 'Alex Coal - Beautiful Episode',
    quality: '1080|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: '[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 1080p',
    scene: 'tushy/alex-coal-beautiful-episode',
    key: 'tushy:2023-07-22:alex-coal--beautiful-episode',
    title: 'Beautiful Episode - Alex Coal',
    quality: '1080|-|-|-|-|-|-',
    isNew: true,
  },
  // A listing tail carrying a *source* token, not just a bare resolution.
  // Every other listing row's tail is a lone resolution, which cannot form a
  // valid encode suffix for the dotted recogniser — so without this row the
  // two recognisers can be swapped and the whole suite still passes, even
  // though the swap makes the dotted parser eat listings and key this name on
  // its resolution.
  {
    name: '[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 1080p WEB-DL x264',
    scene: 'tushy/alex-coal-beautiful-episode',
    key: 'tushy:2023-07-22:alex-coal--beautiful-episode',
    title: 'Beautiful Episode - Alex Coal',
    quality: '1080|web-dl|x264|-|-|-|-',
    isNew: true,
  },
  {
    name: '[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 2160p HEVC',
    scene: 'tushy/alex-coal-beautiful-episode',
    key: 'tushy:2023-07-22:alex-coal--beautiful-episode',
    title: 'Beautiful Episode - Alex Coal',
    quality: '2160|-|h265|-|-|-|-',
    isNew: true,
  },
  // A different scene on the same site and day: the title segment differs, so
  // the sorted-component slug still separates them.
  {
    name: '[Tushy] Different Episode - Alex Coal - 2023-07-22 - 1080p',
    scene: 'tushy/alex-coal-different-episode',
    key: 'tushy:2023-07-22:alex-coal--different-episode',
    title: 'Different Episode - Alex Coal',
    quality: '1080|-|-|-|-|-|-',
    isNew: true,
  },

  // --- Written-month date in parentheses -----------------------------------
  {
    name: 'Pure Taboo - Sarah Arabic, Lily LaBeau - A Costly Divorce (June 24, 2025) [1080p HEVC x265]',
    scene: 'pure-taboo/a-costly-divorce',
    key: 'puretaboo:2025-06-24:a-costly-divorce--sarah-arabic-lily-labeau',
    title: 'Sarah Arabic, Lily LaBeau - A Costly Divorce',
    quality: '1080|-|x265|-|-|-|-',
    isNew: true,
  },
  {
    name: 'Pure Taboo - A Costly Divorce - Sarah Arabic, Lily LaBeau - 2025-06-24 - 2160p',
    scene: 'pure-taboo/a-costly-divorce',
    key: 'puretaboo:2025-06-24:a-costly-divorce--sarah-arabic-lily-labeau',
    title: 'A Costly Divorce - Sarah Arabic, Lily LaBeau',
    quality: '2160|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: 'Pure Taboo - Sarah Arabic - A Different Divorce (Jun 24, 2025) [1080p]',
    scene: 'pure-taboo/a-different-divorce',
    key: 'puretaboo:2025-06-24:a-different-divorce--sarah-arabic',
    title: 'Sarah Arabic - A Different Divorce',
    quality: '1080|-|-|-|-|-|-',
    isNew: true,
  },

  // --- Regression: an XXX release group must not move the boundary ----------
  {
    name: 'TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX',
    scene: 'teamskeet/jane-doe',
    key: 'teamskeet:2024-01-02:jane-doe',
    title: 'Jane Doe',
    quality: '1080|-|-|mp4|-|-|XXX',
    isNew: false,
  },
  {
    name: 'TeamSkeet.24.01.02.Jane.Doe.XXX.2160p.HEVC.MP4-XXX',
    scene: 'teamskeet/jane-doe',
    key: 'teamskeet:2024-01-02:jane-doe',
    title: 'Jane Doe',
    quality: '2160|-|h265|mp4|-|-|XXX',
    isNew: false,
  },
  {
    name: 'TeamSkeet.24.01.02.John.Smith.XXX.1080p.MP4-XXX',
    scene: 'teamskeet/john-smith',
    key: 'teamskeet:2024-01-02:john-smith',
    title: 'John Smith',
    quality: '1080|-|-|mp4|-|-|XXX',
    isNew: false,
  },

  // --- Regression: an in-title XXX must not truncate the title -------------
  {
    name: 'Site.23.04.15.Anniversary.XXX.1080p.MP4-G',
    scene: 'site/anniversary',
    key: 'site:2023-04-15:anniversary',
    title: 'Anniversary',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.Edition.XXX.1080p.MP4-G',
    scene: 'site/anniversary-edition',
    key: 'site:2023-04-15:anniversary-xxx-edition',
    title: 'Anniversary XXX Edition',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.Edition.XXX.2160p.HEVC.MP4-G',
    scene: 'site/anniversary-edition',
    key: 'site:2023-04-15:anniversary-xxx-edition',
    title: 'Anniversary XXX Edition',
    quality: '2160|-|h265|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.Web.Party.XXX.MP4-GRP1',
    scene: 'site/anniversary-web-party',
    key: 'site:2023-04-15:anniversary-xxx-web-party',
    title: 'Anniversary XXX Web Party',
    quality: '-|-|-|mp4|-|-|GRP1',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.Web.Party.XXX.1080p.MP4-GRP2',
    scene: 'site/anniversary-web-party',
    key: 'site:2023-04-15:anniversary-xxx-web-party',
    title: 'Anniversary XXX Web Party',
    quality: '1080|-|-|mp4|-|-|GRP2',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.Web.Bash.XXX.MP4-GRP2',
    scene: 'site/anniversary-web-bash',
    key: 'site:2023-04-15:anniversary-xxx-web-bash',
    title: 'Anniversary XXX Web Bash',
    quality: '-|-|-|mp4|-|-|GRP2',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Anniversary.XXX.4K.Party.XXX.MP4-GRP1',
    scene: 'site/anniversary-4k-party',
    key: 'site:2023-04-15:anniversary-xxx-4k-party',
    title: 'Anniversary XXX 4K Party',
    quality: '-|-|-|mp4|-|-|GRP1',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Gala.XXX.MP4.Madness.XXX.1080p.MP4-G',
    scene: 'site/gala-mp4-madness',
    key: 'site:2023-04-15:gala-xxx-mp4-madness',
    title: 'Gala XXX MP4 Madness',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Gala.XXX.MP4.Mayhem.XXX.1080p.MP4-G',
    scene: 'site/gala-mp4-mayhem',
    key: 'site:2023-04-15:gala-xxx-mp4-mayhem',
    title: 'Gala XXX MP4 Mayhem',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.XXX.Anniversary.XXX.1080p.MP4-GRP',
    scene: 'site/xxx-anniversary',
    key: 'site:2023-04-15:xxx-anniversary',
    title: 'XXX Anniversary',
    quality: '1080|-|-|mp4|-|-|GRP',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.XXXtreme.Makeover.XXX.1080p.MP4-GRP',
    scene: 'site/xxxtreme-makeover',
    key: 'site:2023-04-15:xxxtreme-makeover',
    title: 'XXXtreme Makeover',
    quality: '1080|-|-|mp4|-|-|GRP',
    isNew: false,
  },

  // --- Regression: weak encode words inside a title ------------------------
  {
    name: 'Site.23.04.15.Girls.Of.Web.1080p.MP4-G',
    scene: 'site/girls-of-web',
    key: 'site:2023-04-15:girls-of-web',
    title: 'Girls Of Web',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Girls.Of.Print.1080p.MP4-G',
    scene: 'site/girls-of-print',
    key: 'site:2023-04-15:girls-of-print',
    title: 'Girls Of Print',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.The.1080.Club.XXX.1080p.MP4-G',
    scene: 'site/the-1080-club',
    key: 'site:2023-04-15:the-1080-club',
    title: 'The 1080 Club',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Agent.007.Undercover.XXX.1080p.MP4-G',
    scene: 'site/agent-007-undercover',
    key: 'site:2023-04-15:agent-007-undercover',
    title: 'Agent 007 Undercover',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Agent.007.Overcover.XXX.1080p.MP4-G',
    scene: 'site/agent-007-overcover',
    key: 'site:2023-04-15:agent-007-overcover',
    title: 'Agent 007 Overcover',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Miss.AVI.XXX.1080p.MP4-G',
    scene: 'site/miss-avi',
    key: 'site:2023-04-15:miss-avi',
    title: 'Miss AVI',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Miss.MKV.XXX.1080p.MP4-G',
    scene: 'site/miss-mkv',
    key: 'site:2023-04-15:miss-mkv',
    title: 'Miss MKV',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: '[Site] 2023-01-01 - Girls Of Web',
    scene: 'site/girls-of-web-listing',
    key: 'site:2023-01-01:girls-of-web',
    title: 'Girls Of Web',
    quality: '-|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: '[Site] 2023-01-01 - Episode 2 4K',
    scene: 'site/episode-2',
    key: 'site:2023-01-01:episode-2',
    title: 'Episode 2',
    quality: '2160|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: '[Site] 2023-01-01 - Episode 3 4K',
    scene: 'site/episode-3',
    key: 'site:2023-01-01:episode-3',
    title: 'Episode 3',
    quality: '2160|-|-|-|-|-|-',
    isNew: true,
  },

  // --- No marker at all, and marker-only encode sections -------------------
  {
    name: 'Site.23.04.15.Alex.Coal.1080p.MP4-WRB',
    scene: 'site/alex-coal',
    key: 'site:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Alex.Coal.XXX.MP4-GRP',
    scene: 'site/alex-coal',
    key: 'site:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '-|-|-|mp4|-|-|GRP',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Alex.Coal.XXX.MKV-GRP',
    scene: 'site/alex-coal',
    key: 'site:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '-|-|-|mkv|-|-|GRP',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Alex.Coal.XXX.WMV',
    scene: 'site/alex-coal',
    key: 'site:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '-|-|-|wmv|-|-|-',
    isNew: false,
  },
  {
    name: 'Site.23.04.15.Alex.Coal.XXX',
    scene: 'site/alex-coal',
    key: 'site:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '-|-|-|-|-|-|-',
    isNew: false,
  },

  // --- The site is whatever precedes the date, with no vocabulary judgement -
  // A studio whose own name is built from encode words is exactly the case the
  // old whole-name boundary scan could corrupt.
  {
    name: '4K.Media.23.04.15.Alex.Coal.XXX.1080p.MP4-G',
    scene: '4k-media/alex-coal',
    key: '4kmedia:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'WebYoung.23.04.15.Alex.Coal.XXX.1080p.MP4-G',
    scene: 'webyoung/alex-coal',
    key: 'webyoung:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },
  {
    name: 'Tushy.com.23.04.15.Emily.Willis.XXX.1080p-G',
    scene: 'tushy-com/emily-willis',
    key: 'tushycom:2023-04-15:emily-willis',
    title: 'Emily Willis',
    quality: '1080|-|-|-|-|-|G',
    isNew: false,
  },
  {
    name: 'Vintage.1979.Collection.23.04.15.Alex.Coal.XXX.1080p.MP4-G',
    scene: 'vintage-1979-collection/alex-coal',
    key: 'vintage1979collection:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|G',
    isNew: false,
  },

  // --- A studio named after its domain, in the listing form ----------------
  // `Bang.com - Alex Coal - ...` is shaped exactly like a website prefix, so
  // stripping on a bare domain promoted the *performer* into the site slot and
  // collapsed every `.com` studio onto one key (and filed all their scenes
  // under `Alex Coal/`). A prefix now needs `www.` or a scheme.
  {
    name: 'Bang.com - Alex Coal - Deep - 2023-01-01 - 1080p',
    scene: 'bang-com/alex-coal-deep',
    key: 'bangcom:2023-01-01:alex-coal--deep',
    title: 'Alex Coal - Deep',
    quality: '1080|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: 'Deeper.com - Alex Coal - Deep - 2023-01-01 - 1080p',
    scene: 'deeper-com/alex-coal-deep',
    key: 'deepercom:2023-01-01:alex-coal--deep',
    title: 'Alex Coal - Deep',
    quality: '1080|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: 'Private.com - Alex Coal - Deep - 2023-01-01 - 1080p',
    scene: 'private-com/alex-coal-deep',
    key: 'privatecom:2023-01-01:alex-coal--deep',
    title: 'Alex Coal - Deep',
    quality: '1080|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: 'Nubiles.net - Alex Coal - Deep - 2023-01-01 - 1080p',
    scene: 'nubiles-net/alex-coal-deep',
    key: 'nubilesnet:2023-01-01:alex-coal--deep',
    title: 'Alex Coal - Deep',
    quality: '1080|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: '[Bang.com] - Alex Coal - Deep - 2023-01-01 - 1080p',
    scene: 'bang-com/alex-coal-deep',
    key: 'bangcom:2023-01-01:alex-coal--deep',
    title: 'Alex Coal - Deep',
    quality: '1080|-|-|-|-|-|-',
    isNew: true,
  },
  // A marked prefix is still stripped, path and scheme included.
  {
    name: 'http://www.site.com/rss - Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: true,
  },
  // A bracketed *bare* domain is a tracker stamp only when the name is not a
  // listing, and then it is safe to strip.
  {
    name: '[pornsite.net] Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'brazzers/alex-coal',
    key: 'brazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: true,
  },

  // --- Component re-splits in the listing form ------------------------------
  // Sorting the components is only safe if the join is injective. Joined with
  // a single "-" these four collapse into two collisions, because `slug()`
  // emits "-" as well and the component boundaries dissolve.
  {
    name: '[Vixen] Kylie - Page Turner - 2023-07-19',
    scene: 'vixen/kylie--page-turner',
    key: 'vixen:2023-07-19:kylie--page-turner',
    title: 'Kylie - Page Turner',
    quality: '-|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: '[Vixen] Kylie Page - Turner - 2023-07-19',
    scene: 'vixen/kylie-page--turner',
    key: 'vixen:2023-07-19:kylie-page--turner',
    title: 'Kylie Page - Turner',
    quality: '-|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: '[Tushy] Anna Bell - Peaks - 2023-07-22',
    scene: 'tushy/anna-bell--peaks',
    key: 'tushy:2023-07-22:anna-bell--peaks',
    title: 'Anna Bell - Peaks',
    quality: '-|-|-|-|-|-|-',
    isNew: true,
  },
  {
    name: '[Tushy] Anna - Bell Peaks - 2023-07-22',
    scene: 'tushy/anna--bell-peaks',
    key: 'tushy:2023-07-22:anna--bell-peaks',
    title: 'Anna - Bell Peaks',
    quality: '-|-|-|-|-|-|-',
    isNew: true,
  },

  // --- A tracker stamp in front of a dotted name ---------------------------
  // The leading bracket must not hand the name to the listing recogniser: that
  // reading finds a date but no encode section, so every encode in the group
  // scores identically and upgrade detection dies. Quality is the assertion
  // that catches it; the key alone looks fine.
  {
    name: '[EmpornIum] Brazzers.2023.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
    scene: 'empornium-brazzers/alex-coal',
    key: 'emporniumbrazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '1080|-|-|mp4|-|-|WRB',
    isNew: true,
  },
  {
    name: '[EmpornIum] Brazzers.2023.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-WRB',
    scene: 'empornium-brazzers/alex-coal',
    key: 'emporniumbrazzers:2023-04-15:alex-coal',
    title: 'Alex Coal',
    quality: '2160|-|h265|mp4|-|-|WRB',
    isNew: true,
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
    'a bare year is not a release date, and no site named "Some Random" or "Some" is confirmed, so nothing marks where the site stops',
  ],
  [
    '23.04.15.Alex.Coal.XXX.1080p.MP4-G',
    'the date is first, so there is no site; every scene on that day would share a key',
  ],
  ['Site.23.13.45.Name.XXX.1080p.MP4-G', 'month 13 and day 45 are not a calendar date'],
  ['Site.23.02.30.Name.XXX.1080p.MP4-G', 'February 30 does not exist'],
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
  // NON_GROUP_TERMS is now the only guard on a trailing tag, casing having
  // been abandoned as a signal. Every row below is a tag whose entry in that
  // list is the sole reason it is not detached as a group, and each is a case
  // where merging destroys something: two halves of one scene, or two cuts of
  // it. Removing an entry re-opens exactly one merge, silently.
  [
    'Site.23.04.15.Name.XXX.1080p.MP4-Part1',
    'a part tag, not a group: detaching it would merge the two halves of one scene under a single key',
  ],
  [
    'Site.23.04.15.Name.XXX.1080p.MP4-Part2',
    'the other half of the same scene, refused for the same reason',
  ],
  ['Site.23.04.15.Name.XXX.1080p.MP4-UNCUT', 'an edit tag in NON_GROUP_TERMS, correctly capitalised'],
  ['Site.23.04.15.Name.XXX.1080p.MP4-FRENCH', 'a language tag, not a group'],
  ['Site.23.04.15.Name.XXX.1080p.HEVC.UNCUT', 'the same, dot-attached'],
  [
    'Site.23.04.15.Name.XXX.1080p.MP4-PART1',
    'a numbered part tag in caps: only stripping the digits before the lookup rejects it, and merging PART1 with PART2 is the same over-collation',
  ],
  ['Site.23.04.15.Name.XXX.1080p.MP4-PART2', 'the other half, refused for the same reason'],
  // Disc and part numbering, the other half of the same class. Each of these
  // is rejected only by its own `NON_GROUP_TERMS` entry, so each entry needs
  // its own row or removing it silently re-opens the merge.
  ['Site.23.04.15.Name.XXX.1080p.MP4-CD1', 'disc numbering, not a group'],
  ['Site.23.04.15.Name.XXX.1080p.MP4-CD2', 'the other disc of the same scene'],
  ['Site.23.04.15.Name.XXX.1080p.MP4-PT1', 'abbreviated part numbering'],
  ['Site.23.04.15.Name.XXX.1080p.MP4-PT2', 'the other part of the same scene'],
  ['Site.23.04.15.Name.XXX.1080p.MP4-DISC1', 'spelled-out disc numbering'],
  ['Site.23.04.15.Name.XXX.1080p.MP4-DISC2', 'the other disc of the same scene'],
  [
    'Site.23.04.15.Name.XXX.1080p.HEVC.G',
    'a single character attached by the name\'s own separator is a stray, not a group; a hyphen is what makes a one-letter tag like "-G" credible',
  ],
  // The date-at-end shape is only recognised when *everything* after the date
  // is encode information and there is more before the date than after it.
  // These separate the two conditions, and each is what keeps a normal-form
  // name from being re-read as a date-at-end one.
  [
    'Site.2022.09.29.1080p.MP4',
    'only one token before the date against two after: the ordinary form, whose title would be empty',
  ],
  // Raising the cap to 12 moved every 9-12 character edit tag out from behind
  // it, leaving NON_GROUP_TERMS as their only guard. These rows are what make
  // that list load-bearing in the newly exposed band: each is a *different cut
  // or different content*, so detaching it as a group merges it with the scene
  // proper. DIRECTORS and REMASTERED were already listed and were previously
  // redundant with the cap; they are no longer redundant.
  // REMASTERED used to sit here too. Real titles put it *inside* the encode
  // run — `XXX.REMASTERED.XviD-iPT Team` — which is where REPACK and PROPER
  // sit, so it is encode vocabulary and a remaster collates with the original
  // as another version of one scene.
  ['Site.23.04.15.Name.XXX.1080p.MP4-DIRECTORS', 'nine characters, an edit tag the old cap hid'],
  ['Site.23.04.15.Name.XXX.1080p.MP4-UNCENSORED', 'a different cut, not a group'],
  ['Site.23.04.15.Name.XXX.1080p.MP4-DIRECTORSCUT', 'the same at the full twelve characters'],
  ['Site.23.04.15.Name.XXX.1080p.MP4-COMPILATION', 'different content entirely, not one scene'],
];

/**
 * `site : anchor : scene`. The anchor is an ISO date, an episode number, or
 * empty for a name that carries neither — never anything else, because the
 * whole key is rendered back into a library path and that round trip only
 * survives inside this alphabet.
 */
const KEY_SHAPE = /^[a-z0-9-]+:(?:\d{4}-\d{2}-\d{2}|e\d+|):[a-z0-9-]+$/;

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

test('corpus: every accepted name keeps its full quality tokens', () => {
  for (const entry of CORPUS) {
    assert.equal(qualitySignature(parsed(entry.name).quality), entry.quality, entry.name);
  }
});

test('corpus: encodes of one scene are ranked apart, never tied by a lost token', () => {
  // The consequence of the assertion above, stated as the behaviour that
  // actually matters: within a scene, rows that pin a different *rank* must
  // score differently. A shape that silently drops quality ties them.
  //
  // Resolution is not the only column that ranks a row, which is the correction
  // here: comparing on resolution alone skipped every same-resolution pair, so
  // an upscale tying the native encode it collates with — the exact tie
  // `UPSCALE_PENALTY` exists to break, and enough on its own for `flagUpgrade`
  // to trash the native file — passed unnoticed. Upscaled is compared too.
  const rank = (entry: Entry): string => {
    const fields = entry.quality.split('|');
    return `${fields[0]}|${fields[5]}`;
  };

  const byScene = new Map<string, Entry[]>();
  for (const entry of CORPUS) byScene.set(entry.scene, [...(byScene.get(entry.scene) ?? []), entry]);
  for (const [scene, entries] of byScene) {
    for (const a of entries) {
      for (const b of entries) {
        if (rank(a) === rank(b)) continue;
        assert.notEqual(
          scoreScene(parsed(a.name).quality),
          scoreScene(parsed(b.name).quality),
          `${scene}: ${a.name} and ${b.name} scored the same despite pinning different ranks`,
        );
      }
    }
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

test('corpus: the display never disagrees with the key about the anchor', () => {
  // `display.date` carries a real date or nothing. An episode number occupies
  // the same slot in the key but is not a date, and handing it to a consumer
  // that sorts or filters on that field would be a lie the type does not
  // prevent — so it is surfaced as its own field instead.
  for (const entry of CORPUS) {
    const release = parsed(entry.name);
    const anchor = release.identityKey.split(':')[1] ?? '';
    const episode = release.display.fields.find((field) => field.label === 'Episode');

    if (/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
      assert.equal(release.display.date, anchor, entry.name);
      assert.equal(episode, undefined, entry.name);
    } else if (anchor.length > 0) {
      assert.equal(release.display.date, undefined, entry.name);
      assert.equal(episode?.value, anchor.toUpperCase(), entry.name);
    } else {
      assert.equal(release.display.date, undefined, entry.name);
      assert.equal(episode, undefined, entry.name);
    }
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
 * Preserving order was rejected: it under-collates every time one site is
 * scraped by two indexers with different layouts, and under-collation here is
 * silent — two cards that look identical, with no way to tell which carries
 * the better encode.
 *
 * Sorting is sound *only because the join is injective*, and that is a
 * property of the delimiter, not of sorting. Joined with a single `-` it is
 * false: `slug()` emits `-` too, so component boundaries dissolve and any
 * re-split preserving alphabetical order collides — `Kylie` + `Page Turner`
 * and `Kylie Page` + `Turner` both render `kylie-page-turner`, and those are
 * different scenes. The join is therefore `--`, which `slug()` can never
 * produce inside a component (it collapses runs of non-alphanumerics to one
 * `-` and strips the edges) and which empty components cannot introduce (they
 * are filtered). With that delimiter the split is unique, the multiset
 * determines the string and vice versa, and the only remaining way for two
 * scenes to collide is for one site to publish, on one day, two scenes whose
 * component multisets are exact permutations of each other — which are the
 * same scene. Sharing a performer is not enough, because the title component
 * still differs.
 *
 * Both halves are pinned below, and the four re-split rows are in the corpus.
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

test('the component join is injective: a re-split of one string is a different key', () => {
  const pairs: [string, string][] = [
    ['[Vixen] Kylie - Page Turner - 2023-07-19', '[Vixen] Kylie Page - Turner - 2023-07-19'],
    ['[Tushy] Anna Bell - Peaks - 2023-07-22', '[Tushy] Anna - Bell Peaks - 2023-07-22'],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(parsed(a).identityKey, parsed(b).identityKey, `${a} vs ${b}`);
  }
});

test('a studio named after its domain keeps the studio as the site', () => {
  const studios = ['Bang.com', 'Deeper.com', 'Tushy.com', 'Private.com', 'Nubiles.net'];
  const keys = new Set<string>();
  for (const studio of studios) {
    const release = parsed(`${studio} - Alex Coal - Deep - 2023-01-01 - 1080p`);
    assert.equal(release.display.subtitle, studio, studio);
    // The key's site segment is the separator-free form, so the dot of the
    // domain is deleted rather than turned into a `-`. The studio's real
    // spelling is on `display.subtitle`, asserted above.
    assert.equal(release.identityKey.split(':')[0], studio.toLowerCase().replace('.', ''), studio);
    keys.add(release.identityKey);
  }
  assert.equal(keys.size, studios.length, `${JSON.stringify([...keys])}`);
});

test('a tracker stamp in front of a dotted name does not cost it its quality', () => {
  const bare = parsed('Brazzers.2023.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  const stamped = parsed('[EmpornIum] Brazzers.2023.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  assert.deepEqual(stamped.quality, bare.quality);
  assert.notEqual(
    scoreScene(stamped.quality),
    scoreScene(parsed('[EmpornIum] Brazzers.2023.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-WRB').quality),
  );
});

test('a part or edit tag is never detached as a release group', () => {
  const merged: [string, string][] = [
    ['Site.23.04.15.Name.XXX.1080p.MP4-Part1', 'Site.23.04.15.Name.XXX.1080p.MP4-Part2'],
    ['Site.23.04.15.Name.XXX.1080p.MP4-UNCUT', 'Site.23.04.15.Name.XXX.1080p.MP4-Bonus'],
    ['Site.23.04.15.Name.XXX.1080p.HEVC.UNCUT', 'Site.23.04.15.Name.XXX.1080p.HEVC.Bonus'],
  ];
  for (const [a, b] of merged) {
    const left = parseSceneRelease(a);
    const right = parseSceneRelease(b);
    assert.ok(
      left === null || right === null || left.identityKey !== right.identityKey,
      `${a} and ${b} merged onto one key`,
    );
  }
});
