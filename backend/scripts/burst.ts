/**
 * Load generator for the burst demo: submits TOTAL events at the same moment from one process
 * and measures how the API copes, including a /health probe while the burst is in flight.
 *
 *   docker compose --profile tools run --rm burst          (used by scripts/demo-burst.sh)
 *
 * Mix: 80% ok, 10% fail_then_succeed:1, 5% slow:2, 5% always_fail.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const TOTAL = Number(process.env.TOTAL ?? 500);
const PREFIX = process.env.PREFIX ?? `evt_burst_${Date.now()}_`;

function simulateFor(i: number): string {
  const n = i % 20;
  if (n < 16) return 'ok';
  if (n < 18) return 'fail_then_succeed:1';
  if (n < 19) return 'slow:2';
  return 'always_fail';
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
  console.log(`Submitting ${TOTAL} events to ${API_URL}/webhooks at once (prefix ${PREFIX})`);

  const send = (i: number) =>
    timed(() =>
      fetch(`${API_URL}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: `${PREFIX}${i}`,
          type: 'order.created',
          data: { orderId: `ORD-B${i}`, customerId: 'CUS-42', simulate: simulateFor(i) },
        }),
      }).then((r) => r.status),
    ).catch(() => ({ ms: 0, value: 0 }));

  const burst = timed(() => Promise.all(Array.from({ length: TOTAL }, (_, i) => send(i + 1))));
  // Probe the API while the burst is being absorbed.
  const health = timed(() => fetch(`${API_URL}/health`).then((r) => r.status));

  const [{ ms: totalMs, value: results }, probe] = await Promise.all([burst, health]);

  const byStatus = new Map<number, number>();
  for (const r of results) byStatus.set(r.value, (byStatus.get(r.value) ?? 0) + 1);
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);

  console.log(
    `Responses: ${[...byStatus].map(([code, n]) => `${n} x ${code || 'network error'}`).join(', ')}`,
  );
  console.log(`All ${TOTAL} answered in ${totalMs.toFixed(0)} ms`);
  console.log(
    `Per-request latency: p50 ${percentile(latencies, 50).toFixed(0)} ms, ` +
      `p99 ${percentile(latencies, 99).toFixed(0)} ms, max ${latencies.at(-1)?.toFixed(0)} ms`,
  );
  console.log(`GET /health during the burst: ${probe.value} in ${probe.ms.toFixed(0)} ms`);

  if (byStatus.get(202) !== TOTAL) process.exitCode = 1;
}

void main();
