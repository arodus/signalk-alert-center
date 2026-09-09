import { AlertDatabase } from "../storage/db";
import { AlertRecord, DeliveryRecord } from "../alerts/types";
import {
  NotificationTransport,
  renderAlert,
  TransportResult,
} from "../transports/transport";
import { nextRetry, RetryPolicy } from "./retry";

export interface DeliveryRunSummary {
  processed: number;
  succeeded: number;
  retryableFailures: number;
  terminalFailures: number;
}

export interface DeliverySchedulerStatus {
  running: boolean;
  lastRunStartedAt?: Date;
  lastRunCompletedAt?: Date;
  lastSummary?: DeliveryRunSummary;
  lastError?: string;
}

export interface DeliverySchedulerOptions {
  batchSize?: number;
  concurrency?: number;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 4;

export class DeliveryScheduler {
  private running = false;
  private stopped = false;
  private activeRun?: Promise<DeliveryRunSummary>;
  private lastRunStartedAt?: Date;
  private lastRunCompletedAt?: Date;
  private lastSummary?: DeliveryRunSummary;
  private lastError?: string;
  constructor(
    private readonly database: AlertDatabase,
    private readonly transports: Map<string, NotificationTransport>,
    private readonly policy: RetryPolicy = {
      initialSeconds: 10,
      maxSeconds: 1800,
      multiplier: 2,
      jitter: 0.2,
    },
    private readonly options: DeliverySchedulerOptions = {},
  ) {
    this.database.recoverSending();
  }
  get isRunning(): boolean {
    return this.running;
  }
  status(): DeliverySchedulerStatus {
    return {
      running: this.running,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunCompletedAt: this.lastRunCompletedAt,
      lastSummary: this.lastSummary,
      lastError: this.lastError,
    };
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.activeRun;
  }
  async runOnce(now = new Date()): Promise<DeliveryRunSummary | undefined> {
    if (this.stopped || this.running) return this.activeRun;
    this.running = true;
    this.lastRunStartedAt = now;
    const run = (async () => {
      const summary: DeliveryRunSummary = {
        processed: 0,
        succeeded: 0,
        retryableFailures: 0,
        terminalFailures: 0,
      };
      const deliveries = this.database.listDueDeliveries(
        now,
        this.options.batchSize ?? DEFAULT_BATCH_SIZE,
      );
      const concurrency = Math.min(
        this.options.concurrency ?? DEFAULT_CONCURRENCY,
        deliveries.length,
      );
      let cursor = 0;
      const errors: unknown[] = [];
      const worker = async (): Promise<void> => {
        while (!this.stopped) {
          const delivery = deliveries[cursor];
          cursor += 1;
          if (!delivery) return;
          try {
            await this.processDelivery(delivery, summary, now);
          } catch (error) {
            errors.push(error);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (errors.length)
        throw new AggregateError(
          errors,
          "One or more deliveries could not be processed",
        );
      return summary;
    })();
    this.activeRun = run;
    try {
      const result = await run;
      this.lastRunCompletedAt = new Date();
      this.lastSummary = result;
      this.lastError = undefined;
      return result;
    } catch (error) {
      this.lastRunCompletedAt = new Date();
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.running = false;
      this.activeRun = undefined;
    }
  }

  private async processDelivery(
    delivery: DeliveryRecord,
    summary: DeliveryRunSummary,
    now: Date,
  ): Promise<void> {
    // Claim and commit before leaving the database for external network I/O.
    if (!this.database.claimDelivery(delivery.id, now)) return;
    summary.processed += 1;
    const transport = this.transports.get(delivery.transportInstanceId);
    if (!transport) {
      this.database.recordDeliveryFailure(
        delivery.id,
        "CONFIG",
        "Transport is not configured",
        false,
        undefined,
        now,
      );
      summary.terminalFailures += 1;
      return;
    }
    const alert = this.database.getAlert(delivery.alertId);
    let result: TransportResult;
    try {
      result = await transport.send(alert, delivery, {
        rendered: renderAlert(alert),
        now,
      });
    } catch (error) {
      result = {
        kind: "retryable",
        code: "TRANSPORT_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.kind === "success") {
      this.database.recordDeliverySuccess(delivery.id, result.remoteId, now);
      summary.succeeded += 1;
      return;
    }
    this.database.recordDeliveryFailure(
      delivery.id,
      result.code,
      result.message,
      result.kind === "retryable",
      result.kind === "retryable"
        ? nextRetry(delivery.attemptCount + 1, now, this.policy)
        : undefined,
      now,
    );
    if (result.kind === "retryable") summary.retryableFailures += 1;
    else summary.terminalFailures += 1;
  }
}
