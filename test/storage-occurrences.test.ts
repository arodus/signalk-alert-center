import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NormalizedAlert } from "../src/alerts/types";
import { AlertDatabase } from "../src/storage/db";

const active = (overrides: Partial<NormalizedAlert> = {}): NormalizedAlert => ({
  sourceKey: "notifications.navigation.anchor",
  path: "notifications.navigation.anchor",
  state: "active",
  severity: "alarm",
  message: "Anchor dragging",
  ...overrides,
});

describe("occurrence storage", () => {
  const databases: AlertDatabase[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const database of databases) database.close();
    databases.length = 0;
    for (const directory of directories)
      rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  const database = () => {
    const result = new AlertDatabase();
    databases.push(result);
    return result;
  };

  it("stores raise-clear-raise as distinct occurrences and keeps dismissal history", () => {
    const db = database();
    const first = db.ingest(
      active(),
      ["ntfy"],
      new Date("2026-01-01T00:00:00Z"),
    )!;
    db.ingest(
      active({ state: "cleared", severity: "normal" }),
      ["ntfy"],
      new Date("2026-01-01T00:01:00Z"),
    );
    db.dismissOccurrence(first.id, new Date("2026-01-01T00:02:00Z"));
    const second = db.ingest(
      active(),
      ["ntfy"],
      new Date("2026-01-01T00:03:00Z"),
    )!;

    expect(second.id).not.toBe(first.id);
    expect(second.occurrenceNumber).toBe(2);
    expect(db.listOccurrences()).toHaveLength(2);
    expect(db.listOccurrences({ dismissed: true })).toHaveLength(1);
    expect(db.listOccurrences({ dismissed: false })).toEqual([second]);
    expect(
      db.listAlertEvents(first.id).map((event) => event.eventType),
    ).toEqual(["raised", "cleared", "dismissed"]);
    expect(db.listDeliveries()).toHaveLength(2);
  });

  it("does not fabricate an occurrence for an orphan clear", () => {
    const db = database();
    const result = db.ingest(active({ state: "cleared", severity: "normal" }), [
      "ntfy",
    ]);
    expect(result).toBeUndefined();
    expect(db.listOccurrences()).toEqual([]);
    expect(db.listDeliveries()).toEqual([]);
  });

  it("persists activation deadlines across restart and promotes once", () => {
    const directory = mkdtempSync(join(tmpdir(), "notifier-storage-"));
    directories.push(directory);
    const filename = join(directory, "alerts.sqlite");
    const firstDb = new AlertDatabase(filename);
    const startedAt = new Date("2026-01-01T00:00:00Z");
    const occurrence = firstDb.ingest(
      active(),
      ["ntfy", "discord"],
      startedAt,
      {
        activationDelaySeconds: 60,
      },
    )!;
    expect(firstDb.listDeliveries()).toEqual([]);
    expect(firstDb.nextActivationDueAt()).toEqual(
      new Date("2026-01-01T00:01:00Z"),
    );
    firstDb.close();

    const restarted = new AlertDatabase(filename);
    databases.push(restarted);
    expect(
      restarted.processDueActivations(new Date("2026-01-01T00:00:59Z")),
    ).toEqual([]);
    expect(
      restarted.processDueActivations(new Date("2026-01-01T00:01:00Z"))[0].id,
    ).toBe(occurrence.id);
    expect(restarted.listDeliveries()).toHaveLength(2);
    expect(
      restarted.processDueActivations(new Date("2026-01-01T00:02:00Z")),
    ).toEqual([]);
    expect(
      restarted.listAlertEvents(occurrence.id).map((event) => event.eventType),
    ).toEqual(["raised", "activation_eligible"]);
  });

  it("suppresses a pending activation that clears before its deadline", () => {
    const db = database();
    const occurrence = db.ingest(
      active(),
      ["ntfy"],
      new Date("2026-01-01T00:00:00Z"),
      {
        activationDelaySeconds: 60,
      },
    )!;
    db.ingest(
      active({ state: "cleared", severity: "normal" }),
      ["ntfy"],
      new Date("2026-01-01T00:00:30Z"),
    );
    expect(db.getAlert(occurrence.id).activationState).toBe("suppressed");
    expect(db.nextActivationDueAt()).toBeUndefined();
    expect(db.processDueActivations(new Date("2026-01-01T00:02:00Z"))).toEqual(
      [],
    );
    expect(db.listDeliveries()).toEqual([]);
  });

  it("stores policies, explicit rearm, filtered pages, and delivery attempts", () => {
    const db = database();
    db.upsertDefinition({
      id: "anchor-rule",
      sourceType: "rule",
      pathPattern: "notifications.navigation.anchor",
      name: "Anchor",
    });
    const policy = db.setPolicy("anchor-rule", {
      enabled: true,
      oneTime: false,
      minimumSeverity: "warn",
      connectivity: { mode: "queue" },
      activationDelaySeconds: 0,
      rearmAfterSeconds: 60,
      notifierIds: ["ntfy"],
    });
    expect(policy.rearmAfterSeconds).toBe(60);

    const first = db.ingest(
      active(),
      ["ntfy"],
      new Date("2026-01-01T00:00:00Z"),
      {
        definitionId: "anchor-rule",
        rearmAfterSeconds: 60,
      },
    )!;
    const second = db.ingest(
      active(),
      ["ntfy"],
      new Date("2026-01-01T00:01:00Z"),
      {
        definitionId: "anchor-rule",
        rearmAfterSeconds: 60,
      },
    )!;
    expect(second.id).not.toBe(first.id);
    expect(
      db.queryOccurrences({ definitionId: "anchor-rule", limit: 1 }),
    ).toMatchObject({
      items: [{ id: second.id }],
      nextCursor: second.id,
    });

    const delivery = db.listDeliveries()[0];
    db.claimDelivery(delivery.id, new Date("2026-01-01T00:02:00Z"));
    db.recordDeliveryFailure(
      delivery.id,
      "TIMEOUT",
      "timed out",
      true,
      new Date("2026-01-01T00:03:00Z"),
      new Date("2026-01-01T00:02:10Z"),
    );
    expect(db.listDeliveryAttempts(delivery.id)).toMatchObject([
      {
        attemptNumber: 1,
        outcome: "failed_retryable",
        errorCode: "TIMEOUT",
      },
    ]);
  });

  it("preserves source time separately from local receipt time", () => {
    const db = database();
    const sourceTimestamp = new Date("2025-12-31T23:59:30Z");
    const receivedAt = new Date("2026-01-01T00:00:00Z");
    const occurrence = db.ingest(active({ sourceTimestamp }), [], receivedAt)!;
    expect(occurrence.sourceTimestamp).toEqual(sourceTimestamp);
    expect(occurrence.receivedAt).toEqual(receivedAt);
  });
});
