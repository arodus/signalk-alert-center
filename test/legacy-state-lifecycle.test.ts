import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeNotification } from "../src/alerts/normalize";
import { AlertDatabase } from "../src/storage/db";

const path = "notifications.electrical.battery";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 12, minute));
const input = (state: string, extra: object = {}) =>
  normalizeNotification(path, {
    state,
    message: "Battery voltage",
    method: ["visual", "sound"],
    ...extra,
  });

describe("legacy notification attention lifecycle", () => {
  it.each([
    ["warn", "alarm"],
    ["alarm", "warn"],
  ])(
    "resets local actions on %s -> %s and preserves history across restart",
    (from, to) => {
      const directory = mkdtempSync(join(tmpdir(), "legacy-state-"));
      const filename = join(directory, "alerts.sqlite");
      let db = new AlertDatabase(filename);
      try {
        const original = db.ingest(input(from), ["ntfy"], at(0))!;
        db.acknowledgeAlert(original.id, at(1));
        db.silenceAlert(original.id, at(1));
        const initialDelivery = db.listDeliveries()[0];
        db.close();
        db = new AlertDatabase(filename);
        const updated = db.ingest(input(to), ["ntfy"], at(2))!;
        expect(updated.id).toBe(original.id);
        expect(updated.acknowledgedAt).toBeUndefined();
        expect(updated.silencedAt).toBeUndefined();
        expect(db.listDeliveries()).toHaveLength(2);
        expect(
          db.listDeliveries().find((row) => row.id === initialDelivery.id),
        ).toEqual(initialDelivery);
        expect(
          db.listAlertEvents(original.id).map((event) => event.eventType),
        ).toEqual([
          "raised",
          "acknowledged",
          "silenced",
          "attention_reset",
          "severity_changed",
        ]);
        db.close();
        db = new AlertDatabase(filename);
        expect(db.getAlert(original.id).acknowledgedAt).toBeUndefined();
        expect(db.getAlert(original.id).silencedAt).toBeUndefined();
      } finally {
        db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps local actions for message/location-only updates and retains producer methods", () => {
    const db = new AlertDatabase();
    try {
      const raised = db.ingest(input("alarm"), ["ntfy"], at(0))!;
      db.acknowledgeAlert(raised.id, at(1));
      db.silenceAlert(raised.id, at(1));
      for (const extra of [
        { message: "New message" },
        { location: "Engine room" },
        { method: [] },
      ]) {
        const result = db.ingest(input("alarm", extra), ["ntfy"], at(2))!;
        expect(result.acknowledgedAt).toEqual(at(1));
        expect(result.silencedAt).toEqual(at(1));
      }
      expect(db.listDeliveries()).toHaveLength(1);
      const changed = db.ingest(
        input("warn", { method: [] }),
        ["ntfy"],
        at(3),
      )!;
      expect(changed.sourcePayload).toMatchObject({ method: [] });
      expect(changed.acknowledgedAt).toBeUndefined();
      expect(
        db
          .listAlertEvents(raised.id)
          .filter((row) => row.eventType === "attention_reset"),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("does not apply an old queued acknowledgement to the new state", () => {
    const db = new AlertDatabase();
    try {
      const options = { resolvingNotifierIds: ["pagerduty"] };
      const raised = db.ingest(
        input("warn"),
        ["pagerduty", "ntfy"],
        at(0),
        options,
      )!;
      const trigger = db
        .listDeliveries()
        .find((row) => row.transportInstanceId === "pagerduty")!;
      db.claimDelivery(trigger.id, at(0));
      db.recordDeliverySuccess(trigger.id, "stable-incident", at(0));
      db.acknowledgeAlert(raised.id, at(1));
      const acknowledgement = db
        .listDeliveries()
        .find((row) => row.operation === "acknowledge")!;
      expect(acknowledgement.state).toBe("pending");
      db.ingest(input("alarm"), ["pagerduty", "ntfy"], at(2), options);
      expect(db.getDelivery(acknowledgement.id).state).toBe("suppressed");
      const nextTrigger = db
        .listDeliveries()
        .find((row) => row.operation === "trigger" && row.id !== trigger.id)!;
      db.claimDelivery(nextTrigger.id, at(3));
      db.recordDeliverySuccess(nextTrigger.id, "stable-incident", at(3));
      expect(
        db.listDeliveries().filter((row) => row.operation === "acknowledge"),
      ).toHaveLength(1);
      expect(db.getDelivery(trigger.id).state).toBe("delivered");
      expect(
        db.listDeliveries().filter((row) => row.transportInstanceId === "ntfy"),
      ).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("retains acknowledgement and silence in a cleared occurrence's history", () => {
    const db = new AlertDatabase();
    try {
      const raised = db.ingest(input("alarm"), [], at(0))!;
      db.acknowledgeAlert(raised.id, at(1));
      db.silenceAlert(raised.id, at(1));
      db.ingest(normalizeNotification(path, null), [], at(2));
      expect(db.getAlert(raised.id)).toMatchObject({
        currentState: "cleared",
        acknowledgedAt: at(1),
        silencedAt: at(1),
      });
    } finally {
      db.close();
    }
  });
});
