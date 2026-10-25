import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerAPI } from "@signalk/server-api";
import { afterEach, expect, it, vi } from "vitest";
import { AlertCenterRuntime } from "../src/runtime";
import type { AlertCenterRepository } from "../src/api/routes";
import { AlertDatabase } from "../src/storage/db";
import { CoreAlert, normalizeCoreAlert } from "../src/signalk/core-alerts";
import { coreFixture } from "./fixtures/core-alert";

const runtimes: AlertCenterRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { force: true, recursive: true }),
    );
  vi.unstubAllGlobals();
});

function setup(initial: CoreAlert[] = [], filename?: string, audio = false) {
  const directory = mkdtempSync(join(tmpdir(), "core-runtime-"));
  directories.push(directory);
  let snapshot = initial;
  let subscriber: (delta: unknown) => void = () => {};
  const publish = (alert: CoreAlert) => {
    snapshot = snapshot.filter((item) => item.id !== alert.id);
    if (alert.state !== "normal") snapshot.push(alert);
    subscriber({
      context: "vessels.own",
      updates: [
        {
          $source: "alertsApi",
          values: [{ path: `alerts.${alert.path}`, value: alert }],
        },
      ],
    });
  };
  const alerts = {
    list: vi.fn(() => snapshot),
    get: vi.fn((id: string) => snapshot.find((item) => item.id === id) ?? null),
    acknowledge: vi.fn(async (id: string) => {
      const alert = snapshot.find((item) => item.id === id)!;
      if (alert.latching || alert.state === "rtn-unacknowledged") {
        publish({ ...alert, state: "normal", condition: false });
        return { alert: null, cleared: true, previousState: alert.state };
      }
      const next = {
        ...alert,
        state: "acknowledged" as const,
        acknowledgedAt: new Date().toISOString(),
      };
      publish(next);
      return { alert: next, cleared: false, previousState: alert.state };
    }),
    silence: vi.fn(async (id: string) => {
      const alert = snapshot.find((item) => item.id === id)!;
      const next = {
        ...alert,
        silenced: true,
        silencedUntil: new Date(Date.now() + 120000).toISOString(),
      };
      publish(next);
      return next;
    }),
  };
  const announcements = new Map<
    string,
    { id: string; state: "queued" | "cancelled"; targets: object }
  >();
  const wyoming = {
    version: 1,
    announce: vi.fn(async ({ requestId }: { requestId: string }) => {
      const value = { id: requestId, state: "queued" as const, targets: {} };
      announcements.set(requestId, value);
      return value;
    }),
    getAnnouncement: (id: string) => announcements.get(id),
    cancelAnnouncement: vi.fn((id: string) => {
      const value = { id, state: "cancelled" as const, targets: {} };
      announcements.set(id, value);
      return value;
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(undefined, { status: 200 })),
  );
  const app = {
    alerts,
    selfContext: "vessels.own",
    debug: vi.fn(),
    error: vi.fn(),
    handleMessage: vi.fn(),
    setPluginStatus: vi.fn(),
    getSelfPath: () => undefined,
    getPath: () => undefined,
    notifications: { acknowledge: vi.fn(), silence: vi.fn() },
    onPropertyValues: (_key: string, callback: (values: unknown[]) => void) => {
      callback([{ value: wyoming }]);
      return () => {};
    },
    subscriptionmanager: {
      subscribe: (
        command: { subscribe: Array<{ path: string }> },
        stops: Array<() => void>,
        _error: unknown,
        handler: (delta: unknown) => void,
      ) => {
        if (command.subscribe.some((entry) => entry.path === "alerts.*"))
          subscriber = handler;
        stops.push(vi.fn());
      },
    },
  } as unknown as ServerAPI;
  const runtime = new AlertCenterRuntime(app);
  runtimes.push(runtime);
  runtime.start({
    storage: { path: filename ?? join(directory, "alerts.sqlite") },
    notifiers: audio
      ? [
          { name: "speaker", type: "wyoming" },
          {
            name: "remote",
            type: "ntfy",
            server: "http://127.0.0.1:9",
            topic: "test",
          },
        ]
      : [],
    defaults: {
      notifiers: audio ? ["speaker", "remote"] : [],
      speechEnabled: false,
    },
  });
  const internal = runtime as unknown as {
    database: AlertDatabase;
    repository(): AlertCenterRepository;
  };
  return {
    runtime,
    db: internal.database,
    repository: internal.repository(),
    publish,
    alerts,
    app,
    wyoming,
  };
}

it("reconciles list() and applies queued changes after the captured snapshot", async () => {
  const { runtime, db, publish } = setup([coreFixture()]);
  publish(coreFixture({ silenced: true }));
  await vi.waitFor(() => expect(runtime.status().ingestion.depth).toBe(0));
  await vi.waitFor(() =>
    expect(db.listOccurrences()[0]?.coreAlert?.silenced).toBe(true),
  );
  expect(db.listOccurrences()).toHaveLength(1);
  expect(runtime.status().alertSources).toEqual(["notifications", "alerts"]);
});

it("applies a queued condition return before an overdue activation can deliver", async () => {
  const directory = mkdtempSync(join(tmpdir(), "core-activation-restart-"));
  directories.push(directory);
  const filename = join(directory, "alerts.sqlite");
  const before = new AlertDatabase(filename);
  const first = before.ingest(
    normalizeCoreAlert(coreFixture()),
    ["remote"],
    new Date(Date.now() - 120_000),
    { activationDelaySeconds: 60 },
  )!;
  before.close();
  const { runtime, db, publish } = setup([coreFixture()], filename, true);
  publish(coreFixture({ state: "rtn-unacknowledged", condition: false }));
  await vi.waitFor(() =>
    expect(runtime.status().reconciliation.state).toBe("complete"),
  );
  expect(db.getAlert(first.id).activationState).toBe("suppressed");
  expect(db.listDeliveries()).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("routes actions to core IDs and never records a failed core action as local acknowledgment", async () => {
  const { db, repository, alerts, app } = setup([coreFixture()]);
  await vi.waitFor(() => expect(db.listOccurrences()).toHaveLength(1));
  const id = db.listOccurrences()[0].id;
  alerts.acknowledge.mockRejectedValueOnce(new Error("Core unavailable"));
  expect(await repository.acknowledgeOccurrence(id)).toMatchObject({
    status: "failed",
    upstream: "failed",
  });
  expect(db.getAlert(id).acknowledgedAt).toBeUndefined();
  expect(await repository.acknowledgeOccurrence(id)).toMatchObject({
    status: "acknowledged",
    upstream: "applied",
  });
  expect(alerts.acknowledge).toHaveBeenLastCalledWith("core-1");
  expect(app.notifications.acknowledge).not.toHaveBeenCalled();
  expect(db.getAlert(id).coreAlert?.state).toBe("acknowledged");
});

it("acknowledges a retained momentary event and preserves confirmed resolution after the terminal delta", async () => {
  const { db, repository } = setup([
    coreFixture({ latching: true, condition: false }),
  ]);
  await vi.waitFor(() => expect(db.listOccurrences()).toHaveLength(1));
  const id = db.listOccurrences()[0].id;
  expect(await repository.acknowledgeOccurrence(id)).toMatchObject({
    upstream: "applied",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(db.getAlert(id)).toMatchObject({
    currentState: "cleared",
    coreResolutionConfirmed: true,
  });
  expect(db.getAlert(id).acknowledgedAt).toBeDefined();
});

it("closes missing core memberships on startup without fabricating recovery or losing pending delivery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "core-missing-"));
  directories.push(directory);
  const filename = join(directory, "alerts.sqlite");
  const before = new AlertDatabase(filename);
  const occurrence = before.ingest(normalizeCoreAlert(coreFixture()), [
    "offline",
  ])!;
  before.close();
  const { db, runtime } = setup([], filename);
  await vi.waitFor(() =>
    expect(runtime.status().reconciliation.state).toBe("complete"),
  );
  expect(db.getAlert(occurrence.id)).toMatchObject({
    currentState: "cleared",
    coreResolutionConfirmed: false,
  });
  expect(db.listDeliveries()).toHaveLength(1);
  expect(
    db
      .listAlertEvents()
      .some((event) => event.eventType === "core_missing_on_startup"),
  ).toBe(true);
});

it("cancels core-silenced Wyoming audio, resumes on unsilence, and leaves remote sends independent", async () => {
  const { db, publish, wyoming } = setup([coreFixture()], undefined, true);
  await vi.waitFor(() => expect(wyoming.announce).toHaveBeenCalledTimes(1));
  const remote = db
    .listDeliveries()
    .find((delivery) => delivery.transportInstanceId === "remote")!;
  await vi.waitFor(() =>
    expect(db.getDelivery(remote.id)?.state).toBe("delivered"),
  );
  publish(
    coreFixture({
      silenced: true,
      silencedUntil: new Date(Date.now() + 120000).toISOString(),
    }),
  );
  await vi.waitFor(() =>
    expect(wyoming.cancelAnnouncement).toHaveBeenCalledTimes(1),
  );
  publish(coreFixture());
  await vi.waitFor(() => expect(wyoming.announce).toHaveBeenCalledTimes(2));
  expect(
    db
      .listDeliveries()
      .filter((delivery) => delivery.transportInstanceId === "remote"),
  ).toHaveLength(1);
  publish(
    coreFixture({
      state: "acknowledged",
      acknowledgedAt: new Date().toISOString(),
    }),
  );
  await vi.waitFor(() =>
    expect(wyoming.cancelAnnouncement).toHaveBeenCalledTimes(2),
  );
  expect(db.getAlert(remote.alertId).acknowledgedAt).toBeDefined();
});
