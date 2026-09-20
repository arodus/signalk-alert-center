import { describe, expect, it, vi } from "vitest";
import { AlertRecord, DeliveryRecord } from "../src/alerts/types";
import { DeliveryScheduler } from "../src/delivery/scheduler";
import { AlertDatabase } from "../src/storage/db";
import {
  renderSpeechText,
  WyomingSayApi,
  WyomingTransport,
} from "../src/transports/wyoming";
import { renderAlert } from "../src/transports/transport";

const now = new Date("2026-01-01T00:00:00.000Z");
const alert: AlertRecord = {
  id: "occurrence-1",
  definitionId: "definition-1",
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
  speechTemplate: "{name}: {severity}. {message}. {path}. {state}",
};

function delivery(operation: DeliveryRecord["operation"]): DeliveryRecord {
  return {
    id: `${operation}-delivery`,
    alertId: alert.id,
    transportInstanceId: "Bridge speakers",
    operation,
    state: "sending",
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function context() {
  return {
    rendered: renderAlert(alert),
    now,
    signal: new AbortController().signal,
  };
}

describe("WyomingTransport", () => {
  it("renders bounded alert text from the occurrence policy snapshot", () => {
    expect(renderSpeechText(alert, "Anchor alarm", "trigger")).toBe(
      "Anchor alarm: alarm. Anchor dragging. notifications.navigation.anchor. active",
    );
    expect(
      renderSpeechText(
        { ...alert, speechTemplate: "{message}", message: "x".repeat(600) },
        "Anchor alarm",
        "trigger",
      ),
    ).toHaveLength(500);
    expect(renderSpeechText(alert, "Anchor alarm", "resolve")).toBe(
      "Cleared. Anchor alarm.",
    );
  });

  it("queues urgent speech through the published signalk-wyoming API", async () => {
    const say = vi.fn().mockResolvedValue({ ok: true, queued: ["salon"] });
    const transport = new WyomingTransport({
      api: () => ({ version: 1, say }),
      targets: ["salon", "salon"],
      voice: "en_US-lessac-medium",
      urgentAt: "alarm",
      definitionName: () => "Anchor alarm",
    });

    await expect(
      transport.send(alert, delivery("trigger"), context()),
    ).resolves.toEqual({ kind: "success", remoteId: "salon" });
    expect(say).toHaveBeenCalledWith({
      text: "Anchor alarm: alarm. Anchor dragging. notifications.navigation.anchor. active",
      priority: "urgent",
      targets: ["salon"],
      voice: "en_US-lessac-medium",
    });
  });

  it("speaks a clear notification at the occurrence priority", async () => {
    const say = vi.fn().mockResolvedValue({ ok: true, queued: ["salon"] });
    const transport = new WyomingTransport({
      api: () => ({ version: 1, say }),
      urgentAt: "emergency",
      definitionName: () => "Anchor alarm",
    });

    await transport.send(alert, delivery("resolve"), context());

    expect(say).toHaveBeenCalledWith({
      text: "Cleared. Anchor alarm.",
      priority: "normal",
    });
  });

  it("retries while signalk-wyoming is unavailable", async () => {
    const transport = new WyomingTransport({ api: () => undefined });
    await expect(
      transport.send(alert, delivery("trigger"), context()),
    ).resolves.toMatchObject({
      kind: "retryable",
      code: "WYOMING_UNAVAILABLE",
    });
  });

  it("records muted normal speech as intentionally suppressed", async () => {
    const api: WyomingSayApi = {
      version: 1,
      say: vi.fn().mockResolvedValue({ ok: true, suppressed: "muted" }),
    };
    const transport = new WyomingTransport({ api: () => api });
    await expect(
      transport.send(
        { ...alert, maxSeverity: "warn" },
        delivery("trigger"),
        context(),
      ),
    ).resolves.toEqual({ kind: "success", remoteId: "suppressed:muted" });
  });

  it("persists a fake Wyoming queue result through the delivery scheduler", async () => {
    const database = new AlertDatabase();
    const say = vi.fn().mockResolvedValue({ ok: true, queued: ["bridge"] });
    const transport = new WyomingTransport({
      api: () => ({ version: 1, say }),
      definitionName: () => "Anchor alarm",
    });
    const occurrence = database.ingest(
      {
        sourceKey: alert.sourceKey,
        path: alert.path,
        state: "active",
        severity: "alarm",
        message: alert.message,
      },
      ["Bridge speakers"],
      now,
      {
        resolvingNotifierIds: ["Bridge speakers"],
        acknowledgingNotifierIds: [],
        speechTemplate: "{name}. {message}",
      },
    )!;
    const scheduler = new DeliveryScheduler(
      database,
      new Map([["Bridge speakers", transport]]),
    );

    await expect(scheduler.runOnce(now)).resolves.toMatchObject({
      processed: 1,
      succeeded: 1,
    });
    expect(database.listDeliveriesForAlert(occurrence.id)).toMatchObject([
      {
        operation: "trigger",
        state: "delivered",
        remoteId: "bridge",
      },
    ]);
    expect(say).toHaveBeenCalledWith({
      text: "Anchor alarm. Anchor dragging",
      priority: "urgent",
    });
    database.close();
  });
});
