import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

const tableExists = (database: DatabaseSync, table: string): boolean =>
  Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
      )
      .get(table),
  );

const columns = (database: DatabaseSync, table: string): Set<string> =>
  new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(
      (row) => String(row.name),
    ),
  );

/**
 * Upgrades the schema used immediately before per-service repeat delivery.
 *
 * This is deliberately shape-detected because both layouts are pre-release
 * version-one databases. It is idempotent and keeps the legacy rearm columns as
 * unused compatibility data rather than rebuilding large alert tables.
 */
export function migrateLegacyRepeatSchema(database: DatabaseSync): boolean {
  if (!tableExists(database, "alert_definitions")) return false;

  const policyColumns = columns(database, "alert_policies");
  const policyNotifierColumns = columns(database, "alert_policy_notifiers");
  const occurrenceColumns = columns(database, "alert_occurrences");
  const occurrenceNotifierColumns = columns(database, "occurrence_notifiers");
  const deliveryColumns = columns(database, "deliveries");
  const needsMigration =
    !policyNotifierColumns.has("repeat_override_seconds") ||
    !occurrenceNotifierColumns.has("repeat_after_seconds") ||
    !occurrenceNotifierColumns.has("next_repeat_at") ||
    !deliveryColumns.has("cycle");
  if (!needsMigration) return false;

  if (
    !policyColumns.has("rearm_after_seconds") ||
    !occurrenceColumns.has("rearm_after_seconds") ||
    !tableExists(database, "delivery_attempts")
  )
    throw new Error(
      "Existing Alert Center database has an unsupported pre-release schema",
    );

  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    if (!policyNotifierColumns.has("repeat_override_seconds"))
      database.exec(
        "ALTER TABLE alert_policy_notifiers ADD COLUMN repeat_override_seconds INTEGER",
      );
    if (!occurrenceNotifierColumns.has("repeat_after_seconds"))
      database.exec(
        "ALTER TABLE occurrence_notifiers ADD COLUMN repeat_after_seconds INTEGER NOT NULL DEFAULT 0",
      );
    if (!occurrenceNotifierColumns.has("next_repeat_at"))
      database.exec(
        "ALTER TABLE occurrence_notifiers ADD COLUMN next_repeat_at TEXT",
      );

    const policies = database
      .prepare(
        `SELECT definition_id, rearm_after_seconds, override_fields_json
         FROM alert_policies`,
      )
      .all() as Row[];
    const updatePolicyFields = database.prepare(
      "UPDATE alert_policies SET override_fields_json=? WHERE definition_id=?",
    );
    const updatePolicyNotifiers = database.prepare(
      `UPDATE alert_policy_notifiers SET repeat_override_seconds=?
       WHERE definition_id=?`,
    );
    for (const policy of policies) {
      const fields = JSON.parse(
        String(policy.override_fields_json),
      ) as string[];
      const hadLegacyOverride = fields.includes("rearmAfterSeconds");
      const migratedFields = fields.filter(
        (field) => field !== "rearmAfterSeconds",
      );
      if (hadLegacyOverride && !migratedFields.includes("notifierIds"))
        migratedFields.push("notifierIds");
      updatePolicyFields.run(
        JSON.stringify([...new Set(migratedFields)]),
        String(policy.definition_id),
      );
      if (hadLegacyOverride && policy.rearm_after_seconds !== null)
        updatePolicyNotifiers.run(
          Number(policy.rearm_after_seconds),
          String(policy.definition_id),
        );
    }

    database.exec(
      `UPDATE occurrence_notifiers
       SET repeat_after_seconds=COALESCE((
         SELECT o.rearm_after_seconds FROM alert_occurrences o
         WHERE o.id=occurrence_notifiers.alert_id
       ), 0)`,
    );

    if (!deliveryColumns.has("cycle")) {
      database.exec(`
        ALTER TABLE delivery_attempts RENAME TO delivery_attempts_legacy_repeat;
        ALTER TABLE deliveries RENAME TO deliveries_legacy_repeat;

        CREATE TABLE deliveries (
          id TEXT PRIMARY KEY,
          alert_id TEXT NOT NULL REFERENCES alert_occurrences(id),
          transport_instance_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          cycle INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          delivered_at TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          remote_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(alert_id, transport_instance_id, operation, cycle)
        );
        INSERT INTO deliveries (
          id, alert_id, transport_instance_id, operation, cycle, state,
          attempt_count, next_attempt_at, last_attempt_at, delivered_at,
          last_error_code, last_error_message, remote_id, created_at, updated_at
        )
        SELECT id, alert_id, transport_instance_id, operation, 1, state,
          attempt_count, next_attempt_at, last_attempt_at, delivered_at,
          last_error_code, last_error_message, remote_id, created_at, updated_at
        FROM deliveries_legacy_repeat;

        CREATE TABLE delivery_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          outcome TEXT NOT NULL,
          error_code TEXT,
          error_message TEXT,
          remote_id TEXT,
          UNIQUE(delivery_id, attempt_number)
        );
        INSERT INTO delivery_attempts (
          id, delivery_id, attempt_number, started_at, finished_at, outcome,
          error_code, error_message, remote_id
        )
        SELECT id, delivery_id, attempt_number, started_at, finished_at, outcome,
          error_code, error_message, remote_id
        FROM delivery_attempts_legacy_repeat;

        DROP TABLE delivery_attempts_legacy_repeat;
        DROP TABLE deliveries_legacy_repeat;
      `);
    }

    const delivered = database
      .prepare(
        `SELECT n.alert_id, n.transport_instance_id, n.repeat_after_seconds,
                MAX(d.delivered_at) AS delivered_at
         FROM occurrence_notifiers n
         JOIN alert_occurrences o ON o.id=n.alert_id
         LEFT JOIN deliveries d
           ON d.alert_id=n.alert_id
          AND d.transport_instance_id=n.transport_instance_id
          AND d.operation IN ('notify', 'trigger')
          AND d.state='delivered'
         WHERE o.current_state='active' AND n.repeat_after_seconds > 0
         GROUP BY n.alert_id, n.transport_instance_id`,
      )
      .all() as Row[];
    const scheduleRepeat = database.prepare(
      `UPDATE occurrence_notifiers SET next_repeat_at=?
       WHERE alert_id=? AND transport_instance_id=?`,
    );
    for (const row of delivered) {
      if (!row.delivered_at) continue;
      const dueAt = new Date(
        new Date(String(row.delivered_at)).getTime() +
          Number(row.repeat_after_seconds) * 1000,
      );
      scheduleRepeat.run(
        dueAt.toISOString(),
        String(row.alert_id),
        String(row.transport_instance_id),
      );
    }

    const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length)
      throw new Error(
        "Alert Center database migration failed a foreign-key check",
      );
    database.exec("COMMIT; PRAGMA foreign_keys = ON;");
    return true;
  } catch (error) {
    database.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
    throw error;
  }
}
