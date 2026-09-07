import { AlertDatabase } from "../storage/db";
import { AlertRecord, DeliveryRecord } from "../alerts/types";
import { NotificationTransport, renderAlert } from "../transports/transport";
import { nextRetry, RetryPolicy } from "./retry";

export class DeliveryScheduler {
  private running = false;
  constructor(private readonly database: AlertDatabase, private readonly transports: Map<string, NotificationTransport>, private readonly policy: RetryPolicy = { initialSeconds: 10, maxSeconds: 1800, multiplier: 2, jitter: 0.2 }) {}
  stop(): void { this.running = false; }
  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const delivery of this.database.listDeliveries()) {
        if (delivery.state === "delivered" || delivery.state === "failed_terminal") continue;
        if (delivery.nextAttemptAt && delivery.nextAttemptAt > now) continue;
        const transport = this.transports.get(delivery.transportInstanceId);
        if (!transport) { this.database.recordDeliveryFailure(delivery.id, "CONFIG", "Transport is not configured", false, now); continue; }
        this.database.claimDelivery(delivery.id, now);
        const alert = this.database.getAlert(delivery.alertId);
        const result = await transport.send(alert, delivery, { rendered: renderAlert(alert), now });
        if (result.kind === "success") this.database.recordDeliverySuccess(delivery.id, result.remoteId, now);
        else this.database.recordDeliveryFailure(delivery.id, result.code, result.message, result.kind === "retryable", nextRetry(delivery.attemptCount + 1, now, this.policy), now);
      }
    } finally { this.running = false; }
  }
}