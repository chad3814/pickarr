/**
 * The idempotence guard behind every host-owned job kind that reschedules
 * itself on a timer the dispatcher already owns -- `host.ts`'s `poll` cycle
 * and `clients/reconcile-job.ts`'s `reconcile` cycle both need the identical
 * answer to "is one of these already pending" before creating a second, and
 * a caller that scans by `kind` and one numeric payload field is the whole
 * of what either needs.
 *
 * Extracted rather than left as `host.ts`'s own private `pendingPollJobId`
 * (which is what this used to be, verbatim, before `reconcile` needed the
 * same thing): a job cycle's idempotence guard implemented twice is how the
 * two copies drift apart the moment one is edited and the other is not.
 * Both `host.ts`'s poll cycle and `reconcile-job.ts`'s reconcile cycle now
 * call this same function, so an edit to the guard's own logic reaches both
 * at once.
 */
import type { DatabaseSync } from 'node:sqlite';

/**
 * Narrows an `unknown` job payload to the number at `key`, or `undefined`
 * for anything else -- object, array, missing key, or a key holding
 * something other than a number. Never throws: this is the non-throwing
 * reader every strict, throwing payload reader (`host.ts`'s
 * `readPollPayload`, `reconcile-job.ts`'s own equivalent) is built from,
 * and also what `pendingJobId` below uses directly, for a scan over rows
 * that are not the one being run. A strict reader throwing is right inside
 * a handler, where the payload IS the job under execution and a bad one
 * should fail loudly and dead-letter; it is wrong for a scan, where one
 * corrupt row must not poison every other row's own check.
 */
export function readPayloadNumber(payload: unknown, key: string): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * The id of a job already `ready` or `running` under `pluginId`/`kind`,
 * whose JSON payload's `key` field equals `value` -- so no caller ever
 * starts a second concurrent cycle for the same feed or download client.
 *
 * A row whose payload `readPayloadNumber` cannot read as `{ [key]: number
 * }` is logged and skipped, not treated as a failure of the whole scan: one
 * unrelated row this host never would have written -- or one belonging to a
 * different shape entirely -- is not a reason to stop looking for every
 * other row's own match.
 *
 * `exceptJobId` is for the one caller that is itself a running job of this
 * same kind and must not count as its own reason not to reschedule --
 * without it, a job would find itself pending, decline to schedule, and
 * silence its own cycle forever. An external caller (`Host.schedulePoll`,
 * `reconcile-job.ts`'s exported `scheduleReconcile`) is never the row it is
 * scanning for, so it passes `undefined`.
 */
export function pendingJobId(
  raw: DatabaseSync,
  pluginId: string,
  kind: string,
  key: string,
  value: number,
  exceptJobId: number | undefined,
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void,
): number | undefined {
  const rows = raw.prepare(`
    SELECT id, payload_json FROM jobs WHERE plugin_id = ? AND kind = ? AND state IN ('ready', 'running')
  `).all(pluginId, kind);
  for (const row of rows) {
    const id = Number((row as { id: unknown }).id);
    if (id === exceptJobId) continue;
    const payloadJson = String((row as { payload_json: unknown }).payload_json);
    const payload: unknown = JSON.parse(payloadJson);
    const otherValue = readPayloadNumber(payload, key);
    if (otherValue === undefined) {
      log(`${kind} job payload is not shaped like { ${key}: number }, skipping it`, { jobId: id, payload: payloadJson });
      continue;
    }
    if (otherValue === value) {
      return id;
    }
  }
  return undefined;
}
