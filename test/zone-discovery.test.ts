import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedDelta, ServerAPI } from "@signalk/server-api";
import { expect, it, vi } from "vitest";
import { AlertCenterRuntime } from "../src/runtime";
import { AlertDatabase } from "../src/storage/db";

it("discovers late zone metadata promptly, coalesces updates and unsubscribes on stop", async () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), "zone-discovery-"));
  const model: Record<string, unknown> = {};
  let listener: ((delta: NormalizedDelta) => void) | undefined;
  const unsubscribe = vi.fn();
  const getPath = vi.fn((path: string) =>
    path === "vessels.self" ? model : undefined,
  );
  const app = {
    debug: vi.fn(),
    error: vi.fn(),
    handleMessage: vi.fn(),
    setPluginStatus: vi.fn(),
    selfContext: "vessels.self",
    getDataDirPath: () => directory,
    getPath,
    subscriptionmanager: { subscribe: vi.fn() },
    streambundle: {
      getBus: () => ({
        onValue: (callback: typeof listener) => {
          listener = callback;
          return unsubscribe;
        },
      }),
    },
  } as unknown as ServerAPI;
  const runtime = new AlertCenterRuntime(app);
  const internal = runtime as unknown as {
    database: AlertDatabase;
    changeListeners: Set<(change: { reason: string }) => void>;
  };
  const changes = vi.fn();
  const metadata = (value: unknown, context = "vessels.self", isMeta = true) =>
    listener?.({
      context,
      path: "environment.temperature",
      value,
      isMeta,
    } as NormalizedDelta);
  try {
    runtime.start({ storage: { path: join(directory, "alerts.sqlite") } });
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.status().reconciliation.state).toBe("complete");
    expect(internal.database.listDefinitions()).toHaveLength(0);
    internal.changeListeners.add(changes);
    getPath.mockClear();
    metadata(280, "vessels.self", false);
    metadata({ zones: [] }, "vessels.other");
    metadata({ description: "Not a zone change" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(getPath).not.toHaveBeenCalled();
    const zones = [{ lower: 290, state: "alarm" }];
    model.environment = {
      temperature: {
        value: 280,
        meta: { zones, displayName: "Cabin temperature" },
      },
    };
    metadata({ zones });
    await vi.advanceTimersByTimeAsync(500);
    metadata({ zones });
    await vi.advanceTimersByTimeAsync(499);
    expect(getPath).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(internal.database.listDefinitions()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(internal.database.listDefinitions()).toMatchObject([
      { sourceType: "zone", name: "Cabin temperature", metadata: { zones } },
    ]);
    expect(getPath).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "definitions" }),
    );
    expect(internal.database.listOccurrences()).toHaveLength(0);
    expect(internal.database.listDeliveries()).toHaveLength(0);
    model.environment = { temperature: { value: 280, meta: { zones: null } } };
    metadata({ zones: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(internal.database.listDefinitions()[0].metadata).toMatchObject({
      zones: [],
    });
    metadata({ zones });
    getPath.mockClear();
    await runtime.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(getPath).not.toHaveBeenCalled();
  } finally {
    await runtime.stop();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});
