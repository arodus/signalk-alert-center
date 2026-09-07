import { AlertRecord, DeliveryRecord, Severity } from "../alerts/types";

export interface RenderedAlert { title: string; body: string; severity: Severity; occurredAt: Date; clearedAt?: Date; durationMs?: number }
export interface TransportContext { rendered: RenderedAlert; now: Date }
export type TransportResult = { kind: "success"; remoteId?: string } | { kind: "retryable" | "terminal"; code: string; message: string };
export interface NotificationTransport {
  readonly type: string;
  send(alert: AlertRecord, delivery: DeliveryRecord, context: TransportContext): Promise<TransportResult>;
}

export function renderAlert(alert: AlertRecord): RenderedAlert {
  const title = `${alert.currentSeverity.toUpperCase()}: ${alert.path}`;
  const duration = alert.clearedAt ? alert.clearedAt.getTime() - alert.firstSeenAt.getTime() : undefined;
  const lifecycle = alert.clearedAt
    ? `Occurred at ${alert.firstSeenAt.toISOString()}. Cleared at ${alert.clearedAt.toISOString()} after ${Math.round((duration ?? 0) / 60000)} minutes.`
    : `First seen at ${alert.firstSeenAt.toISOString()}.`;
  return { title, body: `${alert.message ?? alert.path}\n${lifecycle}\nMaximum severity: ${alert.maxSeverity}.`, severity: alert.maxSeverity, occurredAt: alert.firstSeenAt, clearedAt: alert.clearedAt, durationMs: duration };
}

export function classifyHttp(status: number, body = ""): TransportResult {
  if (status >= 200 && status < 300) return { kind: "success" };
  if (status === 408 || status === 425 || status === 429 || status >= 500) return { kind: "retryable", code: `HTTP_${status}`, message: body.slice(0, 500) };
  return { kind: "terminal", code: `HTTP_${status}`, message: body.slice(0, 500) };
}