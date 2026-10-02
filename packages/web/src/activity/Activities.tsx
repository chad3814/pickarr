/**
 * `/activities`: what the host is doing, live (design spec 2026-10-02 §5).
 *
 * Six sections, each a heading and either a list of real text or a
 * sentence saying the list is empty. Five come from `GET /api/activity`
 * through {@link useActivity} (running, waiting, dead and recently finished
 * jobs, and the fetch queue); the sixth, downloads in progress, comes from
 * the replica through {@link useActiveDownloads} and so is unaffected by the
 * host being unreachable. While the first answer is pending the page says
 * `Loading…` once, in place of the five; the downloads section shows its
 * heading alone until its own read resolves, so the sentence is not repeated.
 *
 * **Everything is text.** No state is an `aria-label` or an icon: a screen
 * reader and a test read exactly what a sighted operator reads. The one
 * deliberate exception to "short text" is a dead job's `lastError`, which is
 * rendered whole in a `<pre>` (the stylesheet wraps it) -- never truncated,
 * and never an attribute, since an attribute is announced as a label and a
 * stack trace is not one.
 *
 * Kind and plugin id are shown as the host spelled them, never mapped
 * through a list this build knows: `poll` belongs to two plugins, so the id
 * always sits beside it.
 *
 * Styled by `styles/activities.css`, keyed on structure only.
 */
import type { ReactElement } from 'react';
import type { ActivityHost, ActivityJob } from '@pickarr/contract';
import {
  useActivity,
  type ActivityFetch,
  type ActivitySource,
} from './useActivity.ts';
import { useActiveDownloads, type ActiveDownloadsSource } from './useActiveDownloads.ts';
import type { ActiveDownload } from '../store/rows.ts';
import type { Store } from '../store/index.ts';

/** A real `Store` satisfies this by structural assignment; a test passes a small stub. */
export type ActivitiesSource = ActivitySource & Pick<Store, 'activeDownloads' | 'subscribeTable' | 'subscribeReset'>;

export interface ActivitiesProps {
  source: ActivitiesSource;
  fetchActivity: ActivityFetch;
  onExpired: () => void;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

type JobTiming = 'started' | 'runs' | 'failed' | 'finished';

function jobTime(job: ActivityJob, timing: JobTiming): string {
  switch (timing) {
    case 'started':
      return `started ${when(job.startedAt ?? job.updatedAt)}`;
    case 'runs':
      return `runs ${when(job.runAt)}`;
    case 'failed':
      return `last attempt ${when(job.updatedAt)}`;
    case 'finished':
      return `finished ${when(job.updatedAt)}`;
  }
}

interface JobSectionProps {
  readonly heading: string;
  readonly label: string;
  readonly empty: string;
  readonly jobs: readonly ActivityJob[];
  readonly timing: JobTiming;
  /** False for finished jobs: "attempt n of m" says nothing an operator wants of a job that is over. */
  readonly showAttempts: boolean;
}

function JobSection({ heading, label, empty, jobs, timing, showAttempts }: JobSectionProps): ReactElement {
  return (
    <section>
      <h2>{heading}</h2>
      {jobs.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <ul aria-label={label}>
          {jobs.map((job) => (
            <li key={job.id}>
              <span>{`${job.pluginId} ${job.kind}`}</span>
              {showAttempts ? <span>{`attempt ${String(job.attempts)} of ${String(job.maxAttempts)}`}</span> : null}
              <span>{jobTime(job, timing)}</span>
              {job.lastError === null ? null : <pre>{job.lastError}</pre>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HostBlock({ host }: { host: ActivityHost }): ReactElement {
  return (
    <li>
      <p>
        {`${host.hostname} · ${String(host.inFlight.length)} in flight, ${String(host.waiting.length)} waiting, limit ${String(host.limit)}`}
      </p>
      {host.inFlight.length === 0 ? null : (
        <ul aria-label={`${host.hostname} in flight`}>
          {host.inFlight.map((r, i) => (
            <li key={i}>{`${r.method} ${r.target}`}</li>
          ))}
        </ul>
      )}
      {host.waiting.length === 0 ? null : (
        <ul aria-label={`${host.hostname} waiting`}>
          {host.waiting.map((r, i) => (
            <li key={i}>{`${r.method} ${r.target}`}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function FetchSection({ fetches }: { fetches: readonly ActivityHost[] }): ReactElement {
  return (
    <section>
      <h2>Fetch queue</h2>
      {fetches.length === 0 ? (
        <p>No requests queued</p>
      ) : (
        <ul aria-label="fetch queue">
          {fetches.map((host) => (
            <HostBlock key={host.hostname} host={host} />
          ))}
        </ul>
      )}
    </section>
  );
}

function downloadKey(d: ActiveDownload): string {
  return `${d.table}:${String(d.id)}`;
}

function DownloadsSection({ downloads }: { downloads: readonly ActiveDownload[] | undefined }): ReactElement {
  return (
    <section>
      <h2>Downloads in progress</h2>
      {downloads === undefined ? null : downloads.length === 0 ? (
        <p>No downloads in progress</p>
      ) : (
        <ul aria-label="downloads in progress">
          {downloads.map((d) => (
            <li key={downloadKey(d)}>
              <span>{d.filename}</span>
              <span>{d.title ?? 'unmatched'}</span>
              <span>{d.clientName}</span>
              <span>{d.status}</span>
              {d.status === 'downloading' && d.percentage !== null ? <span>{`${String(d.percentage)}%`}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Activities({ source, fetchActivity, onExpired }: ActivitiesProps): ReactElement {
  const activity = useActivity(source, fetchActivity, onExpired);
  const downloads = useActiveDownloads(source satisfies ActiveDownloadsSource);

  return (
    <section data-testid="activities" aria-labelledby="activities-heading">
      <h1 id="activities-heading">Activities</h1>
      {activity.phase === 'loading' ? (
        <p>Loading…</p>
      ) : activity.phase === 'unreachable' ? (
        <p role="status">Couldn&apos;t reach Pickarr</p>
      ) : (
        <>
          {activity.unreachable ? <p role="status">Couldn&apos;t reach Pickarr</p> : null}
          <JobSection
            heading="Running"
            label="running jobs"
            empty="Nothing running"
            jobs={activity.read.jobs.running}
            timing="started"
            showAttempts
          />
          <JobSection
            heading="Waiting"
            label="waiting jobs"
            empty="Nothing waiting"
            jobs={activity.read.jobs.waiting}
            timing="runs"
            showAttempts
          />
          <JobSection
            heading="Dead"
            label="dead jobs"
            empty="No dead jobs"
            jobs={activity.read.jobs.dead}
            timing="failed"
            showAttempts
          />
          <JobSection
            heading="Recently finished"
            label="recently finished jobs"
            empty="Nothing finished recently"
            jobs={activity.read.jobs.recent}
            timing="finished"
            showAttempts={false}
          />
          <FetchSection fetches={activity.read.fetches} />
        </>
      )}
      <DownloadsSection downloads={downloads} />
    </section>
  );
}
