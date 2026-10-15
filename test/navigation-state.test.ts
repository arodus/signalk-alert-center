import { describe, expect, it, vi } from "vitest";
import { ServerAPI } from "@signalk/server-api";
import { PluginConfig } from "../src/config";
import { AlertCenterRuntime } from "../src/runtime";
import {
  extractNavigationState,
  isAnchoredOrMoored,
  NavigationStateObservation,
  navigationStateSnapshot,
} from "../src/signalk/navigation-state";
import { AlertDatabase } from "../src/storage/db";
import { SuppressionStore } from "../src/suppression/store";

describe("navigation state", () => {
  it("extracts the standard path and treats clears or invalid values as unavailable", () => {
    expect(
      extractNavigationState({
        updates: [
          {
            $source: "autostate.0",
            timestamp: "2026-10-15T09:00:00Z",
            values: [{ path: "navigation.state", value: "anchored" }],
          },
        ],
      }),
    ).toEqual({
      value: "anchored",
      source: "autostate.0",
      updatedAt: "2026-10-15T09:00:00.000Z",
    });
    expect(
      extractNavigationState({ path: "navigation.state", value: null }),
    ).toEqual({ value: null });
    expect(
      extractNavigationState({ path: "navigation.speedOverGround", value: 0 }),
    ).toBeUndefined();
    expect(navigationStateSnapshot({ value: "moored" })).toEqual({
      value: "moored",
    });
    expect(isAnchoredOrMoored({ value: "sailing" })).toBe(false);
    expect(isAnchoredOrMoored({ value: "moored" })).toBe(true);
  });

  it("bypasses snooze unless the opt-in guard sees anchored or moored", async () => {
    const database = new AlertDatabase();
    const suppression = new SuppressionStore(database);
    const runtime = new AlertCenterRuntime({
      debug: vi.fn(),
      error: vi.fn(),
      handleMessage: vi.fn(),
      setPluginStatus: vi.fn(),
    } as unknown as ServerAPI);
    const internal = runtime as unknown as {
      config: PluginConfig;
      database: AlertDatabase;
      suppression: SuppressionStore;
      navigationState?: NavigationStateObservation;
      reconcileSuppression: () => void;
      suppressionReason: () => unknown;
      status: () => { snooze?: Record<string, unknown> };
    };
    internal.config = { snooze: { onlyWhenAnchoredOrMoored: true } };
    internal.database = database;
    internal.suppression = suppression;
    suppression.setSnooze(900, "test", new Date("2026-10-15T09:00:00Z"));

    internal.navigationState = { value: "sailing" };
    internal.reconcileSuppression();
    expect(internal.suppressionReason()).toBeUndefined();
    expect(internal.status().snooze).toMatchObject({
      active: true,
      effective: false,
      bypassed: true,
      bypassReason: "navigation_state_not_anchored_or_moored",
      navigationState: { value: "sailing" },
    });

    internal.navigationState = { value: "anchored" };
    internal.reconcileSuppression();
    expect(internal.suppressionReason()).toMatchObject({ reason: "snooze" });
    expect(internal.status().snooze).toMatchObject({
      effective: true,
      bypassed: false,
    });

    internal.navigationState = undefined;
    internal.reconcileSuppression();
    expect(internal.suppressionReason()).toBeUndefined();
    expect(internal.status().snooze).toMatchObject({
      effective: false,
      bypassed: true,
      bypassReason: "navigation_state_unavailable",
      navigationState: { value: null },
    });
    expect(
      suppression
        .events()
        .filter(
          (event) =>
            (event as { event: string }).event ===
            "snooze_effectiveness_changed",
        ),
    ).toHaveLength(3);
    await runtime.stop();
  });

  it("keeps existing snooze behavior when the guard is disabled", () => {
    const database = new AlertDatabase();
    const suppression = new SuppressionStore(database);
    const runtime = new AlertCenterRuntime({} as ServerAPI);
    const internal = runtime as unknown as {
      config: PluginConfig;
      suppression: SuppressionStore;
      navigationState?: NavigationStateObservation;
      suppressionReason: () => unknown;
    };
    internal.config = {};
    internal.suppression = suppression;
    internal.navigationState = { value: "sailing" };
    suppression.setSnooze(900, "test", new Date("2026-10-15T09:00:00Z"));
    expect(internal.suppressionReason()).toMatchObject({ reason: "snooze" });
    database.close();
  });
});
