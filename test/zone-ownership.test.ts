import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerAPI } from "@signalk/server-api";
import { expect, it, vi } from "vitest";
import { pathDefinitionId } from "../src/alerts/policy";
import type { AlertCenterRepository, Page } from "../src/api/routes";
import { AlertCenterRuntime } from "../src/runtime";
import { AlertDatabase } from "../src/storage/db";

it("keeps policies, history and same-path legacy producers when zone management is disabled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zone-ownership-"));
  const filename = join(directory, "alerts.sqlite");
  const path = "notifications.environment.depth";
  const id = pathDefinitionId(path);
  const dormantId = pathDefinitionId("notifications.environment.temperature");
  const ruleId = "rule:signalk-alert-rules:depth-low";
  const db = new AlertDatabase(filename);
  for (const [key, sourceType, pathPattern] of [
    [id, "zone", path],
    [dormantId, "zone", "notifications.environment.temperature"],
    [ruleId, "rule", "alerts.environment.depthLow"],
  ] as const) {
    db.upsertDefinition({ id: key, sourceType, pathPattern, name: key });
    db.setPolicy(key, {
      enabled: true,
      minimumSeverity: "alarm",
      oneTime: false,
      connectivity: { mode: "queue" },
      activationDelaySeconds: 0,
      notifierIds: ["crew"],
      notifierRepeatOverrides: {},
      overrideFields: ["notifierIds"],
    });
  }
  const legacy = db.ingest(
    {
      sourceKey: `${path}:old`,
      source: "old",
      path,
      state: "active",
      severity: "alarm",
    },
    ["crew"],
    new Date(),
    { definitionId: id },
  )!;
  db.ingest(
    {
      sourceKey: `${path}:old`,
      source: "old",
      path,
      state: "cleared",
      severity: "normal",
    },
    ["crew"],
  );
  const history = db.listAlertEvents(legacy.id);
  const delivery = db.listDeliveries()[0];
  const policy = db.getPolicy(dormantId);
  db.close();
  let subscriber: ((delta: unknown) => void) | undefined;
  const snapshot = {
    environment: {
      depth: {
        value: { state: "alarm", message: "Other producer" },
        $source: "snapshot-fixture",
      },
    },
  };
  const getPath = vi.fn((key: string) =>
    key === "vessels.self.notifications" ? snapshot : undefined,
  );
  const app = {
    config: { settings: { notifications: { manageNotifications: false } } },
    debug: vi.fn(),
    error: vi.fn(),
    handleMessage: vi.fn(),
    setPluginStatus: vi.fn(),
    selfContext: "vessels.self",
    getDataDirPath: () => directory,
    getPath,
    getSelfPath: (key: string) =>
      key === "notifications"
        ? snapshot
        : key === "network.internet.state"
          ? { value: "offline" }
          : undefined,
    subscriptionmanager: {
      subscribe: (
        command: { subscribe: Array<{ path: string }> },
        stops: Array<() => void>,
        _error: unknown,
        handler: (delta: unknown) => void,
      ) => {
        if (command.subscribe.some((entry) => entry.path === "notifications.*"))
          subscriber = handler;
        stops.push(() => {});
      },
    },
  } as unknown as ServerAPI;
  const runtime = new AlertCenterRuntime(app);
  const internal = runtime as unknown as {
    database: AlertDatabase;
    repository(): AlertCenterRepository;
    seedDefinitions(): void;
  };
  try {
    runtime.start({
      storage: { path: filename },
      notifiers: [
        {
          name: "crew",
          type: "ntfy",
          server: "http://127.0.0.1:9",
          topic: "fixture",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(runtime.status().reconciliation.state).toBe("complete"),
    );
    const repository = internal.repository();
    const list = async () =>
      (await repository.listDefinitions({ limit: 100 })) as Page<{
        id: string;
      }>;
    expect((await list()).items.map((item) => item.id)).toEqual(
      expect.arrayContaining([id, ruleId]),
    );
    expect((await list()).items.map((item) => item.id)).not.toContain(
      dormantId,
    );
    expect(internal.database.getPolicy(dormantId)).toEqual(policy);
    expect(await repository.getDefinition(dormantId)).toBeDefined();
    expect(internal.database.listAlertEvents(legacy.id)).toEqual(history);
    expect(internal.database.getDelivery(delivery.id)).toMatchObject({
      id: delivery.id,
      alertId: legacy.id,
    });
    expect(
      internal.database
        .listOccurrences()
        .some((item) => item.source === "snapshot-fixture"),
    ).toBe(true);
    getPath.mockClear();
    internal.seedDefinitions();
    expect(getPath).not.toHaveBeenCalled();
    subscriber?.({
      updates: [
        {
          $source: "delta-fixture",
          values: [
            {
              path: "notifications.environment.temperature",
              value: {
                state: "alarm",
                message: "Independent temperature sensor",
              },
            },
          ],
        },
      ],
    });
    await vi.waitFor(async () =>
      expect((await list()).items.map((item) => item.id)).toContain(dormantId),
    );
    expect(
      internal.database
        .listOccurrences()
        .some((item) => item.source === "delta-fixture"),
    ).toBe(true);
    expect(internal.database.getPolicy(dormantId)).toEqual(policy);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
