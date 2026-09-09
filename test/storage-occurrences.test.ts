import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { NormalizedAlert } from "../src/alerts/types";
import { AlertDatabase } from "../src/storage/db";
import { schema } from "../src/storage/schema";

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

  it("migrates a version-one database and installs history indexes", () => {
    const directory = mkdtempSync(join(tmpdir(), "notifier-migration-"));
    directories.push(directory);
    const filename = join(directory, "alerts.sqlite");
    const legacy = new DatabaseSync(filename);
    legacy.exec(schema);
    legacy
      .prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)",
      )
      .run(new Date("2026-01-01T00:00:00Z").toISOString());
    legacy.close();

    const migrated = new AlertDatabase(filename);
    databases.push(migrated);
    expect(migrated.schemaVersion()).toBe(2);
    const columns = migrated.db
      .prepare("PRAGMA table_info(alert_occurrences)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("source");
    const indexes = migrated.db
      .prepare("PRAGMA index_list(alert_occurrences)")
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "occurrence_path_history_idx",
        "occurrence_source_history_idx",
      ]),
    );
  });

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

  it("resets all stored data and re-initializes the schema", () => {
    const db = database();
    const occurrence = db.ingest(active(), ["ntfy"])!;
    db.setWakeDue(occurrence.id, new Date("2026-01-01T00:10:00Z"));
    db.setPolicy(occurrence.definitionId, {
      enabled: true,
      oneTime: false,
      minimumSeverity: "warn",
      connectivity: { mode: "queue" },
      activationDelaySeconds: 0,
      notifierIds: ["ntfy"],
    });

    db.reset();

    expect(db.schemaVersion()).toBe(2);
    expect(db.listDefinitions()).toEqual([]);
    expect(db.listOccurrences()).toEqual([]);
    expect(db.listDeliveries()).toEqual([]);
    expect(db.listWakeRequests()).toEqual([]);
    expect(db.ingest(active(), [])).toMatchObject({ occurrenceNumber: 1 });
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

  it("starts the delay when an occurrence rises above its snapshotted threshold", () => {
    const db = database();
    const started = db.ingest(
      active({ severity: "warn" }),
      ["ntfy"],
      new Date("2026-01-01T00:00:00Z"),
      {
        activationDelaySeconds: 60,
        minimumSeverity: "alarm",
        oneTime: true,
      },
    )!;
    expect(started.activationState).toBe("suppressed");
    expect(started.oneTime).toBe(true);

    const escalated = db.ingest(
      active({ severity: "alarm" }),
      ["discord"],
      new Date("2026-01-01T00:00:30Z"),
      {
        activationDelaySeconds: 0,
        minimumSeverity: "warn",
      },
    )!;
    expect(escalated.activationState).toBe("pending");
    expect(escalated.activationDueAt).toEqual(new Date("2026-01-01T00:01:30Z"));
    expect(escalated.minimumSeverity).toBe("alarm");
    expect(escalated.oneTime).toBe(true);

    db.processDueActivations(new Date("2026-01-01T00:01:30Z"));
    expect(db.listDeliveries()).toMatchObject([
      { transportInstanceId: "ntfy" },
    ]);
  });

  it("snapshots notifier severity floors and adds delivery on escalation", () => {
    const db = database();
    const occurrence = db.ingest(
      active({ severity: "warn" }),
      ["ntfy", "pd"],
      undefined,
      {
        minimumSeverity: "warn",
        notifierMinimumSeverities: { ntfy: "warn", pd: "alarm" },
      },
    )!;
    expect(db.listDeliveries()).toMatchObject([
      { alertId: occurrence.id, transportInstanceId: "ntfy" },
    ]);

    db.ingest(active({ severity: "alarm" }), ["different-policy"], undefined, {
      minimumSeverity: "normal",
      notifierMinimumSeverities: { "different-policy": "normal" },
    });
    expect(
      db.listDeliveries().map((delivery) => delivery.transportInstanceId),
    ).toEqual(["ntfy", "pd"]);
  });

  it("cancels a pending delay when severity drops below its threshold", () => {
    const db = database();
    const occurrence = db.ingest(
      active({ severity: "alarm" }),
      ["ntfy"],
      new Date("2026-01-01T00:00:00Z"),
      { activationDelaySeconds: 60, minimumSeverity: "alarm" },
    )!;
    db.ingest(
      active({ severity: "warn" }),
      ["ntfy"],
      new Date("2026-01-01T00:00:30Z"),
      { activationDelaySeconds: 0, minimumSeverity: "normal" },
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
      id: "anchor-alert",
      sourceType: "recognized",
      pathPattern: "notifications.navigation.anchor",
      name: "Anchor",
    });
    const policy = db.setPolicy("anchor-alert", {
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
        definitionId: "anchor-alert",
        rearmAfterSeconds: 60,
      },
    )!;
    const second = db.ingest(
      active(),
      ["ntfy"],
      new Date("2026-01-01T00:01:00Z"),
      {
        definitionId: "anchor-alert",
        rearmAfterSeconds: 60,
      },
    )!;
    expect(second.id).not.toBe(first.id);
    expect(
      db.queryOccurrences({ definitionId: "anchor-alert", limit: 1 }),
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

  it("filters history by exact path and source with a stable cursor", () => {
    const db = database();
    const first = db.ingest(
      active({
        sourceKey: "notifications.test@gps.one",
        path: "notifications.test",
        source: "gps.one",
      }),
      [],
      new Date("2026-01-01T00:00:00Z"),
    )!;
    db.ingest(
      active({
        sourceKey: "notifications.test@gps.one",
        path: "notifications.test",
        source: "gps.one",
        state: "cleared",
        severity: "normal",
      }),
      [],
      new Date("2026-01-01T00:01:00Z"),
    );
    const second = db.ingest(
      active({
        sourceKey: "notifications.test@gps.one",
        path: "notifications.test",
        source: "gps.one",
      }),
      [],
      new Date("2026-01-01T00:02:00Z"),
    )!;
    db.ingest(
      active({
        sourceKey: "notifications.test@gps.two",
        path: "notifications.test",
        source: "gps.two",
      }),
      [],
      new Date("2026-01-01T00:03:00Z"),
    );

    const page = db.queryOccurrences({
      path: "notifications.test",
      source: "gps.one",
      limit: 1,
    });
    expect(page).toMatchObject({
      items: [{ id: second.id, source: "gps.one" }],
      nextCursor: second.id,
    });
    expect(
      db.queryOccurrences({
        path: "notifications.test",
        source: "gps.one",
        cursor: page.nextCursor,
        limit: 1,
      }).items,
    ).toMatchObject([{ id: first.id }]);
    expect(
      db.queryOccurrences({ path: "notifications.test", source: "gps.two" })
        .items,
    ).toHaveLength(1);
  });

  it("forgets only inactive discovered definitions and their history", () => {
    const db = database();
    const occurrence = db.ingest(active(), ["ntfy"])!;
    const definitionId = occurrence.definitionId!;
    expect(db.forgetDiscoveredDefinition(definitionId)).toBe("active");

    db.ingest(active({ state: "cleared", severity: "normal" }), []);
    expect(db.forgetDiscoveredDefinition(definitionId)).toBe("deleted");
    expect(db.listOccurrences()).toEqual([]);
    expect(db.listDefinitions()).toEqual([]);
    expect(db.listDeliveries()).toEqual([]);
  });

  it("does not forget definitions sourced from Signal K metadata", () => {
    const db = database();
    db.upsertDefinition({
      id: "zone:anchor",
      sourceType: "zone",
      pathPattern: "notifications.navigation.anchor",
      name: "Anchor",
    });
    expect(db.forgetDiscoveredDefinition("zone:anchor")).toBe("not_discovered");
  });

  it("does not rewrite an unchanged definition during discovery refresh", () => {
    const db = database();
    const definition = {
      id: "zone:anchor",
      sourceType: "zone" as const,
      pathPattern: "notifications.navigation.anchor",
      name: "Anchor",
      metadata: { description: "Anchor alarm" },
    };

    db.upsertDefinition(definition, new Date("2026-01-01T00:00:00Z"));
    const unchanged = db.upsertDefinition(
      definition,
      new Date("2026-01-01T00:05:00Z"),
    );

    expect(unchanged.updatedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("prunes only old completed occurrences without unfinished work", () => {
    const db = database();
    const old = new Date("2025-01-01T00:00:00Z");
    const clear = new Date("2025-01-01T00:01:00Z");
    const cutoff = new Date("2026-01-01T00:00:00Z");

    const removable = db.ingest(active({ sourceKey: "removable" }), [], old)!;
    db.ingest(
      active({ sourceKey: "removable", state: "cleared", severity: "normal" }),
      [],
      clear,
    );
    const activeOccurrence = db.ingest(
      active({ sourceKey: "still-active" }),
      [],
      old,
    )!;
    const pending = db.ingest(
      active({ sourceKey: "pending-delivery" }),
      ["ntfy"],
      old,
    )!;
    db.ingest(
      active({
        sourceKey: "pending-delivery",
        state: "cleared",
        severity: "normal",
      }),
      [],
      clear,
    );

    expect(db.retentionStatus(cutoff).eligibleOccurrences).toBe(1);
    expect(db.pruneOccurrences(cutoff, 10)).toEqual([removable.id]);
    expect(
      db
        .listOccurrences()
        .map((item) => item.id)
        .sort(),
    ).toEqual([activeOccurrence.id, pending.id].sort());
    expect(db.listDefinitions()).toHaveLength(3);
    expect(db.listDeliveries()).toHaveLength(1);
    expect(db.retentionStatus(cutoff).eligibleOccurrences).toBe(0);
  });
});
