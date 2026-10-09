import { describe, it, expect, vi } from "vitest";
import { AlertDatabase } from "../src/storage/db";
import { SuppressionStore, snoozeSeconds } from "../src/suppression/store";
import { DeliveryScheduler } from "../src/delivery/scheduler";
import { registerSnoozePuts } from "../src/signalk/snooze";
import { ServerAPI, ActionHandler } from "@signalk/server-api";

const start = new Date("2026-10-09T00:00:00Z");
const later = new Date("2026-10-09T00:01:00Z");
const input = {
  sourceKey: "notifications.test",
  path: "notifications.test",
  severity: "emergency" as const,
  state: "active" as const,
};

describe("global snooze", () => {
  it("pauses without attempts, suppresses cleared alerts, and resumes active alerts once", async () => {
    const db = new AlertDatabase();
    const store = new SuppressionStore(db);
    store.setSnooze(900, "test", start);
    const active = db.ingest(input, ["test"], start)!;
    const cleared = db.ingest(
      {
        ...input,
        sourceKey: "notifications.clear",
        path: "notifications.clear",
      },
      ["test"],
      start,
    )!;
    const reason = () =>
      store.getSnooze().active
        ? {
            reason: "snooze",
            startedAt: start.toISOString(),
            endsAt: store.getSnooze().endsAt!,
          }
        : undefined;
    store.reconcile(reason, start);
    expect(db.listDueDeliveries(later)).toHaveLength(0);
    expect(db.listDeliveriesForAlert(active.id)[0]).toMatchObject({
      state: "paused",
      attemptCount: 0,
    });
    db.ingest(
      {
        ...input,
        sourceKey: "notifications.clear",
        path: "notifications.clear",
        state: "cleared",
      },
      [],
      later,
    );
    store.setSnooze(0, "expiry", later);
    store.reconcile(reason, later);
    store.reconcile(reason, later);
    expect(db.listDeliveriesForAlert(cleared.id)[0].state).toBe("suppressed");
    const send = vi.fn(async () => ({ kind: "success" as const }));
    const scheduler = new DeliveryScheduler(
      db,
      new Map([["test", { type: "test", send }]]),
    );
    await scheduler.runOnce(later);
    await scheduler.runOnce(later);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.pendingDeliveryCount()).toBe(0);
    expect(store.events()).toHaveLength(2);
    db.close();
  });
  it("preserves historical work cleared before snooze and remote resolve work", () => {
    const db = new AlertDatabase();
    const store = new SuppressionStore(db);
    const alert = db.ingest(input, ["test"], new Date(start.getTime() - 2000))!;
    db.ingest(
      { ...input, state: "cleared" },
      [],
      new Date(start.getTime() - 1000),
    );
    store.setSnooze(900, "test", start);
    store.reconcile(
      () => ({
        reason: "snooze",
        startedAt: start.toISOString(),
        endsAt: later.toISOString(),
      }),
      start,
    );
    store.setSnooze(0, "test", later);
    store.reconcile(() => undefined, later);
    expect(db.listDeliveriesForAlert(alert.id)[0].state).toBe("pending");
    db.close();
  });
  it("checks the gate after asynchronous metadata lookup before claiming or sending", async () => {
    const db = new AlertDatabase();
    const store = new SuppressionStore(db);
    const alert = db.ingest(input, ["test"], start)!;
    let finish!: () => void;
    const metadata = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const send = vi.fn(async () => ({ kind: "success" as const }));
    const scheduler = new DeliveryScheduler(
      db,
      new Map([["test", { type: "test", send }]]),
      undefined,
      {
        unitMetadata: async () => {
          await metadata;
          return undefined;
        },
        beforeSend: (delivery) => {
          if (!store.getSnooze().active) return true;
          store.hold(
            delivery,
            {
              reason: "snooze",
              startedAt: start.toISOString(),
              endsAt: later.toISOString(),
            },
            start,
          );
          return false;
        },
      },
    );
    const run = scheduler.runOnce(start);
    store.setSnooze(900, "test", start);
    finish();
    await run;
    expect(send).not.toHaveBeenCalled();
    expect(db.listDeliveriesForAlert(alert.id)[0]).toMatchObject({
      state: "paused",
      attemptCount: 0,
    });
    db.close();
  });
  it("keeps accepted audio history and gives resumed audio a new delivery identity", () => {
    const db = new AlertDatabase();
    const store = new SuppressionStore(db);
    const alert = db.ingest(input, ["audio"], start)!;
    const delivery = db.listDeliveriesForAlert(alert.id)[0];
    db.claimDelivery(delivery.id, start);
    db.recordDeliverySuccess(delivery.id, "audio-id", start);
    store.hold(
      db.getDelivery(delivery.id)!,
      {
        reason: "snooze",
        startedAt: start.toISOString(),
        endsAt: later.toISOString(),
      },
      start,
      true,
    );
    store.reconcile(() => undefined, later);
    store.reconcile(() => undefined, later);
    const rows = db.listDeliveriesForAlert(alert.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe("delivered");
    expect(rows[1]).toMatchObject({ state: "pending", cycle: 2 });
    db.close();
  });
  it("validates bounded durations and makes repeated boolean PUT idempotent", () => {
    const handlers = new Map<string, ActionHandler>();
    const db = new AlertDatabase();
    const store = new SuppressionStore(db);
    registerSnoozePuts(
      {
        registerPutHandler: (_c: string, p: string, h: ActionHandler) =>
          handlers.set(p, h),
      } as ServerAPI,
      () => store.getSnooze(),
      (seconds, source) => {
        store.setSnooze(seconds, source, start);
      },
    );
    const put = (name: string, value: unknown) =>
      handlers.get(`digital.alertCenter.snooze.${name}`)!(
        "vessels.self",
        "",
        value,
        () => {},
      );
    expect(put("duration", 900)).toMatchObject({ statusCode: 200 });
    const deadline = store.getSnooze().endsAt;
    expect(put("active", true)).toMatchObject({ statusCode: 200 });
    expect(store.getSnooze().endsAt).toBe(deadline);
    expect(put("duration", 28801)).toMatchObject({ statusCode: 400 });
    expect(put("active", "true")).toMatchObject({ statusCode: 400 });
    expect(put("active", false)).toMatchObject({ statusCode: 200 });
    expect(store.getSnooze().active).toBe(false);
    for (const value of [-1, NaN, Infinity, 0.5, "900", null])
      expect(() => snoozeSeconds(value)).toThrow();
    db.close();
  });
});

describe("snooze database restart", () => {
  it("migrates version two and restores the deadline and paused work without resetting data", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "snooze-"));
    const file = join(dir, "state.sqlite");
    try {
      let db = new AlertDatabase(file);
      const alert = db.ingest(input, ["remote"], start)!;
      db.db.exec(
        "DROP TABLE delivery_holds; DROP TABLE notification_controls; DROP TABLE suppression_events; PRAGMA user_version=2;",
      );
      db.close();
      db = new AlertDatabase(file);
      expect(db.migrationApplied).toBe(true);
      let store = new SuppressionStore(db);
      const state = store.setSnooze(900, "test", start);
      store.reconcile(
        () => ({
          reason: "snooze",
          startedAt: state.startedAt!,
          endsAt: state.endsAt!,
        }),
        start,
      );
      db.close();
      db = new AlertDatabase(file);
      store = new SuppressionStore(db);
      expect(db.migrationApplied).toBe(false);
      expect(store.getSnooze()).toEqual(state);
      expect(db.getAlert(alert.id).currentState).toBe("active");
      expect(db.listDueDeliveries(later)).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("runtime cancels owned audio, blocks emergency tests, and resumes with a fresh identity", async () => {
  const { AlertCenterRuntime } = await import("../src/runtime");
  const db = new AlertDatabase();
  const store = new SuppressionStore(db);
  const alert = db.ingest(
    { ...input, sourcePayload: { method: ["sound"] } },
    ["audio"],
    new Date(),
  )!;
  const delivery = db.listDeliveriesForAlert(alert.id)[0];
  db.claimDelivery(delivery.id);
  db.recordDeliverySuccess(delivery.id, "owned");
  db.recordWyomingPlayback(delivery.id, "sound", {
    id: "owned",
    state: "playing",
  });
  const cancel = vi.fn(() => ({ id: "owned", state: "cancelled" as const }));
  const runtime = new AlertCenterRuntime({
    handleMessage: vi.fn(),
    setPluginStatus: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as ServerAPI);
  const internal = runtime as unknown as {
    database: AlertDatabase;
    suppression: SuppressionStore;
    config: unknown;
    wyomingApi: unknown;
    testNotifier: (id: string, operation: "send") => Promise<unknown>;
  };
  internal.database = db;
  internal.suppression = store;
  internal.config = { notifiers: [{ name: "audio", type: "wyoming" }] };
  internal.wyomingApi = {
    version: 1,
    announce: vi.fn(),
    getAnnouncement: () => ({ id: "owned", state: "playing" }),
    cancelAnnouncement: cancel,
  };
  runtime.setSnooze(900);
  expect(cancel).toHaveBeenCalledWith("owned");
  expect(await internal.testNotifier("audio", "send")).toBe("snoozed");
  runtime.setSnooze(0);
  expect(db.listDeliveriesForAlert(alert.id)).toHaveLength(2);
  expect(db.getDelivery(delivery.id)?.state).toBe("delivered");
  await runtime.stop();
});
