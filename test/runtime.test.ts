import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerAPI } from "@signalk/server-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathDefinitionId } from "../src/alerts/policy";
import { AlertCenterRepository, Page } from "../src/api/routes";
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

  it("resolves relative database paths inside the Signal K data directory", () => {
    const dataDirectory = join(tmpdir(), "signalk-data");
    const runtime = new PersistentNotifierRuntime({
      getDataDirPath: () => dataDirectory,
    } as unknown as ServerAPI);
    const databasePath = (
      runtime as unknown as {
        databasePath(options: { storage?: { path?: string } }): string;
      }
    ).databasePath.bind(runtime);
    const absolutePath = join(tmpdir(), "external-alerts.sqlite");

    expect(databasePath({})).toBe(
      join(dataDirectory, "persistent-notifier.sqlite"),
    );
    expect(databasePath({ storage: { path: "notifier/alerts.sqlite" } })).toBe(
      join(dataDirectory, "notifier/alerts.sqlite"),
    );
    expect(databasePath({ storage: { path: absolutePath } })).toBe(
      absolutePath,
    );
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
    const getPath = vi.fn((path: string) =>
      path === "vessels.self.notifications" ? self.notifications : self,
    );
    const notificationStatus = {
      canAcknowledge: true,
      canSilence: true,
      acknowledged: false,
      silenced: false,
    };
    const app = {
      debug: vi.fn(),
      error: vi.fn(),
      getDataDirPath: () => directory,
      getPath,
      getSelfPath: (path: string) =>
        path === "notifications" ? self.notifications : self,
      notifications: {
        getId: vi.fn(() => ({
          value: { status: notificationStatus },
        })),
        acknowledge: vi.fn(() => {
          notificationStatus.acknowledged = true;
        }),
        silence: vi.fn(async () => {
          notificationStatus.silenced = true;
        }),
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
      notifiers: [
        {
          name: "warning",
          type: "ntfy",
          server: "http://127.0.0.1:9",
          topic: "test",
          minSeverity: "warn",
        },
        {
          name: "critical",
          type: "ntfy",
          server: "http://127.0.0.1:9",
          topic: "test",
          minSeverity: "emergency",
        },
      ],
      defaults: {
        oneTime: true,
        minSeverity: "alarm",
        notifiers: ["warning", "critical"],
      },
    });
    expect(getPath).not.toHaveBeenCalled();

    const path = "notifications.environment.inside.refrigerator.temperature";
    subscriber?.({
      updates: [
        {
          $source: "fixture.temperature",
          timestamp: "2026-01-01T00:00:00Z",
          values: [
            {
              path,
              value: {
                id: "temperature-alarm",
                state: "alarm",
                message: "Warm",
              },
            },
          ],
        },
      ],
    });
    await flush();
    expect(getPath).toHaveBeenCalled();
    await flush();
    expect(app.debug).toHaveBeenCalledWith(
      expect.stringContaining("Startup reconciliation complete"),
    );
    await vi.waitFor(() => {
      expect(runtime.status()).toMatchObject({
        health: {
          state: "degraded",
          reasons: ["warning last failed (NETWORK)"],
        },
        reconciliation: {
          state: "complete",
          snapshotEntries: 0,
          queuedEntries: 1,
        },
        ingestion: {
          depth: 0,
          highWaterMark: 1,
          received: 1,
          processed: 1,
          rejected: 0,
        },
        scheduler: { running: false, activeRequests: 0 },
        database: { healthy: true, schemaVersion: 8, expectedSchemaVersion: 8 },
        services: [
          {
            id: "warning",
            type: "ntfy",
            pendingCount: 1,
            lastFailureCode: "NETWORK",
          },
          { id: "critical", type: "ntfy", pendingCount: 0 },
        ],
      });
    });
    expect(app.setPluginStatus).toHaveBeenCalledWith(
      expect.stringContaining("degraded:"),
    );
    const repository = (
      runtime as unknown as { repository(): AlertCenterRepository }
    ).repository();
    const runtimeDatabase = (runtime as unknown as { database: AlertDatabase })
      .database;
    const fullHistoryRead = vi.spyOn(runtimeDatabase, "listAlerts");
    runtime.status();
    expect(fullHistoryRead).not.toHaveBeenCalled();
    const active = (await repository.listOccurrences({
      limit: 10,
      state: "active",
    })) as Page<{ id: string; definitionId: string }>;
    expect(fullHistoryRead).not.toHaveBeenCalled();
    expect(
      await repository.acknowledgeOccurrence(active.items[0].id),
    ).toMatchObject({ upstream: "applied" });
    expect(
      await repository.silenceOccurrence(active.items[0].id),
    ).toMatchObject({
      upstream: "applied",
    });
    expect(app.notifications.acknowledge).toHaveBeenCalledWith(
      "temperature-alarm",
    );
    expect(app.notifications.silence).toHaveBeenCalledWith("temperature-alarm");
    const updatedDefinition = (await repository.updatePolicy(
      active.items[0].definitionId,
      {
        connectivity: { mode: "wake" },
      },
    )) as { policy: { provenance: string; overriddenFields: string[] } };
    expect(updatedDefinition.policy).toMatchObject({
      provenance: "partial",
      overriddenFields: ["connectivity"],
    });
    subscriber?.({
      updates: [
        {
          $source: "fixture.temperature",
          timestamp: "2026-01-01T00:00:30Z",
          values: [
            {
              path,
              value: {
                id: "temperature-alarm",
                state: "alarm",
                message: "Still warm",
              },
            },
          ],
        },
      ],
    });
    await flush();
    expect(
      (
        runtime as unknown as { database: AlertDatabase }
      ).database.listWakeRequests(),
    ).toEqual([]);
    const definitions = (await repository.listDefinitions({
      limit: 10,
    })) as Page<{
      id: string;
      lastActivityAt?: Date;
      metadata?: { zones?: Array<{ upper?: number; state: string }> };
    }>;
    expect(
      definitions.items.find(
        (definition) => definition.id === active.items[0].definitionId,
      )?.lastActivityAt,
    ).toBeInstanceOf(Date);
    expect(
      definitions.items.find(
        (definition) => definition.id === active.items[0].definitionId,
      )?.metadata?.zones,
    ).toEqual([{ upper: 281.15, state: "alarm" }]);
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
    expect(await repository.acknowledgeOccurrence(active.items[0].id)).toBe(
      "inactive",
    );
    expect(await repository.silenceOccurrence(active.items[0].id)).toBe(
      "inactive",
    );
    expect(app.notifications.acknowledge).toHaveBeenCalledTimes(1);
    expect(app.notifications.silence).toHaveBeenCalledTimes(1);
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
    expect(
      database.listDeliveries().map((delivery) => delivery.transportInstanceId),
    ).toEqual(["warning", "warning"]);
    expect(occurrences[0].sourceTimestamp).toEqual(
      new Date("2026-01-01T00:02:00Z"),
    );
    database.close();
  });

  it("keeps ingestion bounded and progressing while a notifier is stalled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notifier-pressure-"));
    directories.push(directory);
    let subscriber: ((delta: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const app = {
      debug: vi.fn(),
      error: vi.fn(),
      getDataDirPath: () => directory,
      getPath: vi.fn(() => ({})),
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
          unsubscribes.push(unsubscribe);
        },
      },
    } as unknown as ServerAPI;
    const runtime = new PersistentNotifierRuntime(app);
    try {
      runtime.start({
        ingestion: { queueLimit: 10, batchSize: 2 },
        delivery: { requestTimeoutSeconds: 300 },
        notifiers: [
          {
            name: "stalled",
            type: "ntfy",
            server: "https://notify.invalid",
            topic: "test",
          },
        ],
        defaults: { notifiers: ["stalled"] },
      });
      expect(() => runtime.start({})).toThrow("already started");
      await vi.waitFor(() => {
        expect(runtime.status().reconciliation.state).toBe("complete");
      });

      subscriber?.({
        updates: [
          {
            $source: "fixture",
            values: [
              {
                path: "notifications.pressure.initial",
                value: { state: "alarm", message: "Initial" },
              },
            ],
          },
        ],
      });
      await vi.waitFor(() => {
        expect(runtime.status().scheduler.activeRequests).toBe(1);
      });

      for (let index = 0; index < 10_000; index += 1)
        subscriber?.({
          updates: [
            {
              $source: "fixture",
              values: [
                {
                  path: `notifications.pressure.${index}`,
                  value: { state: "alarm", message: String(index) },
                },
              ],
            },
          ],
        });

      expect(runtime.status().ingestion).toMatchObject({
        depth: 10,
        limit: 10,
        highWaterMark: 10,
        rejected: 9_990,
      });
      expect(app.error).toHaveBeenCalledWith(
        expect.stringContaining("ingestion queue reached"),
      );
      await vi.waitFor(() => {
        expect(runtime.status().ingestion.depth).toBe(0);
        expect(runtime.status().scheduler.activeRequests).toBe(1);
      });
    } finally {
      await runtime.stop();
      vi.unstubAllGlobals();
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("completes startup while live notifications exceed the queue limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notifier-startup-pressure-"));
    directories.push(directory);
    let subscriber: ((delta: unknown) => void) | undefined;
    let flooded = false;
    const app = {
      debug: vi.fn(),
      error: vi.fn(),
      getDataDirPath: () => directory,
      selfContext: "vessels.self",
      setPluginStatus: vi.fn(),
      getPath: vi.fn((path: string) => {
        if (path !== "vessels.self.notifications") return {};
        if (!flooded) {
          flooded = true;
          for (let index = 0; index < 10_000; index += 1)
            subscriber?.({
              updates: [
                {
                  $source: "startup-fixture",
                  values: [
                    {
                      path: `notifications.startup.${index}`,
                      value: { state: "alarm", message: String(index) },
                    },
                  ],
                },
              ],
            });
        }
        return {
          snapshot: {
            value: { state: "warn", message: "Snapshot" },
            $source: "snapshot-fixture",
          },
        };
      }),
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
    runtime.start({ ingestion: { queueLimit: 10, batchSize: 2 } });
    try {
      await vi.waitFor(() => {
        expect(runtime.status()).toMatchObject({
          reconciliation: {
            state: "complete",
            snapshotEntries: 1,
            queuedEntries: 10_000,
          },
          ingestion: {
            depth: 0,
            limit: 10,
            highWaterMark: 10,
            received: 10_000,
            processed: 10,
            rejected: 9_990,
          },
        });
      });
    } finally {
      await runtime.stop();
    }
  });
});
