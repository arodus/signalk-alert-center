import { AlertRecord, DeliveryRecord } from "../alerts/types";
import {
  classifyHttp,
  NotificationTransport,
  readResponseBody,
  TransportContext,
  TransportResult,
} from "./transport";

interface TelegramConfig {
  botToken: string;
  chatId: string;
  messageThreadId?: number;
  disableNotification?: boolean;
}

interface TelegramResponse {
  ok?: boolean;
  result?: { message_id?: unknown };
}

/** Durable text delivery through Telegram's HTTPS Bot API. */
export class TelegramTransport implements NotificationTransport {
  readonly type = "telegram";

  constructor(
    private readonly config: TelegramConfig,
    private readonly apiBase = "https://api.telegram.org",
  ) {}

  async send(
    _alert: AlertRecord,
    _delivery: DeliveryRecord,
    context: TransportContext,
  ): Promise<TransportResult> {
    try {
      const response = await fetch(
        `${this.apiBase.replace(/\/$/, "")}/bot${this.config.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.config.chatId,
            text: `${context.rendered.title}\n\n${context.rendered.body}`.slice(
              0,
              4096,
            ),
            ...(this.config.messageThreadId === undefined
              ? {}
              : { message_thread_id: this.config.messageThreadId }),
            disable_notification: this.config.disableNotification === true,
          }),
          signal: context.signal,
        },
      );
      const body = await readResponseBody(response);
      if (!response.ok) return classifyHttp(response.status, body);
      try {
        const parsed = JSON.parse(body) as TelegramResponse;
        if (parsed.ok === false)
          return {
            kind: "terminal",
            code: "TELEGRAM_REJECTED",
            message: "Telegram rejected the message",
          };
        const messageId = parsed.result?.message_id;
        return {
          kind: "success",
          ...(typeof messageId === "number" || typeof messageId === "string"
            ? { remoteId: String(messageId) }
            : {}),
        };
      } catch {
        return { kind: "success" };
      }
    } catch (error) {
      return {
        kind: "retryable",
        code: "NETWORK",
        message:
          error instanceof DOMException && error.name === "AbortError"
            ? "Telegram request was aborted"
            : "Telegram request failed",
      };
    }
  }
}
