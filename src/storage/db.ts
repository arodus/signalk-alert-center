import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AlertRecord, DeliveryRecord, NormalizedAlert, severityRank } from "../alerts/types";
import { schema } from "./schema";

type AlertRow = Record<string, unknown>;
const date = (value: unknown): Date | undefined => value ? new Date(String(value)) : undefined;

export class AlertDatabase {
  readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec(schema);
  }

  close(): void { this.db.close(); }

  ingest(alert: NormalizedAlert, transportIds: string[], now = new Date()): AlertRecord {
    const timestamp = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM alerts WHERE source_key = ?").get(alert.sourceKey) as AlertRow | undefined;
      const id = existing ? String(existing.id) : randomUUID();
      const maxSeverity = existing && severityRank(String(existing.max_severity) as AlertRecord["maxSeverity"]) > severityRank(alert.severity)
        ? String(existing.max_severity) : alert.severity;
      const firstSeenAt = existing ? String(existing.first_seen_at) : timestamp;
      const clearedAt = alert.state === "cleared" ? timestamp : null;
      if (existing) {
        this.db.prepare(`UPDATE alerts SET last_seen_at=?, cleared_at=COALESCE(?, cleared_at), current_state=?, current_severity=?, max_severity=?, message=?, source_payload_json=?, updated_at=? WHERE id=?`)
          .run(timestamp, clearedAt, alert.state, alert.severity, maxSeverity, alert.message ?? null, JSON.stringify(alert.sourcePayload), timestamp, id);
      } else {
        this.db.prepare(`INSERT INTO alerts (id,source_key,path,first_seen_at,last_seen_at,cleared_at,current_state,current_severity,max_severity,message,source_payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, alert.sourceKey, alert.path, firstSeenAt, timestamp, clearedAt, alert.state, alert.severity, maxSeverity, alert.message ?? null, JSON.stringify(alert.sourcePayload), timestamp, timestamp);
        this.db.prepare("INSERT INTO alert_events (alert_id,event_type,occurred_at,payload_json) VALUES (?,?,?,?)")
          .run(id, alert.state === "cleared" ? "cleared" : "raised", timestamp, JSON.stringify(alert.sourcePayload));
      }
      for (const transportId of transportIds) {
        this.db.prepare(`INSERT OR IGNORE INTO deliveries (id,alert_id,transport_instance_id,state,attempt_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
          .run(randomUUID(), id, transportId, "pending", 0, timestamp, timestamp);
      }
      const result = this.getAlert(id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getAlert(id: string): AlertRecord {
    const row = this.db.prepare("SELECT * FROM alerts WHERE id=?").get(id) as AlertRow;
    return {
      id: String(row.id), sourceKey: String(row.source_key), path: String(row.path),
      firstSeenAt: new Date(String(row.first_seen_at)), lastSeenAt: new Date(String(row.last_seen_at)),
      clearedAt: date(row.cleared_at), currentState: row.current_state as AlertRecord["currentState"],
      currentSeverity: row.current_severity as AlertRecord["currentSeverity"], maxSeverity: row.max_severity as AlertRecord["maxSeverity"],
      message: row.message ? String(row.message) : undefined, sourcePayload: row.source_payload_json ? JSON.parse(String(row.source_payload_json)) : undefined
    };
  }

  listDeliveries(): DeliveryRecord[] {
    const rows = this.db.prepare("SELECT * FROM deliveries ORDER BY created_at").all() as AlertRow[];
    return rows.map((row) => ({ id: String(row.id), alertId: String(row.alert_id), transportInstanceId: String(row.transport_instance_id), state: row.state as DeliveryRecord["state"], attemptCount: Number(row.attempt_count), nextAttemptAt: date(row.next_attempt_at), lastAttemptAt: date(row.last_attempt_at), deliveredAt: date(row.delivered_at), lastErrorCode: row.last_error_code ? String(row.last_error_code) : undefined, lastErrorMessage: row.last_error_message ? String(row.last_error_message) : undefined, remoteId: row.remote_id ? String(row.remote_id) : undefined }));
  }

  claimDelivery(id: string, now = new Date()): void {
    this.db.prepare("UPDATE deliveries SET state='sending', attempt_count=attempt_count+1, last_attempt_at=?, updated_at=? WHERE id=? AND state <> 'delivered'").run(now.toISOString(), now.toISOString(), id);
  }

  recordDeliverySuccess(id: string, remoteId?: string, now = new Date()): void {
    this.db.prepare("UPDATE deliveries SET state='delivered', delivered_at=?, remote_id=?, next_attempt_at=NULL, updated_at=? WHERE id=?").run(now.toISOString(), remoteId ?? null, now.toISOString(), id);
  }

  recordDeliveryFailure(id: string, code: string, message: string, retryable: boolean, nextAttemptAt?: Date, now = new Date()): void {
    this.db.prepare("UPDATE deliveries SET state=?, last_error_code=?, last_error_message=?, next_attempt_at=?, updated_at=? WHERE id=?").run(retryable ? "failed_retryable" : "failed_terminal", code, message.slice(0, 500), nextAttemptAt?.toISOString() ?? null, now.toISOString(), id);
  }
}