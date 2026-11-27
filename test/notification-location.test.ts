import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeNotification } from "../src/alerts/normalize";
import { DeliveryScheduler } from "../src/delivery/scheduler";
import { renderSpeechText } from "../src/transports/wyoming";
import { AlertDatabase } from "../src/storage/db";
import {
  NotificationTransport,
  renderAlert,
} from "../src/transports/transport";

const path = "notifications.bilge.highWater";
const input = (location?: unknown) =>
  normalizeNotification(path, {
    state: "alarm",
    message: "High water",
    location,
  });

describe("notification locations", () => {
  it("accepts display text and ignores missing, blank and non-string locations", () => {
    expect(input("ER Port").location).toBe("ER Port");
    for (const location of [undefined, null, "", "  ", 12, { latitude: 1 }])
      expect(input(location).location).toBeUndefined();
  });

  it("keeps location-only history and immutable delivery snapshots across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-location-"));
    const filename = join(dir, "alerts.sqlite");
    let db = new AlertDatabase(filename);
    try {
      const start = new Date("2026-11-27T00:00:00Z");
      const alert = db.ingest(input("ER Port"), ["ntfy", "discord"], start)!;
      db.ingest(
        input("Engine room starboard"),
        ["ntfy", "discord"],
        new Date(start.getTime() + 1000),
      );
      expect(db.getAlert(alert.id).location).toBe("Engine room starboard");
      expect(db.listDeliveries()).toHaveLength(2);
      expect(
        db
          .listDeliveries()
          .every((d) => d.alertSnapshot?.location === "ER Port"),
      ).toBe(true);
      expect(
        db
          .listAlertEvents(alert.id)
          .filter((e) => e.eventType === "location_changed"),
      ).toEqual([
        expect.objectContaining({
          location: "Engine room starboard",
          payload: { from: "ER Port", to: "Engine room starboard" },
        }),
      ]);
      expect(
        db
          .queryAlertHistory({ search: "ER Port" })
          .items.map((event) => event.location),
      ).toContain("ER Port");
      db.ingest(input(), ["ntfy", "discord"], new Date(start.getTime() + 2000));
      expect(db.getAlert(alert.id).location).toBeUndefined();
      db.close();
      db = new AlertDatabase(filename);
      expect(db.migrationApplied).toBe(false);
      expect(db.getAlert(alert.id).location).toBeUndefined();
      expect(
        db
          .listDeliveries()
          .every((d) => d.alertSnapshot?.location === "ER Port"),
      ).toBe(true);
      expect(
        db.listAlertEvents(alert.id).find((e) => e.eventType === "raised")
          ?.location,
      ).toBe("ER Port");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains the last location on null clear and keeps older payloads supported", () => {
    const db = new AlertDatabase();
    try {
      const alert = db.ingest(input("ER Port"), [])!;
      db.ingest(normalizeNotification(path, null), []);
      expect(db.getAlert(alert.id)).toMatchObject({
        location: "ER Port",
        currentState: "cleared",
      });
      const older = db.ingest(input(), [])!;
      expect(older.location).toBeUndefined();
      expect(
        renderSpeechText(
          {
            ...older,
            location: "ER Port",
            speechTemplate: "{message}. {location}",
          },
          "Bilge",
          "notify",
        ),
      ).toBe("High water. ER Port");
      expect(renderAlert(older).body).not.toContain("Location:");
      expect(renderAlert(older, "{message} {location}").body).toBe(
        "High water",
      );
    } finally {
      db.close();
    }
  });

  it("sends the queued location in default messages and templates, including retries", async () => {
    const db = new AlertDatabase();
    try {
      const now = new Date();
      db.ingest(input("ER Port"), ["ntfy", "discord"], now);
      db.ingest(input("ER Starboard"), ["ntfy", "discord"], now);
      const send = vi.fn<NotificationTransport["send"]>().mockResolvedValue({
        kind: "retryable",
        code: "OFFLINE",
        message: "offline",
      });
      const transport = { type: "test", requiresInternet: true, send };
      const scheduler = new DeliveryScheduler(
        db,
        new Map([
          ["ntfy", transport],
          ["discord", transport],
        ]),
        undefined,
        { messageTemplates: new Map([["ntfy", "{message} — {location}"]]) },
      );
      await scheduler.runOnce(now);
      expect(
        send.mock.calls.map(([, d, c]) => [
          d.transportInstanceId,
          c.rendered.body,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["ntfy", "High water — ER Port"],
          ["discord", expect.stringContaining("Location: ER Port")],
        ]),
      );
      db.retryFailedDeliveries();
      await scheduler.runOnce(new Date(now.getTime() + 1000));
      expect(send).toHaveBeenCalledTimes(4);
      expect(
        send.mock.calls.every(([alert]) => alert.location === "ER Port"),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("upgrades schema 5 without inventing historical delivery locations", () => {
    const dir = mkdtempSync(join(tmpdir(), "location-migration-"));
    const filename = join(dir, "alerts.sqlite");
    let db = new AlertDatabase(filename);
    try {
      const alert = db.ingest(input("ER Port"), ["ntfy"])!;
      for (const table of ["alert_occurrences", "alert_events", "deliveries"])
        db.db.exec(`ALTER TABLE ${table} DROP COLUMN location`);
      db.db.exec("PRAGMA user_version=5");
      db.close();
      db = new AlertDatabase(filename);
      expect(db.schemaVersion()).toBe(6);
      expect(db.getAlert(alert.id).location).toBe("ER Port");
      expect(db.listAlertEvents(alert.id)[0].location).toBe("ER Port");
      expect(db.listDeliveries()[0].alertSnapshot?.location).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
