import { setTimeout as sleep } from 'node:timers/promises';
import { LeaseLostError, NonRetryableError, RetryableError } from './errors';

/**
 * The `data.simulate` contract:
 *   ok (or absent)         succeed
 *   fail_then_succeed:N    fail attempts 1..N (by attempt number), succeed from attempt N+1
 *   always_fail            fail every attempt
 *   slow:N                 take N seconds, then succeed
 */
export type Simulation =
  | { kind: 'ok' }
  | { kind: 'fail_then_succeed'; failures: number }
  | { kind: 'always_fail' }
  | { kind: 'slow'; seconds: number };

const FAIL_THEN_SUCCEED = /^fail_then_succeed:(\d+)$/;
const SLOW = /^slow:(\d+(?:\.\d+)?)$/;

/**
 * Parses `data.simulate`. Any number is accepted, even ones above the retry cap or longer than the
 * lease: the cap and the lease are the processor's problem, not the contract's. A value outside
 * the contract can never succeed, so it is reported as non-retryable instead of burning retries.
 */
export function parseSimulation(value: unknown): Simulation {
  if (value === undefined || value === null) return { kind: 'ok' };
  if (typeof value !== 'string') {
    throw new NonRetryableError(`Unsupported simulate value: ${JSON.stringify(value)}`);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'ok') return { kind: 'ok' };
  if (normalized === 'always_fail') return { kind: 'always_fail' };

  const failThenSucceed = FAIL_THEN_SUCCEED.exec(normalized);
  if (failThenSucceed) return { kind: 'fail_then_succeed', failures: Number(failThenSucceed[1]) };

  const slow = SLOW.exec(normalized);
  if (slow) return { kind: 'slow', seconds: Number(slow[1]) };

  throw new NonRetryableError(`Unsupported simulate value: ${JSON.stringify(value)}`);
}

/**
 * Runs the simulated downstream call for one attempt. `signal` aborts a slow call when the worker
 * loses its lease or shuts down, so it does not keep working on an event it no longer owns.
 */
export async function runSimulation(
  simulation: Simulation,
  attemptNumber: number,
  signal: AbortSignal,
): Promise<void> {
  switch (simulation.kind) {
    case 'ok':
      return;
    case 'always_fail':
      throw new RetryableError(`Simulated failure (always_fail), attempt ${attemptNumber}`);
    case 'fail_then_succeed':
      if (attemptNumber <= simulation.failures) {
        throw new RetryableError(
          `Simulated failure ${attemptNumber} of ${simulation.failures} (fail_then_succeed)`,
        );
      }
      return;
    case 'slow':
      await abortableSleep(simulation.seconds * 1000, signal);
      return;
  }
}

/** Node timers overflow above ~24.8 days and would fire after 1ms, so long waits are chunked. */
const MAX_TIMER_MS = 2 ** 31 - 1;

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_TIMER_MS);
    try {
      await sleep(chunk, undefined, { signal });
    } catch (err) {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new LeaseLostError('Work aborted: lease lost or worker shutting down');
      }
      throw err;
    }
    remaining -= chunk;
  }
}
