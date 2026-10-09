import { describe, expect, it, vi } from "vitest";
import { convertAlertMessage } from "../src/alerts/message-units";
import { AlertDatabase } from "../src/storage/db";
import { DeliveryScheduler } from "../src/delivery/scheduler";
import { NtfyTransport } from "../src/transports/ntfy";
import { DiscordTransport } from "../src/transports/discord";
import { TelegramTransport } from "../src/transports/telegram";
import { PagerDutyTransport } from "../src/transports/pagerduty";
import { WyomingTransport } from "../src/transports/wyoming";
import { NotificationTransport } from "../src/transports/transport";

describe("outgoing message units", () => {
  it("converts generated bounds and explicit SI values while preserving custom prose", () => {
    expect(convertAlertMessage("283.15 < value < 373.15", { units: "K" })).toBe(
      "10 °C ≤ value < 100 °C",
    );
    expect(
      convertAlertMessage("undefined < value < 275.15", { units: "K" }),
    ).toBe("value < 2 °C");
    expect(
      convertAlertMessage("Fridge 283.15 K, sensor 12, time 10:30", {
        units: "K",
      }),
    ).toBe("Fridge 10 °C, sensor 12, time 10:30");
    expect(
      convertAlertMessage("Fridge 10 °C, sensor 283.15", { units: "K" }),
    ).toBe("Fridge 10 °C, sensor 283.15");
    expect(
      convertAlertMessage("Depth 10 m", {
        units: "m",
        displayUnits: { formula: "value * 3.28084", symbol: "ft" },
      }),
    ).toBe("Depth 32.808 ft");
    expect(
      convertAlertMessage("Temperature 283.15 K", {
        units: "K",
        displayUnits: { formula: "invalid()", symbol: "°F" },
      }),
    ).toBe("Temperature 283.15 K");
  });

  it("converts bounds and a finite captured reading together, including zero and missing metadata", () => {
    expect(
      convertAlertMessage("273.15 < value < 283.15", { units: "K" }, 278.15),
    ).toBe("0 °C ≤ 5 °C < 10 °C");
    expect(
      convertAlertMessage(
        "undefined < value < 10",
        {
          units: "m",
          displayUnits: { formula: "value * 3.28084", symbol: "ft" },
        },
        0,
      ),
    ).toBe("0 ft < 32.808 ft");
    expect(convertAlertMessage("-1e1 < value < undefined", {}, -2)).toBe(
      "-10 ≤ -2",
    );
    expect(
      convertAlertMessage("undefined < value < 10", { units: "m" }, NaN),
    ).toBe("value < 10 m");
    expect(
      convertAlertMessage("Sensor value is unavailable", { units: "K" }, 280),
    ).toBe("Sensor value is unavailable");
    expect(
      convertAlertMessage(
        "0 < value < 10",
        { units: "m", displayUnits: { formula: "bad()", symbol: "ft" } },
        3,
      ),
    ).toBe("0 m ≤ 3 m < 10 m");
  });

  it("converts queued snapshots for every actual transport without altering history", async () => {
    const database = new AlertDatabase();
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        bodies.push(String(options.body));
        return new Response('{"ok":true}', { status: 200 });
      }),
    );
    const announce = vi.fn(async () => ({
      id: "announcement",
      state: "played",
      targets: {},
    }));
    const transports = new Map<string, NotificationTransport>([
      [
        "ntfy",
        new NtfyTransport({ server: "https://example.invalid", topic: "test" }),
      ],
      ["discord", new DiscordTransport("https://example.invalid")],
      ["telegram", new TelegramTransport({ botToken: "test", chatId: "test" })],
      ["pagerduty", new PagerDutyTransport("test")],
      [
        "wyoming",
        new WyomingTransport({ api: () => ({ version: 1, announce }) }),
      ],
    ]);
    const now = new Date("2026-01-01T00:00:00Z");
    try {
      const alert = database.ingest(
        {
          sourceKey: "notifications.environment.refrigerator.temperature",
          path: "notifications.environment.refrigerator.temperature",
          state: "active",
          severity: "alarm",
          message: "273.15 < value < 373.15",
          messageSample: {
            message: "273.15 < value < 373.15",
            value: 283.15,
            units: "K",
            capturedAt: now.toISOString(),
          },
          sourcePayload: {
            method: ["sound"],
            message: "273.15 < value < 373.15",
          },
        },
        [...transports.keys()],
        now,
        { soundEnabled: false, speechEnabled: true },
      )!;
      database.ingest(
        {
          sourceKey: alert.sourceKey,
          path: alert.path,
          state: "active",
          severity: "alarm",
          message: alert.message,
          messageSample: { ...alert.messageSample!, value: 293.15 },
          sourcePayload: alert.sourcePayload,
        },
        [...transports.keys()],
        new Date(now.getTime() + 1000),
      );
      const scheduler = new DeliveryScheduler(database, transports, undefined, {
        unitMetadata: () => ({ units: "K" }),
      });
      await scheduler.runOnce(now);
      expect(bodies).toHaveLength(4);
      for (const body of bodies) {
        expect(body).toContain("0 °C ≤ 10 °C < 100 °C");
        expect(body).not.toContain("283.15");
      }
      expect(JSON.stringify(announce.mock.calls)).toContain(
        "0 °C ≤ 10 °C < 100 °C",
      );
      expect(database.getAlert(alert.id).message).toBe(
        "273.15 < value < 373.15",
      );
      expect(
        database.listDeliveries().every((item) => item.state === "delivered"),
      ).toBe(true);
      expect(database.listDeliveries()[0].alertSnapshot?.message).toBe(
        "273.15 < value < 373.15",
      );
    } finally {
      database.close();
      vi.unstubAllGlobals();
    }
  });
});
