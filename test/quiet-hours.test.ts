import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QuietHours,
  QuietHoursClock,
  validateQuietHours,
} from "../src/suppression/quiet-hours";
import { AlertDatabase } from "../src/storage/db";
import { SuppressionStore } from "../src/suppression/store";
import { AlertCenterRuntime } from "../src/runtime";
import { ServerAPI } from "@signalk/server-api";
import { DeliveryRecord, Severity } from "../src/alerts/types";

const schedule: QuietHours = {
  enabled: true,
  start: "22:00",
  end: "07:00",
  timeZone: "Europe/Berlin",
  minimumSeverity: "alarm",
};
afterEach(() => vi.useRealTimers());
describe("quiet hours clock", () => {
  it("crosses midnight with exact inclusive start and exclusive end", () => {
    const clock = new QuietHoursClock();
    expect(
      clock.window("cabin", schedule, new Date("2026-01-01T20:59:59Z")),
    ).toMatchObject({
      active: false,
      nextChangeAt: "2026-01-01T21:00:00.000Z",
    });
    expect(
      clock.window("cabin", schedule, new Date("2026-01-01T21:00:00Z")),
    ).toMatchObject({
      active: true,
      startedAt: "2026-01-01T21:00:00.000Z",
      endsAt: "2026-01-02T06:00:00.000Z",
    });
    expect(
      clock.window("cabin", schedule, new Date("2026-01-02T06:00:00Z")),
    ).toMatchObject({ active: false });
  });
  it("uses local wall time through spring and autumn DST changes", () => {
    const clock = new QuietHoursClock();
    expect(
      clock.window("cabin", schedule, new Date("2026-03-28T23:00:00Z")),
    ).toMatchObject({
      active: true,
      startedAt: "2026-03-28T21:00:00.000Z",
      endsAt: "2026-03-29T05:00:00.000Z",
    });
    expect(
      clock.window("cabin", schedule, new Date("2026-10-24T23:00:00Z")),
    ).toMatchObject({
      active: true,
      startedAt: "2026-10-24T20:00:00.000Z",
      endsAt: "2026-10-25T06:00:00.000Z",
    });
  });
  it("handles daytime windows, timezone changes and backwards clock corrections", () => {
    const clock = new QuietHoursClock();
    const daytime = {
      ...schedule,
      start: "09:00",
      end: "17:00",
      timeZone: "UTC",
    };
    expect(
      clock.window("desk", daytime, new Date("2026-01-01T10:00:00Z")).active,
    ).toBe(true);
    expect(
      clock.window("desk", daytime, new Date("2026-01-01T08:00:00Z")).active,
    ).toBe(false);
    expect(
      clock.window(
        "desk",
        { ...daytime, timeZone: "America/Curacao" },
        new Date("2026-01-01T10:00:00Z"),
      ).active,
    ).toBe(false);
    expect(clock.window("desk", { ...daytime, enabled: false })).toEqual({
      enabled: false,
      active: false,
    });
  });
  it("validates times, thresholds and timezones", () => {
    for (const patch of [
      { start: "25:00" },
      { end: "22:00" },
      { timeZone: "Boat/Local" },
      { minimumSeverity: "critical" },
    ])
      expect(() =>
        validateQuietHours({ ...schedule, ...patch } as QuietHours),
      ).toThrow();
    expect(() => validateQuietHours(undefined)).not.toThrow();
  });
});

it("holds only services below their threshold, allows PagerDuty actions, and gives global snooze precedence", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-01-01T23:00:00Z"));
  const db = new AlertDatabase();
  const store = new SuppressionStore(db);
  const app = {
    handleMessage: vi.fn(),
    setPluginStatus: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as ServerAPI;
  const runtime = new AlertCenterRuntime(app);
  const internal = runtime as unknown as {
    database: AlertDatabase;
    suppression: SuppressionStore;
    config: unknown;
    reconcileSuppression(): void;
    suppressionReason(delivery?: DeliveryRecord): unknown;
    canWakeForAlert(id: string): boolean;
    testNotifier(id: string, op: "send"): Promise<unknown>;
  };
  internal.database = db;
  internal.suppression = store;
  internal.config = {
    notifiers: [
      { name: "cabin", type: "wyoming", quietHours: schedule },
      { name: "phone", type: "ntfy", quietHours: schedule },
      { name: "log", type: "discord" },
      { name: "pd", type: "pagerduty", quietHours: schedule },
    ],
  };
  const input = {
    sourceKey: "notifications.night",
    path: "notifications.night",
    severity: "warn" as Severity,
    state: "active" as const,
  };
  const alert = db.ingest(input, ["cabin", "phone", "log", "pd"], new Date(), {
    connectivity: { mode: "wake" },
    resolvingNotifierIds: ["pd"],
    acknowledgingNotifierIds: ["pd"],
  })!;
  const pd = db
    .listDeliveriesForAlert(alert.id)
    .find((d) => d.transportInstanceId === "pd")!;
  db.claimDelivery(pd.id);
  db.recordDeliverySuccess(pd.id);
  db.acknowledgeAlert(alert.id);
  internal.reconcileSuppression();
  expect(
    db
      .listDeliveriesForAlert(alert.id)
      .filter((d) => d.state === "paused")
      .map((d) => d.transportInstanceId),
  ).toEqual(["cabin", "phone"]);
  const acknowledge = db
    .listDeliveriesForAlert(alert.id)
    .find((d) => d.operation === "acknowledge")!;
  expect(internal.suppressionReason(acknowledge)).toBeUndefined();
  expect(internal.canWakeForAlert(alert.id)).toBe(true); // Discord remains unrestricted.
  expect(await internal.testNotifier("phone", "send")).toBe("snoozed");
  runtime.setSnooze(900);
  expect(internal.suppressionReason(acknowledge)).toMatchObject({
    reason: "snooze",
  });
  runtime.setSnooze(0);
  expect(internal.suppressionReason(acknowledge)).toBeUndefined();
  db.ingest(
    { ...input, severity: "emergency" },
    ["cabin", "phone", "log", "pd"],
    new Date(),
  );
  internal.reconcileSuppression();
  expect(
    db.listDeliveriesForAlert(alert.id).filter((d) => d.state === "paused"),
  ).toHaveLength(0);
  await runtime.stop();
});

it("never wakes connectivity for an alert whose remote services are all quiet", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-01-01T23:00:00Z"));
  const db = new AlertDatabase();
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
    canWakeForAlert(id: string): boolean;
  };
  internal.database = db;
  internal.suppression = new SuppressionStore(db);
  internal.config = {
    notifiers: [{ name: "phone", type: "ntfy", quietHours: schedule }],
  };
  const alert = db.ingest(
    {
      sourceKey: "notifications.quiet",
      path: "notifications.quiet",
      severity: "warn",
      state: "active",
    },
    ["phone"],
    new Date(),
    { connectivity: { mode: "wake" } },
  )!;
  expect(internal.canWakeForAlert(alert.id)).toBe(false);
  await runtime.stop();
});

it("automatically releases active work at the scheduled boundary and audits once", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-01-02T05:59:00Z"));
  const db = new AlertDatabase();
  const store = new SuppressionStore(db);
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
    reconcileSuppression(): void;
  };
  internal.database = db;
  internal.suppression = store;
  internal.config = {
    notifiers: [{ name: "phone", type: "ntfy", quietHours: schedule }],
  };
  const alert = db.ingest(
    {
      sourceKey: "notifications.boundary",
      path: "notifications.boundary",
      state: "active",
      severity: "warn",
    },
    ["phone"],
    new Date(),
  )!;
  internal.reconcileSuppression();
  internal.reconcileSuppression();
  expect(store.events()).toHaveLength(1);
  expect(db.listDeliveriesForAlert(alert.id)[0].state).toBe("paused");
  await vi.advanceTimersByTimeAsync(60000);
  expect(db.listDeliveriesForAlert(alert.id)[0].state).toBe("pending");
  expect(store.events()).toHaveLength(2);
  await runtime.stop();
});
