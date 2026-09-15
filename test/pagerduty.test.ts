import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertRecord, DeliveryRecord } from "../src/alerts/types";
import { PagerDutyTransport } from "../src/transports/pagerduty";
import { renderAlert } from "../src/transports/transport";

const now = new Date("2026-01-01T00:00:00.000Z");
const alert: AlertRecord = {
  id: "occurrence-1",
  sourceKey: "notifications.navigation.anchor",
  path: "notifications.navigation.anchor",
  firstSeenAt: now,
  lastSeenAt: now,
  clearedAt: new Date("2026-01-01T00:05:00.000Z"),
  currentState: "cleared",
  currentSeverity: "normal",
  maxSeverity: "alarm",
  message: "Anchor dragging",
  fireCount: 1,
  oneTime: false,
  minimumSeverity: "normal",
  activationDelaySeconds: 0,
  connectivity: { mode: "queue" },
};

function delivery(operation: DeliveryRecord["operation"]): DeliveryRecord {
  return {
    id: `${operation}-delivery`,
    alertId: alert.id,
    transportInstanceId: "pagerduty",
    operation,
    state: "sending",
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe("PagerDutyTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["trigger", "trigger"],
    ["resolve", "resolve"],
  ] as const)("sends a %s delivery as %s", async (operation, eventAction) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new PagerDutyTransport("routing-key");

    await transport.send(alert, delivery(operation), {
      rendered: renderAlert(alert),
      now,
      signal: new AbortController().signal,
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      event_action: eventAction,
      dedup_key: `signalk:${alert.sourceKey}`,
    });
  });
});
