import { AlertRecord, DeliveryRecord, Severity } from "../alerts/types";

export interface RenderedAlert {
  title: string;
  body: string;
  severity: Severity;
  occurredAt: Date;
  clearedAt?: Date;
  durationMs?: number;
}
export interface TransportContext {
  rendered: RenderedAlert;
  now: Date;
  signal: AbortSignal;
}
export type TransportResult =
  | { kind: "success"; remoteId?: string }
  | { kind: "retryable" | "terminal"; code: string; message: string };
export interface NotificationTransport {
  readonly type: string;
  send(
    alert: AlertRecord,
    delivery: DeliveryRecord,
    context: TransportContext,
  ): Promise<TransportResult>;
}

export function renderAlert(alert: AlertRecord): RenderedAlert {
  const title = `${alert.currentSeverity.toUpperCase()}: ${alert.path}`;
  const duration = alert.clearedAt
    ? alert.clearedAt.getTime() - alert.firstSeenAt.getTime()
    : undefined;
  const lifecycle = alert.clearedAt
    ? `Occurred at ${alert.firstSeenAt.toISOString()}. Cleared at ${alert.clearedAt.toISOString()} after ${Math.round((duration ?? 0) / 60000)} minutes.`
    : `First seen at ${alert.firstSeenAt.toISOString()}.`;
  return {
    title,
    body: `${alert.message ?? alert.path}\n${lifecycle}\nMaximum severity: ${alert.maxSeverity}.`,
    severity: alert.maxSeverity,
    occurredAt: alert.firstSeenAt,
    clearedAt: alert.clearedAt,
    durationMs: duration,
  };
}

export function classifyHttp(status: number, body = ""): TransportResult {
  if (status >= 200 && status < 300) return { kind: "success" };
  if (status === 408 || status === 425 || status === 429 || status >= 500)
    return {
      kind: "retryable",
      code: `HTTP_${status}`,
      message: body.slice(0, 500),
    };
  return {
    kind: "terminal",
    code: `HTTP_${status}`,
    message: body.slice(0, 500),
  };
}

/** Read only a small diagnostic prefix instead of buffering an arbitrary body. */
export async function readResponseBody(
  response: Response,
  maxBytes = 8_192,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      const selected =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(selected);
      size += selected.byteLength;
      if (selected.byteLength < value.byteLength) break;
    }
  } finally {
    if (size >= maxBytes) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
