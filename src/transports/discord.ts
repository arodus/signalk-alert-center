import { AlertRecord, DeliveryRecord } from "../alerts/types";
import {
  classifyHttp,
  NotificationTransport,
  readResponseBody,
  TransportContext,
  TransportResult,
} from "./transport";

export class DiscordTransport implements NotificationTransport {
  readonly type = "discord";
  readonly requiresInternet = true;
  constructor(private readonly webhookUrl: string) {}
  async send(
    _alert: AlertRecord,
    _delivery: DeliveryRecord,
    context: TransportContext,
  ): Promise<TransportResult> {
    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [
            {
              ...(context.rendered.title && { title: context.rendered.title }),
              description: context.rendered.body.slice(0, 4096),
              timestamp: context.rendered.occurredAt.toISOString(),
            },
          ],
        }),
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
