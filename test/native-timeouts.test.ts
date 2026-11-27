import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerAPI } from "@signalk/server-api";
import { describe, expect, it, vi } from "vitest";
import { AlertCenterRuntime } from "../src/runtime";
import { AlertDatabase } from "../src/storage/db";
import {
  isNativeTimeoutRule,
  NativeTimeoutRule,
  nativeTimeoutEntry,
  nativeTimeoutStatus,
} from "../src/signalk/native-timeouts";

const rule: NativeTimeoutRule = {
  slug: "depth",
  name: "Depth unavailable",
  path: "environment.depth.belowKeel",
  severity: "alarm",
};
const fresh = {
  value: 4.2,
  timestamp: "2026-11-27T00:00:00Z",
  $source: "primary",
};
const stale = {
  value: null,
  timestamp: "2026-11-27T00:01:00Z",
  $source: "primary",
  state: {
    timedOut: true,
    lastValue: { timestamp: fresh.timestamp, value: fresh.value },
  },
};

describe("native timeout contract", () => {
  it("reads state beside value and preserves the last valid timestamp separately", () => {
    expect(nativeTimeoutEntry(rule, stale)).toMatchObject({
      sourceTimestamp: new Date(stale.timestamp),
      value: {
        state: "alarm",
        data: {
          lastValidTimestamp: fresh.timestamp,
          lastValue: 4.2,
          source: "primary",
        },
      },
    });
    expect(nativeTimeoutEntry(rule, fresh)).toMatchObject({
      value: { state: "normal" },
    });
  });
  it("does not mistake missing data, unmarked null, or invalid timestamp for recovery", () => {
    for (const node of [
      undefined,
      {},
      { value: null },
      { ...fresh, value: Number.NaN },
      { ...fresh, value: Number.POSITIVE_INFINITY },
      { ...fresh, timestamp: "bad" },
      { ...fresh, state: { timedOut: true } },
    ])
      expect(nativeTimeoutEntry(rule, node)).toBeUndefined();
  });
  it("uses the selected leaf instead of a timed out losing source", () => {
    expect(
      nativeTimeoutEntry(rule, {
        ...fresh,
        $source: "backup",
        values: { primary: stale },
      }),
    ).toMatchObject({
      value: { state: "normal", data: { source: "backup" } },
    });
  });
  it("accepts non-numeric sensor recovery and rejects unsafe or wildcard rules", () => {
    for (const value of [false, 0, "GNSS Fix", { latitude: 1, longitude: 2 }])
      expect(
        nativeTimeoutEntry(rule, { ...fresh, value })?.value,
      ).toMatchObject({ state: "normal" });
    expect(isNativeTimeoutRule(rule)).toBe(true);
    for (const path of [
      "environment.*",
      "notifications.foo",
      "alerts.foo",
      "environment.__proto__.foo",
    ])
      expect(isNativeTimeoutRule({ ...rule, path })).toBe(false);
    expect(isNativeTimeoutRule({ ...rule, severity: "normal" })).toBe(false);
  });
  it("reports the opt-in prerequisite without pretending older servers support it", () => {
    expect(nativeTimeoutStatus({})).toMatchObject({ enabled: false });
    expect(nativeTimeoutStatus({ config: { settings: {} } })).toMatchObject({
      enabled: false,
    });
    expect(
      nativeTimeoutStatus({
        config: { settings: { enforceDataTimeouts: true } },
      }),
    ).toMatchObject({ enabled: true });
  });
});

describe("durable native timeout rules", () => {
  it("survives restart and unknown data, follows preferred-source failover, and clears on recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "native-timeout-test-"));
    let leaf: unknown = stale;
    let onSensor: ((delta: unknown) => void) | undefined;
    const emit = (node: unknown = leaf, path = rule.path) => {
      const value = node as Record<string, unknown>;
      onSensor?.({
        updates: [
          {
            timestamp: value.timestamp,
            $source: value.$source,
            values: [{ path, value: value.value, state: value.state }],
          },
        ],
      });
    };
    const subscriptions: unknown[] = [];
    const app = {
      config: { settings: { enforceDataTimeouts: true } },
      selfContext: "vessels.self",
      getDataDirPath: () => directory,
      debug: vi.fn(),
      error: vi.fn(),
      setPluginStatus: vi.fn(),
      handleMessage: vi.fn(),
      getPath: () => ({}),
      getSelfPath: (path: string) =>
        path === rule.path
          ? leaf
          : path === "environment.other.sensor"
            ? fresh
            : undefined,
      subscriptionmanager: {
        subscribe: (
          subscription: { subscribe: Array<{ path: string }> },
          stops: Array<() => void>,
          _error: unknown,
          callback: (delta: unknown) => void,
        ) => {
          if (subscription.subscribe.some((item) => item.path === rule.path)) {
            subscriptions.push(subscription);
            onSensor = callback;
            stops.push(() => {
              onSensor = undefined;
            });
          }
        },
      },
    } as unknown as ServerAPI;
    const options = { ingestion: { startupGraceSeconds: 1 } };
    let runtime = new AlertCenterRuntime(app);
    const internal = () =>
      runtime as unknown as {
        createNativeTimeoutRule(rule: NativeTimeoutRule): unknown;
        database: AlertDatabase;
      };
    try {
      runtime.start(options);
      await vi.waitFor(() =>
        expect(runtime.status().reconciliation.state).toBe("complete"),
      );
      internal().createNativeTimeoutRule(rule);
      expect(subscriptions).toContainEqual(
        expect.objectContaining({ sourcePolicy: "preferred" }),
      );
      await vi.waitFor(() =>
        expect(internal().database.listOccurrences()).toHaveLength(1),
      );
      const first = internal().database.listOccurrences()[0];
      expect(first.currentState).toBe("active");
      // The preferred-source bus emits the valid backup rather than a losing source timeout.
      leaf = { ...fresh, $source: "backup", values: { primary: stale } };
      emit();
      await vi.waitFor(() =>
        expect(internal().database.getAlert(first.id).currentState).toBe(
          "cleared",
        ),
      );
      leaf = stale;
      emit();
      await vi.waitFor(() =>
        expect(internal().database.listOccurrences()).toHaveLength(2),
      );
      internal().createNativeTimeoutRule({
        ...rule,
        slug: "other",
        name: "Other sensor",
        path: "environment.other.sensor",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const before = internal()
        .database.db.prepare("SELECT count(*) AS n FROM alert_events")
        .get();
      for (let i = 0; i < 100; i++) emit(fresh, "environment.other.sensor");
      for (let i = 0; i < 100; i++) emit(stale);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        internal()
          .database.db.prepare("SELECT count(*) AS n FROM alert_events")
          .get(),
      ).toEqual(before);
      await runtime.stop();
      leaf = undefined;
      runtime = new AlertCenterRuntime(app);
      runtime.start(options);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(
        internal()
          .database.listOccurrences()
          .filter((item) => item.currentState === "active"),
      ).toHaveLength(1);
      expect(
        internal()
          .database.listDefinitions()
          .some((item) => item.name === rule.name),
      ).toBe(true);
      leaf = { ...fresh, value: null };
      emit();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        internal()
          .database.listOccurrences()
          .filter((item) => item.currentState === "active"),
      ).toHaveLength(1);
      leaf = { ...fresh, timestamp: "2026-11-27T00:02:00Z" };
      emit();
      await vi.waitFor(() =>
        expect(
          internal()
            .database.listOccurrences()
            .every((item) => item.currentState === "cleared"),
        ).toBe(true),
      );
      // Accepted timeout and recovery in the same event-loop turn must persist
      // an occurrence even though the model already holds the fresh value.
      leaf = fresh;
      emit(stale);
      emit(fresh);
      await vi.waitFor(() =>
        expect(internal().database.listOccurrences()).toHaveLength(3),
      );
      expect(
        internal()
          .database.listOccurrences()
          .every((item) => item.currentState === "cleared"),
      ).toBe(true);
      expect(app.handleMessage).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          updates: expect.arrayContaining([
            expect.objectContaining({
              values: expect.arrayContaining([
                expect.objectContaining({ path: rule.path }),
              ]),
            }),
          ]),
        }),
      );
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
