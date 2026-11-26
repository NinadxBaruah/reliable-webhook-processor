import { hostname } from 'node:os';
import { z } from 'zod';

const int = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);

/**
 * Every setting the API, workers and migrator read from the environment.
 * Parsed once at startup so a bad value fails fast instead of mid-processing.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z
      .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    PORT: int(3000, 1),
    DATABASE_URL: z.string().url(),
    DB_POOL_MAX: int(10, 1),

    WORKER_ID: z.string().min(1).default(hostname()),
    /** Events one worker process handles at the same time. */
    WORKER_CONCURRENCY: int(4, 1),
    /** How long an idle worker waits before polling for work again. */
    POLL_INTERVAL_MS: int(500, 10),

    /** Attempts allowed per retry budget (a manual retry starts a new budget). */
    MAX_ATTEMPTS: int(5, 1),
    BACKOFF_BASE_MS: int(1000, 0),
    BACKOFF_MAX_MS: int(60_000, 0),

    /** A claim is valid this long unless the worker renews it. */
    LEASE_MS: int(15_000, 100),
    /** How often a worker renews the lease of each event it is processing. */
    HEARTBEAT_MS: int(5_000, 10),
    /** On SIGTERM, how long in-flight events may finish before they are handed back. */
    SHUTDOWN_GRACE_MS: int(10_000, 0),
  })
  .refine((env) => env.HEARTBEAT_MS * 2 <= env.LEASE_MS, {
    message: 'HEARTBEAT_MS must be at most half of LEASE_MS so one missed heartbeat is survivable',
    path: ['HEARTBEAT_MS'],
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
