import { randomUUID } from "node:crypto";
import { AlertDatabase } from "../storage/db";
import { DeliveryRecord } from "../alerts/types";

export interface SnoozeState {
  active: boolean;
  startedAt: string | null;
  endsAt: string | null;
  cleanupError?: string;
}
export interface SuppressionReason {
  reason: string;
  startedAt: string;
  endsAt: string;
}
type Row = Record<string, unknown>;

export function snoozeSeconds(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 28800
  )
    throw new Error("Duration must be an integer from 0 to 28800 seconds");
  return value;
}

/** Durable operating mode and held work, separate from occurrence policy. */
export class SuppressionStore {
  constructor(private readonly database: AlertDatabase) {}
  getSnooze(): SnoozeState {
    const row = this.database.db
      .prepare("SELECT value FROM notification_controls WHERE key='snooze'")
      .get() as Row | undefined;
    return row
      ? (JSON.parse(String(row.value)) as SnoozeState)
      : { active: false, startedAt: null, endsAt: null };
  }
  setSnooze(seconds: number, source: string, now = new Date()): SnoozeState {
    snoozeSeconds(seconds);
    const previous = this.getSnooze();
    const state: SnoozeState = seconds
      ? {
          active: true,
          startedAt: previous.active ? previous.startedAt : now.toISOString(),
          endsAt: new Date(now.getTime() + seconds * 1000).toISOString(),
        }
      : { active: false, startedAt: null, endsAt: null };
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.save(state);
      if (seconds || previous.active)
        this.audit(
          seconds
            ? previous.active
              ? "snooze_replaced"
              : "snooze_started"
            : source === "expiry"
              ? "snooze_expired"
              : "snooze_ended",
          { source, previous, state, inFlightRequestsMayFinish: true },
          now,
        );
      this.database.db.exec("COMMIT");
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
    return state;
  }
  setCleanupError(message?: string): void {
    const current = this.getSnooze();
    if (current.cleanupError === message) return;
    this.save({ ...current, cleanupError: message });
    if (message) this.audit("audio_cleanup_failed", { message });
  }
  private save(state: SnoozeState): void {
    this.database.db
      .prepare(
        "INSERT INTO notification_controls(key,value) VALUES ('snooze',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(state));
  }
  audit(event: string, details: unknown, now = new Date()): void {
    this.database.db
      .prepare(
        "INSERT INTO suppression_events(event,at,details) VALUES (?,?,?)",
      )
      .run(event, now.toISOString(), JSON.stringify(details));
  }
  events(): unknown[] {
    return (
      this.database.db
        .prepare(
          "SELECT event,at,details FROM suppression_events ORDER BY id DESC LIMIT 100",
        )
        .all() as Row[]
    ).map((row) => ({
      event: row.event,
      at: row.at,
      details: JSON.parse(String(row.details)),
    }));
  }
  interruptedAudio(deliveryId: string): boolean {
    return Boolean(
      this.database.db
        .prepare(
          "SELECT 1 FROM alert_events WHERE alert_id=(SELECT alert_id FROM deliveries WHERE id=?) AND event_type='notification_paused' AND json_extract(payload_json,'$.deliveryId')=? AND json_extract(payload_json,'$.replay')=1 LIMIT 1",
        )
        .get(deliveryId, deliveryId),
    );
  }
  pending(): DeliveryRecord[] {
    return (
      this.database.db
        .prepare(
          "SELECT id FROM deliveries WHERE state IN ('pending','waiting_connectivity','failed_retryable','paused')",
        )
        .all() as Row[]
    ).map((row) => this.database.getDelivery(String(row.id))!);
  }
  hold(
    delivery: DeliveryRecord,
    reason: SuppressionReason,
    now = new Date(),
    replay = false,
  ): void {
    const db = this.database.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db
        .prepare("SELECT replay FROM delivery_holds WHERE delivery_id=?")
        .get(delivery.id);
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO delivery_holds(delivery_id,previous_state,reason,started_at,ends_at,replay) VALUES (?,?,?,?,?,?)`,
        )
        .run(
          delivery.id,
          delivery.state,
          reason.reason,
          reason.startedAt,
          reason.endsAt,
          replay ? 1 : 0,
        );
      if (!replay)
        db.prepare(
          "UPDATE deliveries SET state='paused',updated_at=? WHERE id=? AND state IN ('pending','waiting_connectivity','failed_retryable')",
        ).run(now.toISOString(), delivery.id);
      if (replay)
        db.prepare(
          "UPDATE occurrence_notifiers SET next_repeat_at=NULL WHERE alert_id=? AND transport_instance_id=?",
        ).run(delivery.alertId, delivery.transportInstanceId);
      if (inserted.changes || (replay && !previous?.replay)) {
        this.database.recordOccurrenceEvent(
          delivery.alertId,
          "notification_paused",
          {
            deliveryId: delivery.id,
            service: delivery.transportInstanceId,
            ...reason,
            replay,
          },
          now,
        );
      } else
        db.prepare(
          "UPDATE delivery_holds SET reason=?,ends_at=? WHERE delivery_id=?",
        ).run(reason.reason, reason.endsAt, delivery.id);
      if (replay)
        db.prepare(
          "UPDATE delivery_holds SET replay=1 WHERE delivery_id=?",
        ).run(delivery.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Reconcile before scheduling, including after an offline restart. */
  reconcile(
    reasonFor: (delivery: DeliveryRecord) => SuppressionReason | undefined,
    now = new Date(),
    preserveAction: (delivery: DeliveryRecord) => boolean = () => true,
  ): void {
    for (const delivery of this.pending()) {
      const reason = reasonFor(delivery);
      if (reason) this.hold(delivery, reason, now);
    }
    const rows = this.database.db
      .prepare("SELECT * FROM delivery_holds")
      .all() as Row[];
    for (const row of rows) {
      const delivery = this.database.getDelivery(String(row.delivery_id));
      if (!delivery || reasonFor(delivery)) continue;
      const alert = this.database.getAlert(delivery.alertId);
      const clearedDuringHold =
        alert.currentState === "cleared" &&
        (!alert.clearedAt ||
          alert.clearedAt.toISOString() >= String(row.started_at));
      const suppress =
        clearedDuringHold &&
        (["notify", "trigger"].includes(delivery.operation) ||
          !preserveAction(delivery));
      const refreshSnapshot =
        !Number(row.replay) &&
        alert.currentState === "active" &&
        delivery.alertSnapshot &&
        (delivery.alertSnapshot.severity !== alert.currentSeverity ||
          delivery.alertSnapshot.message !== alert.message ||
          JSON.stringify(delivery.alertSnapshot.messageSample) !==
            JSON.stringify(alert.messageSample));
      const db = this.database.db;
      const hasNewerIntent = Boolean(
        db
          .prepare(
            "SELECT 1 FROM deliveries WHERE alert_id=? AND transport_instance_id=? AND operation=? AND cycle>? AND state IN ('pending','paused','sending','failed_retryable','delivered') LIMIT 1",
          )
          .get(
            delivery.alertId,
            delivery.transportInstanceId,
            delivery.operation,
            delivery.cycle,
          ),
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        if (Number(row.replay) || refreshSnapshot || hasNewerIntent) {
          db.prepare(
            "UPDATE deliveries SET state='suppressed',updated_at=? WHERE id=? AND state <> 'delivered'",
          ).run(now.toISOString(), delivery.id);
          if (!hasNewerIntent)
            db.prepare(
              "UPDATE occurrence_notifiers SET next_repeat_at=NULL WHERE alert_id=? AND transport_instance_id=?",
            ).run(delivery.alertId, delivery.transportInstanceId);
          if (
            !suppress &&
            !hasNewerIntent &&
            alert.currentState === "active" &&
            (!Number(row.replay) ||
              (!alert.acknowledgedAt && !alert.silencedAt))
          ) {
            // Preserve the original snapshot. Changed readings and interrupted
            // audio resume under a new identity, without rewriting past work.
            db.prepare(
              `INSERT INTO deliveries(id,alert_id,transport_instance_id,operation,cycle,snapshot_state,snapshot_severity,snapshot_message,message_sample_json,snapshot_at,state,created_at,updated_at)
              SELECT ?,alert_id,transport_instance_id,operation,(SELECT MAX(cycle)+1 FROM deliveries WHERE alert_id=d.alert_id AND transport_instance_id=d.transport_instance_id AND operation=d.operation),?,?,?,?,?,'pending',?,? FROM deliveries d WHERE id=?`,
            ).run(
              randomUUID(),
              alert.currentState,
              alert.currentSeverity,
              alert.message ?? null,
              alert.messageSample ? JSON.stringify(alert.messageSample) : null,
              now.toISOString(),
              now.toISOString(),
              now.toISOString(),
              delivery.id,
            );
          }
        } else
          db.prepare(
            "UPDATE deliveries SET state=?,updated_at=? WHERE id=? AND state='paused'",
          ).run(
            suppress ? "suppressed" : row.previous_state,
            now.toISOString(),
            delivery.id,
          );
        db.prepare("DELETE FROM delivery_holds WHERE delivery_id=?").run(
          delivery.id,
        );
        this.database.recordOccurrenceEvent(
          delivery.alertId,
          suppress ? "notification_suppressed" : "notification_resumed",
          {
            deliveryId: delivery.id,
            service: delivery.transportInstanceId,
            reason: row.reason,
            startedAt: row.started_at,
            endsAt: row.ends_at,
            refreshedSnapshot: Boolean(refreshSnapshot),
          },
          now,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  }
}
