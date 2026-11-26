import { backoffDelayMs } from '../src/processing/backoff';

describe('backoffDelayMs', () => {
  const min = () => 0;
  const max = () => 1;

  it('doubles per attempt within the jitter window', () => {
    expect([1, 2, 3, 4].map((n) => backoffDelayMs(n, 1000, 60_000, max))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
    expect([1, 2, 3, 4].map((n) => backoffDelayMs(n, 1000, 60_000, min))).toEqual([
      500, 1000, 2000, 4000,
    ]);
  });

  it('never exceeds the cap, even for huge attempt numbers', () => {
    expect(backoffDelayMs(10, 1000, 30_000, max)).toBe(30_000);
    expect(backoffDelayMs(5000, 1000, 30_000, max)).toBe(30_000);
  });
});
