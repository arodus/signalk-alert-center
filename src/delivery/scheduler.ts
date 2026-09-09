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

export class DeliveryScheduler {
  private running = false;
  private stopped = false;
  private activeRun?: Promise<DeliveryRunSummary>;
  constructor(
    private readonly database: AlertDatabase,
    private readonly transports: Map<string, NotificationTransport>,
    private readonly policy: RetryPolicy = {
      initialSeconds: 10,
      maxSeconds: 1800,
      multiplier: 2,
      jitter: 0.2,
    },
  ) {
    this.database.recoverSending();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    await this.activeRun;
  }
  async runOnce(now = new Date()): Promise<DeliveryRunSummary | undefined> {
    if (this.stopped || this.running) return this.activeRun;
    this.running = true;
    const run = (async () => {
      const summary: DeliveryRunSummary = {
        processed: 0,
        succeeded: 0,
        retryableFailures: 0,
        terminalFailures: 0,
      };
      for (const delivery of this.database.listDueDeliveries(now)) {
        if (this.stopped) break;
        summary.processed += 1;
        const transport = this.transports.get(delivery.transportInstanceId);
        if (!transport) {
          this.database.recordDeliveryFailure(
            delivery.id,
            "CONFIG",
            "Transport is not configured",
            false,
            now,
          );
          summary.terminalFailures += 1;
          continue;
        }
        // Claim and commit before leaving the database for an external HTTP call.
        this.database.claimDelivery(delivery.id, now);
        const alert = this.database.getAlert(delivery.alertId);
        let result: TransportResult;
        try {
          result = await transport.send(alert, delivery, {
            rendered: renderAlert(alert),
            now,
          });
        } catch (error) {
          result = {
            kind: "retryable" as const,
            code: "TRANSPORT_ERROR",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        if (result.kind === "success") {
          this.database.recordDeliverySuccess(
            delivery.id,
            result.remoteId,
            now,
          );
          summary.succeeded += 1;
        } else {
          this.database.recordDeliveryFailure(
            delivery.id,
            result.code,
            result.message,
            result.kind === "retryable",
            nextRetry(delivery.attemptCount + 1, now, this.policy),
            now,
          );
          if (result.kind === "retryable") summary.retryableFailures += 1;
          else summary.terminalFailures += 1;
        }
      }
      return summary;
    })();
    this.activeRun = run;
    try {
      await run;
    } finally {
      this.running = false;
      this.activeRun = undefined;
    }
    return run;
  }
}
