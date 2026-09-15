import { AlertRecord, DeliveryRecord } from "../alerts/types";
import {
  classifyHttp,
  NotificationTransport,
  readResponseBody,
  TransportContext,
  TransportResult,
} from "./transport";

export class PagerDutyTransport implements NotificationTransport {
  readonly type = "pagerduty";
  constructor(
    private readonly routingKey: string,
    private readonly endpoint = "https://events.pagerduty.com/v2/enqueue",
  ) {}
  async send(
    alert: AlertRecord,
    delivery: DeliveryRecord,
    context: TransportContext,
  ): Promise<TransportResult> {
    const payload = {
      routing_key: this.routingKey,
      event_action:
        delivery.operation === "resolve"
          ? "resolve"
          : delivery.operation === "acknowledge"
            ? "acknowledge"
            : "trigger",
      dedup_key: `signalk:${alert.sourceKey}`,
      payload: {
        summary: context.rendered.body,
        severity:
          alert.maxSeverity === "emergency" ? "critical" : alert.maxSeverity,
        source: alert.path,
        timestamp: context.now.toISOString(),
      },
    };
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: context.signal,
      });
      return classifyHttp(response.status, await readResponseBody(response));
    } catch (error) {
      return {
        kind: "retryable",
        code: "NETWORK",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
