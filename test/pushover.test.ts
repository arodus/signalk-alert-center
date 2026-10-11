import { afterEach, describe, expect, it, vi } from "vitest";
import { validateConfig } from "../src/config";
import { AlertRecord, DeliveryRecord } from "../src/alerts/types";
import { PushoverTransport, pushoverMessage } from "../src/transports/pushover";
import { testNotificationService } from "../src/transports/test-service";
import { renderAlert } from "../src/transports/transport";

const config = {
  applicationToken: "a".repeat(30),
  userKey: "u".repeat(30),
  device: "bridge,phone",
  sound: "siren",
};
const now = new Date("2026-01-01T00:00:00Z");
const alert: AlertRecord = {
  id: "test",
  sourceKey: "notifications.bilge",
  path: "notifications.bilge",
  firstSeenAt: now,
  lastSeenAt: now,
  currentState: "active",
  currentSeverity: "alarm",
  maxSeverity: "alarm",
  message: "Bilge high",
  fireCount: 1,
  oneTime: false,
  minimumSeverity: "normal",
  activationDelaySeconds: 0,
  connectivity: { mode: "queue" },
};
const delivery: DeliveryRecord = {
  id: "test",
  alertId: "test",
  transportInstanceId: "Pushover",
  operation: "trigger",
  state: "sending",
  attemptCount: 1,
  createdAt: now,
  updatedAt: now,
};
const context = {
  rendered: renderAlert(alert),
  now,
  signal: new AbortController().signal,
};

describe("Pushover", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(["normal", "alert", "warn", "alarm", "emergency"] as const)(
    "sends %s with the mapped priority and rendered message",
    async (severity) => {
      const mock = vi
        .fn()
        .mockResolvedValue(
          new Response('{"status":1,"request":"request-123"}'),
        );
      vi.stubGlobal("fetch", mock);
      expect(
        await new PushoverTransport(config).send(alert, delivery, {
          ...context,
          rendered: { ...context.rendered, severity },
        }),
      ).toEqual({ kind: "success", remoteId: "request-123" });
      expect(mock.mock.calls[0][0]).toBe(
        "https://api.pushover.net/1/messages.json",
      );
      expect(JSON.parse(mock.mock.calls[0][1].body)).toMatchObject({
        token: config.applicationToken,
        user: config.userKey,
        device: "bridge,phone",
        sound: "siren",
        message: context.rendered.body,
        priority: ["alarm", "emergency"].includes(severity) ? 1 : 0,
      });
      expect(mock.mock.calls[0][1].signal).toBe(context.signal);
    },
  );
  it("sends recovery at normal priority without emergency repetition", async () => {
    const mock = vi.fn().mockResolvedValue(new Response('{"status":1}'));
    vi.stubGlobal("fetch", mock);
    await new PushoverTransport(config).send(
      alert,
      { ...delivery, operation: "resolve" },
      context,
    );
    const body = JSON.parse(mock.mock.calls[0][1].body);
    expect(body.priority).toBe(0);
    expect(body).not.toHaveProperty("retry");
  });
  it.each([
    [400, "terminal"],
    [401, "terminal"],
    [403, "terminal"],
    [429, "retryable"],
    [500, "retryable"],
    [503, "retryable"],
  ])(
    "classifies HTTP %s without exposing credentials",
    async (status, kind) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(config), { status: Number(status) }),
          ),
      );
      const result = await new PushoverTransport(config).send(
        alert,
        delivery,
        context,
      );
      expect(result.kind).toBe(kind);
      expect(JSON.stringify(result)).not.toContain(config.applicationToken);
      expect(JSON.stringify(result)).not.toContain(config.userKey);
    },
  );
  it.each([
    ["{}", "retryable"],
    ["not json", "retryable"],
    ["null", "retryable"],
    ['{"status":0}', "terminal"],
  ])("does not claim acceptance for %s", async (body, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    expect(
      (await new PushoverTransport(config).send(alert, delivery, context)).kind,
    ).toBe(kind);
    const test = await testNotificationService(
      { name: "Push", type: "pushover", ...config },
      { timeoutMs: 1000 },
    );
    expect(test.status).toBe("error");
  });
  it("bounds Unicode text and omits optional fields", () => {
    const body = pushoverMessage(
      { applicationToken: "token", userKey: "key" },
      "😀".repeat(300),
      "😀".repeat(1100),
    );
    expect(Array.from(String(body.title))).toHaveLength(250);
    expect(Array.from(String(body.message))).toHaveLength(1024);
    expect(body).not.toHaveProperty("device");
  });
  it("retries network failure without leaking the thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(config.applicationToken)),
    );
    expect(
      await new PushoverTransport(config).send(alert, delivery, context),
    ).toMatchObject({ kind: "retryable", code: "NETWORK" });
  });
  it("tests the configured recipient at normal priority", async () => {
    const mock = vi.fn().mockResolvedValue(new Response('{"status":1}'));
    const result = await testNotificationService(
      { name: "Push", type: "pushover", ...config },
      { timeoutMs: 1000, fetch: mock },
    );
    expect(result.status).toBe("success");
    expect(JSON.parse(mock.mock.calls[0][1].body)).toMatchObject({
      user: config.userKey,
      priority: 0,
    });
  });
  it("validates secrets and optional device names without echoing values", () => {
    expect(() =>
      validateConfig({
        notifiers: [{ name: "Push", type: "pushover", ...config }],
      }),
    ).not.toThrow();
    for (const invalid of [
      { applicationToken: "bad-secret" },
      { userKey: "" },
      { device: "bad device" },
      { sound: "bad sound" },
    ])
      expect(() =>
        validateConfig({
          notifiers: [
            { name: "Push", type: "pushover", ...config, ...invalid },
          ],
        }),
      ).toThrow(/Pushover/);
  });
});
