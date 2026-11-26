// Shapes returned by the backend's /events endpoints.

export type EventStatus = 'pending' | 'processing' | 'succeeded' | 'failed';
export type AttemptResult = 'running' | 'succeeded' | 'failed' | 'abandoned';

export interface EventSummary {
  eventId: string;
  type: string;
  status: EventStatus;
  orderId: unknown;
  simulate: unknown;
  attemptCount: number;
  attemptsInBudget: number;
  lastError: string | null;
  lockedBy: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string;
  deliveryCount: number;
  conflictingDeliveryCount: number;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Attempt {
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  result: AttemptResult;
  error: string | null;
}

export interface EventDetail extends EventSummary {
  payload: unknown;
  attempts: Attempt[];
  processedOrder: { orderId: string; processedAt: string } | null;
}

export interface EventList {
  items: EventSummary[];
  total: number;
}

export interface Stats {
  counts: Record<EventStatus, number>;
  total: number;
  processedOrders: number;
  maxAttempts: number;
}
