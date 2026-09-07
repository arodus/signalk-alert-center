import { afterEach, describe, expect, it } from "vitest";
import { AlertLifecycle } from "../src/alerts/lifecycle";
import { NormalizedAlert } from "../src/alerts/types";
import { AlertDatabase } from "../src/storage/db";

describe("AlertLifecycle", () => {
  const databases: AlertDatabase[] = [];

  afterEach(() => {
    for (const database of databases) database.close();
    databases.length = 0;
  });

  function createLifecycle(transportIds: string[]) {
    const database = new AlertDatabase();
    databases.push(database);
    return { database, lifecycle: new AlertLifecycle(database, transportIds) };
  }

  function alert(overrides: Partial<NormalizedAlert> = {}): NormalizedAlert {
    return {
      sourceKey: "notifications.bilge.highWater",
      path: "notifications.bilge.highWater",
      severity: "alarm",
      state: "active",
      message: "High water",
      sourcePayload: { state: "alarm" },
      ...overrides
    };
  }

  it("creates an alert and one pending delivery per transport on first ingest", () => {
    const { database, lifecycle } = createLifecycle(["ntfy-main", "pagerduty-critical", "discord-boat"]);
    const ingestedAt = new Date("2026-09-05T10:00:00.000Z");

    const record = lifecycle.ingest(alert(), ingestedAt);

    expect(record).toMatchObject({
      sourceKey: "notifications.bilge.highWater",
      currentState: "active",
      currentSeverity: "alarm",
      maxSeverity: "alarm"
    });
    expect(record.firstSeenAt).toEqual(ingestedAt);
    expect(record.lastSeenAt).toEqual(ingestedAt);
    expect(database.listDeliveries()).toMatchObject([
      { alertId: record.id, transportInstanceId: "ntfy-main", state: "pending", attemptCount: 0 },
      { alertId: record.id, transportInstanceId: "pagerduty-critical", state: "pending", attemptCount: 0 },
      { alertId: record.id, transportInstanceId: "discord-boat", state: "pending", attemptCount: 0 }
    ]);
  });

  it("coalesces duplicate active updates and retains the highest severity", () => {
    const { database, lifecycle } = createLifecycle(["ntfy-main"]);
    const firstSeenAt = new Date("2026-09-05T10:00:00.000Z");
    const updatedAt = new Date("2026-09-05T10:05:00.000Z");

    const first = lifecycle.ingest(alert({ severity: "warn" }), firstSeenAt);
    const second = lifecycle.ingest(alert({ severity: "emergency", message: "More water" }), updatedAt);

    expect(second.id).toBe(first.id);
    expect(second.firstSeenAt).toEqual(firstSeenAt);
    expect(second.lastSeenAt).toEqual(updatedAt);
    expect(second.currentSeverity).toBe("emergency");
    expect(second.maxSeverity).toBe("emergency");
    expect(database.listDeliveries()).toHaveLength(1);
  });

  it("retains a cleared alert and its pending delivery when it clears before delivery", () => {
    const { database, lifecycle } = createLifecycle(["ntfy-main", "discord-boat"]);
    const raisedAt = new Date("2026-09-05T10:00:00.000Z");
    const clearedAt = new Date("2026-09-05T10:17:00.000Z");

    const raised = lifecycle.ingest(alert({ severity: "emergency" }), raisedAt);
    const cleared = lifecycle.ingest(alert({ state: "cleared", severity: "normal" }), clearedAt);

    expect(cleared.id).toBe(raised.id);
    expect(cleared.currentState).toBe("cleared");
    expect(cleared.currentSeverity).toBe("normal");
    expect(cleared.maxSeverity).toBe("emergency");
    expect(cleared.clearedAt).toEqual(clearedAt);
    expect(database.listDeliveries()).toHaveLength(2);
    expect(database.listDeliveries().every((delivery) => delivery.state === "pending")).toBe(true);
  });
});