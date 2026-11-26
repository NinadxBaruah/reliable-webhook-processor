'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { EventDetail as Detail } from '@/lib/types';
import { formatDuration, formatTime } from '@/lib/format';

/** Attempt history, payload and business record of one event. Refreshes with the list. */
export function EventDetail({ eventId, refreshKey }: { eventId: string; refreshKey: number }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get(eventId)
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [eventId, refreshKey]);

  if (error) return <p className="error">Could not load event: {error}</p>;
  if (!detail) return <p className="muted">Loading…</p>;

  return (
    <div className="detail">
      <section>
        <h3>Processing history</h3>
        {detail.attempts.length === 0 ? (
          <p className="muted">No attempts yet.</p>
        ) : (
          <table className="attempts">
            <thead>
              <tr>
                <th>#</th>
                <th>Worker</th>
                <th>Result</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Duration</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {detail.attempts.map((a) => (
                <tr key={a.attemptNumber}>
                  <td>{a.attemptNumber}</td>
                  <td className="mono">{a.workerId}</td>
                  <td>
                    <span className={`badge ${a.result}`}>{a.result}</span>
                  </td>
                  <td>{formatTime(a.startedAt)}</td>
                  <td>{a.finishedAt ? formatTime(a.finishedAt) : '—'}</td>
                  <td>{formatDuration(a.startedAt, a.finishedAt)}</td>
                  <td className="error-text">{a.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="detail-grid">
        <div>
          <h3>processed_orders</h3>
          {detail.processedOrder ? (
            <p>
              order <span className="mono">{detail.processedOrder.orderId}</span> recorded at{' '}
              {formatTime(detail.processedOrder.processedAt)}
            </p>
          ) : (
            <p className="muted">No row (not processed successfully).</p>
          )}
          <h3>Deliveries</h3>
          <p>
            {detail.deliveryCount} received
            {detail.conflictingDeliveryCount > 0 &&
              `, ${detail.conflictingDeliveryCount} with a different payload (ignored)`}
          </p>
        </div>
        <div>
          <h3>Stored payload (first delivery)</h3>
          <pre>{JSON.stringify(detail.payload, null, 2)}</pre>
        </div>
      </section>
    </div>
  );
}
