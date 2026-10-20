import { describe, expect, it, vi } from "vitest";
import { InternetAvailabilityMonitor } from "../src/connectivity/availability";
import {
  extractInternetState,
  internetStateAvailability,
  internetStateSnapshot,
} from "../src/signalk/internet-state";

describe("Internet availability monitoring", () => {
  it("maps the shared Signal K states to delivery availability", () => {
    expect(internetStateAvailability("online")).toBe(true);
    expect(internetStateAvailability("metered")).toBe(true);
    expect(internetStateAvailability("offline")).toBe(false);
    expect(internetStateAvailability("captive")).toBe(false);
    expect(internetStateAvailability(null)).toBeUndefined();
  });

  it("tracks exact provider state without performing its own probe", async () => {
    const changes: string[] = [];
    const monitor = new InternetAvailabilityMonitor(({ state }) =>
      changes.push(state),
    );
    monitor.observe({
      value: "metered",
      source: "@meri-imperiumi/signalk-internet.internet",
      updatedAt: new Date("2026-10-19T08:00:00Z"),
    });

    expect(monitor.status()).toEqual({
      state: "metered",
      available: true,
      source: "@meri-imperiumi/signalk-internet.internet",
      lastUpdatedAt: new Date("2026-10-19T08:00:00Z"),
    });
    await expect(monitor.checkNow()).resolves.toBe(true);
    expect(changes).toEqual(["metered"]);
  });

  it("extracts state, source, and timestamp from Signal K deltas", () => {
    expect(
      extractInternetState({
        updates: [
          {
            $source: "signalk-internet.internet",
            timestamp: "2026-10-19T08:00:00Z",
            values: [
              { path: "network.internet.ping", value: 42 },
              { path: "network.internet.state", value: "captive" },
            ],
          },
        ],
      }),
    ).toEqual({
      value: "captive",
      source: "signalk-internet.internet",
      updatedAt: new Date("2026-10-19T08:00:00Z"),
    });
  });

  it("treats missing and invalid provider values as unknown", () => {
    expect(internetStateSnapshot(undefined)).toBeUndefined();
    expect(
      internetStateSnapshot({ value: "broken", $source: "fixture" }),
    ).toEqual({ value: null, source: "fixture" });

    const changed = vi.fn();
    const monitor = new InternetAvailabilityMonitor(changed);
    monitor.observe({ value: null, source: "fixture" });
    expect(monitor.status()).toEqual({ state: "unknown", source: "fixture" });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
