import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AlertDefinitionRecord,
  AlertEventRecord,
  AlertHistoryPage,
  AlertHistoryQuery,
  AlertHistoryRecord,
  AlertPolicyRecord,
  AlertPolicyField,
  AlertRecord,
  DeliveryAttemptRecord,
  DeliveryAttemptPage,
  DeliveryPage,
  DeliveryRecord,
  IngestOptions,
  NormalizedAlert,
  OccurrencePage,
  OccurrenceQuery,
  severityRank,
} from "../alerts/types";
import { currentSchemaVersion, schema } from "./schema";
import { migrateLegacyRepeatSchema } from "./migrations";

type Row = Record<string, unknown>;

export interface ServiceOperationalStatus {
  id: string;
  pendingCount: number;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  lastFailureCode?: string;
}

export interface DatabaseOperationalStatus {
  healthy: boolean;
  schemaVersion: number;
  expectedSchemaVersion: number;
  oldestPendingDeliveryAt?: Date;
  oldestDueDeliveryAt?: Date;
  overdueActivationCount: number;
  pendingWakeCount: number;
  nextWakeAt?: Date;
  services: ServiceOperationalStatus[];
  error?: string;
}
const date = (value: unknown): Date | undefined =>
  value ? new Date(String(value)) : undefined;
const json = (value: unknown): unknown | undefined =>
  value === null || value === undefined ? undefined : JSON.parse(String(value));

const deliveryContextSelect = `SELECT d.*,
  o.id AS occurrence_id, o.occurrence_number, o.definition_id,
  o.path AS alert_path, o.message AS alert_message,
  o.max_severity AS alert_severity, o.started_at AS alert_started_at,
  f.name AS definition_name
FROM deliveries d
LEFT JOIN alert_occurrences o ON o.id=d.alert_id
LEFT JOIN alert_definitions f ON f.id=o.definition_id`;

const deliveryRecord = (row: Row): DeliveryRecord => ({
  id: String(row.id),
  alertId: String(row.alert_id),
  transportInstanceId: String(row.transport_instance_id),
  operation: row.operation as DeliveryRecord["operation"],
  state: row.state as DeliveryRecord["state"],
  attemptCount: Number(row.attempt_count),
  cycle: Number(row.cycle ?? 1),
  nextAttemptAt: date(row.next_attempt_at),
  lastAttemptAt: date(row.last_attempt_at),
  deliveredAt: date(row.delivered_at),
  lastErrorCode: row.last_error_code ? String(row.last_error_code) : undefined,
  lastErrorMessage: row.last_error_message
    ? String(row.last_error_message)
    : undefined,
  remoteId: row.remote_id ? String(row.remote_id) : undefined,
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
  ...(row.occurrence_id
    ? {
        alert: {
          occurrenceId: String(row.occurrence_id),
          occurrenceNumber:
            row.occurrence_number === null ||
            row.occurrence_number === undefined
              ? undefined
              : Number(row.occurrence_number),
          definitionId: row.definition_id
            ? String(row.definition_id)
            : undefined,
          name: String(row.definition_name ?? row.alert_path),
          path: String(row.alert_path),
          message: row.alert_message ? String(row.alert_message) : undefined,
          severity: row.alert_severity as AlertRecord["maxSeverity"],
          startedAt: new Date(String(row.alert_started_at)),
        },
      }
    : {}),
});

const deliveryAttemptRecord = (row: Row): DeliveryAttemptRecord => ({
  id: Number(row.id),
  deliveryId: String(row.delivery_id),
  attemptNumber: Number(row.attempt_number),
  startedAt: new Date(String(row.started_at)),
  finishedAt: date(row.finished_at),
  outcome: row.outcome as DeliveryAttemptRecord["outcome"],
  errorCode: row.error_code ? String(row.error_code) : undefined,
  errorMessage: row.error_message ? String(row.error_message) : undefined,
  remoteId: row.remote_id ? String(row.remote_id) : undefined,
});

const alertHistoryRecord = (row: Row): AlertHistoryRecord => {
  const payload = json(row.payload_json);
  const payloadRecord =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;
  const payloadSeverity =
    typeof payloadRecord?.state === "string" &&
    ["normal", "warn", "alert", "alarm", "emergency"].includes(
      payloadRecord.state,
    )
      ? payloadRecord.state
      : undefined;
  const severity =
    row.event_type === "severity_changed" &&
    typeof payloadRecord?.to === "string"
      ? payloadRecord.to
      : (payloadSeverity ?? row.max_severity);
  return {
    id: Number(row.id),
    alertId: String(row.alert_id),
    definitionId: String(row.definition_id),
    occurrenceNumber: Number(row.occurrence_number),
    name: String(row.definition_name ?? row.path),
    path: String(row.path),
    sourceKey: String(row.source_key),
    source: row.source ? String(row.source) : undefined,
    state: row.current_state as AlertHistoryRecord["state"],
    severity: severity as AlertHistoryRecord["severity"],
    message:
      row.event_type === "message_changed" &&
      typeof payloadRecord?.to === "string"
        ? payloadRecord.to
        : typeof payloadRecord?.message === "string"
          ? payloadRecord.message
          : row.message
            ? String(row.message)
            : undefined,
    startedAt: new Date(String(row.started_at)),
    clearedAt: date(row.cleared_at),
    eventType: String(row.event_type),
    occurredAt: new Date(String(row.occurred_at)),
    payload,
  };
};

export class AlertDatabase {
  readonly db: DatabaseSync;
  readonly migrationApplied: boolean;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrationApplied = migrateLegacyRepeatSchema(this.db);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(schema);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Clears all application data while preserving and re-initializing the schema. */
  reset(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [
        "delivery_attempts",
        "deliveries",
        "wake_requests",
        "occurrence_notifier_thresholds",
        "occurrence_notifiers",
        "alert_events",
        "alert_occurrences",
        "alert_policy_notifiers",
        "alert_policies",
        "alert_definitions",
        "connectivity_sessions",
      ])
        this.db.exec(`DELETE FROM ${table}`);
      this.db.exec(
        "DELETE FROM sqlite_sequence WHERE name IN ('alert_events', 'delivery_attempts')",
      );
      // Keep this operation valid as new idempotent schema objects are added.
      this.db.exec(schema);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  schemaVersion(): number {
    return currentSchemaVersion;
  }

  operationalStatus(now = new Date()): DatabaseOperationalStatus {
    try {
      const queue = this.db
        .prepare(
          `SELECT MIN(COALESCE(next_attempt_at, created_at)) AS oldest,
             MIN(CASE WHEN next_attempt_at IS NULL OR next_attempt_at <= ?
               THEN COALESCE(next_attempt_at, created_at) END) AS oldest_due
           FROM deliveries
           WHERE state IN ('pending', 'waiting_connectivity', 'sending', 'failed_retryable')`,
        )
        .get(now.toISOString()) as Row;
      const activation = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM alert_occurrences
           WHERE activation_state='pending' AND current_state='active'
             AND activation_due_at <= ?`,
        )
        .get(now.toISOString()) as Row;
      const wake = this.db
        .prepare(
          "SELECT COUNT(*) AS count, MIN(wake_due_at) AS next_at FROM wake_requests",
        )
        .get() as Row;
      const serviceRows = this.db
        .prepare(
          `SELECT transport_instance_id,
             SUM(CASE WHEN state IN ('pending', 'waiting_connectivity', 'sending', 'failed_retryable') THEN 1 ELSE 0 END) AS pending,
             MAX(delivered_at) AS last_success
           FROM deliveries GROUP BY transport_instance_id
           ORDER BY transport_instance_id`,
        )
        .all() as Row[];
      const lastFailure = this.db.prepare(
        `SELECT a.finished_at, a.error_code
         FROM delivery_attempts a
         JOIN deliveries d ON d.id=a.delivery_id
         WHERE d.transport_instance_id=?
           AND a.outcome IN ('failed_retryable', 'failed_terminal', 'interrupted')
         ORDER BY a.finished_at DESC, a.id DESC LIMIT 1`,
      );
      return {
        healthy: true,
        schemaVersion: currentSchemaVersion,
        expectedSchemaVersion: currentSchemaVersion,
        oldestPendingDeliveryAt: date(queue.oldest),
        oldestDueDeliveryAt: date(queue.oldest_due),
        overdueActivationCount: Number(activation.count ?? 0),
        pendingWakeCount: Number(wake.count ?? 0),
        nextWakeAt: date(wake.next_at),
        services: serviceRows.map((row) => {
          const failure = lastFailure.get(row.transport_instance_id) as
            Row | undefined;
          return {
            id: String(row.transport_instance_id),
            pendingCount: Number(row.pending ?? 0),
            lastSuccessAt: date(row.last_success),
            lastFailureAt: date(failure?.finished_at),
            lastFailureCode: failure?.error_code
              ? String(failure.error_code)
              : undefined,
          };
        }),
      };
    } catch (error) {
      return {
        healthy: false,
        schemaVersion: 0,
        expectedSchemaVersion: currentSchemaVersion,
        overdueActivationCount: 0,
        pendingWakeCount: 0,
        services: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  upsertDefinition(
    definition: {
      id: string;
      sourceType: AlertDefinitionRecord["sourceType"];
      pathPattern: string;
      name: string;
      metadata?: unknown;
    },
    now = new Date(),
  ): AlertDefinitionRecord {
    const timestamp = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO alert_definitions
          (id, source_type, path_pattern, name, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          source_type=excluded.source_type, path_pattern=excluded.path_pattern,
          name=excluded.name, metadata_json=excluded.metadata_json,
          updated_at=excluded.updated_at
         WHERE alert_definitions.source_type IS NOT excluded.source_type
            OR alert_definitions.path_pattern IS NOT excluded.path_pattern
            OR alert_definitions.name IS NOT excluded.name
            OR alert_definitions.metadata_json IS NOT excluded.metadata_json`,
      )
      .run(
        definition.id,
        definition.sourceType,
        definition.pathPattern,
        definition.name,
        definition.metadata === undefined
          ? null
          : JSON.stringify(definition.metadata),
        timestamp,
        timestamp,
      );
    return this.getDefinition(definition.id);
  }

  private ensureDefinition(
    alert: NormalizedAlert,
    definitionId: string,
    now: Date,
  ): void {
    if (
      this.db
        .prepare("SELECT 1 FROM alert_definitions WHERE id=?")
        .get(definitionId)
    )
      return;
    this.upsertDefinition(
      {
        id: definitionId,
        sourceType: "recognized",
        pathPattern: alert.path,
        name: alert.path,
      },
      now,
    );
  }

  getDefinition(id: string): AlertDefinitionRecord {
    const row = this.db
      .prepare("SELECT * FROM alert_definitions WHERE id=?")
      .get(id) as Row | undefined;
    if (!row) throw new Error(`Unknown alert definition: ${id}`);
    return {
      id: String(row.id),
      sourceType: row.source_type as AlertDefinitionRecord["sourceType"],
      pathPattern: String(row.path_pattern),
      name: String(row.name),
      metadata: json(row.metadata_json),
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
    };
  }

  listDefinitions(): AlertDefinitionRecord[] {
    return (
      this.db
        .prepare("SELECT id FROM alert_definitions ORDER BY name, id")
        .all() as Row[]
    ).map((row) => this.getDefinition(String(row.id)));
  }

  definitionStats(id: string): {
    fireCount: number;
    lastFiredAt?: Date;
    lastActivityAt?: Date;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS fire_count, MAX(started_at) AS last_fired_at,
                MAX(updated_at) AS last_activity_at
         FROM alert_occurrences WHERE definition_id=?`,
      )
      .get(id) as Row;
    return {
      fireCount: Number(row.fire_count),
      lastFiredAt: date(row.last_fired_at),
      lastActivityAt: date(row.last_activity_at),
    };
  }

  alertStats(): { total: number; active: number; pendingActivation: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN current_state='active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN activation_state='pending' THEN 1 ELSE 0 END) AS pending_activation
         FROM alert_occurrences`,
      )
      .get() as Row;
    return {
      total: Number(row.total),
      active: Number(row.active ?? 0),
      pendingActivation: Number(row.pending_activation ?? 0),
    };
  }

  definitionCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM alert_definitions")
      .get() as Row;
    return Number(row.count);
  }

  retentionStatus(cutoff: Date): {
    eligibleOccurrences: number;
    oldestEligibleAt?: Date;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS eligible, MIN(started_at) AS oldest
         FROM alert_occurrences o
         WHERE o.current_state='cleared' AND o.cleared_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM deliveries d
             WHERE d.alert_id=o.id
               AND d.state IN ('pending', 'waiting_connectivity', 'sending', 'failed_retryable')
           )
           AND NOT EXISTS (
             SELECT 1 FROM wake_requests w WHERE w.alert_id=o.id
           )`,
      )
      .get(cutoff.toISOString()) as Row;
    return {
      eligibleOccurrences: Number(row.eligible),
      oldestEligibleAt: date(row.oldest),
    };
  }

  pruneOccurrences(cutoff: Date, limit = 100): string[] {
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const ids = (
        this.db
          .prepare(
            `SELECT o.id FROM alert_occurrences o
             WHERE o.current_state='cleared' AND o.cleared_at < ?
               AND NOT EXISTS (
                 SELECT 1 FROM deliveries d
                 WHERE d.alert_id=o.id
                   AND d.state IN ('pending', 'waiting_connectivity', 'sending', 'failed_retryable')
               )
               AND NOT EXISTS (
                 SELECT 1 FROM wake_requests w WHERE w.alert_id=o.id
               )
             ORDER BY o.started_at, o.id LIMIT ?`,
          )
          .all(cutoff.toISOString(), boundedLimit) as Row[]
      ).map((row) => String(row.id));
      const remove = this.db.prepare(
        "DELETE FROM alert_occurrences WHERE id=?",
      );
      for (const id of ids) {
        this.db
          .prepare(
            "DELETE FROM delivery_attempts WHERE delivery_id IN (SELECT id FROM deliveries WHERE alert_id=?)",
          )
          .run(id);
        this.db.prepare("DELETE FROM deliveries WHERE alert_id=?").run(id);
        this.db.prepare("DELETE FROM alert_events WHERE alert_id=?").run(id);
        this.db.prepare("DELETE FROM wake_requests WHERE alert_id=?").run(id);
        this.db
          .prepare("DELETE FROM occurrence_notifiers WHERE alert_id=?")
          .run(id);
        this.db
          .prepare(
            "DELETE FROM occurrence_notifier_thresholds WHERE alert_id=?",
          )
          .run(id);
        remove.run(id);
      }
      this.db.exec("COMMIT");
      return ids;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteDefinition(id: string): "deleted" | "active" | "not_found" {
    const definition = this.db
      .prepare("SELECT 1 FROM alert_definitions WHERE id=?")
      .get(id) as Row | undefined;
    if (!definition) return "not_found";
    const active = this.db
      .prepare(
        "SELECT 1 FROM alert_occurrences WHERE definition_id=? AND current_state='active' LIMIT 1",
      )
      .get(id);
    if (active) return "active";

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "DELETE FROM delivery_attempts WHERE delivery_id IN (SELECT id FROM deliveries WHERE alert_id IN (SELECT id FROM alert_occurrences WHERE definition_id=?))",
        )
        .run(id);
      for (const table of [
        "deliveries",
        "wake_requests",
        "occurrence_notifier_thresholds",
        "occurrence_notifiers",
        "alert_events",
      ])
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE alert_id IN (SELECT id FROM alert_occurrences WHERE definition_id=?)`,
          )
          .run(id);
      this.db
        .prepare("DELETE FROM alert_occurrences WHERE definition_id=?")
        .run(id);
      this.db
        .prepare("DELETE FROM alert_policy_notifiers WHERE definition_id=?")
        .run(id);
      this.db
        .prepare("DELETE FROM alert_policies WHERE definition_id=?")
        .run(id);
      this.db.prepare("DELETE FROM alert_definitions WHERE id=?").run(id);
      this.db.exec("COMMIT");
      return "deleted";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setPolicy(
    definitionId: string,
    policy: Omit<AlertPolicyRecord, "definitionId" | "updatedAt">,
    now = new Date(),
  ): AlertPolicyRecord {
    const timestamp = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO alert_policies
            (definition_id, enabled, minimum_severity, connectivity_json,
             one_time, activation_delay_seconds,
             speech_minimum_severity, speech_template, speech_announce_clear,
             override_fields_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(definition_id) DO UPDATE SET
            enabled=excluded.enabled, minimum_severity=excluded.minimum_severity,
            connectivity_json=excluded.connectivity_json, one_time=excluded.one_time,
            activation_delay_seconds=excluded.activation_delay_seconds,
            speech_minimum_severity=excluded.speech_minimum_severity,
            speech_template=excluded.speech_template,
            speech_announce_clear=excluded.speech_announce_clear,
            override_fields_json=excluded.override_fields_json,
            updated_at=excluded.updated_at`,
        )
        .run(
          definitionId,
          policy.enabled === undefined ? null : Number(policy.enabled),
          policy.minimumSeverity ?? null,
          policy.connectivity === undefined
            ? null
            : JSON.stringify(policy.connectivity),
          policy.oneTime === undefined ? null : Number(policy.oneTime),
          policy.activationDelaySeconds ?? null,
          policy.speechMinimumSeverity ?? null,
          policy.speechTemplate ?? null,
          policy.speechAnnounceClear === undefined
            ? null
            : Number(policy.speechAnnounceClear),
          JSON.stringify([...new Set(policy.overrideFields)]),
          timestamp,
        );
      this.db
        .prepare("DELETE FROM alert_policy_notifiers WHERE definition_id=?")
        .run(definitionId);
      for (const notifierId of [...new Set(policy.notifierIds)]) {
        this.db
          .prepare(
            "INSERT INTO alert_policy_notifiers(definition_id, transport_instance_id, repeat_override_seconds) VALUES (?, ?, ?)",
          )
          .run(
            definitionId,
            notifierId,
            policy.notifierRepeatOverrides?.[notifierId] ?? null,
          );
      }
      this.db.exec("COMMIT");
      return this.getPolicy(definitionId)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getPolicy(definitionId: string): AlertPolicyRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM alert_policies WHERE definition_id=?")
      .get(definitionId) as Row | undefined;
    if (!row) return undefined;
    const notifiers = this.db
      .prepare(
        "SELECT transport_instance_id, repeat_override_seconds FROM alert_policy_notifiers WHERE definition_id=? ORDER BY transport_instance_id",
      )
      .all(definitionId) as Row[];
    return {
      definitionId,
      enabled: row.enabled === null ? undefined : Boolean(row.enabled),
      minimumSeverity: row.minimum_severity
        ? (String(row.minimum_severity) as AlertPolicyRecord["minimumSeverity"])
        : undefined,
      connectivity: json(row.connectivity_json) as
        AlertPolicyRecord["connectivity"] | undefined,
      oneTime: row.one_time === null ? undefined : Boolean(row.one_time),
      activationDelaySeconds:
        row.activation_delay_seconds === null
          ? undefined
          : Number(row.activation_delay_seconds),
      speechMinimumSeverity: row.speech_minimum_severity
        ? (String(
            row.speech_minimum_severity,
          ) as AlertPolicyRecord["speechMinimumSeverity"])
        : undefined,
      speechTemplate: row.speech_template
        ? String(row.speech_template)
        : undefined,
      speechAnnounceClear:
        row.speech_announce_clear === null
          ? undefined
          : Boolean(row.speech_announce_clear),
      notifierIds: notifiers.map((item) => String(item.transport_instance_id)),
      notifierRepeatOverrides: Object.fromEntries(
        notifiers
          .filter((item) => item.repeat_override_seconds !== null)
          .map((item) => [
            String(item.transport_instance_id),
            Number(item.repeat_override_seconds),
          ]),
      ),
      overrideFields:
        (json(row.override_fields_json) as AlertPolicyField[] | undefined) ??
        [],
      updatedAt: new Date(String(row.updated_at)),
    };
  }

  clearPolicy(definitionId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM alert_policy_notifiers WHERE definition_id=?")
        .run(definitionId);
      const result = this.db
        .prepare("DELETE FROM alert_policies WHERE definition_id=?")
        .run(definitionId);
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Reconciles notifier capabilities after configuration and schema upgrades.
   * Existing operation rows predate the capability snapshot, so PagerDuty
   * deliveries must be identified by their configured instance names.
   */
  configureResolvingNotifiers(transportIds: string[], now = new Date()): void {
    if (!transportIds.length) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const affectedAlerts = new Set<string>();
      const select = this.db.prepare(
        `SELECT alert_id FROM occurrence_notifiers
         WHERE transport_instance_id=?`,
      );
      for (const transportId of new Set(transportIds)) {
        for (const row of select.all(transportId) as Row[])
          affectedAlerts.add(String(row.alert_id));
        this.db
          .prepare(
            `UPDATE occurrence_notifiers
             SET supports_resolution=1, supports_acknowledgement=1
             WHERE transport_instance_id=?`,
          )
          .run(transportId);
        this.db
          .prepare(
            `UPDATE deliveries SET operation='trigger'
             WHERE transport_instance_id=? AND operation='notify'`,
          )
          .run(transportId);
      }
      for (const alertId of affectedAlerts) {
        const occurrence = this.db
          .prepare(
            "SELECT current_state, acknowledged_at FROM alert_occurrences WHERE id=?",
          )
          .get(alertId) as Row | undefined;
        if (occurrence?.acknowledged_at)
          this.createActionDeliveryIntents(alertId, "acknowledge", now);
        if (occurrence?.current_state === "cleared")
          this.createActionDeliveryIntents(alertId, "resolve", now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private eligibleNotifierCount(
    alertId: string,
    severity: AlertRecord["currentSeverity"],
  ): number {
    const rows = this.db
      .prepare(
        `SELECT n.transport_instance_id, COALESCE(t.minimum_severity, 'normal') AS minimum_severity
         FROM occurrence_notifiers n
         LEFT JOIN occurrence_notifier_thresholds t
           ON t.alert_id=n.alert_id AND t.transport_instance_id=n.transport_instance_id
         WHERE n.alert_id=?`,
      )
      .all(alertId) as Row[];
    return rows.filter(
      (row) =>
        severityRank(severity) >=
        severityRank(
          String(row.minimum_severity) as AlertRecord["currentSeverity"],
        ),
    ).length;
  }

  ingest(
    alert: NormalizedAlert,
    transportIds: string[],
    now = new Date(),
    options: IngestOptions = {},
  ): AlertRecord | undefined {
    const timestamp = now.toISOString();
    const definitionId =
      options.definitionId ?? `recognized:${alert.sourceKey}`;
    const delaySeconds = Math.max(0, options.activationDelaySeconds ?? 0);
    const minimumSeverity = options.minimumSeverity ?? "normal";
    const connectivity = options.connectivity ?? { mode: "queue" };
    const payload =
      alert.sourcePayload === undefined
        ? null
        : JSON.stringify(alert.sourcePayload);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureDefinition(alert, definitionId, now);
      let active = this.db
        .prepare(
          "SELECT * FROM alert_occurrences WHERE source_key=? AND current_state='active'",
        )
        .get(alert.sourceKey) as Row | undefined;

      let id: string;
      if (active) {
        id = String(active.id);
        this.enableLifecycleActionsForNotifiers(
          id,
          options.resolvingNotifierIds,
          options.acknowledgingNotifierIds ?? options.resolvingNotifierIds,
        );
        const previousSeverity = String(active.current_severity);
        const previousMessage = active.message
          ? String(active.message)
          : undefined;
        const maxSeverity =
          severityRank(active.max_severity as AlertRecord["maxSeverity"]) >
          severityRank(alert.severity)
            ? String(active.max_severity)
            : alert.severity;
        const clearing = alert.state === "cleared";
        const suppression = clearing && active.activation_state === "pending";
        this.db
          .prepare(
            `UPDATE alert_occurrences SET
              source_timestamp=COALESCE(?, source_timestamp), last_seen_at=?,
              cleared_at=?, current_state=?, current_severity=?, max_severity=?,
              message=?, source_payload_json=?, notification_id=COALESCE(?, notification_id),
              activation_state=CASE WHEN ? THEN 'suppressed' ELSE activation_state END,
              activation_due_at=CASE WHEN ? THEN NULL ELSE activation_due_at END,
              updated_at=? WHERE id=?`,
          )
          .run(
            alert.sourceTimestamp?.toISOString() ?? null,
            timestamp,
            clearing ? timestamp : null,
            alert.state,
            alert.severity,
            maxSeverity,
            alert.message ?? null,
            payload,
            alert.notificationId ?? null,
            Number(suppression),
            Number(suppression),
            timestamp,
            id,
          );
        if (!clearing && previousSeverity !== alert.severity) {
          this.addEvent(id, "severity_changed", now, {
            from: previousSeverity,
            to: alert.severity,
          });
        }
        if (!clearing && previousMessage !== alert.message) {
          this.addEvent(id, "message_changed", now, {
            from: previousMessage,
            to: alert.message,
          });
        }
        if (
          !clearing &&
          previousSeverity === alert.severity &&
          previousMessage === alert.message
        )
          this.addEvent(id, "updated", now, alert.sourcePayload);
        if (suppression) this.addEvent(id, "suppressed_before_activation", now);
        if (clearing) {
          this.addEvent(id, "cleared", now, alert.sourcePayload);
          this.db
            .prepare(
              "UPDATE occurrence_notifiers SET next_repeat_at=NULL WHERE alert_id=?",
            )
            .run(id);
        }

        if (alert.acknowledged && !active.acknowledged_at) {
          this.db
            .prepare(
              "UPDATE alert_occurrences SET acknowledged_at=?, updated_at=? WHERE id=?",
            )
            .run(timestamp, timestamp, id);
          this.addEvent(id, "acknowledged", now);
          this.createActionDeliveryIntents(id, "acknowledge", now);
        }
        if (clearing) this.createActionDeliveryIntents(id, "resolve", now);

        if (!clearing) {
          const qualifies =
            severityRank(alert.severity) >=
            severityRank(
              String(active.minimum_severity) as AlertRecord["minimumSeverity"],
            );
          const notifierCount = this.eligibleNotifierCount(id, alert.severity);
          if (
            qualifies &&
            notifierCount > 0 &&
            active.activation_state === "suppressed"
          ) {
            const snapshotDelay = Number(active.activation_delay_seconds);
            const dueAt =
              snapshotDelay > 0
                ? new Date(now.getTime() + snapshotDelay * 1000)
                : undefined;
            this.db
              .prepare(
                `UPDATE alert_occurrences SET activation_state=?, activation_due_at=?,
                 updated_at=? WHERE id=?`,
              )
              .run(
                dueAt ? "pending" : "eligible",
                dueAt?.toISOString() ?? null,
                timestamp,
                id,
              );
            this.addEvent(
              id,
              dueAt ? "activation_pending" : "activation_eligible",
              now,
            );
            if (!dueAt) this.createDeliveryIntents(id, now);
          } else if (!qualifies && active.activation_state === "pending") {
            this.db
              .prepare(
                `UPDATE alert_occurrences SET activation_state='suppressed',
                 activation_due_at=NULL, updated_at=? WHERE id=?`,
              )
              .run(timestamp, id);
            this.addEvent(id, "suppressed_before_activation", now, {
              reason: "below_minimum_severity",
            });
          } else if (qualifies && active.activation_state === "eligible") {
            // A severity increase can make an additional globally-thresholded
            // notifier eligible during an already active occurrence.
            this.createDeliveryIntents(id, now);
          }
        }
      } else {
        if (alert.state === "cleared") {
          this.db.exec("COMMIT");
          return undefined;
        }
        id = randomUUID();
        const count = this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM alert_occurrences WHERE source_key=?",
          )
          .get(alert.sourceKey) as Row;
        const occurrenceNumber = Number(count.count) + 1;
        const activeState = alert.state === "active";
        const eligibleTransportIds = transportIds.filter(
          (transportId) =>
            severityRank(alert.severity) >=
            severityRank(
              options.notifierMinimumSeverities?.[transportId] ?? "normal",
            ),
        );
        const qualifies =
          activeState &&
          eligibleTransportIds.length > 0 &&
          severityRank(alert.severity) >= severityRank(minimumSeverity);
        const activationState = qualifies
          ? delaySeconds > 0
            ? "pending"
            : "eligible"
          : "suppressed";
        const activationDueAt =
          qualifies && delaySeconds > 0
            ? new Date(now.getTime() + delaySeconds * 1000).toISOString()
            : null;
        this.db
          .prepare(
            `INSERT INTO alert_occurrences
              (id, definition_id, occurrence_number, source_key, path, source, started_at,
               source_timestamp, received_at, last_seen_at, cleared_at, current_state,
               current_severity, max_severity, message, source_payload_json,
               notification_id, one_time, minimum_severity,
               activation_delay_seconds, speech_template,
               connectivity_json, activation_due_at, activation_state,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            definitionId,
            occurrenceNumber,
            alert.sourceKey,
            alert.path,
            alert.source ?? null,
            timestamp,
            alert.sourceTimestamp?.toISOString() ?? null,
            timestamp,
            timestamp,
            activeState ? null : timestamp,
            alert.state,
            alert.severity,
            alert.severity,
            alert.message ?? null,
            payload,
            alert.notificationId ?? null,
            Number(options.oneTime ?? false),
            minimumSeverity,
            delaySeconds,
            options.speechTemplate ?? null,
            JSON.stringify(connectivity),
            activationDueAt,
            activationState,
            timestamp,
            timestamp,
          );
        this.addEvent(
          id,
          activeState ? "raised" : "cleared",
          now,
          alert.sourcePayload,
        );
        if (alert.acknowledged) {
          this.db
            .prepare(
              "UPDATE alert_occurrences SET acknowledged_at=?, updated_at=? WHERE id=?",
            )
            .run(timestamp, timestamp, id);
          this.addEvent(id, "acknowledged", now);
        }
        for (const transportId of [...new Set(transportIds)]) {
          this.db
            .prepare(
              `INSERT INTO occurrence_notifiers
                (alert_id, transport_instance_id, supports_resolution,
                 supports_acknowledgement, repeat_after_seconds)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              transportId,
              Number(
                options.resolvingNotifierIds?.includes(transportId) ?? false,
              ),
              Number(
                (
                  options.acknowledgingNotifierIds ??
                  options.resolvingNotifierIds
                )?.includes(transportId) ?? false,
              ),
              options.notifierRepeatIntervals?.[transportId] ?? 0,
            );
          this.db
            .prepare(
              "INSERT INTO occurrence_notifier_thresholds(alert_id, transport_instance_id, minimum_severity) VALUES (?, ?, ?)",
            )
            .run(
              id,
              transportId,
              options.notifierMinimumSeverities?.[transportId] ?? "normal",
            );
        }
        if (activationState === "eligible") this.createDeliveryIntents(id, now);
      }
      const result = this.getAlert(id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createDeliveryIntents(alertId: string, now: Date): void {
    const timestamp = now.toISOString();
    const alert = this.getAlert(alertId);
    const rows = this.db
      .prepare(
        `SELECT n.transport_instance_id, n.supports_resolution,
                COALESCE(t.minimum_severity, 'normal') AS minimum_severity
         FROM occurrence_notifiers n
         LEFT JOIN occurrence_notifier_thresholds t
           ON t.alert_id=n.alert_id AND t.transport_instance_id=n.transport_instance_id
         WHERE n.alert_id=? ORDER BY n.rowid`,
      )
      .all(alertId) as Row[];
    for (const row of rows) {
      if (
        severityRank(alert.currentSeverity) <
        severityRank(
          String(row.minimum_severity) as AlertRecord["currentSeverity"],
        )
      )
        continue;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO deliveries
            (id, alert_id, transport_instance_id, operation, state,
             attempt_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          randomUUID(),
          alertId,
          String(row.transport_instance_id),
          Number(row.supports_resolution) ? "trigger" : "notify",
          timestamp,
          timestamp,
        );
    }
  }

  private enableLifecycleActionsForNotifiers(
    alertId: string,
    resolvingIds: string[] | undefined,
    acknowledgingIds: string[] | undefined,
  ): void {
    const lifecycleIds = new Set([
      ...(resolvingIds ?? []),
      ...(acknowledgingIds ?? []),
    ]);
    if (!lifecycleIds.size) return;
    const enableResolution = this.db.prepare(
      `UPDATE occurrence_notifiers SET supports_resolution=1
       WHERE alert_id=? AND transport_instance_id=?`,
    );
    const enableAcknowledgement = this.db.prepare(
      `UPDATE occurrence_notifiers SET supports_acknowledgement=1
       WHERE alert_id=? AND transport_instance_id=?`,
    );
    const markTrigger = this.db.prepare(
      `UPDATE deliveries SET operation='trigger'
       WHERE alert_id=? AND transport_instance_id=? AND operation='notify'`,
    );
    for (const transportId of lifecycleIds) {
      if (resolvingIds?.includes(transportId))
        enableResolution.run(alertId, transportId);
      if (acknowledgingIds?.includes(transportId))
        enableAcknowledgement.run(alertId, transportId);
      markTrigger.run(alertId, transportId);
    }
  }

  private createActionDeliveryIntents(
    alertId: string,
    operation: "acknowledge" | "resolve",
    now: Date,
  ): void {
    const timestamp = now.toISOString();
    const rows = this.db
      .prepare(
        `SELECT n.transport_instance_id, MAX(trigger_delivery.cycle) AS trigger_cycle
         FROM occurrence_notifiers n
         JOIN deliveries trigger_delivery
           ON trigger_delivery.alert_id=n.alert_id
          AND trigger_delivery.transport_instance_id=n.transport_instance_id
          AND trigger_delivery.operation='trigger'
          AND trigger_delivery.state='delivered'
         WHERE n.alert_id=?
           AND CASE WHEN ?='acknowledge'
             THEN n.supports_acknowledgement=1
             ELSE n.supports_resolution=1
           END
         GROUP BY n.transport_instance_id`,
      )
      .all(alertId, operation) as Row[];
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO deliveries
        (id, alert_id, transport_instance_id, operation, cycle, state,
         attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    );
    for (const row of rows)
      insert.run(
        randomUUID(),
        alertId,
        String(row.transport_instance_id),
        operation,
        operation === "acknowledge" ? Number(row.trigger_cycle) : 1,
        timestamp,
        timestamp,
      );
  }

  processDueActivations(now = new Date()): AlertRecord[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT id FROM alert_occurrences
           WHERE activation_state='pending' AND current_state='active'
             AND activation_due_at <= ? ORDER BY activation_due_at, id`,
        )
        .all(now.toISOString()) as Row[];
      for (const row of rows) {
        const id = String(row.id);
        this.db
          .prepare(
            "UPDATE alert_occurrences SET activation_state='eligible', activation_due_at=NULL, updated_at=? WHERE id=? AND activation_state='pending'",
          )
          .run(now.toISOString(), id);
        this.addEvent(id, "activation_eligible", now);
        this.createDeliveryIntents(id, now);
      }
      const result = rows.map((row) => this.getAlert(String(row.id)));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listActivationDeadlines(): Array<{ alertId: string; dueAt: Date }> {
    return (
      this.db
        .prepare(
          "SELECT id, activation_due_at FROM alert_occurrences WHERE activation_state='pending' ORDER BY activation_due_at, id",
        )
        .all() as Row[]
    ).map((row) => ({
      alertId: String(row.id),
      dueAt: new Date(String(row.activation_due_at)),
    }));
  }

  nextActivationDueAt(): Date | undefined {
    const row = this.db
      .prepare(
        "SELECT MIN(activation_due_at) AS due_at FROM alert_occurrences WHERE activation_state='pending'",
      )
      .get() as Row;
    return date(row.due_at);
  }

  private addEvent(
    alertId: string,
    eventType: string,
    now: Date,
    payload?: unknown,
  ): void {
    this.db
      .prepare(
        "INSERT INTO alert_events(alert_id,event_type,occurred_at,payload_json) VALUES (?,?,?,?)",
      )
      .run(
        alertId,
        eventType,
        now.toISOString(),
        payload === undefined ? null : JSON.stringify(payload),
      );
  }

  listAlertEvents(alertId?: string): AlertEventRecord[] {
    const rows = (
      alertId
        ? this.db
            .prepare(
              "SELECT * FROM alert_events WHERE alert_id=? ORDER BY occurred_at, id",
            )
            .all(alertId)
        : this.db
            .prepare("SELECT * FROM alert_events ORDER BY occurred_at, id")
            .all()
    ) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      alertId: String(row.alert_id),
      eventType: String(row.event_type),
      occurredAt: new Date(String(row.occurred_at)),
      payload: json(row.payload_json),
    }));
  }

  queryAlertHistory(query: AlertHistoryQuery = {}): AlertHistoryPage {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.definitionId) {
      clauses.push("o.definition_id=?");
      parameters.push(query.definitionId);
    }
    if (query.path) {
      clauses.push("o.path=?");
      parameters.push(query.path);
    }
    if (query.source) {
      clauses.push("o.source=?");
      parameters.push(query.source);
    }
    if (query.state) {
      clauses.push("o.current_state=?");
      parameters.push(query.state);
    }
    if (query.severity) {
      clauses.push("o.max_severity=?");
      parameters.push(query.severity);
    }
    if (query.eventType) {
      clauses.push("e.event_type=?");
      parameters.push(query.eventType);
    }
    if (query.from) {
      clauses.push("e.occurred_at >= ?");
      parameters.push(query.from.toISOString());
    }
    if (query.to) {
      clauses.push("e.occurred_at <= ?");
      parameters.push(query.to.toISOString());
    }
    if (query.cursor) {
      const cursor = this.db
        .prepare("SELECT occurred_at, id FROM alert_events WHERE id=?")
        .get(query.cursor) as Row | undefined;
      if (!cursor) throw new Error("Invalid alert history cursor");
      clauses.push("(e.occurred_at < ? OR (e.occurred_at = ? AND e.id < ?))");
      parameters.push(
        String(cursor.occurred_at),
        String(cursor.occurred_at),
        Number(cursor.id),
      );
    }
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    parameters.push(limit + 1);
    const rows = this.db
      .prepare(
        `SELECT e.*, o.definition_id, o.occurrence_number, o.source_key,
           o.path, o.source, o.current_state, o.max_severity, o.message,
           o.started_at, o.cleared_at, f.name AS definition_name
         FROM alert_events e
         JOIN alert_occurrences o ON o.id=e.alert_id
         LEFT JOIN alert_definitions f ON f.id=o.definition_id
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?`,
      )
      .all(...parameters) as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(alertHistoryRecord);
    return {
      items,
      nextCursor: hasMore ? String(items.at(-1)?.id) : undefined,
    };
  }

  listAlerts(): AlertRecord[] {
    return (
      this.db
        .prepare("SELECT id FROM alert_occurrences ORDER BY started_at, id")
        .all() as Row[]
    ).map((row) => this.getAlert(String(row.id)));
  }

  queryOccurrences(query: OccurrenceQuery = {}): OccurrencePage {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.definitionId) {
      clauses.push("definition_id=?");
      parameters.push(query.definitionId);
    }
    if (query.path) {
      clauses.push("path=?");
      parameters.push(query.path);
    }
    if (query.source) {
      clauses.push("source=?");
      parameters.push(query.source);
    }
    if (query.state) {
      clauses.push("current_state=?");
      parameters.push(query.state);
    }
    if (query.severity) {
      clauses.push("current_severity=?");
      parameters.push(query.severity);
    }
    if (query.from) {
      clauses.push("started_at >= ?");
      parameters.push(query.from.toISOString());
    }
    if (query.to) {
      clauses.push("started_at <= ?");
      parameters.push(query.to.toISOString());
    }
    if (query.cursor) {
      const cursor = this.db
        .prepare("SELECT started_at, id FROM alert_occurrences WHERE id=?")
        .get(query.cursor) as Row | undefined;
      if (!cursor) throw new Error("Invalid occurrence cursor");
      clauses.push("(started_at < ? OR (started_at = ? AND id < ?))");
      parameters.push(
        String(cursor.started_at),
        String(cursor.started_at),
        String(cursor.id),
      );
    }
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    parameters.push(limit + 1);
    const rows = this.db
      .prepare(
        `SELECT id FROM alert_occurrences
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters) as Row[];
    const hasMore = rows.length > limit;
    const items = rows
      .slice(0, limit)
      .map((row) => this.getAlert(String(row.id)));
    return { items, nextCursor: hasMore ? items.at(-1)?.id : undefined };
  }

  listOccurrences(query: OccurrenceQuery = {}): AlertRecord[] {
    return this.queryOccurrences(query).items;
  }

  getAlert(id: string): AlertRecord {
    const row = this.db
      .prepare("SELECT * FROM alert_occurrences WHERE id=?")
      .get(id) as Row | undefined;
    if (!row) throw new Error(`Unknown alert occurrence: ${id}`);
    const lifetime = this.db
      .prepare(
        "SELECT COUNT(*) AS count, MAX(started_at) AS last_fired_at FROM alert_occurrences WHERE source_key=? AND current_state IN ('active','cleared')",
      )
      .get(row.source_key) as Row;
    return {
      id: String(row.id),
      definitionId: String(row.definition_id),
      occurrenceNumber: Number(row.occurrence_number),
      sourceKey: String(row.source_key),
      path: String(row.path),
      source: row.source ? String(row.source) : undefined,
      firstSeenAt: new Date(String(row.started_at)),
      sourceTimestamp: date(row.source_timestamp),
      receivedAt: new Date(String(row.received_at)),
      lastSeenAt: new Date(String(row.last_seen_at)),
      clearedAt: date(row.cleared_at),
      lastFiredAt: date(lifetime.last_fired_at),
      fireCount: Number(lifetime.count),
      currentState: row.current_state as AlertRecord["currentState"],
      currentSeverity: row.current_severity as AlertRecord["currentSeverity"],
      maxSeverity: row.max_severity as AlertRecord["maxSeverity"],
      message: row.message ? String(row.message) : undefined,
      sourcePayload: json(row.source_payload_json),
      notificationId: row.notification_id
        ? String(row.notification_id)
        : undefined,
      acknowledgedAt: date(row.acknowledged_at),
      silencedAt: date(row.silenced_at),
      oneTime: Boolean(row.one_time),
      minimumSeverity: row.minimum_severity as AlertRecord["minimumSeverity"],
      activationDelaySeconds: Number(row.activation_delay_seconds),
      connectivity: json(row.connectivity_json) as AlertRecord["connectivity"],
      activationDueAt: date(row.activation_due_at),
      activationState: row.activation_state as AlertRecord["activationState"],
      speechTemplate: row.speech_template
        ? String(row.speech_template)
        : undefined,
    };
  }

  acknowledgeAlert(id: string, now = new Date()): void {
    this.markOccurrence(id, "acknowledged_at", "acknowledged", now);
    this.createActionDeliveryIntents(id, "acknowledge", now);
  }

  silenceAlert(id: string, now = new Date()): void {
    this.markOccurrence(id, "silenced_at", "silenced", now);
  }

  recordOccurrenceEvent(
    id: string,
    eventType: string,
    payload?: unknown,
    now = new Date(),
  ): void {
    this.getAlert(id);
    this.addEvent(id, eventType, now, payload);
  }

  private markOccurrence(
    id: string,
    column: "acknowledged_at" | "silenced_at",
    event: string,
    now: Date,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE alert_occurrences SET ${column}=COALESCE(${column}, ?), updated_at=? WHERE id=?`,
        )
        .run(now.toISOString(), now.toISOString(), id);
      if (result.changes === 0)
        throw new Error(`Unknown alert occurrence: ${id}`);
      const duplicate = this.db
        .prepare("SELECT 1 FROM alert_events WHERE alert_id=? AND event_type=?")
        .get(id, event);
      if (!duplicate) this.addEvent(id, event, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  pendingDeliveryCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM deliveries WHERE state NOT IN ('delivered', 'failed_terminal')",
      )
      .get() as Row;
    return Number(row.count);
  }

  hasActiveConnectivityAlert(): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM alert_occurrences
           WHERE current_state='active'
             AND activation_state <> 'suppressed'
             AND json_extract(connectivity_json, '$.mode') IN ('wake', 'wake_after')
           LIMIT 1`,
        )
        .get(),
    );
  }

  hasWakeRequests(): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM wake_requests LIMIT 1").get(),
    );
  }

  nextDeliveryDueAt(): Date | undefined {
    const row = this.db
      .prepare(
        `SELECT MIN(due_at) AS due_at FROM (
           SELECT COALESCE(next_attempt_at, created_at) AS due_at
           FROM deliveries
           WHERE state NOT IN ('delivered', 'failed_terminal', 'sending')
           UNION ALL
           SELECT n.next_repeat_at AS due_at
           FROM occurrence_notifiers n
           JOIN alert_occurrences o ON o.id=n.alert_id
           WHERE n.next_repeat_at IS NOT NULL AND o.current_state='active'
         )`,
      )
      .get() as Row;
    return date(row.due_at);
  }

  processDueRepeats(now = new Date()): number {
    const timestamp = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT n.alert_id, n.transport_instance_id, n.supports_resolution
           FROM occurrence_notifiers n
           JOIN alert_occurrences o ON o.id=n.alert_id
           WHERE n.next_repeat_at IS NOT NULL
             AND n.next_repeat_at <= ?
             AND o.current_state='active'
           ORDER BY n.next_repeat_at, n.rowid`,
        )
        .all(timestamp) as Row[];
      const clear = this.db.prepare(
        `UPDATE occurrence_notifiers SET next_repeat_at=NULL
         WHERE alert_id=? AND transport_instance_id=? AND next_repeat_at <= ?`,
      );
      const nextCycle = this.db.prepare(
        `SELECT COALESCE(MAX(cycle), 0) + 1 AS cycle
         FROM deliveries
         WHERE alert_id=? AND transport_instance_id=?
           AND operation IN ('notify', 'trigger')`,
      );
      const insert = this.db.prepare(
        `INSERT INTO deliveries
          (id, alert_id, transport_instance_id, operation, cycle, state,
           attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      );
      let created = 0;
      for (const row of rows) {
        const alertId = String(row.alert_id);
        const transportId = String(row.transport_instance_id);
        if (clear.run(alertId, transportId, timestamp).changes === 0) continue;
        const cycleRow = nextCycle.get(alertId, transportId) as Row;
        insert.run(
          randomUUID(),
          alertId,
          transportId,
          Number(row.supports_resolution) ? "trigger" : "notify",
          Number(cycleRow.cycle),
          timestamp,
          timestamp,
        );
        created += 1;
      }
      this.db.exec("COMMIT");
      return created;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  retryFailedDeliveries(): void {
    this.db
      .prepare(
        "UPDATE deliveries SET state='pending', next_attempt_at=NULL, updated_at=? WHERE state IN ('failed_retryable', 'failed_terminal')",
      )
      .run(new Date().toISOString());
  }

  setWakeDue(alertId: string, dueAt: Date, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO wake_requests (alert_id, wake_due_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(alert_id) DO UPDATE SET
          wake_due_at=MIN(wake_requests.wake_due_at, excluded.wake_due_at),
          updated_at=excluded.updated_at`,
      )
      .run(alertId, dueAt.toISOString(), now.toISOString());
  }

  clearWakeDue(alertId: string): void {
    this.db.prepare("DELETE FROM wake_requests WHERE alert_id=?").run(alertId);
  }

  listWakeDue(now = new Date()): Array<{ alertId: string; dueAt: Date }> {
    return this.readWakeRequests("WHERE wake_due_at <= ?", now.toISOString());
  }

  listWakeRequests(): Array<{ alertId: string; dueAt: Date }> {
    return this.readWakeRequests("");
  }

  private readWakeRequests(
    where: string,
    ...parameters: string[]
  ): Array<{ alertId: string; dueAt: Date }> {
    const rows = this.db
      .prepare(
        `SELECT alert_id, wake_due_at FROM wake_requests ${where} ORDER BY wake_due_at`,
      )
      .all(...parameters) as Row[];
    return rows.map((row) => ({
      alertId: String(row.alert_id),
      dueAt: new Date(String(row.wake_due_at)),
    }));
  }

  recoverSending(now = new Date()): void {
    const timestamp = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          "SELECT id, attempt_count FROM deliveries WHERE state='sending'",
        )
        .all() as Row[];
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE delivery_attempts SET finished_at=?, outcome='interrupted',
             error_code='INTERRUPTED', error_message='Delivery was interrupted before completion'
             WHERE delivery_id=? AND attempt_number=? AND outcome='sending'`,
          )
          .run(timestamp, String(row.id), Number(row.attempt_count));
      }
      this.db
        .prepare(
          `UPDATE deliveries SET state='failed_retryable', next_attempt_at=?,
           last_error_code='INTERRUPTED',
           last_error_message='Delivery was interrupted before completion', updated_at=?
           WHERE state='sending'`,
        )
        .run(timestamp, timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deliveryEvents(): DeliveryRecord[] {
    return this.listDeliveries();
  }

  listDeliveries(): DeliveryRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM deliveries ORDER BY rowid")
      .all() as Row[];
    return rows.map(deliveryRecord);
  }

  listRecentDeliveries(limit = 100): DeliveryRecord[] {
    return this.queryDeliveries(limit).items;
  }

  queryDeliveries(limit = 30, cursor?: string): DeliveryPage {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const total = Number(
      (this.db.prepare("SELECT COUNT(*) AS count FROM deliveries").get() as Row)
        .count ?? 0,
    );
    let cursorPriority: number | undefined;
    let cursorRowId: number | undefined;
    if (cursor) {
      const row = this.db
        .prepare(
          `SELECT rowid,
                  CASE WHEN state IN ('pending', 'waiting_connectivity', 'sending', 'failed_retryable')
                       THEN 0 ELSE 1 END AS priority
           FROM deliveries WHERE id=?`,
        )
        .get(cursor) as Row | undefined;
      if (!row) return { items: [], total };
      cursorPriority = Number(row.priority);
      cursorRowId = Number(row.rowid);
    }
    const rows = this.db
      .prepare(
        `${deliveryContextSelect}
         WHERE ? IS NULL
            OR CASE WHEN d.state IN ('pending', 'waiting_connectivity', 'sending', 'failed_retryable')
                    THEN 0 ELSE 1 END > ?
            OR (CASE WHEN d.state IN ('pending', 'waiting_connectivity', 'sending', 'failed_retryable')
                     THEN 0 ELSE 1 END = ? AND d.rowid < ?)
         ORDER BY CASE WHEN d.state IN ('pending', 'waiting_connectivity', 'sending', 'failed_retryable')
                       THEN 0 ELSE 1 END,
                  d.rowid DESC LIMIT ?`,
      )
      .all(
        cursorPriority ?? null,
        cursorPriority ?? null,
        cursorPriority ?? null,
        cursorRowId ?? null,
        boundedLimit + 1,
      ) as Row[];
    const selected = rows.slice(0, boundedLimit).map(deliveryRecord);
    return {
      items: selected,
      nextCursor: rows.length > boundedLimit ? selected.at(-1)?.id : undefined,
      total,
    };
  }

  getDelivery(id: string): DeliveryRecord | undefined {
    const row = this.db
      .prepare(`${deliveryContextSelect} WHERE d.id=?`)
      .get(id) as Row | undefined;
    return row ? deliveryRecord(row) : undefined;
  }

  listDeliveriesForAlert(alertId: string): DeliveryRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM deliveries WHERE alert_id=? ORDER BY rowid")
        .all(alertId) as Row[]
    ).map(deliveryRecord);
  }

  listDueDeliveries(now = new Date(), limit = 50): DeliveryRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM deliveries
           WHERE state NOT IN ('delivered', 'failed_terminal', 'sending')
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY COALESCE(next_attempt_at, created_at), rowid
           LIMIT ?`,
        )
        .all(now.toISOString(), Math.max(1, Math.min(200, limit))) as Row[]
    ).map(deliveryRecord);
  }

  claimDelivery(id: string, now = new Date()): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE deliveries SET state='sending', attempt_count=attempt_count+1,
           last_attempt_at=?, updated_at=? WHERE id=?
           AND state IN ('pending', 'waiting_connectivity', 'failed_retryable')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
        )
        .run(now.toISOString(), now.toISOString(), id, now.toISOString());
      if (result.changes) {
        const row = this.db
          .prepare("SELECT attempt_count FROM deliveries WHERE id=?")
          .get(id) as Row;
        this.db
          .prepare(
            "INSERT INTO delivery_attempts(delivery_id, attempt_number, started_at, outcome) VALUES (?, ?, ?, 'sending')",
          )
          .run(id, Number(row.attempt_count), now.toISOString());
      }
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordDeliverySuccess(id: string, remoteId?: string, now = new Date()): void {
    this.finishAttempt(id, "delivered", now, undefined, undefined, remoteId);
  }

  recordDeliveryFailure(
    id: string,
    code: string,
    message: string,
    retryable: boolean,
    nextAttemptAt?: Date,
    now = new Date(),
  ): void {
    this.finishAttempt(
      id,
      retryable ? "failed_retryable" : "failed_terminal",
      now,
      code,
      message.slice(0, 500),
      undefined,
      nextAttemptAt,
    );
  }

  private finishAttempt(
    id: string,
    outcome: "delivered" | "failed_retryable" | "failed_terminal",
    now: Date,
    errorCode?: string,
    errorMessage?: string,
    remoteId?: string,
    nextAttemptAt?: Date,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT d.attempt_count, d.alert_id, d.transport_instance_id,
                  d.operation, o.current_state, o.acknowledged_at,
                  n.repeat_after_seconds
           FROM deliveries d
           JOIN alert_occurrences o ON o.id=d.alert_id
           LEFT JOIN occurrence_notifiers n
             ON n.alert_id=d.alert_id
            AND n.transport_instance_id=d.transport_instance_id
           WHERE d.id=?`,
        )
        .get(id) as Row | undefined;
      // An administrator may remove the complete stored alert while a transport
      // request is in flight. Its result has nowhere to be persisted, which is
      // expected after that explicit deletion.
      if (!row) {
        this.db.exec("COMMIT");
        return;
      }
      this.db
        .prepare(
          `UPDATE deliveries SET state=?, delivered_at=?, remote_id=?, next_attempt_at=?,
           last_error_code=?, last_error_message=?, updated_at=? WHERE id=?`,
        )
        .run(
          outcome,
          outcome === "delivered" ? now.toISOString() : null,
          remoteId ?? null,
          nextAttemptAt?.toISOString() ?? null,
          errorCode ?? null,
          errorMessage ?? null,
          now.toISOString(),
          id,
        );
      this.db
        .prepare(
          `UPDATE delivery_attempts SET finished_at=?, outcome=?, error_code=?,
           error_message=?, remote_id=? WHERE delivery_id=? AND attempt_number=?`,
        )
        .run(
          now.toISOString(),
          outcome,
          errorCode ?? null,
          errorMessage ?? null,
          remoteId ?? null,
          id,
          Number(row.attempt_count),
        );
      if (outcome === "delivered" && row.operation === "trigger") {
        if (row.acknowledged_at)
          this.createActionDeliveryIntents(
            String(row.alert_id),
            "acknowledge",
            now,
          );
        if (row.current_state === "cleared")
          this.createActionDeliveryIntents(
            String(row.alert_id),
            "resolve",
            now,
          );
      }
      if (
        outcome === "delivered" &&
        (row.operation === "notify" || row.operation === "trigger") &&
        row.current_state === "active" &&
        Number(row.repeat_after_seconds ?? 0) > 0
      ) {
        const nextRepeatAt = new Date(
          now.getTime() + Number(row.repeat_after_seconds) * 1000,
        ).toISOString();
        this.db
          .prepare(
            `UPDATE occurrence_notifiers SET next_repeat_at=?
             WHERE alert_id=? AND transport_instance_id=?`,
          )
          .run(
            nextRepeatAt,
            String(row.alert_id),
            String(row.transport_instance_id),
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listDeliveryAttempts(deliveryId?: string): DeliveryAttemptRecord[] {
    const rows = (
      deliveryId
        ? this.db
            .prepare(
              "SELECT * FROM delivery_attempts WHERE delivery_id=? ORDER BY attempt_number",
            )
            .all(deliveryId)
        : this.db
            .prepare("SELECT * FROM delivery_attempts ORDER BY started_at, id")
            .all()
    ) as Row[];
    return rows.map(deliveryAttemptRecord);
  }

  queryDeliveryAttempts(
    deliveryId: string,
    limit = 50,
    cursor?: string,
  ): DeliveryAttemptPage | undefined {
    if (!this.getDelivery(deliveryId)) return undefined;
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const cursorId = cursor === undefined ? undefined : Number(cursor);
    if (
      cursor !== undefined &&
      (!Number.isInteger(cursorId) || (cursorId ?? -1) < 0)
    )
      return { items: [] };
    const rows = this.db
      .prepare(
        `SELECT * FROM delivery_attempts
         WHERE delivery_id=? AND (? IS NULL OR id > ?)
         ORDER BY id LIMIT ?`,
      )
      .all(
        deliveryId,
        cursorId ?? null,
        cursorId ?? null,
        boundedLimit + 1,
      ) as Row[];
    const selected = rows.slice(0, boundedLimit).map(deliveryAttemptRecord);
    return {
      items: selected,
      nextCursor:
        rows.length > boundedLimit ? String(selected.at(-1)?.id) : undefined,
    };
  }

  retryDelivery(
    id: string,
    now = new Date(),
  ): "scheduled" | "not_retryable" | "not_found" {
    const delivery = this.getDelivery(id);
    if (!delivery) return "not_found";
    if (!["failed_retryable", "failed_terminal"].includes(delivery.state))
      return "not_retryable";
    this.db
      .prepare(
        `UPDATE deliveries SET state='pending', next_attempt_at=NULL,
         last_error_code=NULL, last_error_message=NULL, updated_at=? WHERE id=?`,
      )
      .run(now.toISOString(), id);
    return "scheduled";
  }
}
