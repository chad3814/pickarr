export interface DisplayField {
  label: string;
  value: string;
}

export interface DisplayFields {
  title: string;
  subtitle?: string;
  date?: string;
  fields: DisplayField[];
}

export type QualityExtra = string | number | boolean;

export interface QualityTokens {
  resolution?: number;
  source?: string;
  videoCodec?: string;
  audioCodec?: string;
  bitrateKbps?: number;
  sizeBytes?: number;
  releaseGroup?: string;
  extras?: Record<string, QualityExtra>;
}

export type ManualFieldType = 'text' | 'number' | 'select';

/** Mirrors `ManualField` in `@pickarr/plugin-api`; see the note on `request` below. */
export interface ManualField {
  name: string;
  label: string;
  type: ManualFieldType;
  scope: 'identity' | 'quality';
  required?: boolean;
  /** Permitted values, for `type: 'select'`. An empty string means "unset". */
  options?: string[];
  placeholder?: string;
  help?: string;
}

/**
 * Keyed by plugin id. A plugin with no field list is *missing* from this map
 * rather than mapped to `[]`, which is how the SPA decides there is no form to
 * offer for its items at all.
 */
export type ManualFieldsResponse = Record<string, ManualField[]>;

export interface ReleaseView {
  id: number;
  score: number;
  quality: QualityTokens;
  releaseName: string;
  publishedAt: number | null;
  /**
   * The quality half of an edit form, prefilled. Optional rather than
   * `| undefined`: the server omits the key entirely for a plugin with no
   * `toManualValues`, and its absence is what says "offer no Edit control".
   */
  manualValues?: Record<string, string>;
  /**
   * True when this release's most recent download failed, and **absent**
   * otherwise — never `false`. The row reads `Failed`, in red, instead of
   * claiming the user has the file.
   */
  downloadFailed?: boolean;
}

/** Mirrors `PerformerView` in `packages/core/src/http/views.ts`; see the note on `MetadataView` below. */
export interface PerformerView {
  id: number;
  name: string;
  url: string;
  hasAvatar: boolean;
  hasImage: boolean;
}

/**
 * What the server can say about a group's scene metadata. Mirrors `MetadataView`
 * in `packages/core/src/http/views.ts` — duplicated rather than imported, the
 * same way `DisplayFields` and `QualityTokens` already are, because the web
 * package does not depend on core.
 *
 * `'pending'` and `'absent'` only ever come from `GET /api/metadata`, which is
 * the only endpoint that also consults the metadata queue to tell "asked, not
 * yet answered" from "never asked"; `GroupView.metadata` (from browse) reads
 * `group_metadata` alone and so is never `'pending'` there.
 */
/**
 * A group's cast, mirroring `CastView` in `packages/core/src/http/views.ts`.
 *
 * Beside `state` rather than inside the `'confirmed'` variant, for the reason
 * that type spells out: `group_performers` is keyed by group and one of its two
 * writers is the performer search, whose whole purpose is a group whose scene
 * lookup settled *without* a cast — most often `state: 'none'`. While the cast
 * lived inside `'confirmed'`, that search's output was unreachable in exactly
 * the case it exists for.
 *
 * Both fields optional here, unlike core's `CastView`, and for two different
 * reasons.
 *
 * `performerNames` is a new key, so a response from a build that predates it
 * genuinely lacks it — a tab left open across a restart onto an older build, or
 * a stale SPA bundle talking to a rolled-back API — and the `?? []` at each use
 * is what keeps that from being a crash.
 *
 * `performers` is not that case, and saying so matters because the obvious
 * reading is wrong: the key already existed before performer rows did, carrying
 * `string[]` — the same names `performerNames` holds now. An older server
 * therefore sends `performers`, not nothing, so `?? []` never fires and what
 * arrives is an array of strings where this code reads `.id` and `.name`. No
 * type can describe that away; only reloading onto the matching bundle fixes it.
 * The field stays optional for consistency with the one beside it, and because a
 * compiler that forces a check at each use costs nothing.
 *
 * Optional also keeps a bare `{ state: 'none' }` a valid `MetadataView`, which
 * is what a response from a server predating this change literally is.
 */
export interface CastView {
  performers?: PerformerView[];
  performerNames?: string[];
}

export type MetadataView = CastView &
  (
  | {
      state: 'confirmed';
      title: string | null;
      releaseDate: string | null;
      durationSeconds: number | null;
      synopsis: string | null;
      hasPoster: boolean;
      /**
       * Optional for the same "new key, older server" reason `performerNames`
       * is; `?? null` at the use site is what keeps its absence from being a
       * crash.
       */
      sceneUrl?: string | null;
    }
  | { state: 'none' }
  /**
   * `nextAttemptAt` is `metadata_queue.next_at` — the epoch ms the worker
   * will next try this group — read straight off the row `GET /api/metadata`
   * already has to consult to tell `pending` from `absent`. `useGroupMetadata`
   * sleeps until roughly that time instead of guessing with a fixed ladder;
   * see its `nextDelayFor` for the guardrails around trusting it literally.
   *
   * Optional rather than required, unlike core's `MetadataView`: the current
   * server always sends it, but this type also describes what a *response*
   * can contain, and a response can come from a server that predates this
   * field (a browser tab left open across a server restart onto an older
   * build, or a stale SPA bundle talking to a rolled-back API). The hook
   * falls back to its own backoff ladder rather than trusting an absent
   * field to mean anything.
   */
  | { state: 'pending'; nextAttemptAt?: number }
  | { state: 'absent' }
  );

/**
 * The answer to `POST /api/metadata/request`. Mirrors `MetadataRequestResponse`
 * in `packages/core/src/http/views.ts`. Five counters: an id naming a group
 * that no longer exists is neither queued, answered, nor waiting, so it gets
 * its own counter (`missing`); an id skipped only because there is currently
 * no worker to drain a queue row for it — metadata disabled, or enabled with
 * no client — gets `unavailable`, deliberately distinct from
 * `alreadyAnswered` since nothing was cached and a later request must still
 * be free to queue it. `queued + alreadyAnswered + pending + missing +
 * unavailable` always equals the number of ids sent. The SPA does not
 * currently read any of these counts — `useGroupMetadata` only cares whether
 * the call succeeded — but the shape is kept accurate rather than loosened to
 * `Record<string, number>`.
 */
export interface MetadataRequestResponse {
  queued: number;
  alreadyAnswered: number;
  pending: number;
  missing: number;
  unavailable: number;
}

/**
 * The answer to `POST /api/metadata/requery`. Mirrors `MetadataRequeryResponse`
 * in `packages/core/src/http/views.ts` — duplicated rather than imported, the
 * same way `MetadataRequestResponse` above already is, because the web
 * package does not depend on core.
 *
 * Four counters, not `MetadataRequestResponse`'s five: this route's
 * precondition is that the group is already settled, so there is no
 * `alreadyAnswered`/`pending` pair to report here — every id either gets
 * requeued or falls into one of the three ways it cannot. `unaskable` is the
 * one with no counterpart there: `/api/metadata/request` folds the same
 * "provider cannot answer this group" case into `alreadyAnswered`, which is
 * honest for a route whose group had no answer yet; here the group is already
 * settled, so the id gets its own outcome rather than reusing a counter that
 * would imply this route rewrote something.
 *
 * `requeued + missing + unavailable + unaskable` always equals the number of
 * distinct ids sent. The SPA does not currently read any of these counts —
 * the Requery button only cares whether the call succeeded — but the shape
 * is kept accurate rather than loosened to `Record<string, number>`, the same
 * choice `MetadataRequestResponse` already made.
 */
export interface MetadataRequeryResponse {
  requeued: number;
  missing: number;
  unavailable: number;
  unaskable: number;
}

export interface GroupView {
  id: number;
  plugin: string;
  display: DisplayFields;
  state: 'new' | 'picked';
  pickedReleaseId: number | null;
  upgradeReleaseId: number | null;
  listRankAt: number;
  releases: ReleaseView[];
  metadata: MetadataView;
  /** The identity half of an edit form, prefilled. Absent as on `ReleaseView`. */
  manualValues?: Record<string, string>;
  // Nothing group-level about failures. `/api/picks` already returns failed
  // groups first, so the order carries that fact; which row to mark is
  // `ReleaseView.downloadFailed`. The failed release is frequently not the
  // pick — an upgrade that failed leaves `pickedReleaseId` on the file the user
  // still has, and the pick is untouched by a failure either way: the user
  // still wants the content, so the group stays picked and its alternatives
  // stay on offer.
}

/** One name the parser refused, and everything a human needs to describe it. */
export interface FailedItemView {
  id: number;
  feedId: string;
  /** The plugin id, so the SPA picks the right schema. Empty when the feed has left configuration. */
  plugin: string;
  rawTitle: string;
  link: string;
  parseError: string;
  firstSeenAt: number;
  publishedAt: number | null;
  /** Best-effort and *sparse*: only the keys the plugin could work out. */
  suggestedValues: Record<string, string>;
  dismissedAt: number | null;
}

export interface FailedResponse {
  items: FailedItemView[];
  nextCursor: string | null;
}

export interface ResolveResponse {
  group: GroupView;
  joinedExisting: boolean;
}

export interface DismissResponse {
  id: number;
  dismissedAt: number;
}

/**
 * `group` is the *surviving* group, which on a merge is the target rather than
 * the one that was patched; `mergedInto` names it, and is null when nothing
 * merged. The caller knows the source id because it sent it, so the two
 * together are what let a paginated list drop one card and replace another.
 *
 * `renamed`, `trashed` and `failed` mirror `GroupEditResponse` in
 * `packages/core/src/http/views.ts` — carried through rather than folded away,
 * because a 200 that hid a per-file failure would tell the user their edit
 * fully succeeded when a file the plan promised to move or trash is not where
 * it said it would be.
 */
export interface GroupEditResponse {
  group: GroupView;
  mergedInto: number | null;
  renamed: number;
  trashed: number;
  failed: readonly { path: string; error: string }[];
}

/**
 * One file `planIdentityChange` would move because the identity that placed
 * it changed.
 */
export interface PlannedRenameView {
  importedFileId: number;
  from: string;
  to: string;
}

/**
 * One file `planIdentityChange` would trash because the release that owns it
 * lost the pick.
 */
export interface PlannedTrashView {
  importedFileId: number;
  path: string;
}

/**
 * Mirrors `IdentityPlan` in `packages/core/src/manual/identity-plan.ts` —
 * duplicated rather than imported, the same way `DisplayFields` and
 * `QualityTokens` already are, because the web package does not depend on
 * core.
 *
 * Not to be confused with `useIdentityPreview`'s per-keystroke key preview:
 * that hook knows only a plugin id and a draft set of values, never a group,
 * and never anything about merges, renames or trashing. This is the read-only
 * plan of everything a *specific group's* identity change would do, fetched
 * once per attempted save rather than on every keystroke.
 */
export interface IdentityPlanView {
  groupId: number;
  identityKey: string;
  /**
   * `none` — the key and the display both survive the edit.
   * `display-only` — the key survives, the display does not.
   * `rekey` — the key changes and belongs to no other group.
   * `merge` — the key belongs to another group, which will absorb this one.
   */
  kind: 'none' | 'display-only' | 'rekey' | 'merge';
  mergeInto: { id: number; title: string } | null;
  releasesMoving: number;
  downloadsMoving: number;
  pick: {
    surviving: { releaseId: number; score: number; side: 'source' | 'target' } | null;
    superseded: { releaseId: number; score: number } | null;
  };
  renames: readonly PlannedRenameView[];
  trashing: readonly PlannedTrashView[];
  /** Shown, and does not stop the apply. */
  warnings: readonly string[];
  /** Shown, and refuses the apply. */
  blockers: readonly string[];
  digest: string;
}

/**
 * `group` is the edited release's standing in browse afterwards; null means it
 * left, exactly as on `PickResponse`. Rescoring re-derives the upgrade flag, so
 * downgrading the release that was the only reason a picked group was listed
 * takes that group out of the list.
 */
export interface ReleaseEditResponse {
  group: GroupView | null;
}

/**
 * `/api/manual-preview` answers 200 either way: the form calls it on a debounce
 * while the user is still typing, so a plugin's complaint about a half-typed
 * date is an answer to "what would these values produce?", not a failed
 * request.
 */
export type ManualPreviewResponse = { identityKey: string } | { error: string };

export interface BrowseResponse {
  groups: GroupView[];
  nextCursor: string | null;
}

export interface PicksResponse {
  groups: GroupView[];
}

export interface DownloadView {
  id: number;
  groupId: number;
  releaseId: number;
  title: string;
  kind: 'initial' | 'upgrade';
  status: string;
  error: string | null;
  attempts: number;
  updatedAt: number;
  /** When the client first stopped reporting this download, or null while it is seen. */
  absentSince: number | null;
}

export interface UntrackedEntry {
  ref: string;
  name: string;
  state: 'downloading' | 'completed' | 'failed' | 'in-progress';
  percentage: number | null;
}

export interface DownloadsResponse {
  tracked: DownloadView[];
  untracked: UntrackedEntry[];
}

/** `group` is the group's standing in browse afterwards; null means it left. */
export interface PickResponse {
  download: DownloadView;
  group: GroupView | null;
}

/**
 * Thrown by `request` in place of a bare `Error`, carrying the HTTP status
 * alongside the message every existing `catch (cause) { (cause as
 * Error).message }` site already reads. `useIdentityChange` is the reason
 * `status` exists: a stale `planDigest` answers 409, and only that status
 * means "re-plan and try again" rather than "this failed, stop and say so".
 * Extending `Error` rather than standing alone keeps every caller written
 * before this type existed working unchanged.
 */
export class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

/**
 * `content-type: application/json` is set only when there is a body to
 * describe. Sending it on a bodyless POST is what broke retry from the day it
 * was written: Fastify's JSON parser sees the header, finds nothing to parse,
 * and answers 400 FST_ERR_CTP_EMPTY_JSON_BODY without the route ever running.
 * `/api/downloads/:id/retry` takes no body, so every click was a 400 — and
 * because the caller had no catch, a silent one.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const request: RequestInit =
    init?.body === undefined
      ? { ...init }
      : { ...init, headers: { 'content-type': 'application/json', ...init.headers } };
  const response = await fetch(path, request);
  if (!response.ok) {
    const body: { error?: string } = await response.json().catch(() => ({}));
    throw new RequestError(
      body.error ?? `Request to ${path} failed with ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

/** Mirrors `SecretView` in `packages/core/src/config/editable.ts`. */
export type SecretView = { kind: 'file'; path: string } | { kind: 'set' };

/** Mirrors `SecretEdit` in `packages/core/src/config/editable.ts`. */
export type SecretEdit = { kind: 'keep' } | { kind: 'file'; path: string } | { kind: 'literal'; value: string };

/** Mirrors `EditablePathMapping` in `packages/core/src/config/editable.ts`. */
export interface EditablePathMapping {
  from: string;
  to: string;
}

/** Mirrors `EditableDownloadClient` in `packages/core/src/config/editable.ts`. */
export interface EditableDownloadClient {
  id: string;
  type: 'sabnzbd';
  url: string;
  apiKey: SecretView;
  category: string;
  importMode: 'move' | 'copy';
  pathMappings: EditablePathMapping[];
}

/** Mirrors `EditableFeed` in `packages/core/src/config/editable.ts`. */
export interface EditableFeed {
  id: string;
  url: string;
  plugin: string;
  intervalSeconds: number;
}

/** Mirrors `EditableSiteLookup` in `packages/core/src/config/editable.ts`. */
export interface EditableSiteLookup {
  type: 'theporndb';
  apiKey: SecretView;
  baseUrl: string;
}

/** Mirrors `EditableMetadata` in `packages/core/src/config/editable.ts`. */
export interface EditableMetadata {
  enabled: boolean;
  intervalSeconds: number;
  perTick: number;
  artworkDir: string | null;
}

/** Mirrors `PluginSettingValue` in `packages/core/src/config/editable.ts`. */
export type PluginSettingValue = string | number | boolean | string[];

/** Mirrors `EditableConfig` in `packages/core/src/config/editable.ts`. */
export interface EditableConfig {
  server: { port: number };
  database: { path: string };
  trashDir: string;
  plugins: Record<string, Record<string, PluginSettingValue>>;
  downloadClients: EditableDownloadClient[];
  feeds: EditableFeed[];
  siteLookup: EditableSiteLookup | null;
  metadata: EditableMetadata;
}

/** Mirrors `SubmittedDownloadClient` in `packages/core/src/config/editable.ts`. */
export interface SubmittedDownloadClient {
  id: string;
  type: 'sabnzbd';
  url: string;
  apiKey: SecretEdit;
  category: string;
  importMode: 'move' | 'copy';
  pathMappings: EditablePathMapping[];
}

/** Mirrors `SubmittedSiteLookup` in `packages/core/src/config/editable.ts`. */
export interface SubmittedSiteLookup {
  type: 'theporndb';
  apiKey: SecretEdit;
  baseUrl: string;
}

/** Mirrors `SubmittedConfig` in `packages/core/src/config/editable.ts`. */
export interface SubmittedConfig {
  server: { port: number };
  database: { path: string };
  trashDir: string;
  plugins: Record<string, Record<string, PluginSettingValue>>;
  downloadClients: SubmittedDownloadClient[];
  feeds: EditableFeed[];
  siteLookup: SubmittedSiteLookup | null;
  metadata: EditableMetadata;
}

/** Mirrors `ConfigResponse` in `packages/core/src/http/views.ts`. */
export interface ConfigResponse {
  config: EditableConfig;
  portOverride: number | null;
  restartRequired: boolean;
}

/**
 * Mirrors `ConfigSaveResponse` in `packages/core/src/http/views.ts`.
 * `restartRequired` is `boolean`, not the literal `true`: a save that writes
 * back exactly what the process booted from needs no restart, and
 * `GET /api/config` computes that the same way, so the two endpoints must not
 * be able to contradict each other.
 */
export interface ConfigSaveResponse {
  savedAt: number;
  restartRequired: boolean;
}

/** What `api.backupDatabase` resolves to: the file, and the name it arrived with. */
export interface DatabaseBackup {
  blob: Blob;
  filename: string;
}

export const api = {
  browse: (cursor: string | null, search: string) => {
    const params = new URLSearchParams();
    if (cursor !== null) params.set('cursor', cursor);
    if (search.length > 0) params.set('q', search);
    return request<BrowseResponse>(`/api/browse?${params.toString()}`);
  },
  picks: () => request<PicksResponse>('/api/picks'),
  downloads: () => request<DownloadsResponse>('/api/downloads'),
  pick: (groupId: number, releaseId: number) =>
    request<PickResponse>(`/api/groups/${groupId}/pick`, {
      method: 'POST',
      body: JSON.stringify({ releaseId }),
    }),
  retry: (downloadId: number) =>
    request<DownloadView>(`/api/downloads/${downloadId}/retry`, { method: 'POST' }),
  manualFields: () => request<ManualFieldsResponse>('/api/manual-fields'),
  failed: (cursor: string | null, includeDismissed: boolean) => {
    const params = new URLSearchParams();
    if (cursor !== null) params.set('cursor', cursor);
    // The literal '1'; the server compares against it rather than coercing,
    // because every non-empty string coerces to true and `=false` would then
    // include them.
    if (includeDismissed) params.set('includeDismissed', '1');
    return request<FailedResponse>(`/api/failed?${params.toString()}`);
  },
  resolveFeedItem: (feedItemId: number, values: Record<string, string>) =>
    request<ResolveResponse>(`/api/feed-items/${feedItemId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ values }),
    }),
  dismissFeedItem: (feedItemId: number) =>
    request<DismissResponse>(`/api/feed-items/${feedItemId}/dismiss`, { method: 'POST' }),
  /**
   * `planDigest` is included in the body only when defined — `values` alone,
   * unadorned, when it is not — because `exactOptionalPropertyTypes` treats
   * `{ planDigest: undefined }` as a different shape from the key's absence,
   * and the server's `editBodySchema` only accepts the latter.
   */
  editGroup: (groupId: number, values: Record<string, string>, planDigest?: string) =>
    request<GroupEditResponse>(`/api/groups/${groupId}`, {
      method: 'PATCH',
      body: JSON.stringify(planDigest === undefined ? { values } : { values, planDigest }),
    }),
  /**
   * Everything an identity change would do, and nothing done — see
   * `IdentityPlanView`. Not to be confused with `manualPreview`, which asks
   * only "what key would these values produce" and knows no group at all.
   */
  identityPlan: (groupId: number, values: Record<string, string>) =>
    request<IdentityPlanView>(`/api/groups/${groupId}/identity-plan`, {
      method: 'POST',
      body: JSON.stringify({ values }),
    }),
  editRelease: (releaseId: number, values: Record<string, string>) =>
    request<ReleaseEditResponse>(`/api/releases/${releaseId}`, {
      method: 'PATCH',
      body: JSON.stringify({ values }),
    }),
  manualPreview: (plugin: string, values: Record<string, string>) =>
    request<ManualPreviewResponse>('/api/manual-preview', {
      method: 'POST',
      body: JSON.stringify({ plugin, values }),
    }),
  /**
   * The explicit enqueue: the server never fetches metadata as a side effect
   * of a read, so this is the only thing that ever puts a group on the queue.
   * `signal` is threaded through (rather than folded into a fixed `init`)
   * so `useGroupMetadata` can abort an in-flight request on unmount without
   * `exactOptionalPropertyTypes` objecting to an explicitly-`undefined`
   * `signal` on the common, non-aborting call sites.
   */
  requestMetadata: (groupIds: number[], signal?: AbortSignal) => {
    const init: RequestInit = { method: 'POST', body: JSON.stringify({ groupIds }) };
    return request<MetadataRequestResponse>(
      '/api/metadata/request',
      signal === undefined ? init : { ...init, signal },
    );
  },
  /**
   * Re-asks the provider for a group that already has a settled answer —
   * `MediaCard`'s Requery button is the only caller — through
   * `requeryOneGroup`, which is what the routes actually call. Deliberately
   * separate from `requestMetadata`: that call is `useGroupMetadata`'s own
   * lazy trigger, and it is the *server* that keeps the two apart rather than
   * the id lists being disjoint. Settled ids do reach `requestMetadata` — the
   * hook asks about every id it has not resolved itself yet, which on first
   * mount is all of them — and `POST /api/metadata/request` refuses each of
   * them as `alreadyAnswered` without queueing anything. This route is the
   * one that treats already-answered as its precondition instead. `signal` is
   * threaded through for the same reason it is on `requestMetadata`, even
   * though the button's own call never aborts one mid-flight today.
   */
  requeryMetadata: (groupIds: number[], signal?: AbortSignal) => {
    const init: RequestInit = { method: 'POST', body: JSON.stringify({ groupIds }) };
    return request<MetadataRequeryResponse>(
      '/api/metadata/requery',
      signal === undefined ? init : { ...init, signal },
    );
  },
  /** `ids` is joined the same `"1,2,3"` way `/api/metadata` expects. */
  metadata: (ids: number[], signal?: AbortSignal) =>
    request<Record<number, MetadataView>>(
      `/api/metadata?ids=${ids.join(',')}`,
      signal === undefined ? undefined : { signal },
    ),
  config: () => request<ConfigResponse>('/api/config'),
  saveConfig: (submitted: SubmittedConfig) =>
    request<ConfigSaveResponse>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(submitted),
    }),
  restart: () => request<{ restarting: true }>('/api/restart', { method: 'POST' }),
  /**
   * Not routed through `request`, which always reads the body as JSON. A backup
   * is bytes, and the filename lives in a header rather than in a payload.
   *
   * Fetched into a blob rather than being left to an `<a download>`: an anchor
   * gives nowhere to report a backup that failed, and a failed backup answers
   * with a JSON error the page should be able to show.
   */
  backupDatabase: async (): Promise<DatabaseBackup> => {
    const response = await fetch('/api/database/backup');
    if (!response.ok) {
      const body: { error?: string } = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Backup failed with ${response.status}`);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const matched = /filename="([^"]+)"/.exec(disposition);
    return { blob: await response.blob(), filename: matched?.[1] ?? 'pickarr-backup.db' };
  },
};
