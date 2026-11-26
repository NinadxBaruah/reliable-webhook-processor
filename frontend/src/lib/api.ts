import type { EventDetail, EventList, EventStatus, Stats } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { cache: 'no-store', ...init });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body ? String(body.message) : res.statusText;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  stats: () => request<Stats>('/events/stats'),
  list: (status: EventStatus | 'all', limit: number) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status !== 'all') params.set('status', status);
    return request<EventList>(`/events?${params}`);
  },
  get: (eventId: string) => request<EventDetail>(`/events/${encodeURIComponent(eventId)}`),
  retry: (eventId: string) =>
    request<unknown>(`/events/${encodeURIComponent(eventId)}/retry`, { method: 'POST' }),
};
