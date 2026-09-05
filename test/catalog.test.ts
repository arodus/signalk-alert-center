import { describe, expect, it } from "vitest";
import { buildAlertCatalog } from "../src/alerts/catalog";
import { AlertRecord } from "../src/alerts/types";

const recognizedAlert: AlertRecord = {
  id: "recognized-1",
  sourceKey: "notifications.engine.temperature",
  path: "notifications.engine.temperature",
  firstSeenAt: new Date("2026-09-05T10:00:00.000Z"),
  lastSeenAt: new Date("2026-09-05T10:05:00.000Z"),
  lastFiredAt: new Date("2026-09-05T10:00:00.000Z"),
  fireCount: 1,
  currentState: "cleared",
  currentSeverity: "normal",
  maxSeverity: "alarm",
  message: "Engine temperature",
};

describe("buildAlertCatalog", () => {
  it("includes never-fired configured rules and unmatched recognized alerts", () => {
    const catalog = buildAlertCatalog(
      [recognizedAlert],
      [
        {
          id: "bilge",
          name: "Bilge high water",
          zone: "Bilge",
          match: "notifications.bilge.highWater",
          minSeverity: "alarm",
          connectivity: { mode: "queue" },
          notifiers: [],
        },
      ],
    );

    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({
      configured: true,
      name: "Bilge high water",
      zone: "Bilge",
      fireCount: 0,
    });
    expect(catalog[1]).toMatchObject({
      configured: false,
      name: "notifications.engine.temperature",
      lastFiredAt: recognizedAlert.lastFiredAt,
      fireCount: 1,
    });
  });

  it("marks a configured one-time occurrence as removable", () => {
    const catalog = buildAlertCatalog(
      [recognizedAlert],
      [
        {
          id: "engine",
          oneTime: true,
          match: "notifications.engine.*",
          minSeverity: "alarm",
          connectivity: { mode: "queue" },
          notifiers: [],
        },
      ],
    );

    expect(catalog[0]).toMatchObject({
      configured: true,
      oneTime: true,
      alertId: recognizedAlert.id,
    });
  });
});
