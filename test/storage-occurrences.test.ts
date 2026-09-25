import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
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

  it("creates the complete version-one schema directly", () => {
    const db = database();

    expect(db.schemaVersion()).toBe(1);
    const occurrenceColumns = db.db
      .prepare("PRAGMA table_info(alert_occurrences)")
      .all()
      .map((column) => (column as { name: string }).name);
    expect(occurrenceColumns).toEqual(
      expect.arrayContaining([
        "source",
        "activation_due_at",
        "speech_template",
      ]),
    );
    expect(occurrenceColumns).not.toContain("dismissed_at");
    expect(
      db.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        )
        .all(),
    ).toEqual([]);
    expect(
      db.db
        .prepare("PRAGMA table_info(alert_policies)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        "speech_minimum_severity",
        "speech_template",
        "speech_announce_clear",
      ]),
    );
    expect(
      db.db
        .prepare("PRAGMA table_info(occurrence_notifiers)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        "supports_acknowledgement",
        "repeat_after_seconds",
        "next_repeat_at",
      ]),
    );
    expect(
      db.db
        .prepare("PRAGMA table_info(deliveries)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toContain("cycle");
    expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migrates the previous repeat schema without losing stored data", () => {
    const directory = mkdtempSync(join(tmpdir(), "notifier-legacy-repeat-"));
    directories.push(directory);
    const filename = join(directory, "alerts.sqlite");
    const legacySchema = schema
      .replace(
        "  speech_minimum_severity TEXT,",
        "  rearm_after_seconds INTEGER,\n  speech_minimum_severity TEXT,",
      )
      .replace("  repeat_override_seconds INTEGER,\n", "")
      .replace(
        '  connectivity_json TEXT NOT NULL DEFAULT \'{"mode":"queue"}\',',
        '  rearm_after_seconds INTEGER,\n  connectivity_json TEXT NOT NULL DEFAULT \'{"mode":"queue"}\',',
      )
      .replace("  repeat_after_seconds INTEGER NOT NULL DEFAULT 0,\n", "")
      .replace("  next_repeat_at TEXT,\n", "")
      .replace(
        "CREATE INDEX IF NOT EXISTS occurrence_notifier_repeat_idx\n  ON occurrence_notifiers(next_repeat_at) WHERE next_repeat_at IS NOT NULL;\n\n",
        "",
      )
      .replace("  cycle INTEGER NOT NULL DEFAULT 1,\n", "")
      .replace(
        "UNIQUE(alert_id, transport_instance_id, operation, cycle)",
        "UNIQUE(alert_id, transport_instance_id, operation)",
      );
    const legacy = new DatabaseSync(filename);
    legacy.exec("PRAGMA foreign_keys=ON;");
    legacy.exec(legacySchema);
    const timestamp = "2026-01-01T00:00:00.000Z";
    legacy
      .prepare(
        `INSERT INTO alert_definitions
          (id, source_type, path_pattern, name, created_at, updated_at)
         VALUES (?, 'recognized', ?, 'Anchor', ?, ?)`,
      )
      .run("anchor", active().path, timestamp, timestamp);
    legacy
      .prepare(
        `INSERT INTO alert_policies
          (definition_id, enabled, rearm_after_seconds, override_fields_json, updated_at)
         VALUES ('anchor', 1, 60, '["rearmAfterSeconds"]', ?)`,
      )
      .run(timestamp);
    legacy
      .prepare(
        `INSERT INTO alert_policy_notifiers
          (definition_id, transport_instance_id) VALUES ('anchor', 'ntfy')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO alert_occurrences
          (id, definition_id, occurrence_number, source_key, path, started_at,
           received_at, last_seen_at, current_state, current_severity,
           max_severity, message, rearm_after_seconds, activation_state,
           created_at, updated_at)
         VALUES ('occurrence-1', 'anchor', 1, ?, ?, ?, ?, ?, 'active', 'alarm',
                 'alarm', 'Anchor dragging', 60, 'eligible', ?, ?)`,
      )
      .run(
        active().sourceKey,
        active().path,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      );
    legacy
      .prepare(
        `INSERT INTO occurrence_notifiers
          (alert_id, transport_instance_id) VALUES ('occurrence-1', 'ntfy')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO alert_events (alert_id, event_type, occurred_at)
         VALUES ('occurrence-1', 'raised', ?)`,
      )
      .run(timestamp);
    legacy
      .prepare(
        `INSERT INTO deliveries
          (id, alert_id, transport_instance_id, operation, state, attempt_count,
           last_attempt_at, delivered_at, remote_id, created_at, updated_at)
         VALUES ('delivery-1', 'occurrence-1', 'ntfy', 'notify', 'delivered', 1,
                 ?, ?, 'remote-1', ?, ?)`,
      )
      .run(timestamp, timestamp, timestamp, timestamp);
    legacy
      .prepare(
        `INSERT INTO delivery_attempts
          (delivery_id, attempt_number, started_at, finished_at, outcome, remote_id)
         VALUES ('delivery-1', 1, ?, ?, 'delivered', 'remote-1')`,
      )
      .run(timestamp, timestamp);
    legacy
      .prepare(
        `INSERT INTO wake_requests (alert_id, wake_due_at, updated_at)
         VALUES ('occurrence-1', '2026-01-01T00:05:00.000Z', ?)`,
      )
      .run(timestamp);
    legacy.close();

    const migrated = new AlertDatabase(filename);
    databases.push(migrated);
    expect(migrated.migrationApplied).toBe(true);
    expect(migrated.listDefinitions()).toHaveLength(1);
    expect(migrated.getPolicy("anchor")).toMatchObject({
      notifierIds: ["ntfy"],
      notifierRepeatOverrides: { ntfy: 60 },
      overrideFields: ["notifierIds"],
    });
    expect(migrated.getAlert("occurrence-1")).toMatchObject({
      message: "Anchor dragging",
      currentState: "active",
    });
    expect(migrated.listAlertEvents("occurrence-1")).toHaveLength(1);
    expect(migrated.listDeliveriesForAlert("occurrence-1")).toMatchObject([
      { id: "delivery-1", cycle: 1, remoteId: "remote-1" },
    ]);
    expect(migrated.listDeliveryAttempts("delivery-1")).toHaveLength(1);
    expect(migrated.listWakeRequests()).toHaveLength(1);
    expect(migrated.nextDeliveryDueAt()).toEqual(
      new Date("2026-01-01T00:01:00.000Z"),
    );
    expect(
      migrated.processDueRepeats(new Date("2026-01-01T00:01:00.000Z")),
    ).toBe(1);
    expect(migrated.listDeliveriesForAlert("occurrence-1")).toHaveLength(2);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    migrated.close();
    databases.length = 0;
    const reopened = new AlertDatabase(filename);
    databases.push(reopened);
    expect(reopened.migrationApplied).toBe(false);
    expect(reopened.listDeliveriesForAlert("occurrence-1")).toHaveLength(2);
  });

  it("stores raise-clear-raise as distinct visible occurrences", () => {
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
    const second = db.ingest(
      active(),
      ["ntfy"],
      new Date("2026-01-01T00:03:00Z"),
    )!;

    expect(second.id).not.toBe(first.id);
    expect(second.occurrenceNumber).toBe(2);
    expect(db.listOccurrences()).toHaveLength(2);
    expect(
      db.listAlertEvents(first.id).map((event) => event.eventType),
    ).toEqual(["raised", "cleared"]);
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

  it("records repeated unchanged Signal K updates in alert history", () => {
    const db = database();
    const raised = db.ingest(
      active({ sourcePayload: { state: "alarm", message: "Anchor dragging" } }),
      [],
      new Date("2026-01-01T00:00:00Z"),
    )!;
    db.ingest(
      active({ sourcePayload: { state: "alarm", message: "Anchor dragging" } }),
      [],
      new Date("2026-01-01T00:01:00Z"),
    );

    expect(
      db.listAlertEvents(raised.id).map((event) => event.eventType),
    ).toEqual(["raised", "updated"]);
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
      overrideFields: ["enabled"],
    });

    db.reset();

    expect(db.schemaVersion()).toBe(1);
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

  it("creates a PagerDuty resolve after an accepted trigger and only once", () => {
    const db = database();
    const raisedAt = new Date("2026-01-01T00:00:00Z");
    const clearedAt = new Date("2026-01-01T00:01:00Z");
    const occurrence = db.ingest(active(), ["pagerduty"], raisedAt, {
      resolvingNotifierIds: ["pagerduty"],
    })!;
    const trigger = db.listDeliveries()[0];

    expect(trigger.operation).toBe("trigger");
    expect(db.claimDelivery(trigger.id, raisedAt)).toBe(true);
    db.recordDeliverySuccess(trigger.id, "pd-dedup", raisedAt);

    db.ingest(
      active({ state: "cleared", severity: "normal" }),
      ["pagerduty"],
      clearedAt,
      { resolvingNotifierIds: ["pagerduty"] },
    );
    db.ingest(
      active({ state: "cleared", severity: "normal" }),
      ["pagerduty"],
      new Date("2026-01-01T00:02:00Z"),
      { resolvingNotifierIds: ["pagerduty"] },
    );

    expect(db.listDeliveriesForAlert(occurrence.id)).toMatchObject([
      { operation: "trigger", state: "delivered" },
      { operation: "resolve", state: "pending", attemptCount: 0 },
    ]);
  });

  it("creates one PagerDuty acknowledgement after an accepted trigger", () => {
    const db = database();
    const raisedAt = new Date("2026-01-01T00:00:00Z");
    const acknowledgedAt = new Date("2026-01-01T00:01:00Z");
    const occurrence = db.ingest(active(), ["pagerduty"], raisedAt, {
      resolvingNotifierIds: ["pagerduty"],
    })!;
    const trigger = db.listDeliveries()[0];
    expect(db.claimDelivery(trigger.id, raisedAt)).toBe(true);
    db.recordDeliverySuccess(trigger.id, "pd-dedup", raisedAt);

    db.ingest(active({ acknowledged: true }), ["pagerduty"], acknowledgedAt, {
      resolvingNotifierIds: ["pagerduty"],
    });
    db.ingest(active({ acknowledged: true }), ["pagerduty"], acknowledgedAt, {
      resolvingNotifierIds: ["pagerduty"],
    });

    expect(db.getAlert(occurrence.id).acknowledgedAt).toEqual(acknowledgedAt);
    expect(db.listDeliveriesForAlert(occurrence.id)).toMatchObject([
      { operation: "trigger", state: "delivered" },
      { operation: "acknowledge", state: "pending", attemptCount: 0 },
    ]);
  });

  it("forwards an existing acknowledgement after each repeated PagerDuty trigger", () => {
    const db = database();
    const raisedAt = new Date("2026-01-01T00:00:00Z");
    const occurrence = db.ingest(
      active({ acknowledged: true }),
      ["pagerduty"],
      raisedAt,
      {
        resolvingNotifierIds: ["pagerduty"],
        notifierRepeatIntervals: { pagerduty: 60 },
      },
    )!;
    const firstTrigger = db.listDeliveriesForAlert(occurrence.id)[0];
    expect(db.claimDelivery(firstTrigger.id, raisedAt)).toBe(true);
    db.recordDeliverySuccess(firstTrigger.id, "pd-dedup", raisedAt);

    expect(db.processDueRepeats(new Date("2026-01-01T00:01:00Z"))).toBe(1);
    const secondTrigger = db
      .listDeliveriesForAlert(occurrence.id)
      .find(
        (delivery) => delivery.operation === "trigger" && delivery.cycle === 2,
      )!;
    expect(db.claimDelivery(secondTrigger.id)).toBe(true);
    db.recordDeliverySuccess(
      secondTrigger.id,
      "pd-dedup",
      new Date("2026-01-01T00:01:01Z"),
    );

    expect(
      db
        .listDeliveriesForAlert(occurrence.id)
        .filter((delivery) => delivery.operation === "acknowledge")
        .map((delivery) => delivery.cycle),
    ).toEqual([1, 2]);
  });

  it("announces a Wyoming clear without creating an acknowledgement delivery", () => {
    const db = database();
    const raisedAt = new Date("2026-01-01T00:00:00Z");
    const occurrence = db.ingest(active(), ["speech"], raisedAt, {
      resolvingNotifierIds: ["speech"],
      acknowledgingNotifierIds: [],
      speechTemplate: "{name}: {message}",
    })!;
    const trigger = db.listDeliveries()[0];
    expect(db.getAlert(occurrence.id).speechTemplate).toBe("{name}: {message}");
    expect(db.claimDelivery(trigger.id, raisedAt)).toBe(true);
    db.recordDeliverySuccess(trigger.id, "salon", raisedAt);

    db.acknowledgeAlert(occurrence.id, new Date("2026-01-01T00:01:00Z"));
    expect(db.listDeliveriesForAlert(occurrence.id)).toHaveLength(1);

    db.ingest(
      active({ state: "cleared", severity: "normal" }),
      ["speech"],
      new Date("2026-01-01T00:02:00Z"),
      {
        resolvingNotifierIds: ["speech"],
        acknowledgingNotifierIds: [],
      },
    );
    expect(db.listDeliveriesForAlert(occurrence.id)).toMatchObject([
      { operation: "trigger", state: "delivered" },
      { operation: "resolve", state: "pending" },
    ]);
  });

  it("defers PagerDuty acknowledgement until its trigger is accepted", () => {
    const db = database();
    const occurrence = db.ingest(
      active({ acknowledged: true }),
      ["pagerduty"],
      new Date("2026-01-01T00:00:00Z"),
      { resolvingNotifierIds: ["pagerduty"] },
    )!;
    const trigger = db.listDeliveries()[0];
    expect(db.listDeliveriesForAlert(occurrence.id)).toHaveLength(1);

    expect(db.claimDelivery(trigger.id)).toBe(true);
    db.recordDeliverySuccess(trigger.id, "pd-dedup");

    expect(db.listDeliveriesForAlert(occurrence.id)).toMatchObject([
      { operation: "trigger", state: "delivered" },
      { operation: "acknowledge", state: "pending" },
    ]);
  });

  it("defers PagerDuty resolve until a trigger is accepted", () => {
    const db = database();
    const raisedAt = new Date("2026-01-01T00:00:00Z");
    const occurrence = db.ingest(active(), ["pagerduty"], raisedAt, {
      resolvingNotifierIds: ["pagerduty"],
    })!;
    const trigger = db.listDeliveries()[0];

    db.ingest(
      active({ state: "cleared", severity: "normal" }),
      ["pagerduty"],
      new Date("2026-01-01T00:01:00Z"),
      { resolvingNotifierIds: ["pagerduty"] },
    );
    expect(db.listDeliveriesForAlert(occurrence.id)).toHaveLength(1);

    expect(db.claimDelivery(trigger.id, new Date("2026-01-01T00:02:00Z"))).toBe(
      true,
    );
    db.recordDeliverySuccess(
      trigger.id,
      "pd-dedup",
      new Date("2026-01-01T00:02:01Z"),
    );

    expect(db.listDeliveriesForAlert(occurrence.id)).toMatchObject([
      { operation: "trigger", state: "delivered" },
      { operation: "resolve", state: "pending" },
    ]);
  });

  it("does not resolve PagerDuty when its trigger was not accepted", () => {
    const db = database();
    const occurrence = db.ingest(active(), ["pagerduty"], undefined, {
      resolvingNotifierIds: ["pagerduty"],
    })!;
    const trigger = db.listDeliveries()[0];
    expect(db.claimDelivery(trigger.id)).toBe(true);
    db.recordDeliveryFailure(trigger.id, "HTTP_400", "Rejected", false);

    db.ingest(
      active({ state: "cleared", severity: "normal" }),
      ["pagerduty"],
      new Date(),
      { resolvingNotifierIds: ["pagerduty"] },
    );

    expect(db.listDeliveriesForAlert(occurrence.id)).toMatchObject([
      { operation: "trigger", state: "failed_terminal" },
    ]);
  });

  it("retries PagerDuty resolve independently from its delivered trigger", () => {
    const db = database();
    const occurrence = db.ingest(active(), ["pagerduty"], undefined, {
      resolvingNotifierIds: ["pagerduty"],
    })!;
    const trigger = db.listDeliveries()[0];
    expect(db.claimDelivery(trigger.id)).toBe(true);
    db.recordDeliverySuccess(trigger.id, "pd-dedup");
    db.ingest(
      active({ state: "cleared", severity: "normal" }),
      ["pagerduty"],
      new Date(),
      { resolvingNotifierIds: ["pagerduty"] },
    );
    const resolve = db
      .listDeliveriesForAlert(occurrence.id)
      .find((item) => item.operation === "resolve")!;

    expect(db.claimDelivery(resolve.id)).toBe(true);
    db.recordDeliveryFailure(
      resolve.id,
      "HTTP_503",
      "Unavailable",
      true,
      new Date("2026-01-01T00:10:00Z"),
    );

    expect(db.listDeliveriesForAlert(occurrence.id)).toMatchObject([
      { operation: "trigger", state: "delivered", attemptCount: 1 },
      {
        operation: "resolve",
        state: "failed_retryable",
        attemptCount: 1,
        lastErrorCode: "HTTP_503",
      },
    ]);
  });

  it("recovers a pending PagerDuty resolve after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "notifier-pagerduty-"));
    directories.push(directory);
    const filename = join(directory, "alerts.sqlite");
    const first = new AlertDatabase(filename);
    const occurrence = first.ingest(active(), ["pagerduty"], undefined, {
      resolvingNotifierIds: ["pagerduty"],
    })!;
    const trigger = first.listDeliveries()[0];
    expect(first.claimDelivery(trigger.id)).toBe(true);
    first.recordDeliverySuccess(trigger.id, "pd-dedup");
    first.ingest(
      active({ state: "cleared", severity: "normal" }),
      ["pagerduty"],
      new Date(),
      { resolvingNotifierIds: ["pagerduty"] },
    );
    first.close();

    const restarted = new AlertDatabase(filename);
    databases.push(restarted);
    expect(restarted.listDueDeliveries()).toMatchObject([
      {
        alertId: occurrence.id,
        transportInstanceId: "pagerduty",
        operation: "resolve",
        state: "pending",
      },
    ]);
  });

  it("reconciles existing deliveries when a notifier supports resolution", () => {
    const db = database();
    const occurrence = db.ingest(active(), ["pagerduty"])!;
    const legacyDelivery = db.listDeliveries()[0];
    expect(legacyDelivery.operation).toBe("notify");
    expect(db.claimDelivery(legacyDelivery.id)).toBe(true);
    db.recordDeliverySuccess(legacyDelivery.id, "pd-dedup");
    db.ingest(active({ state: "cleared", severity: "normal" }), ["pagerduty"]);

    db.configureResolvingNotifiers(["pagerduty"]);

    expect(db.listDeliveriesForAlert(occurrence.id)).toMatchObject([
      { operation: "trigger", state: "delivered" },
      { operation: "resolve", state: "pending" },
    ]);
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

  it("stores per-service repeat overrides, filtered pages, and delivery attempts", () => {
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
      notifierIds: ["ntfy"],
      notifierRepeatOverrides: { ntfy: 60 },
      overrideFields: ["notifierIds"],
    });
    expect(policy.notifierRepeatOverrides).toEqual({ ntfy: 60 });

    const first = db.ingest(
      active(),
      ["ntfy"],
      new Date("2026-01-01T00:00:00Z"),
      {
        definitionId: "anchor-alert",
        notifierRepeatIntervals: { ntfy: 60 },
      },
    )!;
    const second = db.ingest(
      active(),
      ["ntfy"],
      new Date("2026-01-01T00:01:00Z"),
      {
        definitionId: "anchor-alert",
        notifierRepeatIntervals: { ntfy: 60 },
      },
    )!;
    expect(second.id).toBe(first.id);
    expect(
      db.queryOccurrences({ definitionId: "anchor-alert", limit: 1 }),
    ).toMatchObject({
      items: [{ id: first.id }],
      nextCursor: undefined,
    });

    const delivery = db.listDeliveries()[0];
    expect(
      db.claimDelivery(delivery.id, new Date("2026-01-01T00:02:00Z")),
    ).toBe(true);
    expect(
      db.claimDelivery(delivery.id, new Date("2026-01-01T00:02:01Z")),
    ).toBe(false);
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

  it("schedules repeat deliveries independently after each service succeeds", () => {
    const db = database();
    const raisedAt = new Date("2026-01-01T00:00:00Z");
    const occurrence = db.ingest(active(), ["ntfy", "backup"], raisedAt, {
      notifierRepeatIntervals: { ntfy: 60, backup: 120 },
    })!;
    const initial = db.listDeliveries();
    expect(initial).toHaveLength(2);
    for (const delivery of initial) {
      expect(db.claimDelivery(delivery.id, raisedAt)).toBe(true);
      db.recordDeliverySuccess(delivery.id, undefined, raisedAt);
    }

    expect(db.nextDeliveryDueAt()).toEqual(new Date("2026-01-01T00:01:00Z"));
    expect(db.processDueRepeats(new Date("2026-01-01T00:00:59Z"))).toBe(0);
    expect(db.processDueRepeats(new Date("2026-01-01T00:01:00Z"))).toBe(1);
    expect(
      db
        .listDeliveries()
        .filter((delivery) => delivery.alertId === occurrence.id)
        .map((delivery) => [delivery.transportInstanceId, delivery.cycle]),
    ).toEqual(
      expect.arrayContaining([
        ["ntfy", 1],
        ["backup", 1],
        ["ntfy", 2],
      ]),
    );

    db.ingest(
      active({ state: "cleared", severity: "normal" }),
      [],
      new Date("2026-01-01T00:01:30Z"),
    );
    expect(db.processDueRepeats(new Date("2026-01-01T00:02:00Z"))).toBe(0);
  });

  it("recovers a scheduled service repeat after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "notifier-repeat-"));
    directories.push(directory);
    const filename = join(directory, "alerts.sqlite");
    const first = new AlertDatabase(filename);
    const deliveredAt = new Date("2026-01-01T00:00:00Z");
    first.ingest(active(), ["ntfy"], deliveredAt, {
      notifierRepeatIntervals: { ntfy: 60 },
    });
    const initial = first.listDeliveries()[0];
    expect(first.claimDelivery(initial.id, deliveredAt)).toBe(true);
    first.recordDeliverySuccess(initial.id, undefined, deliveredAt);
    first.close();

    const restarted = new AlertDatabase(filename);
    databases.push(restarted);
    expect(restarted.nextDeliveryDueAt()).toEqual(
      new Date("2026-01-01T00:01:00Z"),
    );
    expect(restarted.processDueRepeats(new Date("2026-01-01T00:01:00Z"))).toBe(
      1,
    );
    expect(
      restarted.listDeliveries().map((delivery) => delivery.cycle),
    ).toEqual([1, 2]);
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

  it("returns the latest five occurrences for one alert definition", () => {
    const db = database();
    const sourceKey = "notifications.test@gps.repeat";
    for (let index = 0; index < 6; index += 1) {
      const raisedAt = new Date(Date.UTC(2026, 0, 1, 0, index * 2));
      db.ingest(
        active({
          sourceKey,
          path: "notifications.test",
          source: "gps.repeat",
        }),
        [],
        raisedAt,
      );
      db.ingest(
        active({
          sourceKey,
          path: "notifications.test",
          source: "gps.repeat",
          state: "cleared",
          severity: "normal",
        }),
        [],
        new Date(raisedAt.getTime() + 60_000),
      );
    }

    const page = db.queryOccurrences({
      definitionId: `recognized:${sourceKey}`,
      limit: 5,
    });
    expect(page.items.map((item) => item.occurrenceNumber)).toEqual([
      6, 5, 4, 3, 2,
    ]);
    expect(page.nextCursor).toBe(page.items[4].id);
  });

  it("pages global alert events with occurrence context and no delivery data", () => {
    const db = database();
    const sourceKey = "notifications.test@gps.history";
    const first = db.ingest(
      active({
        sourceKey,
        path: "notifications.test",
        source: "gps.history",
        severity: "warn",
        message: "Getting warm",
      }),
      ["ntfy"],
      new Date("2026-01-01T00:00:00Z"),
    )!;
    db.ingest(
      active({
        sourceKey,
        path: "notifications.test",
        source: "gps.history",
        severity: "alarm",
        message: "Too hot",
      }),
      ["ntfy"],
      new Date("2026-01-01T00:01:00Z"),
    );
    db.ingest(
      active({
        sourceKey,
        path: "notifications.test",
        source: "gps.history",
        state: "cleared",
        severity: "normal",
      }),
      ["ntfy"],
      new Date("2026-01-01T00:02:00Z"),
    );

    const page = db.queryAlertHistory({
      definitionId: first.definitionId,
      source: "gps.history",
      limit: 2,
    });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      alertId: first.id,
      definitionId: first.definitionId,
      name: "notifications.test",
      path: "notifications.test",
      source: "gps.history",
      eventType: "cleared",
    });
    expect(page.items[0]).not.toHaveProperty("deliveries");
    expect(page.nextCursor).toBe(String(page.items[1].id));

    const next = db.queryAlertHistory({
      definitionId: first.definitionId,
      source: "gps.history",
      cursor: page.nextCursor,
      limit: 2,
    });
    expect(next.items.map((item) => item.eventType)).toEqual([
      "severity_changed",
      "raised",
    ]);
    expect(
      db.queryAlertHistory({ eventType: "severity_changed" }).items,
    ).toMatchObject([{ severity: "alarm" }]);
  });

  it("removes an inactive stored alert and all definition-owned data", () => {
    const db = database();
    const occurrence = db.ingest(active(), ["ntfy"])!;
    const definitionId = occurrence.definitionId!;
    db.setPolicy(definitionId, {
      enabled: true,
      notifierIds: ["ntfy"],
      overrideFields: ["enabled", "notifierIds"],
    });
    db.setWakeDue(occurrence.id, new Date("2026-01-01T00:10:00Z"));
    const delivery = db.listDeliveries()[0];
    expect(db.claimDelivery(delivery.id)).toBe(true);
    db.recordDeliverySuccess(delivery.id, "remote-id");

    expect(db.deleteDefinition(definitionId)).toBe("active");

    db.ingest(active({ state: "cleared", severity: "normal" }), []);
    expect(db.deleteDefinition(definitionId)).toBe("deleted");
    expect(db.listOccurrences()).toEqual([]);
    expect(db.listDefinitions()).toEqual([]);
    expect(db.listDeliveries()).toEqual([]);
    expect(db.listAlertEvents()).toEqual([]);
    expect(db.listWakeRequests()).toEqual([]);
    expect(() =>
      db.recordDeliverySuccess(delivery.id, "late-result"),
    ).not.toThrow();
    for (const table of [
      "alert_policies",
      "alert_policy_notifiers",
      "occurrence_notifiers",
      "occurrence_notifier_thresholds",
      "deliveries",
      "delivery_attempts",
    ]) {
      const row = db.db
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as {
        count: number;
      };
      expect(Number(row.count), table).toBe(0);
    }
    expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("also removes inactive definitions sourced from Signal K metadata", () => {
    const db = database();
    db.upsertDefinition({
      id: "zone:anchor",
      sourceType: "zone",
      pathPattern: "notifications.navigation.anchor",
      name: "Anchor",
    });
    expect(db.deleteDefinition("zone:anchor")).toBe("deleted");
    expect(db.listDefinitions()).toEqual([]);
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

  it("bounds dashboard delivery reads and prioritizes unfinished work", () => {
    const db = database();
    const completed = db.ingest(active({ sourceKey: "completed-delivery" }), [
      "ntfy",
    ])!;
    const completedDelivery = db.listDeliveries()[0];
    expect(db.claimDelivery(completedDelivery.id)).toBe(true);
    db.recordDeliverySuccess(completedDelivery.id);
    const pending = db.ingest(active({ sourceKey: "pending-delivery" }), [
      "ntfy",
    ])!;

    expect(db.listRecentDeliveries(1)).toMatchObject([
      {
        alertId: pending.id,
        state: "pending",
        alert: { occurrenceId: pending.id, path: pending.path },
      },
    ]);
    const firstPage = db.queryDeliveries(1);
    expect(firstPage.total).toBe(2);
    expect(firstPage.nextCursor).toBe(firstPage.items[0].id);
    const secondPage = db.queryDeliveries(1, firstPage.nextCursor);
    expect(secondPage.total).toBe(2);
    expect(secondPage.items[0]).toMatchObject({
      alertId: completed.id,
      state: "delivered",
    });
    expect(db.listDeliveries()).toHaveLength(2);
    expect(completed.id).not.toBe(pending.id);
  });

  it("pages delivery attempts chronologically and retries one failed delivery", () => {
    const db = database();
    db.ingest(active({ sourceKey: "retry-one" }), ["ntfy"]);
    const delivery = db.listDeliveries()[0];
    expect(delivery.createdAt).toBeInstanceOf(Date);
    expect(db.getDelivery(delivery.id)?.id).toBe(delivery.id);

    expect(db.claimDelivery(delivery.id)).toBe(true);
    db.recordDeliveryFailure(
      delivery.id,
      "OFFLINE",
      "No network",
      true,
      new Date("2026-01-01T00:01:00Z"),
    );
    expect(db.retryDelivery(delivery.id)).toBe("scheduled");
    expect(db.claimDelivery(delivery.id)).toBe(true);
    db.recordDeliveryFailure(
      delivery.id,
      "DENIED",
      "Rejected",
      false,
      new Date("2026-01-01T00:02:00Z"),
    );

    const first = db.queryDeliveryAttempts(delivery.id, 1)!;
    expect(first.items).toMatchObject([
      { attemptNumber: 1, outcome: "failed_retryable" },
    ]);
    expect(first.nextCursor).toBe(String(first.items[0].id));
    expect(
      db.queryDeliveryAttempts(delivery.id, 1, first.nextCursor),
    ).toMatchObject({
      items: [{ attemptNumber: 2, outcome: "failed_terminal" }],
    });
    expect(db.retryDelivery(delivery.id)).toBe("scheduled");
    expect(db.retryDelivery(delivery.id)).toBe("not_retryable");
    expect(db.retryDelivery("missing")).toBe("not_found");
  });
});
