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
 *
 * One file per tier; the tier name is the file's basename.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  lastRefusalReason,
  parseSceneRelease,
  sceneSiteCandidates,
} from '@pickarr/plugin-scenes';

interface Options {
  files: string[];
  sitesFile: string | null;
  examples: number;
  holdoutPercent: number;
  showCollisions: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    files: [],
    sitesFile: null,
    examples: 3,
    holdoutPercent: 10,
    showCollisions: 15,
  };
  for (const arg of argv) {
    if (arg.startsWith('--sites=')) options.sitesFile = arg.slice('--sites='.length);
    else if (arg.startsWith('--examples=')) options.examples = Number(arg.slice('--examples='.length));
    else if (arg.startsWith('--holdout=')) options.holdoutPercent = Number(arg.slice('--holdout='.length));
    else if (arg.startsWith('--collisions='))
      options.showCollisions = Number(arg.slice('--collisions='.length));
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
  /\.part\d+\.(rar|nzb)\b|\.par2\b|\.vol\d+\+\d+|\.r\d{2}\b|yEnc|^\s*\[\d+\/\d+\]|\.nzb\b/i;

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
 */
function contentFingerprint(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(?:\d{3,4}p(?:\d{2,3})?|4k|8k|uhd|sd|hd)\b/g, '')
    .replace(/\b(?:x26[45]|h ?26[45]|hevc|avc|av1|xvid|divx|vp9)\b/g, '')
    .replace(/\b(?:mp4|mkv|avi|wmv|mov|m4v|flv|ts|webm)\b/g, '')
    .replace(/\b(?:web[- ]?dl|web[- ]?rip|siterip|blu[- ]?ray|bd[- ]?rip|dvd[- ]?rip|hdtv)\b/g, '')
    .replace(/\b(?:aac\d?|ac3|eac3|ddp?\d?|mp3|flac|opus|\d{1,2}bit|hdr(?:10)?|dv)\b/g, '')
    .replace(/\b(?:vr|3d|sbs|lr|ou|mono|fisheye\d*|mkx\d+|oculus|gearvr|psvr)\b/g, '')
    .replace(/-[a-z0-9]{1,12}$/, '')
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let sites: string[] = [];
  if (options.sitesFile !== null) {
    sites = (await readFile(options.sitesFile, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }
  const parseOptions = { sites };

  const reports: TierReport[] = [];
  const keyToTitles = new Map<string, Set<string>>();
  const siteQueries = new Map<string, number>();

  for (const file of options.files) {
    const raw = (await readFile(file, 'utf8')).split('\n').map((line) => line.trim());
    const lines = raw.filter((line) => line.length > 0);
    const unique = [...new Set(lines)];
    const signal = unique.filter((title) => !USENET_NOISE.test(title));

    const report: TierReport = {
      tier: basename(file).replace(/\.[^.]+$/, ''),
      lines: lines.length,
      unique: unique.length,
      noise: unique.length - signal.length,
      held: 0,
      measured: 0,
      parsed: 0,
      refusals: new Map(),
    };

    for (const title of signal) {
      if (heldOut(title, options.holdoutPercent)) {
        report.held += 1;
        continue;
      }
      report.measured += 1;

      const result = parseSceneRelease(title, parseOptions);
      if (result === null) {
        const reason = lastRefusalReason() ?? 'unrecognized';
        const bucket = report.refusals.get(reason) ?? [];
        bucket.push(title);
        report.refusals.set(reason, bucket);

        // What a site lookup would be asked, had one been enabled.
        const candidates = sceneSiteCandidates(title, parseOptions);
        for (const query of candidates?.queries ?? []) {
          siteQueries.set(query, (siteQueries.get(query) ?? 0) + 1);
        }
        continue;
      }

      report.parsed += 1;
      const titles = keyToTitles.get(result.identityKey) ?? new Set<string>();
      titles.add(title);
      keyToTitles.set(result.identityKey, titles);
    }

    reports.push(report);
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
    const fingerprints = new Set([...titles].map(contentFingerprint));
    if (fingerprints.size > 1) suspicious.push({ key, titles: [...titles] });
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

  if (options.holdoutPercent > 0) {
    const held = reports.reduce((sum, r) => sum + r.held, 0);
    console.log(`\n  ${held} titles held back and never measured. Re-run with --holdout=0 to check against them.`);
  }
}

main().catch((error: Error) => {
  console.error(`corpus: ${error.message}`);
  process.exit(1);
});
