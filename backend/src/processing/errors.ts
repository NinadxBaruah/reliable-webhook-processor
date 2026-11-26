/** A failure that will fail the same way on every attempt, so retrying it is pointless. */
export class NonRetryableError extends Error {
  override readonly name = 'NonRetryableError';
}

/** A failure that may succeed on a later attempt (downstream outage, timeout, ...). */
export class RetryableError extends Error {
  override readonly name = 'RetryableError';
}

/**
 * This worker no longer owns the event (its lease expired and another worker may have taken it).
 * The worker must stop and write nothing.
 */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
