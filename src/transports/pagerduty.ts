import { AlertRecord, DeliveryRecord, Severity } from "../alerts/types";
import {
  classifyHttp,
  NotificationTransport,
  readResponseBody,
  TransportContext,
  TransportResult,
} from "./transport";

type PagerDutySeverity = "critical" | "error" | "warning" | "info";

const pagerDutySeverity: Record<Severity, PagerDutySeverity> = {
  normal: "info",
  alert: "info",
  warn: "warning",
  alarm: "error",
  emergency: "critical",
};

export class PagerDutyTransport implements NotificationTransport {
  readonly type = "pagerduty";
  readonly requiresInternet = true;
  constructor(
    private readonly routingKey: string,
    private readonly endpoint = "https://events.pagerduty.com/v2/enqueue",
  ) {}
  async send(
    alert: AlertRecord,
    delivery: DeliveryRecord,
    context: TransportContext,
  ): Promise<TransportResult> {
    const eventAction =
      delivery.operation === "resolve"
        ? "resolve"
        : delivery.operation === "acknowledge"
          ? "acknowledge"
          : "trigger";
    const event = {
      routing_key: this.routingKey,
      event_action: eventAction,
      dedup_key: `signalk:${alert.sourceKey}`,
      ...(eventAction === "trigger"
        ? {
            payload: {
              summary: context.rendered.body,
              severity: pagerDutySeverity[context.rendered.severity],
              source: alert.path,
              timestamp: context.now.toISOString(),
            },
          }
        : {}),
    };
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
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
