import { AlertRecord, DeliveryRecord } from "../alerts/types";
import {
  classifyHttp,
  NotificationTransport,
  readResponseBody,
  TransportContext,
  TransportResult,
} from "./transport";

export interface PushoverConfig {
  applicationToken: string;
  userKey: string;
  device?: string;
  sound?: string;
}

export const pushoverEndpoint = "https://api.pushover.net/1/messages.json";

export function pushoverMessage(
  config: PushoverConfig,
  title: string,
  message: string,
  priority = 0,
): Record<string, string | number> {
  return {
    token: config.applicationToken,
    user: config.userKey,
    title: Array.from(title).slice(0, 250).join(""),
    message: Array.from(message).slice(0, 1024).join(""),
    priority,
    ...(config.device ? { device: config.device } : {}),
    ...(config.sound ? { sound: config.sound } : {}),
  };
}

/** Never expose response text: a service/proxy may echo credentials. */
export async function pushoverResult(
  response: Response,
): Promise<TransportResult> {
  const body = await readResponseBody(response);
  if (!response.ok)
    return classifyHttp(
      response.status,
      `Pushover request returned HTTP ${response.status}`,
    );
  try {
    const parsed = JSON.parse(body) as { status?: number; request?: unknown };
    if (parsed.status === 1)
      return {
        kind: "success",
        ...(typeof parsed.request === "string" &&
        /^[a-z0-9-]{1,64}$/i.test(parsed.request)
          ? { remoteId: parsed.request }
          : {}),
      };
    if (parsed.status === 0)
      return {
        kind: "terminal",
        code: "PUSHOVER_REJECTED",
        message:
          "Pushover rejected the message. Check the application token, user/group key, device, and sound.",
      };
  } catch {
    // A proxy success page is not confirmation that Pushover accepted a message.
  }
  return {
    kind: "retryable",
    code: "PUSHOVER_INVALID_RESPONSE",
    message: "Pushover did not confirm message acceptance",
  };
}

export class PushoverTransport implements NotificationTransport {
  readonly type = "pushover";
  constructor(
    private readonly config: PushoverConfig,
    private readonly endpoint = pushoverEndpoint,
  ) {}

  async send(
    _alert: AlertRecord,
    delivery: DeliveryRecord,
    context: TransportContext,
  ): Promise<TransportResult> {
    try {
      // Priority 2 starts an independent repeating loop with receipt/cancellation
      // semantics. Keep repeats owned by our durable scheduler instead.
      const high =
        delivery.operation !== "resolve" &&
        !context.rendered.clearedAt &&
        ["alarm", "emergency"].includes(context.rendered.severity);
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          pushoverMessage(
            this.config,
            context.rendered.title,
            context.rendered.body,
            high ? 1 : 0,
          ),
        ),
        signal: context.signal,
      });
      return await pushoverResult(response);
    } catch {
      return {
        kind: "retryable",
        code: "NETWORK",
        message: "Pushover request failed or was aborted",
      };
    }
  }
}
