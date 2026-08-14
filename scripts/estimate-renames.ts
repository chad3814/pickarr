/**
 * How many already-imported files would need renaming if the current parser were
 * applied to an existing library.
 *
 * Written for the suffix-token change, but it asks a question any parser change
 * has to answer: library paths derive from the identity key, so a change that
 * moves keys silently strands the files named under the old ones. The re-key pass
 * (docs/superpowers/specs/2026-08-14-rekey-scene-slugs-design.md) renames them,
 * and this is how its population is measured before and after.
 *
 * Method. For each live `imported_files` row, the destination is rendered twice
 * with the SAME plugin and the SAME quality tokens, varying only the identity:
 * once from the identity already stored on the group (which the old parser
 * produced, at import time) and once from a fresh parse of the release's
 * `raw_title` (what the new parser produces). Holding quality fixed isolates
 * this branch's effect without needing the base tree checked out — the branch
 * cannot move `{resolution}` or `{group}`.
 *
 * Usage: node --import tsx --conditions development scripts/estimate-renames.ts <db>
 */
import { DatabaseSync } from 'node:sqlite';
import createScenesPlugin from '../packages/plugin-scenes/src/index.ts';
import type { ParsedRelease } from '../packages/plugin-api/src/types.ts';

const dbPath = process.argv[2];
if (dbPath === undefined) {
  console.error('usage: estimate-renames.ts <db>');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

function tableExists(name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  );
}

// Parse with the site list a running instance would have, so multi-token sites
// resolve the way they do in production rather than collapsing to first-token
// guesses.
const sites: string[] = [];
for (const table of ['discovered_sites', 'sites']) {
  if (!tableExists(table)) continue;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const col = cols.find((c) => c.name === 'name') ?? cols.find((c) => c.name === 'site');
  if (col === undefined) continue;
  for (const row of db.prepare(`SELECT DISTINCT ${col.name} AS n FROM ${table}`).all() as {
    n: unknown;
  }[]) {
    if (typeof row.n === 'string' && row.n.length > 0) sites.push(row.n);
  }
}

const plugin = createScenesPlugin({ libraryRoot: '/library', sites });

interface Row {
  fileId: number;
  groupId: number;
  destPath: string;
  identityKey: string;
  display: string;
  editedAt: number | null;
}

const rows = db
  .prepare(
    `SELECT f.id AS fileId, f.group_id AS groupId, f.dest_path AS destPath,
            g.identity_key AS identityKey, g.display AS display, g.edited_at AS editedAt
       FROM imported_files f
       JOIN media_groups g ON g.id = f.group_id
      WHERE f.trashed_at IS NULL AND g.plugin = 'scenes'
      ORDER BY f.id`,
  )
  .all() as unknown as Row[];

const rawTitleFor = db.prepare(
  `SELECT fi.raw_title AS rawTitle
     FROM releases r
     JOIN feed_items fi ON fi.id = r.feed_item_id
    WHERE r.group_id = ?
    ORDER BY r.id
    LIMIT 1`,
);

function render(media: ParsedRelease, destPath: string): string | null {
  const slash = destPath.lastIndexOf('/');
  const base = slash === -1 ? destPath : destPath.slice(slash + 1);
  const plan = plugin.planImport(media, [
    { absolutePath: destPath, relativePath: base, sizeBytes: 1 },
  ]);
  return plan?.files[0]?.destination ?? null;
}

let live = 0;
let edited = 0;
let noRaw = 0;
let refused = 0;
let unchanged = 0;
const changed: { groupId: number; from: string; to: string; raw: string }[] = [];
const groupsChanged = new Set<number>();

for (const row of rows) {
  live += 1;
  if (row.editedAt !== null) {
    edited += 1;
    continue;
  }
  const rawRow = rawTitleFor.get(row.groupId) as { rawTitle?: unknown } | undefined;
  const raw = typeof rawRow?.rawTitle === 'string' ? rawRow.rawTitle : null;
  if (raw === null) {
    noRaw += 1;
    continue;
  }
  const fresh = plugin.parse(raw);
  if (fresh === null) {
    refused += 1;
    continue;
  }

  let display: ParsedRelease['display'];
  try {
    display = JSON.parse(row.display) as ParsedRelease['display'];
  } catch {
    noRaw += 1;
    continue;
  }

  // Same quality both sides; only the identity varies.
  const stored: ParsedRelease = {
    identityKey: row.identityKey,
    display,
    quality: fresh.quality,
  };
  const before = render(stored, row.destPath);
  const after = render(fresh, row.destPath);
  if (before === null || after === null) {
    refused += 1;
    continue;
  }
  if (before === after) {
    unchanged += 1;
    continue;
  }
  changed.push({ groupId: row.groupId, from: before, to: after, raw });
  groupsChanged.add(row.groupId);
}

console.log(`db                  : ${dbPath}`);
console.log(`site list           : ${sites.length} names`);
console.log(`live imported files : ${live}`);
console.log(`  hand-edited, skipped by the pass : ${edited}`);
console.log(`  no raw_title reachable           : ${noRaw}`);
console.log(`  raw_title refused / unrenderable : ${refused}`);
console.log(`  path unchanged                   : ${unchanged}`);
console.log(`  PATH WOULD CHANGE                : ${changed.length}`);
console.log(`groups affected     : ${groupsChanged.size}`);
console.log('');
for (const c of changed.slice(0, 40)) {
  console.log(`group ${c.groupId}`);
  console.log(`  raw   ${c.raw}`);
  console.log(`  from  ${c.from}`);
  console.log(`  to    ${c.to}`);
}
if (changed.length > 40) console.log(`... and ${changed.length - 40} more`);
