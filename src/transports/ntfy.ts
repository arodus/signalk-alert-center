import { AlertRecord, DeliveryRecord } from "../alerts/types";
import { classifyHttp, NotificationTransport, TransportContext, TransportResult } from "./transport";

export class NtfyTransport implements NotificationTransport {
  readonly type = "ntfy";
  constructor(private readonly config: { server: string; topic: string; token?: string }) {}
  async send(_alert: AlertRecord, _delivery: DeliveryRecord, context: TransportContext): Promise<TransportResult> {
    try {
      const headers: Record<string, string> = { Title: context.rendered.title, Priority: String({ normal: 2, warn: 3, alert: 3, alarm: 4, emergency: 5 }[context.rendered.severity]) };
      if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
      const response = await fetch(`${this.config.server.replace(/\/$/, "")}/${encodeURIComponent(this.config.topic)}`, { method: "POST", headers, body: context.rendered.body });
      return classifyHttp(response.status, await response.text());
    } catch (error) { return { kind: "retryable", code: "NETWORK", message: error instanceof Error ? error.message : String(error) }; }
  }
}