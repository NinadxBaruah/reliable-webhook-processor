/**
 * Exponential backoff with "equal jitter": half of the delay is fixed, half is random.
 * The fixed half guarantees a real pause; the random half spreads out retries of many events that
 * failed together (for example during one downstream outage).
 *
 * @param attemptInBudget 1 for the first attempt of the current retry budget
 */
export function backoffDelayMs(
  attemptInBudget: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attemptInBudget - 1);
  const capped = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.round(capped / 2 + random() * (capped / 2));
}
