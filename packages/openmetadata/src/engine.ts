/**
 * The lookup flow, shared by every plugin built on this package.
 *
 * The branch below is the whole reason this is one engine and not three
 * plugins: the order the outcomes are read in is a correctness property, not a
 * style, and `PluginContext`'s own documentation warns about two of them.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PluginContext } from '@pickarr/contract';
import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/node-sqlite';
import type { LookupEnvelope, Media, MediaSuggestions } from './types.ts';
import type { lookupTable } from './table.ts';

export const LOOKUP_JOB = 'lookup';
export const POLL_JOB = 'poll';

/** How long a poll waits before asking again. */
export const POLL_DELAY_MS = 30_000;

/**
 * How many polls one lookup may spend.
 *
 * A poll that answers "not yet" enqueues the *next* poll, so the job runner's
 * `attempts` never rises and nothing else bounds the sequence. Twenty polls at
 * thirty seconds is ten minutes, after which the item is left `unresolved`
 * naming its lookup id -- visible, rather than `pending` forever.
 */
export const MAX_POLLS = 20;

export type LookupDb = ReturnType<typeof drizzle>;
export type LookupStateTable = ReturnType<typeof lookupTable>;

/** What a plugin is handed for its own rows. `raw` is already narrowed. */
export interface ApplyArgs {
  readonly media: Media;
  readonly mediaItemId: number;
  readonly raw: DatabaseSync;
  readonly ctx: PluginContext;
  readonly now: number;
}

/** Which rss item an answer is about, and how many polls it has already cost. */
export interface ApplyTarget {
  readonly rssItemId: number;
  readonly filename: string;
  readonly polls: number;
}

export interface EnvelopeDeps {
  readonly pluginId: string;
  readonly ctx: PluginContext;
  readonly raw: DatabaseSync;
  readonly db: LookupDb;
  readonly table: LookupStateTable;
  readonly now: number;
  apply(args: ApplyArgs): Promise<void>;
}

/**
 * What to tell a human about a name the service did not recognise.
 *
 * A lookup for something the provider has not indexed fails the same way as
 * one we misread, and `suggestions` is how the two are told apart: "we have
 * never seen this" against "we know the site, not the scene".
 */
export function describeUnresolved(filename: string, suggestions: MediaSuggestions | null): string {
  const parts: string[] = [];
  if (suggestions !== null) {
    if (suggestions.site !== null) parts.push(`site ${suggestions.site.name}`);
    if (suggestions.performers.length > 0) {
      parts.push(`performers ${suggestions.performers.map((person) => person.name).join(', ')}`);
    }
  }
  if (parts.length === 0) return `the lookup service did not recognise "${filename}"`;
  return `the lookup service recognised ${parts.join(' and ')} in "${filename}", but not the item itself`;
}

/**
 * The service's people, de-duplicated by the provider's own person id as they
 * are written, in the order the service gave them.
 */
async function attachPeople(media: Media, mediaItemId: number, ctx: PluginContext): Promise<void> {
  for (const person of media.people) {
    // eslint-disable-next-line no-await-in-loop -- one person at a time: `attachRole` needs the id this upsert returns, and the roles have to land in billing order
    const personId = await ctx.media.upsertPerson({ name: person.name, providerRef: person.providerRef });
    // eslint-disable-next-line no-await-in-loop -- see above; this is the same person's own role
    await ctx.media.attachRole(mediaItemId, {
      personId,
      role: person.role,
      name: person.characterName,
      billingOrder: person.billingOrder,
    });
  }
}

/**
 * A resolved answer, in the one order that survives a lost dedup race.
 *
 * The media item is created late -- after the answer arrived -- so the three
 * outcomes that identify nothing have no row to clean up. `MediaWriter` does
 * offer `updateMediaItem`, so creating early is implementable; it would only
 * add a row to drop on every refusal.
 */
async function applyResolved(
  envelope: LookupEnvelope,
  media: Media,
  target: ApplyTarget,
  deps: EnvelopeDeps,
): Promise<void> {
  const { ctx } = deps;
  const mine = await ctx.media.createMediaItem({
    pluginId: deps.pluginId,
    title: media.title,
    releaseDate: media.releaseDate,
    description: media.overview,
  });

  const claim = await ctx.media.claimProviderRef(mine, media.provider, media.providerRef);
  if (claim.dropped !== null) {
    // Lost the race. Nothing points at our row yet -- the rss item is linked
    // below, to whichever row kept the reference -- so dropping it now leaves
    // nothing dangling.
    await ctx.media.dropMediaItem(claim.dropped);
  }
  await ctx.media.relinkRssItem(target.rssItemId, claim.kept);

  await deps.db.update(deps.table)
    .set({
      mediaItemId: claim.kept,
      lookupId: envelope.lookupId,
      providerRef: media.providerRef,
      confidence: envelope.confidence,
      updatedAt: deps.now,
    })
    .where(eq(deps.table.rssItemId, target.rssItemId));

  // Against `claim.kept`, which may be a row another item wrote: every write
  // a plugin's `apply` makes is an upsert keyed on the media item or a
  // provider reference, so re-applying the winner's own answer is a no-op
  // rather than a duplicate.
  await deps.apply({ media, mediaItemId: claim.kept, raw: deps.raw, ctx, now: deps.now });
  await attachPeople(media, claim.kept, ctx);
  await ctx.media.setResolution(target.rssItemId, 'resolved', null);
}

/**
 * One answer, applied. The five outcomes, in the one order that reads them
 * correctly.
 */
export async function applyEnvelope(
  envelope: LookupEnvelope,
  target: ApplyTarget,
  deps: EnvelopeDeps,
): Promise<void> {
  const { ctx } = deps;

  // 1. Not here yet -- read FIRST, and per answer rather than per response. A
  //    batch always answers HTTP 200, and a partial entry carries the state it
  //    *expects* to reach, so neither the response arriving nor this entry's
  //    own state says whether the answer is present.
  if (envelope.partial || envelope.state === 'pending') {
    const polls = target.polls + 1;
    if (polls > MAX_POLLS) {
      await ctx.media.setResolution(
        target.rssItemId,
        'unresolved',
        `the lookup service never finished lookup ${envelope.lookupId} for "${target.filename}"`,
      );
      return;
    }
    await ctx.jobs.enqueue({
      kind: POLL_JOB,
      payload: { lookupId: envelope.lookupId, rssItemId: target.rssItemId, polls },
      runAt: deps.now + POLL_DELAY_MS,
    });
    // The resolution stays `pending`: nothing is known about this item yet.
    return;
  }

  // 2. A non-media file, successfully identified. Terminal: folding this into
  //    `unresolved` would retry a subtitle forever and show it to a reader as
  //    a problem they cannot fix.
  if (envelope.refusal !== null) {
    await ctx.media.setResolution(target.rssItemId, 'refused', envelope.refusal);
    return;
  }

  // 3. Not an error either: the name was not recognised, which is the state a
  //    human might fix. Nothing is enqueued -- a retry happens on request.
  if (envelope.state === 'unresolved') {
    await ctx.media.setResolution(
      target.rssItemId,
      'unresolved',
      describeUnresolved(target.filename, envelope.suggestions),
    );
    return;
  }

  // 4. Impossible per the document, which requires `media` on every envelope
  //    and fills it for a resolved one. Thrown rather than skipped: a resolved
  //    answer this code cannot use is a service change, and a job that failed
  //    is how anyone finds out.
  if (envelope.media === null) {
    throw new Error(`openmetadata: lookup ${envelope.lookupId} resolved with no media`);
  }

  // 5. The answer.
  await applyResolved(envelope, envelope.media, target, deps);
}
