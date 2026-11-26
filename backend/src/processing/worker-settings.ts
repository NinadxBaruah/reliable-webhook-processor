import type { Env } from '../config/env';

export const WORKER_SETTINGS = Symbol('WORKER_SETTINGS');

/** Worker tuning, kept as a plain object so tests can build workers without Nest or env vars. */
export interface WorkerSettings {
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  leaseMs: number;
  heartbeatMs: number;
  shutdownGraceMs: number;
}

export function workerSettingsFromEnv(env: Env): WorkerSettings {
  return {
    workerId: env.WORKER_ID,
    concurrency: env.WORKER_CONCURRENCY,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    maxAttempts: env.MAX_ATTEMPTS,
    backoffBaseMs: env.BACKOFF_BASE_MS,
    backoffMaxMs: env.BACKOFF_MAX_MS,
    leaseMs: env.LEASE_MS,
    heartbeatMs: env.HEARTBEAT_MS,
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
  };
}
