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
          message: "Fridge 283.15 K",
          sourcePayload: { method: ["sound"], message: "Fridge 283.15 K" },
        },
        [...transports.keys()],
        now,
        { soundEnabled: false, speechEnabled: true },
      )!;
      const scheduler = new DeliveryScheduler(database, transports, undefined, {
        unitMetadata: () => ({ units: "K" }),
      });
      await scheduler.runOnce(now);
      expect(bodies).toHaveLength(4);
      for (const body of bodies) {
        expect(body).toContain("Fridge 10 °C");
        expect(body).not.toContain("283.15");
      }
      expect(JSON.stringify(announce.mock.calls)).toContain("Fridge 10 °C");
      expect(database.getAlert(alert.id).message).toBe("Fridge 283.15 K");
      expect(
        database.listDeliveries().every((item) => item.state === "delivered"),
      ).toBe(true);
      expect(database.listDeliveries()[0].alertSnapshot?.message).toBe(
        "Fridge 283.15 K",
      );
    } finally {
      database.close();
      vi.unstubAllGlobals();
    }
  });
});
