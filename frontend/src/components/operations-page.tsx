'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatTime, formatValue } from '@/lib/format';
import type { EventList, EventStatus, Stats } from '@/lib/types';
import { EventDetail } from './event-detail';

const FILTERS: (EventStatus | 'all')[] = ['all', 'pending', 'processing', 'succeeded', 'failed'];
const REFRESH_MS = 2000;
const PAGE_SIZE = 200;

export function OperationsPage() {
  const [filter, setFilter] = useState<EventStatus | 'all'>('all');
  const [stats, setStats] = useState<Stats | null>(null);
  const [list, setList] = useState<EventList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tick, setTick] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([api.stats(), api.list(filter, PAGE_SIZE)]);
      setStats(s);
      setList(l);
      setError(null);
      setTick((t) => t + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter]);

  useEffect(() => {
    // Initial load and filter changes; the async setState happens after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    if (!autoRefresh) return;
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, autoRefresh]);

  async function retry(eventId: string) {
    setRetrying(eventId);
    try {
      await api.retry(eventId);
      await refresh();
    } catch (e) {
      setError(`Retry of ${eventId} failed: ${(e as Error).message}`);
    } finally {
      setRetrying(null);
    }
  }

  return (
    <main>
      <header className="page-header">
        <h1>Webhook events</h1>
        <label className="toggle">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh every {REFRESH_MS / 1000}s
        </label>
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      {stats && (
        <section className="stats" aria-label="Summary">
          <Stat label="Events" value={stats.total} />
          <Stat label="Pending" value={stats.counts.pending} status="pending" />
          <Stat label="Processing" value={stats.counts.processing} status="processing" />
          <Stat label="Succeeded" value={stats.counts.succeeded} status="succeeded" />
          <Stat label="Failed" value={stats.counts.failed} status="failed" />
          <Stat label="processed_orders rows" value={stats.processedOrders} />
          <Stat label="Max attempts per budget" value={stats.maxAttempts} />
        </section>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <nav className="filters" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={f === filter ? 'active' : ''}
            aria-pressed={f === filter}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
        {list && (
          <span className="muted">
            showing {list.items.length} of {list.total}
          </span>
        )}
      </nav>

      <table className="events">
        <thead>
          <tr>
            <th>Event</th>
            <th>Status</th>
            <th>Order</th>
            <th>Simulate</th>
            <th>Attempts</th>
            <th>Worker</th>
            <th>Last error</th>
            <th>Received</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list?.items.map((e) => (
            <Fragment key={e.eventId}>
              <tr
                className={`row ${expanded === e.eventId ? 'open' : ''}`}
                onClick={() => setExpanded(expanded === e.eventId ? null : e.eventId)}
              >
                <td className="mono">{e.eventId}</td>
                <td>
                  <span className={`badge ${e.status}`}>{e.status}</span>
                </td>
                <td className="mono">{formatValue(e.orderId)}</td>
                <td className="mono">{formatValue(e.simulate)}</td>
                <td title="total attempts (attempts in the current retry budget)">
                  {e.attemptCount}
                  {e.attemptCount !== e.attemptsInBudget && (
                    <span className="muted"> ({e.attemptsInBudget} this budget)</span>
                  )}
                </td>
                <td className="mono">{e.lockedBy ?? ''}</td>
                <td className="error-text">{e.lastError ?? ''}</td>
                <td>{formatTime(e.receivedAt)}</td>
                <td>
                  {e.status === 'failed' && (
                    <button
                      type="button"
                      disabled={retrying === e.eventId}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void retry(e.eventId);
                      }}
                    >
                      {retrying === e.eventId ? 'Retrying…' : 'Retry'}
                    </button>
                  )}
                </td>
              </tr>
              {expanded === e.eventId && (
                <tr className="detail-row">
                  <td colSpan={9}>
                    <EventDetail eventId={e.eventId} refreshKey={tick} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {list && list.items.length === 0 && (
            <tr>
              <td colSpan={9} className="muted empty">
                No events yet. Send one to POST /webhooks on the API (port 3000).
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

function Stat({ label, value, status }: { label: string; value: number; status?: EventStatus }) {
  return (
    <div className={`stat ${status ?? ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
