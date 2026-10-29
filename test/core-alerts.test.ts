import { SuppressionStore } from "../src/suppression/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AlertDatabase } from "../src/storage/db";
import {
  CoreAlert,
  coreAlertEntry,
  extractCoreAlertEntries,
  normalizeCoreAlert,
} from "../src/signalk/core-alerts";
import { BoundedIngestionQueue } from "../src/signalk/ingestion-queue";
import { renderAlert } from "../src/transports/transport";

import { coreFixture } from "./fixtures/core-alert";

describe("core alerts migration", () => {
  const databases: AlertDatabase[] = [];
  const directories: string[] = [];
  afterEach(() => {
    databases.forEach((db) => db.close());
    databases.length = 0;
    directories
      .splice(0)
      .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });
  const database = () => {
    const db = new AlertDatabase();
    databases.push(db);
    return db;
  };
  const ingest = (
    db: AlertDatabase,
    patch: Partial<CoreAlert> = {},
    delay = 0,
  ) =>
    db.ingest(
      normalizeCoreAlert(coreFixture(patch)),
      ["crew", "incident"],
      new Date(patch.stateChangedAt ?? coreFixture().raisedAt),
      {
        activationDelaySeconds: delay,
        resolvingNotifierIds: ["incident"],
        acknowledgingNotifierIds: ["incident"],
        notifierRepeatIntervals: { crew: 10 },
      },
    )!;

  it("accepts only canonical self-vessel snapshots, maps priorities, and retains producer identity", () => {
    const alert = coreFixture({
      priority: "caution",
      references: ["environment.inside.bilge.level"],
    });
    const delta = {
      context: "vessels.own",
      updates: [
        {
          $source: "alertsApi",
          values: [{ path: "alerts.bilge.highWater", value: alert }],
        },
      ],
    };
    expect(extractCoreAlertEntries(delta, "vessels.own")).toEqual([
      coreAlertEntry(alert),
    ]);
    expect(
      extractCoreAlertEntries(
        { ...delta, context: "vessels.other" },
        "vessels.own",
      ),
    ).toEqual([]);
    expect(
      extractCoreAlertEntries(
        { updates: [{ ...delta.updates[0], $source: "raw-producer" }] },
        "vessels.own",
      ),
    ).toEqual([]);
    expect(normalizeCoreAlert(alert)).toMatchObject({
      severity: "alert",
      source: "bilge-sensor",
      sourceKey: "core:core-1",
      sourcePayload: alert,
    });
  });

  it("keeps silence, condition and new core IDs distinct in the bounded queue", () => {
    const queue = new BoundedIngestionQueue(10);
    queue.enqueue(coreAlertEntry(coreFixture()));
    queue.enqueue(
      coreAlertEntry(coreFixture({ lastSourceUpdate: "2026-10-25T08:00:10Z" })),
    );
    queue.enqueue(coreAlertEntry(coreFixture({ silenced: true })));
    queue.enqueue(
      coreAlertEntry(
        coreFixture({ state: "rtn-unacknowledged", condition: false }),
      ),
    );
    queue.enqueue(coreAlertEntry(coreFixture({ id: "core-2" })));
    expect(queue.stats()).toMatchObject({ depth: 4, coalesced: 1 });
  });

  it("persists before delivery and coalesces heartbeats without growing history", () => {
    const db = database();
    const first = ingest(db);
    const events = db.listAlertEvents().length;
    const next = ingest(db, { lastSourceUpdate: "2026-10-25T08:00:10.000Z" });
    expect(next.id).toBe(first.id);
    expect(next.coreAlert?.lastSourceUpdate).toBe("2026-10-25T08:00:10.000Z");
    expect(db.listAlertEvents()).toHaveLength(events);
    expect(db.listDeliveries()).toHaveLength(2);
    expect(next.firstSeenAt.toISOString()).toBe(coreFixture().raisedAt);
  });

  it("retains momentary events with false conditions and groups repeated raises by core ID", () => {
    const db = database();
    const first = ingest(db, { latching: true, condition: false });
    expect(first.currentState).toBe("active");
    expect(db.listDeliveries()).toHaveLength(2);
    const next = ingest(db, {
      latching: true,
      condition: false,
      stateChangedAt: "2026-10-25T08:00:20Z",
    });
    expect(next.id).toBe(first.id);
    expect(db.listOccurrences()).toHaveLength(1);
    expect(db.listDeliveries()).toHaveLength(4);
  });

  it("preserves a cleared condition awaiting acknowledgment but cancels activation", () => {
    const db = database();
    const first = ingest(db, {}, 60);
    expect(first.activationState).toBe("pending");
    const returned = ingest(
      db,
      {
        state: "rtn-unacknowledged",
        condition: false,
        clearedAt: "2026-10-25T08:00:20Z",
        stateChangedAt: "2026-10-25T08:00:20Z",
      },
      60,
    );
    expect(returned).toMatchObject({
      id: first.id,
      currentState: "active",
      activationState: "suppressed",
      coreResolutionConfirmed: true,
    });
    db.processDueActivations(new Date("2026-10-25T09:00:00Z"));
    expect(db.listDeliveries()).toEqual([]);
    expect(
      db
        .listAlertEvents()
        .some((event) => event.eventType === "suppressed_before_activation"),
    ).toBe(true);
  });

  it("does not mistake source staleness for a clear", () => {
    const db = database();
    const first = ingest(db);
    expect(ingest(db, { stale: true, sourceOnline: false })).toMatchObject({
      id: first.id,
      currentState: "active",
      coreResolutionConfirmed: false,
    });
  });

  it("restarts activation delay for a reannounced core condition and creates one new delivery cycle", () => {
    const db = database();
    const first = ingest(db, {}, 10);
    db.processDueActivations(new Date("2026-10-25T08:00:10Z"));
    expect(db.listDeliveries()).toHaveLength(2);
    ingest(
      db,
      {
        state: "rtn-unacknowledged",
        condition: false,
        stateChangedAt: "2026-10-25T08:00:20Z",
      },
      10,
    );
    const raised = ingest(db, { stateChangedAt: "2026-10-25T08:00:30Z" }, 10);
    expect(raised).toMatchObject({
      id: first.id,
      activationState: "pending",
      coreResolutionConfirmed: false,
    });
    expect(db.listDeliveries()).toHaveLength(2);
    db.processDueActivations(new Date("2026-10-25T08:00:39Z"));
    expect(db.listDeliveries()).toHaveLength(2);
    db.processDueActivations(new Date("2026-10-25T08:00:40Z"));
    db.processDueActivations(new Date("2026-10-25T08:00:41Z"));
    expect(db.listDeliveries()).toHaveLength(4);
  });

  it("orders core delivery cycles per notifier while allowing other notifiers to proceed", () => {
    const db = database();
    ingest(db, { latching: true, condition: false });
    ingest(db, {
      latching: true,
      condition: false,
      stateChangedAt: "2026-10-25T08:00:20Z",
    });
    const due = db.listDueDeliveries();
    expect(due).toHaveLength(2);
    expect(due.every((delivery) => delivery.cycle === 1)).toBe(true);
    const first = due.find(
      (delivery) => delivery.transportInstanceId === "crew",
    )!;
    expect(db.claimDelivery(first.id)).toBe(true);
    const next = db
      .listDeliveries()
      .find(
        (delivery) =>
          delivery.transportInstanceId === "crew" && delivery.cycle === 2,
      )!;
    expect(db.claimDelivery(next.id)).toBe(false);
    db.recordDeliverySuccess(first.id);
    expect(db.claimDelivery(next.id)).toBe(true);
  });

  it("suppresses an unsent recovery when the same core alert reactivates", () => {
    const db = database();
    ingest(db);
    const trigger = db
      .listDeliveries()
      .find((delivery) => delivery.operation === "trigger")!;
    db.claimDelivery(trigger.id);
    db.recordDeliverySuccess(trigger.id);
    ingest(db, {
      state: "rtn-unacknowledged",
      condition: false,
      stateChangedAt: "2026-10-25T08:00:10Z",
    });
    const resolve = db
      .listDeliveries()
      .find((delivery) => delivery.operation === "resolve")!;
    const holds = new SuppressionStore(db);
    holds.hold(
      resolve,
      {
        reason: "core_silence",
        startedAt: "2026-10-25T08:00:10Z",
        endsAt: "2026-10-25T08:01:00Z",
      },
      new Date("2026-10-25T08:00:11Z"),
      true,
    );
    ingest(db, { stateChangedAt: "2026-10-25T08:00:20Z" });
    holds.reconcile(() => undefined);
    expect(db.getDelivery(resolve.id)?.state).toBe("suppressed");
    expect(
      db
        .listDeliveries()
        .filter((delivery) => delivery.operation === "resolve"),
    ).toHaveLength(1);
    expect(
      db
        .listAlertEvents()
        .some((event) => event.eventType === "core_actions_superseded"),
    ).toBe(true);
  });

  it("preserves an offline occurrence and resolves it only after its trigger succeeds", () => {
    const db = database();
    const first = ingest(db);
    ingest(db, {
      state: "rtn-unacknowledged",
      condition: false,
      stateChangedAt: "2026-10-25T08:01:00Z",
      clearedAt: "2026-10-25T08:01:00Z",
    });
    const trigger = db
      .listDeliveries()
      .find((delivery) => delivery.operation === "trigger")!;
    expect(
      db.listDeliveries().some((delivery) => delivery.operation === "resolve"),
    ).toBe(false);
    db.claimDelivery(trigger.id);
    db.recordDeliverySuccess(trigger.id);
    expect(
      db
        .listDeliveries()
        .filter((delivery) => delivery.operation === "resolve"),
    ).toHaveLength(1);
    expect(renderAlert(db.getAlert(first.id)).body).toContain("Cleared at");
    expect(db.processDueRepeats(new Date("2026-10-26T08:00:00Z"))).toBe(0);
  });

  it("never reports an unclassified terminal removal as recovery, including late sends and restart setup", () => {
    const db = database();
    const first = ingest(db);
    const terminal = ingest(db, {
      state: "normal",
      condition: false,
      stateChangedAt: "2026-10-25T08:01:00Z",
    });
    const trigger = db
      .listDeliveries()
      .find((delivery) => delivery.operation === "trigger")!;
    db.claimDelivery(trigger.id);
    db.recordDeliverySuccess(trigger.id);
    db.configureResolvingNotifiers(["incident"]);
    expect(terminal).toMatchObject({
      id: first.id,
      currentState: "cleared",
      coreResolutionConfirmed: false,
    });
    expect(terminal.clearedAt).toBeUndefined();
    expect(
      db.listDeliveries().some((delivery) => delivery.operation === "resolve"),
    ).toBe(false);
    expect(renderAlert(terminal).body).toContain("reason is unconfirmed");
    expect(renderAlert(terminal).body).not.toContain("Cleared at");
    ingest(db); // queued stale snapshot cannot reopen a terminal ID
    expect(db.getAlert(first.id).currentState).toBe("cleared");
    expect(ingest(db, { id: "core-2" }).id).not.toBe(first.id);
  });

  it.each(["condition", "acknowledged"] as const)(
    "confirms %s completion and resolves exactly once after an offline trigger succeeds",
    (clearReason) => {
      const db = database();
      const first = ingest(db);
      const terminal = {
        state: "normal" as const,
        condition: false,
        clearReason,
        clearedAt: "2026-10-25T08:01:00Z",
        stateChangedAt: "2026-10-25T08:01:00Z",
      };
      ingest(db, terminal);
      ingest(db, terminal);
      expect(db.getAlert(first.id).coreResolutionConfirmed).toBe(true);
      expect(db.listDeliveries().some((d) => d.operation === "resolve")).toBe(
        false,
      );
      const trigger = db
        .listDeliveries()
        .find((d) => d.transportInstanceId === "incident")!;
      db.claimDelivery(trigger.id);
      db.recordDeliverySuccess(trigger.id);
      db.configureResolvingNotifiers(["incident"]);
      expect(
        db.listDeliveries().filter((d) => d.operation === "resolve"),
      ).toHaveLength(1);
      expect(renderAlert(db.getAlert(first.id)).body).toContain("Cleared at");
      expect(
        db
          .listAlertEvents()
          .some(
            (e) =>
              e.eventType === "core_removed" &&
              JSON.stringify(e).includes(clearReason),
          ),
      ).toBe(true);
    },
  );

  it("retains displacement across restart without resolving, losing pending triggers or repeating", () => {
    const directory = mkdtempSync(join(tmpdir(), "core-displaced-"));
    directories.push(directory);
    const filename = join(directory, "alerts.sqlite");
    let db = new AlertDatabase(filename);
    const first = ingest(db);
    ingest(db, {
      state: "normal",
      condition: false,
      clearReason: "displaced",
      clearedAt: "2026-10-25T08:01:00Z",
      stateChangedAt: "2026-10-25T08:01:00Z",
    });
    db.close();
    db = new AlertDatabase(filename);
    databases.push(db);
    const alert = db.getAlert(first.id);
    expect(alert.coreAlert?.clearReason).toBe("displaced");
    expect(alert.coreResolutionConfirmed).toBe(false);
    expect(alert.clearedAt).toBeUndefined();
    expect(renderAlert(alert).body).toContain("Displaced");
    expect(renderAlert(alert).body).not.toContain("Cleared at");
    expect(db.listDeliveries()).toHaveLength(2);
    for (const delivery of db.listDeliveries()) {
      expect(db.claimDelivery(delivery.id)).toBe(true);
      db.recordDeliverySuccess(delivery.id);
    }
    db.configureResolvingNotifiers(["incident"]);
    expect(db.listDeliveries().some((d) => d.operation === "resolve")).toBe(
      false,
    );
    expect(db.processDueRepeats(new Date("2026-10-26T08:00:00Z"))).toBe(0);
  });

  it("does not coalesce a newly supplied terminal reason and suppresses pending recovery on displacement", () => {
    const db = database();
    ingest(db);
    const trigger = db
      .listDeliveries()
      .find((d) => d.transportInstanceId === "incident")!;
    db.claimDelivery(trigger.id);
    db.recordDeliverySuccess(trigger.id);
    const terminal = {
      state: "normal" as const,
      condition: false,
      stateChangedAt: "2026-10-25T08:01:00Z",
    };
    ingest(db, terminal);
    ingest(db, { ...terminal, clearReason: "condition" });
    const resolve = db.listDeliveries().find((d) => d.operation === "resolve")!;
    expect(resolve.state).toBe("pending");
    // A returned condition may still be displaced while awaiting acknowledgment.
    const displacedDb = database();
    ingest(displacedDb);
    const delivered = displacedDb
      .listDeliveries()
      .find((d) => d.transportInstanceId === "incident")!;
    displacedDb.claimDelivery(delivered.id);
    displacedDb.recordDeliverySuccess(delivered.id);
    ingest(displacedDb, { ...terminal, state: "rtn-unacknowledged" });
    const pendingResolve = displacedDb
      .listDeliveries()
      .find((d) => d.operation === "resolve")!;
    ingest(displacedDb, { ...terminal, clearReason: "displaced" });
    expect(displacedDb.getDelivery(pendingResolve.id)?.state).toBe(
      "suppressed",
    );
    expect(
      displacedDb.getAlert(delivered.alertId).coreResolutionConfirmed,
    ).toBe(false);
    const queue = new BoundedIngestionQueue(10);
    queue.enqueue(coreAlertEntry(coreFixture(terminal)));
    queue.enqueue(
      coreAlertEntry(coreFixture({ ...terminal, clearReason: "condition" })),
    );
    expect(queue.depth).toBe(2);
  });

  it("migrates version 3 without losing legacy delivery state, then retains core IDs across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "core-migration-"));
    directories.push(directory);
    const filename = join(directory, "alerts.sqlite");
    let db = new AlertDatabase(filename);
    const legacy = db.ingest(
      {
        sourceKey: "notifications.old",
        path: "notifications.old",
        state: "active",
        severity: "emergency",
      },
      ["crew"],
    )!;
    const delivery = db.listDeliveries()[0];
    db.db.exec(
      "DROP INDEX occurrences_core_id; ALTER TABLE alert_occurrences DROP COLUMN core_alert_id; ALTER TABLE alert_occurrences DROP COLUMN core_resolution_confirmed; ALTER TABLE alert_occurrences DROP COLUMN core_reannounce_pending; PRAGMA user_version=3",
    );
    db.close();
    db = new AlertDatabase(filename);
    expect(db.schemaVersion()).toBe(4);
    expect(db.getDelivery(delivery.id)?.state).toBe("pending");
    expect(db.getAlert(legacy.id).coreAlert).toBeUndefined();
    const native = ingest(db);
    db.close();
    db = new AlertDatabase(filename);
    databases.push(db);
    expect(db.migrationApplied).toBe(false);
    expect(ingest(db).id).toBe(native.id);
    expect(db.listDeliveries()).toHaveLength(3);
  });
});
