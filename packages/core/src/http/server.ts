import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { DownloadClient } from '../clients/types.ts';
import { browseGroups, getGroup, pickedGroups } from '../db/groups.ts';
import { allDownloads, getDownload, resetForRetry } from '../db/downloads.ts';
import { pickRelease } from '../pipeline/pick.ts';
import type { UntrackedEntry } from '../pipeline/reconcile.ts';
import { toDownloadView, toGroupView, type BrowseResponse } from './views.ts';

export interface ServerDeps {
  db: DatabaseSync;
  defaultClient: DownloadClient;
  untrackedFor(clientId: string): UntrackedEntry[];
  now(): number;
  /** Absolute path to the built SPA, or null to run API-only. */
  webRoot: string | null;
}

const browseQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().min(1).optional(),
});

const pickBodySchema = z.object({ releaseId: z.number().int().positive() });
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

function parseCursor(raw: string | undefined): { listRankAt: number; id: number } | null {
  if (raw === undefined) return null;
  const [rank, id] = raw.split(':');
  const listRankAt = Number(rank);
  const groupId = Number(id);
  if (!Number.isFinite(listRankAt) || !Number.isFinite(groupId)) return null;
  return { listRankAt, id: groupId };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });
  const { db } = deps;

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
      groups: groups.map((group) => toGroupView(db, group)),
      nextCursor: hasMore && last !== undefined ? `${last.listRankAt}:${last.id}` : null,
    };
    return response;
  });

  server.get('/api/picks', async () => ({
    groups: pickedGroups(db).map((group) => toGroupView(db, group)),
  }));

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
      return toDownloadView(db, download);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  server.get('/api/downloads', async () => ({
    tracked: allDownloads(db).map((download) => toDownloadView(db, download)),
    untracked: deps.untrackedFor(deps.defaultClient.id),
  }));

  server.post('/api/downloads/:id/retry', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });
    if (getDownload(db, params.data.id) === null) {
      return reply.code(404).send({ error: 'No such download' });
    }

    const download = resetForRetry(db, params.data.id, deps.now());
    if (download === null) return reply.code(404).send({ error: 'No such download' });
    return toDownloadView(db, download);
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
