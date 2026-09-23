import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertRecord, DeliveryRecord } from "../src/alerts/types";
import { TelegramTransport } from "../src/transports/telegram";
import { renderAlert } from "../src/transports/transport";

const now = new Date("2026-01-01T00:00:00.000Z");
const alert: AlertRecord = {
  id: "occurrence-1",
  sourceKey: "notifications.navigation.anchor",
  path: "notifications.navigation.anchor",
  firstSeenAt: now,
  lastSeenAt: now,
  currentState: "active",
  currentSeverity: "alarm",
  maxSeverity: "alarm",
  message: "Anchor dragging",
  fireCount: 1,
  oneTime: false,
  minimumSeverity: "normal",
  activationDelaySeconds: 0,
  connectivity: { mode: "queue" },
};
const delivery: DeliveryRecord = {
  id: "telegram-delivery",
  alertId: alert.id,
  transportInstanceId: "telegram",
  operation: "trigger",
  state: "sending",
  attemptCount: 1,
  createdAt: now,
  updatedAt: now,
};

describe("TelegramTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends bounded plain text to the configured chat and topic", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 73 } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const transport = new TelegramTransport(
      {
        botToken: "123456:private-token",
        chatId: "-1001234567890",
        messageThreadId: 42,
        disableNotification: true,
      },
      "https://telegram.example",
    );

    const result = await transport.send(alert, delivery, {
      rendered: renderAlert(alert),
      now,
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://telegram.example/bot123456:private-token/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      chat_id: "-1001234567890",
      message_thread_id: 42,
      disable_notification: true,
    });
    expect(JSON.parse(String(request.body)).text).toContain("Anchor dragging");
    expect(result).toEqual({ kind: "success", remoteId: "73" });
  });

  it("classifies Telegram rate limits as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"ok":false,"description":"Too Many Requests"}', {
          status: 429,
        }),
      ),
    );
    const transport = new TelegramTransport(
      { botToken: "token", chatId: "@boat_alerts" },
      "https://telegram.example",
    );

    await expect(
      transport.send(alert, delivery, {
        rendered: renderAlert(alert),
        now,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: "retryable", code: "HTTP_429" });
  });
});
