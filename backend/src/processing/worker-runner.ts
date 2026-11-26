import { Inject, Injectable, Logger } from '@nestjs/common';
import { backoffDelayMs } from './backoff';
import { LeaseLostError, NonRetryableError, errorMessage } from './errors';
import { type ClaimedEvent, EventQueue } from './event-queue';
import { EventProcessor } from './event-processor';
import { WORKER_SETTINGS, type WorkerSettings } from './worker-settings';

/**
 * The worker loop. One runner per worker process; it keeps up to `concurrency` events in flight,
 * claims more as slots free up and polls while the queue is empty.
 */
@Injectable()
export class WorkerRunner {
  private readonly logger = new Logger(WorkerRunner.name);
  private readonly inFlight = new Map<string, { done: Promise<void>; abort: AbortController }>();
  private stopping = false;
  private loopDone: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private recovering = false;

  constructor(
    private readonly queue: EventQueue,
    private readonly processor: EventProcessor,
    @Inject(WORKER_SETTINGS) private readonly settings: WorkerSettings,
  ) {}

  get activeEventIds(): string[] {
    return [...this.inFlight.keys()];
  }

  start(): void {
    if (this.loopDone) return;
    this.stopping = false;
    this.logger.log(
      `Worker ${this.settings.workerId} started (concurrency ${this.settings.concurrency})`,
    );
    this.loopDone = this.loop();
    void this.recover();
    this.recoveryTimer = setInterval(() => void this.recover(), this.settings.recoveryIntervalMs);
  }

  /**
   * Stops claiming, gives in-flight events `shutdownGraceMs` to finish, then aborts the rest.
   * Aborted events keep their lease and are picked up again once it expires.
   */
  async stop(): Promise<void> {
    if (!this.loopDone) return;
    this.stopping = true;
    clearInterval(this.recoveryTimer);
    this.wakeUp?.();
    await this.loopDone;
    this.loopDone = undefined;

    const pending = [...this.inFlight.values()];
    if (pending.length) {
      this.logger.log(`Waiting for ${pending.length} in-flight event(s) before shutdown`);
      const grace = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), this.settings.shutdownGraceMs).unref(),
      );
      const result = await Promise.race([Promise.all(pending.map((p) => p.done)), grace]);
      if (result === 'timeout') {
        pending.forEach((p) => p.abort.abort(new LeaseLostError('Worker shutting down')));
        await Promise.all(pending.map((p) => p.done));
      }
    }
    this.logger.log(`Worker ${this.settings.workerId} stopped`);
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let claimedAll = false;
      try {
        const free = this.settings.concurrency - this.inFlight.size;
        if (free > 0) {
          const claims = await this.queue.claim(free);
          claims.forEach((claim) => this.track(claim));
          // A full batch means more work is probably waiting: claim again without sleeping.
          claimedAll = claims.length === free;
        }
      } catch (err) {
        this.logger.error(`Claiming events failed: ${errorMessage(err)}`);
      }
      if (!claimedAll && !this.stopping) await this.idle(this.settings.pollIntervalMs);
    }
  }

  /** Hands events whose owner died back to the queue. Every worker does this; it is idempotent. */
  private async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const recovered = await this.queue.recoverExpiredLeases();
      for (const { eventId, status } of recovered) {
        this.logger.warn({ eventId, status }, 'Recovered event with an expired lease');
      }
      if (recovered.some((r) => r.status === 'pending')) this.wakeUp?.();
    } catch (err) {
      this.logger.error(`Lease recovery failed: ${errorMessage(err)}`);
    } finally {
      this.recovering = false;
    }
  }

  /** Sleeps until the poll interval passes or a slot frees up. */
  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      this.wakeUp = done;
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private track(claim: ClaimedEvent): void {
    const abort = new AbortController();
    const done = this.handle(claim, abort).finally(() => {
      this.inFlight.delete(claim.eventId);
      this.wakeUp?.();
    });
    this.inFlight.set(claim.eventId, { done, abort });
  }

  private async handle(claim: ClaimedEvent, abort: AbortController): Promise<void> {
    const ctx = { eventId: claim.eventId, attempt: claim.attemptNumber };
    const stopHeartbeat = this.startHeartbeat(claim, abort);
    try {
      await this.processor.process(claim, abort.signal);
      this.logger.log(ctx, 'Event processed');
    } catch (err) {
      if (err instanceof LeaseLostError) {
        // Someone else owns the event now; whatever we did is discarded, nothing to record.
        this.logger.warn({ ...ctx, reason: err.message }, 'Lost lease, abandoning event');
        return;
      }
      await this.recordFailure(claim, err);
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * Renews the lease every heartbeatMs while the event is processed, so work longer than the lease
   * (slow:N with a big N) is not taken over while this worker is alive. If the lease turns out to
   * be gone, or cannot be renewed before it runs out, the work is aborted: past that point another
   * worker may legitimately own the event.
   */
  private startHeartbeat(claim: ClaimedEvent, abort: AbortController): () => void {
    // Conservative local view of the lease, on the monotonic clock (immune to wall-clock jumps),
    // measured from before the claim/renewal was sent.
    let leaseValidUntil = performance.now() + this.settings.leaseMs - this.settings.heartbeatMs;
    let renewing = false;

    const timer = setInterval(() => {
      if (renewing || abort.signal.aborted) return;
      renewing = true;
      const sentAt = performance.now();
      this.queue
        .renewLease(claim)
        .then((stillOwned) => {
          if (stillOwned) {
            leaseValidUntil = sentAt + this.settings.leaseMs;
          } else {
            abort.abort(new LeaseLostError('Lease was taken over by another worker'));
          }
        })
        .catch((err: unknown) => {
          this.logger.warn(
            { eventId: claim.eventId, error: errorMessage(err) },
            'Lease renewal failed',
          );
          if (performance.now() >= leaseValidUntil) {
            abort.abort(new LeaseLostError('Could not renew the lease before it expired'));
          }
        })
        .finally(() => {
          renewing = false;
        });
    }, this.settings.heartbeatMs);

    return () => clearInterval(timer);
  }

  private async recordFailure(claim: ClaimedEvent, err: unknown): Promise<void> {
    const retryable = !(err instanceof NonRetryableError);
    const delayMs = backoffDelayMs(
      claim.attemptNumber - claim.budgetStartAttempt,
      this.settings.backoffBaseMs,
      this.settings.backoffMaxMs,
    );
    const message = errorMessage(err);
    try {
      const status = await this.queue.fail(claim, message, { retryable, delayMs });
      const ctx = { eventId: claim.eventId, attempt: claim.attemptNumber, error: message };
      if (status === 'pending') this.logger.warn({ ...ctx, retryInMs: delayMs }, 'Attempt failed');
      else if (status === 'failed') this.logger.error(ctx, 'Event permanently failed');
      else this.logger.warn(ctx, 'Attempt failed after the lease was lost; not recorded');
    } catch (writeErr) {
      // The event stays 'processing' and is recovered when its lease expires.
      this.logger.error(
        { eventId: claim.eventId, error: errorMessage(writeErr) },
        'Could not record failed attempt',
      );
    }
  }
}
