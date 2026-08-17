/**
 * Runs the *real* scenes parser over a corpus of indexer titles and reports
 * what it does with them.
 *
 * This is a harness, deliberately not a second parser. Every judgement below
 * comes from importing `@pickarr/plugin-scenes` and calling it; the script
 * only counts, groups and prints. A reimplementation would let the thing we
 * tune drift from the thing that ships, which is the failure this whole
 * exercise is meant to avoid.
 *
 *   npm run corpus -- corpus/uhd.txt corpus/hd.txt corpus/sd.txt
 *   npm run corpus -- corpus/*.txt --sites=sites.txt --examples=5
 *   npm run corpus -- corpus/uhd.txt --holdout=0        # include everything
 *   npm run corpus -- corpus/*.txt --no-learned-sites   # first pass only
 *
 * One file per tier; the tier name is the file's basename.
 *
 * The corpus is measured **twice**: once with the configured site list, which is
 * empty unless `--sites=` is given, and once with the site names the first pass
 * produced. The second pass is not a nicety — with no site list `matchSitePrefix`
 * never runs, so a whole half of the parser is unexercised and a change that
 * corrupts a configured site cannot move any number this harness prints. That
 * happened; see `learnedSiteNames`.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import createScenesPlugin, {
  lastRefusalReason,
  sceneSiteCandidates,
} from '@pickarr/plugin-scenes';
// Reached by path rather than by package name: @pickarr/core exports only its
// application entrypoint, and widening that for a dev script would add
// production surface nothing ships against. This is repo-local tooling.
import { createTpdbClient } from '../packages/core/src/clients/theporndb.ts';
import { openDatabase } from '../packages/core/src/db/open.ts';
import { knownSiteNames } from '../packages/core/src/db/sites.ts';
import { resolveSitesForBatch } from '../packages/core/src/pipeline/resolve-sites.ts';

interface Options {
  files: string[];
  sitesFile: string | null;
  examples: number;
  holdoutPercent: number;
  showCollisions: number;
  /** Send real site lookups. Requires TPDB_API_KEY in the environment. */
  lookups: boolean;
  /** Measure a second time with the site names the first pass produced. */
  selfSeed: boolean;
  /** Where confirmed and refused site prefixes persist between runs. */
  cachePath: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    files: [],
    sitesFile: null,
    examples: 3,
    holdoutPercent: 10,
    showCollisions: 15,
    lookups: false,
    selfSeed: true,
    cachePath: '/tmp/pickarr-corpus-sites.db',
  };
  for (const arg of argv) {
    if (arg === '--no-learned-sites') options.selfSeed = false;
    else if (arg.startsWith('--sites=')) options.sitesFile = arg.slice('--sites='.length);
    else if (arg.startsWith('--examples=')) options.examples = Number(arg.slice('--examples='.length));
    else if (arg.startsWith('--holdout=')) options.holdoutPercent = Number(arg.slice('--holdout='.length));
    else if (arg.startsWith('--collisions='))
      options.showCollisions = Number(arg.slice('--collisions='.length));
    else if (arg === '--lookups') options.lookups = true;
    else if (arg.startsWith('--cache=')) options.cachePath = arg.slice('--cache='.length);
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    else options.files.push(arg);
  }
  if (options.files.length === 0) {
    throw new Error('Usage: npm run corpus -- <file...> [--sites=f] [--examples=N] [--holdout=N]');
  }
  return options;
}

/**
 * Usenet artefacts rather than releases: archive volumes, parity files, and
 * raw NNTP subject lines. Counting these as parse failures would inflate the
 * failure rate with strings no parser should accept, and they cluster heavily
 * enough to dominate a report.
 */
const USENET_NOISE =
  /\.part\d+\.(rar|nzb)\b|\.par2\b|\.vol\d+\+\d+|\.r\d{2}\b|yEnc|\[\d+\/\d+\]|\.nzb\b|\._Screen\b/i;

/**
 * Stable 10% holdout, keyed on the title itself rather than on position, so
 * the same titles are held back across runs and across differently ordered
 * corpora. Tuning against a set you also measure on reports your own
 * overfitting back to you as success.
 */
function heldOut(title: string, percent: number): boolean {
  if (percent <= 0) return false;
  let hash = 2166136261;
  for (let index = 0; index < title.length; index += 1) {
    hash ^= title.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 100 < percent;
}

/**
 * Strips the parts of a title that legitimately differ between two encodes of
 * one scene, leaving a rough "what content is this" fingerprint.
 *
 * Used only to triage the collision report. Two titles that collide on an
 * identity key are *supposed* to when they are two encodes of one scene, so a
 * raw list of collisions is mostly correct behaviour and unreadable. Titles
 * whose fingerprints also differ are the ones worth a human look.
 *
 * The release group is removed using the value the parser actually detached,
 * not a guess at where it starts. A first version guessed, and every one of
 * the clusters it surfaced turned out to be a correct collation whose group
 * names simply differed — `-NBQ` against `-P0RNL0V3R` against `.P2P`. A
 * triage heuristic that reports mostly false positives is worse than none,
 * because it trains you to skim past the real ones.
 */
function contentFingerprint(title: string, releaseGroup: string | undefined): string {
  let text = title.toLowerCase();
  if (releaseGroup !== undefined && releaseGroup.length > 0) {
    text = text.replaceAll(releaseGroup.toLowerCase(), '');
  }
  return text
    .replace(/\b(?:19|20)?\d{2}[.\-_ ]\d{2}[.\-_ ]\d{2}\b/g, '')
    .replace(/\b\d{8}\b/g, '')
    .replace(/\bxxx\b/g, '')
    .replace(/\b(?:\d{3,4}[pi](?:\d{2,3})?|4k|8k|uhd|sd|hd)\b/g, '')
    .replace(/\b(?:x26[45]|h ?26[45]|hevc|avc|av1|xvid|divx|vp9)\b/g, '')
    .replace(/\b(?:mp4|mkv|avi|wmv|mov|m4v|flv|ts|webm)\b/g, '')
    .replace(/\b(?:web[- ]?dl|web[- ]?rip|siterip|blu[- ]?ray|bd[- ]?rip|dvd[- ]?rip|hdtv)\b/g, '')
    .replace(/\b(?:aac\d?|ac3|eac3|ddp?\d?|mp3|flac|opus|\d{1,2}bit|hdr(?:10)?|dv|p2p)\b/g, '')
    .replace(/\b(?:internal|repack|proper|multi|dual|upscaled?|remaster)\b/g, '')
    .replace(/\b(?:vr|3d|sbs|lr|ou|mono|fisheye\d*|mkx\d+|oculus|gearvr|psvr)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

interface TierReport {
  tier: string;
  lines: number;
  unique: number;
  noise: number;
  held: number;
  measured: number;
  parsed: number;
  refusals: Map<string, string[]>;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '  0.0%' : `${((part / whole) * 100).toFixed(1).padStart(5)}%`;
}

/** One tier's titles, gathered and filtered once so both passes measure the same set. */
interface Tier {
  name: string;
  lines: number;
  unique: number;
  noise: number;
  /** Signal titles, holdout already applied. */
  measured: string[];
  held: number;
}

/** Everything one pass over the corpus produces. */
interface Pass {
  reports: TierReport[];
  keyToTitles: Map<string, Set<string>>;
  fingerprints: Map<string, string>;
  siteQueries: Map<string, number>;
  /** Per title, for comparing one pass against another. `null` is a refusal. */
  outcomes: Map<string, { key: string; site: string } | null>;
}

/**
 * Parses every measured title with one site list.
 *
 * Split out so the corpus can be measured twice in one run — see
 * `learnedSiteNames`. The judgement is still entirely the plugin's; this only
 * counts and groups.
 */
function runPass(tiers: Tier[], sites: string[]): Pass {
  const plugin = createScenesPlugin({ libraryRoot: '/corpus', sites });
  const parseOptions = { sites };
  const pass: Pass = {
    reports: [],
    keyToTitles: new Map(),
    fingerprints: new Map(),
    siteQueries: new Map(),
    outcomes: new Map(),
  };

  for (const tier of tiers) {
    const report: TierReport = {
      tier: tier.name,
      lines: tier.lines,
      unique: tier.unique,
      noise: tier.noise,
      held: tier.held,
      measured: tier.measured.length,
      parsed: 0,
      refusals: new Map(),
    };

    for (const title of tier.measured) {
      const result = plugin.parse(title);
      if (result === null) {
        const reason = lastRefusalReason() ?? 'unrecognized';
        const bucket = report.refusals.get(reason) ?? [];
        bucket.push(title);
        report.refusals.set(reason, bucket);
        pass.outcomes.set(title, null);

        // What a site lookup would be asked, had one been enabled.
        const candidates = sceneSiteCandidates(title, parseOptions);
        for (const query of candidates?.queries ?? []) {
          pass.siteQueries.set(query, (pass.siteQueries.get(query) ?? 0) + 1);
        }
        continue;
      }

      report.parsed += 1;
      const titles = pass.keyToTitles.get(result.identityKey) ?? new Set<string>();
      titles.add(title);
      pass.keyToTitles.set(result.identityKey, titles);
      pass.fingerprints.set(title, contentFingerprint(title, result.quality.releaseGroup));
      pass.outcomes.set(title, {
        key: result.identityKey,
        site: result.display.subtitle ?? '',
      });
    }

    pass.reports.push(report);
  }

  return pass;
}

/**
 * The site names a pass produced, as a configured site list for a second pass.
 *
 * This exists because of a measurement that missed a Critical. Until it, every
 * run of this harness passed `sites: []` unless `--sites=` was given by hand, so
 * `matchSitePrefix` — and with it every multi-token site name, the whole reason
 * the site list exists — was never executed by the gate at all. A parser change
 * that corrupted a configured site was invisible here: with no site list, the
 * site is a first-token guess before and after, so the numbers cannot move.
 *
 * A running instance is never in that state. `learnSites` and `knownSiteNames`
 * accumulate exactly this list from names the parser has already read, so
 * seeding a second pass from the first is the deployment the corpus is standing
 * in for, not a synthetic worst case. It is also the only way to get a site list
 * with no configuration to hand.
 *
 * Self-seeded, so it is mildly circular: a site the parser reads wrongly is
 * offered back to it. That is a real limit and not a fatal one — the comparison
 * that matters is base against branch with the *same* list, and a list built
 * from the base run is what the site-segment diff is read against.
 */
function learnedSiteNames(pass: Pass, configured: string[]): string[] {
  // Configured names keep their given order and stay in front; only the learned
  // tail is sorted. Both halves of that matter.
  //
  // `matchSitePrefix` keeps the *first* display spelling it is offered for a
  // given `siteComparisonKey`, so the order of this list decides which spelling
  // of `hegre` / `Hegre` every release is filed under. Returning a `Set` in
  // insertion order made that depend on the order the corpus files were named
  // on the command line: the same nine files as `uhd.txt hd.txt` versus
  // `hd.txt uhd.txt` reported 435 against 206 for `site segment moved`, while
  // `parsed` (4133) and `identity keys moved` (153) were identical both ways.
  // The measured set was the same; only the metric added to catch site
  // corruption swung by a factor of two, which is the one number a reader of
  // this gate must be able to trust across runs.
  //
  // Configured spellings still win because an explicit `--sites=` file is an
  // answer, not a guess — sorting the whole list would let a learned `hegre`
  // outrank a configured `Hegre` on nothing but alphabetical luck.
  const ordered = [...new Set(configured)];
  const learned = new Set<string>();
  for (const outcome of pass.outcomes.values()) {
    if (outcome !== null && outcome.site.length > 0) learned.add(outcome.site);
  }
  for (const name of ordered) learned.delete(name);
  return [...ordered, ...[...learned].toSorted()];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let sites: string[] = [];
  if (options.sitesFile !== null) {
    sites = (await readFile(options.sitesFile, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }
  const plugin = createScenesPlugin({ libraryRoot: '/corpus', sites });

  // Deduplicated across every input, not just within each file. Corpora
  // pulled at different times overlap almost entirely — a second snapshot
  // seventeen hours later shared 2,337 of 2,337 SD titles with the first — and
  // counting a title once per file it appears in would report that overlap as
  // corpus size.
  //
  // Gathered once, before anything is parsed, so that both passes measure the
  // same set. Ordering matters for the same reason it does in main.ts: an
  // identity key outlives the tick, so a site learned after a name is parsed
  // cannot be applied to it.
  const seen = new Set<string>();
  const tiers: Tier[] = [];
  const allTitles: string[] = [];
  for (const file of options.files) {
    const raw = (await readFile(file, 'utf8')).split('\n').map((line) => line.trim());
    const lines = raw.filter((line) => line.length > 0);
    const unique = [...new Set(lines)].filter((title) => !seen.has(title));
    for (const title of unique) seen.add(title);
    const signal = unique.filter((title) => !USENET_NOISE.test(title));
    const measured = signal.filter((title) => !heldOut(title, options.holdoutPercent));
    allTitles.push(...signal);
    tiers.push({
      name: basename(file).replace(/\.[^.]+$/, ''),
      lines: lines.length,
      unique: unique.length,
      noise: unique.length - signal.length,
      measured,
      held: signal.length - measured.length,
    });
  }

  let lookupSummary = '';
  if (options.lookups) {
    const apiKey = process.env['TPDB_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('--lookups needs TPDB_API_KEY in the environment');
    }
    const db = openDatabase(options.cachePath);
    const seeded = knownSiteNames(db);
    if (seeded.length > 0) plugin.learnSites?.(seeded);

    const client = createTpdbClient(
      { type: 'theporndb', apiKey, baseUrl: 'https://api.theporndb.net' },
      fetch,
    );
    const started = Date.now();
    const failures: string[] = [];
    const result = await resolveSitesForBatch(
      { db, plugin, client, now: () => Date.now(), log: (m) => failures.push(m) },
      [...new Set(allTitles)],
    );
    lookupSummary =
      `  seeded from cache : ${seeded.length}\n` +
      `  confirmed         : ${result.confirmed.length}\n` +
      `  queries sent      : ${result.queried}\n` +
      `  answered by cache : ${result.cached}\n` +
      `  unresolved        : ${result.unresolved.length}\n` +
      `  lookup failures   : ${failures.length}\n` +
      `  elapsed           : ${Math.round((Date.now() - started) / 1000)}s\n` +
      `  cache             : ${options.cachePath}`;
  }

  const pass = runPass(tiers, sites);
  const { reports, keyToTitles, fingerprints, siteQueries } = pass;

  if (lookupSummary.length > 0) {
    console.log('\n=== Site lookups');
    console.log(lookupSummary);
  }

  // --- per-tier summary -----------------------------------------------------
  console.log('\n=== Parse rate by tier');
  console.log('  tier            lines  unique   noise    held  measured   parsed    rate');
  for (const r of reports) {
    console.log(
      `  ${r.tier.padEnd(14)} ${String(r.lines).padStart(6)} ${String(r.unique).padStart(7)}` +
        ` ${String(r.noise).padStart(7)} ${String(r.held).padStart(7)}` +
        ` ${String(r.measured).padStart(9)} ${String(r.parsed).padStart(8)} ${pct(r.parsed, r.measured)}`,
    );
  }
  const totalMeasured = reports.reduce((sum, r) => sum + r.measured, 0);
  const totalParsed = reports.reduce((sum, r) => sum + r.parsed, 0);
  console.log(
    `  ${'ALL'.padEnd(14)} ${String(reports.reduce((s, r) => s + r.lines, 0)).padStart(6)}` +
      `${' '.repeat(23)}` +
      ` ${String(totalMeasured).padStart(9)} ${String(totalParsed).padStart(8)} ${pct(totalParsed, totalMeasured)}`,
  );

  // --- refusals, ranked -----------------------------------------------------
  const combined = new Map<string, string[]>();
  for (const r of reports) {
    for (const [reason, titles] of r.refusals) {
      combined.set(reason, [...(combined.get(reason) ?? []), ...titles]);
    }
  }
  const ranked = [...combined.entries()].sort((a, b) => b[1].length - a[1].length);
  const refusedTotal = ranked.reduce((sum, [, titles]) => sum + titles.length, 0);

  console.log(`\n=== Why ${refusedTotal} titles were refused, most common first`);
  for (const [reason, titles] of ranked) {
    console.log(`\n  ${String(titles.length).padStart(6)}  ${pct(titles.length, refusedTotal)}  ${reason}`);
    for (const example of titles.slice(0, options.examples)) {
      console.log(`          ${example.slice(0, 96)}`);
    }
  }

  // --- collisions -----------------------------------------------------------
  const suspicious: { key: string; titles: string[] }[] = [];
  for (const [key, titles] of keyToTitles) {
    if (titles.size < 2) continue;
    const distinct = new Set([...titles].map((title) => fingerprints.get(title) ?? title));
    if (distinct.size > 1) suspicious.push({ key, titles: [...titles] });
  }
  suspicious.sort((a, b) => b.titles.length - a.titles.length);

  const collided = [...keyToTitles.values()].filter((t) => t.size > 1).length;
  console.log(`\n=== Collisions`);
  console.log(`  ${keyToTitles.size} distinct identity keys from ${totalParsed} parsed titles`);
  console.log(`  ${collided} keys hold more than one title (expected: encodes of one scene)`);
  console.log(`  ${suspicious.length} of those hold titles whose content differs — look at these`);
  for (const { key, titles } of suspicious.slice(0, options.showCollisions)) {
    console.log(`\n  ${key}`);
    for (const title of titles.slice(0, 6)) console.log(`      ${title.slice(0, 96)}`);
    if (titles.length > 6) console.log(`      ... and ${titles.length - 6} more`);
  }

  // --- site lookup demand ---------------------------------------------------
  const distinctQueries = siteQueries.size;
  const topQueries = [...siteQueries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`\n=== Site lookups this corpus would ask for (none were sent)`);
  console.log(`  ${distinctQueries} distinct queries, covering ${[...siteQueries.values()].reduce((a, b) => a + b, 0)} refusals`);
  for (const [query, count] of topQueries) {
    console.log(`  ${String(count).padStart(6)}  ${query}`);
  }

  // --- second pass, with the sites the first pass learned --------------------
  //
  // Everything above ran with whatever site list was configured, which for every
  // run of this harness before 2026-08-13 was the empty one. That is a gate
  // blind to `matchSitePrefix` — see `learnedSiteNames` for what it cost. This
  // pass exists so the default run exercises it.
  if (!options.selfSeed) {
    console.log('\n=== Site matching: skipped (--no-learned-sites)');
  } else {
    const learned = learnedSiteNames(pass, sites);
    const second = runPass(tiers, learned);
    const parsedAgain = second.reports.reduce((sum, r) => sum + r.parsed, 0);

    let keysMoved = 0;
    let sitesChanged = 0;
    const examples: string[] = [];
    for (const [title, before] of pass.outcomes) {
      const after = second.outcomes.get(title) ?? null;
      const beforeKey = before?.key ?? 'REFUSED';
      const afterKey = after?.key ?? 'REFUSED';
      if (beforeKey !== afterKey) keysMoved += 1;
      if ((before?.site ?? '') === (after?.site ?? '')) continue;
      sitesChanged += 1;
      if (examples.length < options.examples) {
        examples.push(`  ${before?.site ?? '(refused)'} -> ${after?.site ?? '(refused)'}\n      ${title.slice(0, 90)}`);
      }
    }

    const collidedAgain = [...second.keyToTitles.values()].filter((t) => t.size > 1).length;
    let suspiciousAgain = 0;
    for (const [, titles] of second.keyToTitles) {
      if (titles.size < 2) continue;
      const distinct = new Set([...titles].map((t) => second.fingerprints.get(t) ?? t));
      if (distinct.size > 1) suspiciousAgain += 1;
    }

    console.log(`\n=== Site matching, second pass over ${learned.length} learned site names`);
    console.log(`  ${learned.filter((name) => name.includes(' ')).length} of them are multi-token, which is what \`matchSitePrefix\` is for`);
    console.log(`  parsed            : ${parsedAgain} (first pass: ${totalParsed})`);
    console.log(`  identity keys moved: ${keysMoved}`);
    console.log(`  site segment moved : ${sitesChanged}`);
    console.log(`  collisions         : ${collidedAgain} keys hold >1 title, ${suspiciousAgain} of them suspicious`);
    for (const example of examples) console.log(example);
    if (sitesChanged > options.examples) {
      console.log(`  ... and ${sitesChanged - options.examples} more site changes`);
    }
    console.log('  Compare this block against the same block from the base commit: a site');
    console.log('  segment that changes here and not there is the regression class the');
    console.log('  first pass structurally cannot see.');
  }

  if (options.holdoutPercent > 0) {
    const held = reports.reduce((sum, r) => sum + r.held, 0);
    console.log(`\n  ${held} titles held back and never measured. Re-run with --holdout=0 to check against them.`);
  }
}

main().catch((error: Error) => {
  console.error(`corpus: ${error.message}`);
  process.exit(1);
});
