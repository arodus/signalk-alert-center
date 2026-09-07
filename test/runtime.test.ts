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
        getId: vi.fn(() => ({
          value: { status: { canAcknowledge: true, canSilence: true } },
        })),
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
      notifiers: {
        warning: {
          type: "ntfy",
          server: "http://127.0.0.1:9",
          topic: "test",
          minSeverity: "warn",
        },
        critical: {
          type: "ntfy",
          server: "http://127.0.0.1:9",
          topic: "test",
          minSeverity: "emergency",
        },
      },
      defaults: {
        oneTime: true,
        minSeverity: "alarm",
        notifiers: ["warning", "critical"],
      },
    });

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
    const repository = (
      runtime as unknown as { repository(): AlertCenterRepository }
    ).repository();
    const active = (await repository.listOccurrences({
      limit: 10,
      state: "active",
    })) as Page<{ id: string; definitionId: string }>;
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
    await repository.updatePolicy(active.items[0].definitionId, {
      connectivity: { mode: "wake" },
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
    expect(
      await repository.dismissOccurrence(active.items[0].id),
    ).toMatchObject({ status: "dismissed" });
    const definitions = (await repository.listDefinitions({
      limit: 10,
    })) as Page<{ id: string; lastActivityAt?: Date }>;
    expect(
      definitions.items.find(
        (definition) => definition.id === active.items[0].definitionId,
      )?.lastActivityAt,
    ).toBeInstanceOf(Date);
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
});
