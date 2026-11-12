import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { DeliveryState } from "../src/alerts/types";
import { AlertDatabase } from "../src/storage/db";

const databases: AlertDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const states: DeliveryState[] = [
  "pending",
  "waiting_connectivity",
  "sending",
  "failed_retryable",
  "paused",
  "failed_terminal",
  "suppressed",
  "delivered",
];
function fixture(filename?: string) {
  const db = new AlertDatabase(filename);
  const alert = db.ingest(
    {
      sourceKey: "notifications.test.performance",
      path: "notifications.test.performance",
      state: "active",
      severity: "alarm",
      message: "Synthetic fixture",
    },
    states,
  )!;
  const deliveries = db.listDeliveries();
  for (const delivery of deliveries)
    db.db
      .prepare("UPDATE deliveries SET state=? WHERE id=?")
      .run(delivery.transportInstanceId, delivery.id);
  return { db, alert, deliveries };
}

it("counts all undelivered states, excludes suppressed work, and keeps complete history", () => {
  const { db, deliveries } = fixture();
  databases.push(db);
  expect(db.pendingDeliveryCount()).toBe(5);
  expect(db.undeliveredDeliveryCount()).toBe(6);
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = db.queryDeliveries(2, cursor, false);
    expect(page).not.toHaveProperty("total");
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(
    [...deliveries.slice(0, 5).reverse(), ...deliveries.slice(5).reverse()].map(
      (item) => item.id,
    ),
  );
  expect(db.queryDeliveries(2).total).toBe(8);
  expect(db.queryDeliveries(2, "missing-cursor", false)).toEqual({ items: [] });
  expect(db.deleteFailedDelivery(deliveries[5].id)).toBe("deleted");
  expect(db.undeliveredDeliveryCount()).toBe(5);
  expect(db.pendingDeliveryCount()).toBe(5);
  db.db
    .prepare("UPDATE deliveries SET state='delivered' WHERE id=?")
    .run(deliveries[0].id);
  expect(db.undeliveredDeliveryCount()).toBe(4);
  expect(db.pendingDeliveryCount()).toBe(4);
});

it("uses indexed counts and bounded cursor seeks with 100,000 completed deliveries", () => {
  const { db, alert } = fixture();
  databases.push(db);
  db.db
    .prepare(
      `WITH RECURSIVE numbers(n) AS (
    VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n < 100000
  ) INSERT INTO deliveries(id, alert_id, transport_instance_id, operation, state, created_at, updated_at)
    SELECT 'history-'||n, ?, 'history-'||n, 'notify', 'delivered', '2026-01-01', '2026-01-01' FROM numbers`,
    )
    .run(alert.id);
  const prepare = vi.spyOn(db.db, "prepare");
  expect(db.pendingDeliveryCount()).toBe(5);
  expect(db.undeliveredDeliveryCount()).toBe(6);
  const first = db.queryDeliveries(3, undefined, false);
  const boundary = db.queryDeliveries(3, first.nextCursor, false);
  const history = db.queryDeliveries(3, boundary.nextCursor, false);
  expect(boundary.items.map((item) => item.state)).toEqual([
    "waiting_connectivity",
    "pending",
    "delivered",
  ]);
  expect(history.items.map((item) => item.id)).toEqual([
    "history-99999",
    "history-99998",
    "history-99997",
  ]);
  const sql = prepare.mock.calls.map(([query]) => query);
  prepare.mockRestore();
  expect(sql).not.toContain("SELECT COUNT(*) AS count FROM deliveries");
  const counts = sql.filter((query) => query.startsWith("SELECT COUNT(*)"));
  expect(counts).toHaveLength(2);
  for (const query of counts) {
    const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all();
    expect(plan.map((row) => row.detail).join(" ")).toMatch(
      /SEARCH deliveries USING COVERING INDEX deliveries_due_idx/,
    );
  }
  const seeks = [
    ...new Set(
      sql.filter((query) =>
        query.startsWith("SELECT id FROM deliveries WHERE"),
      ),
    ),
  ];
  expect(seeks).toHaveLength(2);
  for (const query of seeks) {
    const params = query.includes("AND rowid < ?") ? [1, 99990, 4] : [0, 4];
    const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params);
    const detail = plan.map((row) => row.detail).join(" ");
    expect(detail).toMatch(
      /SEARCH deliveries USING INDEX deliveries_history_priority_idx/,
    );
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/);
  }
});

it("migrates version 3 transactionally and preserves history across repeated restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "delivery-history-index-"));
  directories.push(directory);
  const filename = join(directory, "alerts.sqlite");
  const { db, deliveries } = fixture(filename);
  db.db.exec(
    "DROP INDEX deliveries_history_priority_idx; PRAGMA user_version=3",
  );
  db.close();
  const migrated = new AlertDatabase(filename);
  expect(migrated.migrationApplied).toBe(true);
  expect(migrated.db.prepare("PRAGMA user_version").get()).toMatchObject({
    user_version: 4,
  });
  expect(
    migrated.listDeliveries().map((item) => [item.id, item.state]),
  ).toEqual(deliveries.map((item) => [item.id, item.transportInstanceId]));
  expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  migrated.close();
  const reopened = new AlertDatabase(filename);
  databases.push(reopened);
  expect(reopened.migrationApplied).toBe(false);
  expect(reopened.undeliveredDeliveryCount()).toBe(6);
  expect(reopened.queryDeliveries(100, undefined, false).items).toHaveLength(8);
});

it("rolls back an interrupted index migration and retries it on restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "delivery-index-rollback-"));
  directories.push(directory);
  const filename = join(directory, "alerts.sqlite");
  const { db } = fixture(filename);
  db.db.exec(
    "DROP INDEX deliveries_history_priority_idx; PRAGMA user_version=3",
  );
  db.close();
  const originalExec = DatabaseSync.prototype.exec;
  let interrupted: DatabaseSync | undefined;
  const fault = vi
    .spyOn(DatabaseSync.prototype, "exec")
    .mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA user_version = 4") {
        interrupted = this;
        throw new Error("Synthetic migration interruption");
      }
      originalExec.call(this, sql);
    });
  expect(() => new AlertDatabase(filename)).toThrow(
    "Synthetic migration interruption",
  );
  fault.mockRestore();
  expect(interrupted!.prepare("PRAGMA user_version").get()).toMatchObject({
    user_version: 3,
  });
  expect(
    interrupted!
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='deliveries_history_priority_idx'",
      )
      .get(),
  ).toBeUndefined();
  interrupted!.close();
  const recovered = new AlertDatabase(filename);
  databases.push(recovered);
  expect(recovered.migrationApplied).toBe(true);
  expect(recovered.queryDeliveries(100).total).toBe(8);
});
