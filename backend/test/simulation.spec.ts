import { LeaseLostError, NonRetryableError, RetryableError } from '../src/processing/errors';
import { parseSimulation, runSimulation } from '../src/processing/simulation';

describe('simulate contract', () => {
  const never = new AbortController().signal;

  it.each([
    [undefined, { kind: 'ok' }],
    [null, { kind: 'ok' }],
    ['ok', { kind: 'ok' }],
    ['  OK ', { kind: 'ok' }],
    ['always_fail', { kind: 'always_fail' }],
    ['fail_then_succeed:0', { kind: 'fail_then_succeed', failures: 0 }],
    ['fail_then_succeed:2', { kind: 'fail_then_succeed', failures: 2 }],
    // Higher than any sensible retry cap: still a valid value.
    ['fail_then_succeed:1000', { kind: 'fail_then_succeed', failures: 1000 }],
    ['slow:3', { kind: 'slow', seconds: 3 }],
    ['slow:0.5', { kind: 'slow', seconds: 0.5 }],
    // Longer than the lease: still a valid value.
    ['slow:86400', { kind: 'slow', seconds: 86400 }],
  ])('parses %p', (value, expected) => {
    expect(parseSimulation(value)).toEqual(expected);
  });

  it.each(['explode', 'fail_then_succeed:-1', 'fail_then_succeed:x', 'slow:', 'slow:-2', 42, {}])(
    'rejects %p as non-retryable',
    (value) => {
      expect(() => parseSimulation(value)).toThrow(NonRetryableError);
    },
  );

  it('fail_then_succeed:N fails attempts 1..N and succeeds from N+1', async () => {
    const sim = parseSimulation('fail_then_succeed:2');
    await expect(runSimulation(sim, 1, never)).rejects.toThrow(RetryableError);
    await expect(runSimulation(sim, 2, never)).rejects.toThrow(RetryableError);
    await expect(runSimulation(sim, 3, never)).resolves.toBeUndefined();
    await expect(runSimulation(sim, 9, never)).resolves.toBeUndefined();
  });

  it('always_fail fails on every attempt', async () => {
    const sim = parseSimulation('always_fail');
    for (const attempt of [1, 5, 50]) {
      await expect(runSimulation(sim, attempt, never)).rejects.toThrow(RetryableError);
    }
  });

  it('slow:N waits N seconds', async () => {
    const started = Date.now();
    await runSimulation(parseSimulation('slow:0.2'), 1, never);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('slow work stops as soon as the lease is lost', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new LeaseLostError('lease lost')), 50);
    await expect(runSimulation(parseSimulation('slow:60'), 1, controller.signal)).rejects.toThrow(
      LeaseLostError,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
