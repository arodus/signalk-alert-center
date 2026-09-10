import { describe, expect, it } from "vitest";
import {
  extractNotificationEntries,
  snapshotNotificationEntries,
} from "../src/signalk/notifications";

describe("Signal K notification input", () => {
  it("preserves update source and timestamp", () => {
    const [entry] = extractNotificationEntries({
      updates: [
        {
          $source: "sensor.gps-1",
          timestamp: "2026-09-07T00:00:00.000Z",
          values: [
            {
              path: "notifications.navigation.gnss",
              value: { state: "alarm", message: "Position lost" },
            },
          ],
        },
      ],
    });

    expect(entry).toMatchObject({
      path: "notifications.navigation.gnss",
      source: "sensor.gps-1",
      value: { state: "alarm", message: "Position lost" },
    });
    expect(entry.sourceTimestamp?.toISOString()).toBe(
      "2026-09-07T00:00:00.000Z",
    );
  });

  it("ignores non-notification values", () => {
    expect(
      extractNotificationEntries({
        updates: [
          { values: [{ path: "navigation.speedOverGround", value: 1 }] },
        ],
      }),
    ).toEqual([]);
  });

  it("flattens the current notification subtree for startup reconciliation", () => {
    const entries = snapshotNotificationEntries({
      navigation: {
        gnss: {
          value: { state: "warn", message: "Poor fix" },
          $source: "sensor.gps-2",
          timestamp: "2026-09-07T00:01:00.000Z",
        },
      },
      bilge: {
        highWater: {
          value: null,
          $source: "sensor.bilge",
        },
      },
    });

    expect(entries.map((entry) => entry.path)).toEqual([
      "notifications.navigation.gnss",
      "notifications.bilge.highWater",
    ]);
    expect(entries[0].source).toBe("sensor.gps-2");
    expect(entries[1].value).toBeNull();
  });

  it("does not revisit cyclic or shared model branches", () => {
    const alarm = { value: { state: "alarm", message: "Flooding" } };
    const root: Record<string, unknown> = { bilge: alarm, duplicate: alarm };
    root.circular = root;

    expect(snapshotNotificationEntries(root)).toEqual([
      expect.objectContaining({ path: "notifications.bilge" }),
    ]);
  });
});
