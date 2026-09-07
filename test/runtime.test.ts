import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerAPI } from "@signalk/server-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathDefinitionId } from "../src/alerts/policy";
import { PersistentNotifierRuntime } from "../src/runtime";
import { AlertDatabase } from "../src/storage/db";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("PersistentNotifierRuntime", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories)
      rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  it("discovers zones and persists source-aware recurring occurrences", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notifier-runtime-"));
    directories.push(directory);
    const filename = join(directory, "alerts.sqlite");
    let subscriber: ((delta: unknown) => void) | undefined;
    const self = {
      environment: {
        inside: {
          refrigerator: {
            temperature: {
              meta: {
                description: "Refrigerator temperature",
                zones: [{ upper: 281.15, state: "alarm" }],
              },
            },
          },
        },
      },
      notifications: {},
    };
    const app = {
      error: vi.fn(),
      getDataDirPath: () => directory,
      getPath: (path: string) =>
        path === "vessels.self.notifications" ? self.notifications : self,
      getSelfPath: (path: string) =>
        path === "notifications" ? self.notifications : self,
      notifications: {
        getId: vi.fn(),
        acknowledge: vi.fn(),
        silence: vi.fn(),
      },
      selfContext: "vessels.self",
      setPluginStatus: vi.fn(),
      subscriptionmanager: {
        subscribe: (
          _command: unknown,
          unsubscribes: Array<() => void>,
          _onError: (error: unknown) => void,
          callback: (delta: unknown) => void,
        ) => {
          subscriber = callback;
          unsubscribes.push(vi.fn());
        },
      },
    } as unknown as ServerAPI;
    const runtime = new PersistentNotifierRuntime(app);
    runtime.start({
      storage: { path: filename },
      defaults: { oneTime: true, minSeverity: "alarm" },
    });

    const path = "notifications.environment.inside.refrigerator.temperature";
    subscriber?.({
      updates: [
        {
          $source: "fixture.temperature",
          timestamp: "2026-01-01T00:00:00Z",
          values: [{ path, value: { state: "alarm", message: "Warm" } }],
        },
      ],
    });
    await flush();
    subscriber?.({
      updates: [
        {
          $source: "fixture.temperature",
          timestamp: "2026-01-01T00:01:00Z",
          values: [{ path, value: null }],
        },
      ],
    });
    await flush();
    subscriber?.({
      updates: [
        {
          $source: "fixture.temperature",
          timestamp: "2026-01-01T00:02:00Z",
          values: [{ path, value: { state: "alarm", message: "Warm again" } }],
        },
      ],
    });
    await flush();
    await runtime.stop();

    const database = new AlertDatabase(filename);
    expect(database.getDefinition(pathDefinitionId(path))).toMatchObject({
      sourceType: "zone",
      name: "Refrigerator temperature",
    });
    const occurrences = database.listOccurrences();
    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((item) => item.occurrenceNumber)).toEqual([2, 1]);
    expect(occurrences.every((item) => item.oneTime)).toBe(true);
    expect(occurrences[0].sourceTimestamp).toEqual(
      new Date("2026-01-01T00:02:00Z"),
    );
    database.close();
  });
});
