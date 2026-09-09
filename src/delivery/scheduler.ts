import { AlertDatabase } from "../storage/db";
import { AlertRecord, DeliveryRecord } from "../alerts/types";
import { NotificationTransport, renderAlert } from "../transports/transport";
import { nextRetry, RetryPolicy } from "./retry";

export class DeliveryScheduler {
  private running = false;
  private stopped = false;
  private activeRun?: Promise<void>;
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
  async runOnce(now = new Date()): Promise<void> {
    if (this.stopped || this.running) return this.activeRun;
    this.running = true;
    const run = (async () => {
      for (const delivery of this.database.listDueDeliveries(now)) {
        if (this.stopped) break;
        const transport = this.transports.get(delivery.transportInstanceId);
        if (!transport) {
          this.database.recordDeliveryFailure(
            delivery.id,
            "CONFIG",
            "Transport is not configured",
            false,
            now,
          );
          continue;
        }
        // Claim and commit before leaving the database for an external HTTP call.
        this.database.claimDelivery(delivery.id, now);
        const alert = this.database.getAlert(delivery.alertId);
        const result = await transport.send(alert, delivery, {
          rendered: renderAlert(alert),
          now,
        });
        if (result.kind === "success")
          this.database.recordDeliverySuccess(
            delivery.id,
            result.remoteId,
            now,
          );
        else
          this.database.recordDeliveryFailure(
            delivery.id,
            result.code,
            result.message,
            result.kind === "retryable",
            nextRetry(delivery.attemptCount + 1, now, this.policy),
            now,
          );
      }
    })();
    this.activeRun = run;
    try {
      await run;
    } finally {
      this.running = false;
      this.activeRun = undefined;
    }
  }
}
