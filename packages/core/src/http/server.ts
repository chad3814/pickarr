import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ManualField, MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import type { DownloadClient } from '../clients/types.ts';
import {
  browsableGroup,
  browseGroups,
  getGroup,
  pickedGroups,
  type GroupRow,
} from '../db/groups.ts';
import { allDownloads, getDownload, resetForRetry } from '../db/downloads.ts';
import { failedFeedItems } from '../db/feed-items.ts';
import { validateIdentity } from '../ingest/commit.ts';
import {
  dismissFeedItem,
  editGroup,
  editRelease,
  resolveFeedItem,
  type ManualDeps,
} from '../manual/operations.ts';
import { pickRelease } from '../pipeline/pick.ts';
import type { PluginRegistry } from '../plugins/registry.ts';
import type { UntrackedEntry } from '../pipeline/reconcile.ts';
import {
  toDownloadView,
  toFailedItemView,
  toGroupView,
  type BrowseResponse,
  type FailedResponse,
  type GroupEditResponse,
  type GroupView,
  type PickResponse,
  type ReleaseEditResponse,
  type ResolveResponse,
} from './views.ts';

export interface ServerDeps {
  db: DatabaseSync;
  defaultClient: DownloadClient;
  untrackedFor(clientId: string): UntrackedEntry[];
  now(): number;
  /** Absolute path to the built SPA, or null to run API-only. */
  webRoot: string | null;
  registry: PluginRegistry;
  /**
   * The plugin configured for a feed, or null when that feed has left
   * configuration. Feeds name their plugin by *package* and stored rows name it
   * by *id*, so a feed item — which has neither a group nor a release yet — can
   * only be mapped to a plugin by something holding the feed list.
   */
  pluginForFeed(feedId: string): MediaTypePlugin | null;
}

const browseQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().min(1).optional(),
});

const failedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // A string rather than a coerced boolean: `z.coerce.boolean()` reads every
  // non-empty string as true, so `?includeDismissed=false` would show them.
  includeDismissed: z.string().optional(),
});

const pickBodySchema = z.object({ releaseId: z.number().int().positive() });
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const valuesBodySchema = z.object({ values: z.record(z.string(), z.string()) });
const previewBodySchema = z.object({
  plugin: z.string().min(1),
  values: z.record(z.string(), z.string()),
});

function parseCursor(raw: string | undefined): { listRankAt: number; id: number } | null {
  if (raw === undefined) return null;
  const [rank, id] = raw.split(':');
  const listRankAt = Number(rank);
  const groupId = Number(id);
  if (!Number.isFinite(listRankAt) || !Number.isFinite(groupId)) return null;
  return { listRankAt, id: groupId };
}

/** The same `"<sort key>:<id>"` format browse uses, over the failed list's own sort key. */
function parseFailedCursor(raw: string | undefined): { firstSeenAt: number; id: number } | null {
  if (raw === undefined) return null;
  const [seen, id] = raw.split(':');
  const firstSeenAt = Number(seen);
  const itemId = Number(id);
  if (!Number.isFinite(firstSeenAt) || !Number.isFinite(itemId)) return null;
  return { firstSeenAt, id: itemId };
}

/**
 * A plugin's field list, or nothing.
 *
 * Nothing when it cannot also *consume* the values: a form whose every submit
 * is a 409 from `resolveFeedItem` is worse than no form, and Browse already
 * hides its Edit control for such a plugin — the two screens have to agree.
 *
 * Guarded for the same reason `toManualValues` is in `views.ts`: the hook's
 * contract makes no promise not to throw, so a plugin that does loses its own
 * form rather than every plugin's.
 */
function fieldsFor(plugin: MediaTypePlugin): readonly ManualField[] | undefined {
  if (plugin.manualFields === undefined || plugin.fromManualValues === undefined) {
    return undefined;
  }
  try {
    return plugin.manualFields();
  } catch {
    return undefined;
  }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });
  const { db } = deps;

  // Wrapped rather than passed by reference so that a `ServerDeps` written with
  // method shorthand keeps its receiver.
  const manual: ManualDeps = {
    db,
    registry: deps.registry,
    pluginForFeed: (feedId) => deps.pluginForFeed(feedId),
    now: () => deps.now(),
  };

  /** A group as the browse list would render it, prefill values and all. */
  const viewOf = (group: GroupRow): GroupView =>
    toGroupView(db, group, deps.registry.byId(group.plugin));

  /**
   * The group a manual operation left behind, read back after it committed —
   * on a merge that is the target, not the group the request named.
   */
  const groupAfter = (groupId: number): GroupView | null => {
    const group = getGroup(db, groupId);
    return group === null ? null : viewOf(group);
  };

  /**
   * The same group, read as the browse list sees it rather than as the database
   * does. Existence and standing are different questions with different
   * answers: a group that is gone is a 404, while a group that is still there
   * and no longer belongs in the list is a 200 whose payload is null — the
   * answer `/api/groups/:id/pick` already gives.
   */
  const listedAfter = (groupId: number): { missing: true } | { listed: GroupView | null } => {
    if (getGroup(db, groupId) === null) return { missing: true };
    const listed = browsableGroup(db, groupId);
    return { listed: listed === null ? null : viewOf(listed) };
  };

  // An empty body with `content-type: application/json` reads as `{}` rather
  // than Fastify's default 400 (FST_ERR_CTP_EMPTY_JSON_BODY), which it raises
  // before any handler runs. `/api/downloads/:id/retry` takes no body at all,
  // so under the default every retry from a client that sets the header
  // unconditionally — as this project's own SPA did, for its whole life — was
  // refused by the framework for a rule the route does not have. Routes that
  // do want a body are unaffected: they validate it with zod and reject `{}`
  // themselves, with their own message.
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string | Buffer, done) => {
      const text = body.toString().trim();
      if (text.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(text) as unknown);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  server.get('/api/health', async () => ({ status: 'ok' }));

  server.get('/api/browse', async (request, reply) => {
    const query = browseQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });

    // Fetched one row past the requested page so a page that is exactly
    // `limit` long can be told apart from the last page: without the extra
    // row, "the page came back exactly `limit` long" is ambiguous between
    // "there is more" and "that was exactly everything left."
    const overFetched = browseGroups(db, {
      cursor: parseCursor(query.data.cursor),
      limit: query.data.limit + 1,
      search: query.data.q ?? null,
    });
    const hasMore = overFetched.length > query.data.limit;
    const groups = hasMore ? overFetched.slice(0, query.data.limit) : overFetched;

    const last = groups.at(-1);
    const response: BrowseResponse = {
      groups: groups.map(viewOf),
      nextCursor: hasMore && last !== undefined ? `${last.listRankAt}:${last.id}` : null,
    };
    return response;
  });

  server.get('/api/picks', async () => ({ groups: pickedGroups(db).map(viewOf) }));

  server.post('/api/groups/:id/pick', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = pickBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const group = getGroup(db, params.data.id);
    if (group === null) return reply.code(404).send({ error: 'No such group' });

    // `kind` is not passed here: pickRelease derives it from the group's own
    // state internally (see pipeline/pick.ts). Accepting it from the caller
    // was removed in Task 11 — that was the entire point of the change, a
    // caller cannot get `kind` wrong if it cannot supply it.
    try {
      const download = await pickRelease(
        db,
        deps.defaultClient,
        { groupId: params.data.id, releaseId: body.data.releaseId },
        deps.now(),
      );
      // Read after the pick, not before: `markPicked` is what changes the
      // answer, and the answer is the whole point of returning it.
      const stillListed = browsableGroup(db, params.data.id);
      const response: PickResponse = {
        download: toDownloadView(db, download),
        group: stillListed === null ? null : viewOf(stillListed),
      };
      return response;
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  server.get('/api/downloads', async () => ({
    tracked: allDownloads(db).map((download) => toDownloadView(db, download)),
    untracked: deps.untrackedFor(deps.defaultClient.id),
  }));

  // Retry is only ever meaningful for a `failed` row, and it is actively
  // dangerous for the others. Resetting a row that is still `queued`,
  // `downloading`, `completed` or `importing` races the reconcile tick that
  // owns it; resetting an `imported` upgrade re-runs an import whose work is
  // already done, which is the one operation in the system that starts by
  // moving files out of the library. The SPA only offers the control on a
  // failed row, but "the UI does not offer it" is not an access rule — the
  // API is the boundary, so the check belongs here.
  server.post('/api/downloads/:id/retry', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });
    const existing = getDownload(db, params.data.id);
    if (existing === null) {
      return reply.code(404).send({ error: 'No such download' });
    }
    if (existing.status !== 'failed') {
      return reply
        .code(409)
        .send({ error: `Only a failed download can be retried; this one is ${existing.status}` });
    }

    const download = resetForRetry(db, params.data.id, deps.now());
    if (download === null) return reply.code(404).send({ error: 'No such download' });
    return toDownloadView(db, download);
  });

  // The form schemas, keyed by plugin id because that is what a group row and a
  // `FailedItemView` both carry. A plugin with no usable field list is left out
  // entirely rather than mapped to an empty array: absence is already how the
  // SPA decides there is no form to offer.
  server.get('/api/manual-fields', async () => {
    const schemas: Record<string, readonly ManualField[]> = {};
    for (const plugin of deps.registry.all()) {
      const fields = fieldsFor(plugin);
      if (fields !== undefined) schemas[plugin.id] = fields;
    }
    return schemas;
  });

  server.get('/api/failed', async (request, reply) => {
    const query = failedQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });

    // Over-fetched by one for the same reason `/api/browse` is: a page that
    // comes back exactly `limit` long is otherwise ambiguous between "there is
    // more" and "that was exactly everything left."
    const overFetched = failedFeedItems(db, {
      cursor: parseFailedCursor(query.data.cursor),
      limit: query.data.limit + 1,
      includeDismissed: query.data.includeDismissed === '1',
    });
    const hasMore = overFetched.length > query.data.limit;
    const items = hasMore ? overFetched.slice(0, query.data.limit) : overFetched;

    const last = items.at(-1);
    const response: FailedResponse = {
      items: items.map((item) => toFailedItemView(item, deps.pluginForFeed(item.feedId))),
      nextCursor: hasMore && last !== undefined ? `${last.firstSeenAt}:${last.id}` : null,
    };
    return response;
  });

  // Each of the four routes below carries the status the operation chose rather
  // than deriving one: which refusal means 400, 404 or 409 is a rule about the
  // operation, and a second copy of it here would be free to drift from it.
  server.post('/api/feed-items/:id/resolve', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = valuesBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const result = resolveFeedItem(manual, params.data.id, body.data.values);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });

    const group = groupAfter(result.ok.groupId);
    if (group === null) return reply.code(404).send({ error: 'No such group' });
    const response: ResolveResponse = { group, joinedExisting: result.ok.joinedExisting };
    return response;
  });

  server.post('/api/feed-items/:id/dismiss', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });

    const result = dismissFeedItem(manual, params.data.id);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });
    return { id: params.data.id, dismissedAt: result.ok.dismissedAt };
  });

  server.patch('/api/groups/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = valuesBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const result = editGroup(manual, params.data.id, body.data.values);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });

    const group = groupAfter(result.ok.groupId);
    if (group === null) return reply.code(404).send({ error: 'No such group' });
    const response: GroupEditResponse = { group, mergedInto: result.ok.mergedInto };
    return response;
  });

  server.patch('/api/releases/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = valuesBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const result = editRelease(manual, params.data.id, body.data.values);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });

    // Read after the edit, and through `browsableGroup`: rescoring re-derives
    // the upgrade flag, and a picked group that was listed only because of that
    // flag leaves the browse list when the edit clears it. Answering with the
    // group anyway leaves the caller showing a card whose Pick button queues an
    // upgrade — trashing the live file for a release that just got worse.
    const after = listedAfter(result.ok.groupId);
    if ('missing' in after) return reply.code(404).send({ error: 'No such group' });
    const response: ReleaseEditResponse = { group: after.listed };
    return response;
  });

  // Writes nothing: it exists because a wrong manual identity is as durable as
  // a right one, and seeing the key before saving is the only guard against one.
  server.post('/api/manual-preview', async (request, reply) => {
    const body = previewBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });

    const plugin = deps.registry.byId(body.data.plugin);
    if (plugin === undefined) {
      return reply.code(404).send({ error: `No plugin loaded for id ${body.data.plugin}` });
    }
    const fromValues = plugin.fromManualValues;
    if (fromValues === undefined) {
      return reply
        .code(409)
        .send({ error: `plugin ${plugin.id} cannot build a release from typed values` });
    }

    // Rejected values answer 200 with `{ error }`, not a 4xx. The form calls
    // this on a debounce while the user is still typing, so a half-filled form
    // is the normal case and the plugin's complaint is a legitimate answer to
    // "what would these values produce?" — not a failed request. The SPA's
    // fetch helper throws on any non-2xx, which would turn every keystroke
    // before the last into an error. A malformed body above is a different
    // thing: the caller, not the values, is wrong.
    let built: { media: ParsedRelease } | { error: string };
    try {
      built = fromValues.call(plugin, body.data.values);
    } catch (error) {
      return { error: `plugin threw: ${(error as Error).message}` };
    }
    if ('error' in built) return { error: built.error };

    // The same identity checks a save would apply, so a preview cannot show a
    // key that a *group edit* would then refuse — `editGroup` runs exactly this
    // validator and nothing else.
    //
    // A resolve is not fully covered, and saying otherwise would overstate the
    // guard. `resolveFeedItem` goes through `validateParsed`, which is this
    // plus the quality half: it calls `plugin.score()` on the values and
    // refuses a score that is not a finite number. Those are quality-scoped
    // fields, and the identity key this returns is unaffected by them — so
    // what the preview shows is still right, but a resolve carrying the shown
    // key can still be refused for a reason the preview never asked about.
    const validated = validateIdentity(built.media);
    if ('error' in validated) return { error: validated.error };
    return { identityKey: validated.identity.identityKey };
  });

  if (deps.webRoot !== null) {
    void server.register(fastifyStatic, { root: deps.webRoot });
    // Any non-API path is a client route; hand back the SPA shell. This must
    // never shadow an API 404: the check below is the only thing keeping a
    // typo'd or removed API route from silently returning the SPA shell
    // instead of a 404, so it must stay in front of the sendFile fallback.
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return server;
}
