import { describe, expect, it, vi } from "vitest";
import { testNotificationService } from "../src/transports/test-service";

describe("manual notification-service tests", () => {
  it("sends a clearly marked ntfy test without returning secrets", async () => {
    const fetch = vi.fn(
      async () => new Response("remote private response", { status: 200 }),
    );
    const result = await testNotificationService(
      {
        name: "Crew",
        type: "ntfy",
        server: "https://ntfy.example",
        topic: "boat-secret-topic",
        token: "secret-token",
      },
      { timeoutMs: 1_000, fetch },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://ntfy.example/boat-secret-topic",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
          Title: "TEST: Signal K Persistent Notifier",
        }),
      }),
    );
    expect(result).toMatchObject({
      status: "success",
      category: "success",
      operation: "send",
      service: { id: "Crew", type: "ntfy" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("remote private response");
  });

  it("classifies authentication and validation failures without response bodies", async () => {
    const authentication = await testNotificationService(
      {
        name: "Discord",
        type: "discord",
        webhookUrl: "https://discord.example/api/webhooks/private-token",
      },
      {
        timeoutMs: 1_000,
        fetch: async () =>
          new Response("token invalid: private-token", { status: 401 }),
      },
    );
    const validation = await testNotificationService(
      {
        name: "Discord",
        type: "discord",
        webhookUrl: "https://discord.example/api/webhooks/private-token",
      },
      {
        timeoutMs: 1_000,
        fetch: async () =>
          new Response("private remote details", { status: 404 }),
      },
    );

    expect(authentication).toMatchObject({
      status: "error",
      category: "authentication",
      technicalDetail: "HTTP 401",
    });
    expect(validation).toMatchObject({
      status: "error",
      category: "validation",
      technicalDetail: "HTTP 404",
    });
    expect(JSON.stringify([authentication, validation])).not.toContain(
      "private",
    );
  });

  it("reports a bounded timeout without exposing the destination", async () => {
    const result = await testNotificationService(
      {
        name: "Slow Discord",
        type: "discord",
        webhookUrl: "https://discord.example/secret-path",
      },
      {
        timeoutMs: 5,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted secret-path", "AbortError")),
            );
          }),
      },
    );

    expect(result).toMatchObject({
      status: "error",
      category: "timeout",
      technicalDetail: "Timeout after 5 ms",
    });
    expect(JSON.stringify(result)).not.toContain("secret-path");
  });

  it("uses the same PagerDuty test incident for separate trigger and resolve actions", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(undefined, { status: 202 });
      },
    );
    const notifier = {
      name: "Emergency",
      type: "pagerduty" as const,
      routingKey: "private-routing-key",
    };

    const trigger = await testNotificationService(notifier, {
      timeoutMs: 1_000,
      fetch,
      pagerDutyEndpoint: "https://pagerduty.example/enqueue",
      operation: "send",
    });
    const resolve = await testNotificationService(notifier, {
      timeoutMs: 1_000,
      fetch,
      pagerDutyEndpoint: "https://pagerduty.example/enqueue",
      operation: "resolve",
    });

    expect(bodies[0]).toMatchObject({
      routing_key: "private-routing-key",
      event_action: "trigger",
      payload: {
        summary: "TEST: Signal K Persistent Notifier: Emergency",
        severity: "warning",
      },
    });
    expect(bodies[1]).toMatchObject({
      routing_key: "private-routing-key",
      event_action: "resolve",
    });
    expect(bodies[1]).not.toHaveProperty("payload");
    expect(bodies[0].dedup_key).toBe(bodies[1].dedup_key);
    expect(trigger.message).toContain("real test incident");
    expect(resolve.message).toContain("resolve event");
    expect(JSON.stringify([trigger, resolve])).not.toContain("routing-key");
  });
});
