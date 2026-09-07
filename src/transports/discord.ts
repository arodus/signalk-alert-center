import { AlertRecord, DeliveryRecord } from "../alerts/types";
import { classifyHttp, NotificationTransport, TransportContext, TransportResult } from "./transport";

export class DiscordTransport implements NotificationTransport {
  readonly type = "discord";
  constructor(private readonly webhookUrl: string) {}
  async send(_alert: AlertRecord, _delivery: DeliveryRecord, context: TransportContext): Promise<TransportResult> {
    try { const response = await fetch(this.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ embeds: [{ title: context.rendered.title, description: context.rendered.body, timestamp: context.rendered.occurredAt.toISOString() }] }) }); return classifyHttp(response.status, await response.text()); }
    catch (error) { return { kind: "retryable", code: "NETWORK", message: error instanceof Error ? error.message : String(error) }; }
  }
}