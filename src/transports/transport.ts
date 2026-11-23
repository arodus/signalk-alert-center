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
  /** Whether this transport must wait for confirmed Internet availability. */
  readonly requiresInternet: boolean;
  send(
    alert: AlertRecord,
    delivery: DeliveryRecord,
    context: TransportContext,
  ): Promise<TransportResult>;
}

export function renderAlert(
  alert: AlertRecord,
  template?: string,
  name = alert.path,
): RenderedAlert {
  const unknownRemoval =
    alert.coreAlert?.state === "normal" && !alert.coreResolutionConfirmed;
  const removal = unknownRemoval
    ? alert.coreAlert?.clearReason === "displaced"
      ? " Displaced from the core active set by a more urgent alert; recovery is not confirmed."
      : " Removed from the core active set; the reason is unconfirmed."
    : "";
  if (unknownRemoval) alert = { ...alert, clearedAt: undefined };
  const title = `${alert.currentSeverity.toUpperCase()}: ${alert.path}`;
  const duration = alert.clearedAt
    ? alert.clearedAt.getTime() - alert.firstSeenAt.getTime()
    : undefined;
  const lifecycle = alert.clearedAt
    ? `Occurred at ${alert.firstSeenAt.toISOString()}. Cleared at ${alert.clearedAt.toISOString()} after ${Math.round((duration ?? 0) / 60000)} minutes.`
    : `First seen at ${alert.firstSeenAt.toISOString()}.`;
  const defaultBody = `${alert.message ?? alert.path}\n${lifecycle}${removal}\nMaximum severity: ${alert.maxSeverity}.`;
  const localTime = (date: Date) =>
    date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  const customBody = template
    ?.replace(
      /\{(name|severity|message|path|state|localTime|clearedLocalTime)\}/g,
      (token) => {
        switch (token) {
          case "{name}":
            return name;
          case "{severity}":
            return alert.maxSeverity;
          case "{message}":
            return alert.message?.trim() || name;
          case "{path}":
            return alert.path;
          case "{state}":
            return unknownRemoval ? "removed" : alert.currentState;
          case "{localTime}":
            return localTime(alert.firstSeenAt);
          case "{clearedLocalTime}":
            return alert.clearedAt ? localTime(alert.clearedAt) : "";
          default:
            return token;
        }
      },
    )
    .trim();
  return {
    title: customBody ? "" : title,
    body: customBody || defaultBody,
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
