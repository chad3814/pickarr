export interface JobEnqueue {
  kind: string;
  payload: unknown;
  /** Epoch ms. Absent means as soon as a worker is free. */
  runAt?: number;
  /** Absent takes the host's default. */
  maxAttempts?: number;
}

export interface JobQueue {
  enqueue(job: JobEnqueue): Promise<number>;
}

export interface JobRecord {
  id: number;
  kind: string;
  payload: unknown;
  /** 1 on the first run. A handler seeing >1 is a retry or a crash recovery. */
  attempts: number;
}
