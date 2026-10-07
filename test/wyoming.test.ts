import { describe, expect, it, vi } from "vitest";
import { AlertRecord, DeliveryRecord } from "../src/alerts/types";
import { DeliveryScheduler } from "../src/delivery/scheduler";
import { AlertDatabase } from "../src/storage/db";
import {
  renderSpeechText,
  WyomingAnnouncementApi,
  WyomingTransport,
} from "../src/transports/wyoming";
import {
  NotificationTransport,
  renderAlert,
} from "../src/transports/transport";

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
  sourcePayload: { method: ["visual", "sound"] },
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
  it.each([
    { method: ["visual"] },
    { method: [] },
    {},
    { method: "sound" },
    { method: null },
    null,
  ])(
    "suppresses all audio without a sound method: %j",
    async (sourcePayload) => {
      const announce = vi.fn();
      const transport = new WyomingTransport({
        api: () => ({ version: 1, announce }),
      });

      for (const operation of ["trigger", "resolve"] as const) {
        await expect(
          transport.send(
            { ...alert, sourcePayload },
            delivery(operation),
            context(),
          ),
        ).resolves.toEqual({ kind: "success", remoteId: "suppressed:method" });
      }
      expect(announce).not.toHaveBeenCalled();
    },
  );

  it("suppresses visual alerts even when Wyoming is unavailable", async () => {
    const transport = new WyomingTransport({ api: () => undefined });

    await expect(
      transport.send(
        { ...alert, sourcePayload: { method: ["visual"] } },
        delivery("trigger"),
        context(),
      ),
    ).resolves.toEqual({ kind: "success", remoteId: "suppressed:method" });
  });

  it("keeps remote delivery and history when a queued alert becomes visual-only", async () => {
    const database = new AlertDatabase();
    const announce = vi.fn();
    const remoteSend = vi.fn().mockResolvedValue({ kind: "success" });
    const occurrence = database.ingest(
      {
        sourceKey: alert.sourceKey,
        path: alert.path,
        state: "active",
        severity: "alarm",
        message: alert.message,
        sourcePayload: alert.sourcePayload,
      },
      ["Bridge speakers", "Crew"],
      now,
    )!;
    database.ingest(
      {
        sourceKey: alert.sourceKey,
        path: alert.path,
        state: "active",
        severity: "alarm",
        message: alert.message,
        sourcePayload: { method: ["visual"] },
      },
      ["Bridge speakers", "Crew"],
      new Date(now.getTime() + 1000),
    );
    const scheduler = new DeliveryScheduler(
      database,
      new Map<string, NotificationTransport>([
        [
          "Bridge speakers",
          new WyomingTransport({ api: () => ({ version: 1, announce }) }),
        ],
        ["Crew", { type: "ntfy", send: remoteSend }],
      ]),
    );

    try {
      await expect(
        scheduler.runOnce(new Date(now.getTime() + 2000)),
      ).resolves.toMatchObject({ processed: 2, succeeded: 2 });
      expect(announce).not.toHaveBeenCalled();
      expect(remoteSend).toHaveBeenCalledOnce();
      expect(database.getAlert(occurrence.id).sourcePayload).toEqual({
        method: ["visual"],
      });
      expect(database.listAlertEvents(occurrence.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventType: "raised" }),
          expect.objectContaining({ eventType: "updated" }),
        ]),
      );
      expect(database.listDeliveriesForAlert(occurrence.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            transportInstanceId: "Bridge speakers",
            state: "delivered",
            remoteId: "suppressed:method",
          }),
          expect.objectContaining({
            transportInstanceId: "Crew",
            state: "delivered",
          }),
        ]),
      );
    } finally {
      database.close();
    }
  });

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
    const announce = vi.fn().mockResolvedValue({
      id: "speech-1",
      state: "queued",
      targets: { salon: { state: "queued" } },
    });
    const transport = new WyomingTransport({
      api: () => ({ version: 1, announce }),
      targets: ["salon", "salon"],
      voice: "en_US-lessac-medium",
      urgentAt: "alarm",
      definitionName: () => "Anchor alarm",
    });

    await expect(
      transport.send(
        { ...alert, soundEnabled: false },
        delivery("trigger"),
        context(),
      ),
    ).resolves.toEqual({ kind: "success", remoteId: "speech:speech-1" });
    expect(announce).toHaveBeenCalledWith({
      requestId: "trigger-delivery:speech",
      content: {
        kind: "speech",
        text: "Anchor alarm: alarm. Anchor dragging. notifications.navigation.anchor. active",
        voice: "en_US-lessac-medium",
      },
      priority: "urgent",
      targets: ["salon"],
    });
  });

  it("queues the alert sound before a clear notification", async () => {
    const announce = vi
      .fn()
      .mockResolvedValueOnce({ id: "clear-sound-1", state: "queued" })
      .mockResolvedValueOnce({ id: "clear-speech-1", state: "queued" });
    const transport = new WyomingTransport({
      api: () => ({ version: 1, announce }),
      urgentAt: "emergency",
      definitionName: () => "Anchor alarm",
    });

    await transport.send(alert, delivery("resolve"), context());

    expect(announce.mock.calls).toEqual([
      [
        {
          requestId: "resolve-delivery:sound",
          content: { kind: "sound", soundId: "alarm" },
          priority: "normal",
        },
      ],
      [
        {
          requestId: "resolve-delivery:speech",
          content: { kind: "speech", text: "Cleared. Anchor alarm." },
          priority: "normal",
        },
      ],
    ]);
  });

  it("queues the per-alert sound before optional speech", async () => {
    const announce = vi
      .fn()
      .mockResolvedValueOnce({ id: "sound-1", state: "queued" })
      .mockResolvedValueOnce({ id: "speech-1", state: "queued" });
    const transport = new WyomingTransport({
      api: () => ({ version: 1, announce }),
      sounds: { alarm: "alarm" },
      definitionName: () => "Anchor alarm",
    });

    await expect(
      transport.send(
        { ...alert, soundId: "anchor-bell", speechEnabled: true },
        delivery("trigger"),
        context(),
      ),
    ).resolves.toEqual({
      kind: "success",
      remoteId: "sound:sound-1,speech:speech-1",
    });
    expect(announce.mock.calls).toEqual([
      [
        {
          content: { kind: "sound", soundId: "anchor-bell" },
          priority: "urgent",
          requestId: "trigger-delivery:sound",
        },
      ],
      [
        {
          content: {
            kind: "speech",
            text: "Anchor alarm: alarm. Anchor dragging. notifications.navigation.anchor. active",
          },
          priority: "urgent",
          requestId: "trigger-delivery:speech",
        },
      ],
    ]);
  });

  it("can play a severity sound without speaking", async () => {
    const announce = vi.fn().mockResolvedValue({
      id: "sound-1",
      state: "queued",
    });
    const transport = new WyomingTransport({
      api: () => ({ version: 1, announce }),
      sounds: { warn: "warning" },
    });

    await transport.send(
      {
        ...alert,
        maxSeverity: "warn",
        speechMinimumSeverity: "alarm",
      },
      delivery("trigger"),
      context(),
    );

    expect(announce).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledWith({
      content: { kind: "sound", soundId: "warning" },
      priority: "normal",
      requestId: "trigger-delivery:sound",
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
    const api: WyomingAnnouncementApi = {
      version: 1,
      announce: vi.fn().mockResolvedValue({
        id: "muted-1",
        state: "suppressed",
      }),
    };
    const transport = new WyomingTransport({ api: () => api });
    await expect(
      transport.send(
        { ...alert, maxSeverity: "warn", soundEnabled: false },
        delivery("trigger"),
        context(),
      ),
    ).resolves.toEqual({ kind: "success", remoteId: "speech:muted-1" });
  });

  it("persists a fake Wyoming queue result through the delivery scheduler", async () => {
    const database = new AlertDatabase();
    const announce = vi.fn().mockResolvedValue({
      id: "speech-1",
      state: "queued",
      requestId: "tracked-request",
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
      targets: {
        salon: { state: "queued", queuedAt: now.getTime() },
      },
    });
    const transport = new WyomingTransport({
      api: () => ({ version: 1, announce }),
      definitionName: () => "Anchor alarm",
      onAnnouncement: (deliveryId, kind, snapshot) =>
        database.recordWyomingPlayback(deliveryId, kind, snapshot),
    });
    const occurrence = database.ingest(
      {
        sourceKey: alert.sourceKey,
        path: alert.path,
        state: "active",
        severity: "alarm",
        message: alert.message,
        sourcePayload: alert.sourcePayload,
      },
      ["Bridge speakers"],
      now,
      {
        resolvingNotifierIds: ["Bridge speakers"],
        acknowledgingNotifierIds: [],
        speechTemplate: "{name}. {message}",
        soundEnabled: false,
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
        remoteId: "speech:speech-1",
      },
    ]);
    expect(
      database.listWyomingPlaybacks(
        database.listDeliveriesForAlert(occurrence.id)[0]!.id,
      ),
    ).toMatchObject([
      {
        announcementId: "speech-1",
        kind: "speech",
        requestId: "tracked-request",
        state: "queued",
        targets: { salon: { state: "queued", queuedAt: now } },
      },
    ]);
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          kind: "speech",
          text: "Anchor alarm. Anchor dragging",
        },
        priority: "urgent",
        requestId: expect.stringMatching(/:speech$/),
      }),
    );
    database.close();
  });
});
