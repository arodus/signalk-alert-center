import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectivityManager,
  SwitchAdapter,
} from "../src/connectivity/manager";
import { AlertDatabase } from "../src/storage/db";
import { AlertLifecycle } from "../src/alerts/lifecycle";
import { vi } from "vitest";

class FakeSwitch implements SwitchAdapter {
  state: boolean | undefined = false;
  commands: boolean[] = [];

  async getState(): Promise<boolean | undefined> {
    return this.state;
  }

  async setState(on: boolean): Promise<void> {
    this.commands.push(on);
    this.state = on;
  }
}

describe("connectivity ownership and durable wake requests", () => {
  const databases: AlertDatabase[] = [];
  const managers: ConnectivityManager[] = [];

  afterEach(() => {
    for (const manager of managers) manager.stop();
    for (const database of databases) database.close();
    managers.length = 0;
    databases.length = 0;
  });

  it("does not release connectivity that was already on", async () => {
    const adapter = new FakeSwitch();
    adapter.state = true;
    const manager = new ConnectivityManager(adapter, 0);
    managers.push(manager);

    await manager.requestWake();
    manager.beginCooldown();
    await manager.releaseIfSafe();

    expect(adapter.commands).toEqual([]);
    expect(manager.ownedByPlugin).toBe(false);
  });

  it("turns off only a plugin-owned connection after cooldown", async () => {
    const adapter = new FakeSwitch();
    const manager = new ConnectivityManager(adapter, 0);
    managers.push(manager);

    await manager.requestWake();
    manager.beginCooldown();
    await manager.releaseIfSafe();

    expect(adapter.commands).toEqual([true, false]);
    expect(manager.state).toBe("OFF");
  });

  it("records connectivity transitions and failed state-check diagnostics", async () => {
    const adapter = new FakeSwitch();
    const manager = new ConnectivityManager(
      adapter,
      0,
      async () => false,
      0,
      1,
    );
    managers.push(manager);

    await manager.requestWake();

    expect(manager.state).toBe("FAULT");
    expect(manager.lastTransitionFrom).toBe("WAITING_FOR_INTERNET");
    expect(manager.lastTransitionAt).toBeInstanceOf(Date);
    expect(manager.lastInternetCheckAt).toBeInstanceOf(Date);
    expect(manager.lastInternetAvailable).toBe(false);
    expect(manager.lastError).toBe(
      "Internet state did not become available before the timeout",
    );
  });

  it("restores persisted plugin ownership only when the switch is still on", async () => {
    const adapter = new FakeSwitch();
    adapter.state = true;
    const manager = new ConnectivityManager(adapter, 0, async () => true);
    managers.push(manager);

    await manager.recover({
      startedAt: new Date("2026-10-19T08:00:00Z"),
      startedByPlugin: true,
      state: "ONLINE",
      observedSwitchOn: true,
      updatedAt: new Date("2026-10-19T08:01:00Z"),
    });
    manager.beginCooldown();
    await manager.releaseIfSafe();

    expect(manager.ownedByPlugin).toBe(false);
    expect(adapter.commands).toEqual([false]);
    expect(manager.state).toBe("OFF");
  });

  it("keeps ownership after an Internet boot timeout and can release safely", async () => {
    const adapter = new FakeSwitch();
    const manager = new ConnectivityManager(
      adapter,
      0,
      async () => false,
      0,
      1,
    );
    managers.push(manager);

    await manager.requestWake();
    expect(manager.state).toBe("FAULT");
    expect(manager.ownedByPlugin).toBe(true);

    manager.beginCooldown();
    await manager.releaseIfSafe();

    expect(adapter.commands).toEqual([true, false]);
    expect(manager.state).toBe("OFF");
  });

  it("fails safely when the switch state cannot be read during recovery", async () => {
    const adapter: SwitchAdapter = {
      getState: async () => {
        throw new Error("PUT provider unavailable");
      },
      setState: async () => {},
    };
    const manager = new ConnectivityManager(adapter, 0);
    managers.push(manager);

    await manager.recover({
      startedByPlugin: true,
      state: "ONLINE",
      observedSwitchOn: true,
      updatedAt: new Date("2026-10-19T08:00:00Z"),
    });

    expect(manager.state).toBe("FAULT");
    expect(manager.ownedByPlugin).toBe(false);
    expect(manager.lastError).toContain("PUT provider unavailable");
  });

  it("re-checks live safety state before switching off", async () => {
    const adapter = new FakeSwitch();
    let pendingDelivery = true;
    const manager = new ConnectivityManager(
      adapter,
      60_000,
      async () => true,
      240_000,
      5_000,
      () => ({
        pendingDelivery,
        activeWakeAlert: false,
        scheduledWake: false,
        sendInFlight: false,
      }),
    );
    managers.push(manager);

    await manager.requestWake();
    manager.beginCooldown();
    await manager.releaseIfSafe();
    expect(adapter.commands).toEqual([true]);
    expect(manager.lastShutdownDeferredReason).toBe("pending delivery");

    pendingDelivery = false;
    manager.beginCooldown();
    await manager.releaseIfSafe();
    expect(adapter.commands).toEqual([true, false]);
  });

  it("preserves plugin ownership when another alert needs the active connection", async () => {
    const adapter = new FakeSwitch();
    const manager = new ConnectivityManager(adapter, 0);
    managers.push(manager);

    await manager.requestWake();
    await manager.requestWake();

    expect(adapter.commands).toEqual([true]);
    expect(manager.ownedByPlugin).toBe(true);
  });

  it("shares one wake operation and cancels its wait when stopped", async () => {
    const adapter = new FakeSwitch();
    const probe = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener("abort", () => resolve(false), {
            once: true,
          });
        }),
    );
    const manager = new ConnectivityManager(adapter, 0, probe, 240_000, 5_000);
    managers.push(manager);

    const first = manager.requestWake();
    const second = manager.requestWake();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    manager.stop();
    await Promise.all([first, second]);

    expect(adapter.commands).toEqual([true]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(manager.lastError).toBeUndefined();
  });

  it("persists wake-after requests independently of in-memory timers", () => {
    const database = new AlertDatabase();
    databases.push(database);
    const lifecycle = new AlertLifecycle(database, ["ntfy-main"]);
    const alert = lifecycle.ingest({
      sourceKey: "notifications.engine.overheat",
      path: "notifications.engine.overheat",
      severity: "alarm",
      state: "active",
    });
    const dueAt = new Date("2026-09-05T10:10:00.000Z");

    database.setWakeDue(alert.id, dueAt);

    expect(database.listWakeRequests()).toEqual([{ alertId: alert.id, dueAt }]);
    expect(database.listWakeDue(new Date("2026-09-05T10:09:59.000Z"))).toEqual(
      [],
    );
    expect(database.listWakeDue(new Date("2026-09-05T10:10:00.000Z"))).toEqual([
      { alertId: alert.id, dueAt },
    ]);
  });

  it("persists connectivity ownership and resumes waiting deliveries", () => {
    const database = new AlertDatabase();
    databases.push(database);
    const now = new Date("2026-10-19T08:00:00Z");
    database.saveConnectivitySession({
      startedAt: now,
      startedByPlugin: true,
      state: "ONLINE",
      observedSwitchOn: true,
      updatedAt: now,
    });
    const lifecycle = new AlertLifecycle(database, ["ntfy-main"]);
    lifecycle.ingest(
      {
        sourceKey: "notifications.internet.wait",
        path: "notifications.internet.wait",
        severity: "alarm",
        state: "active",
      },
      now,
    );
    const delivery = database.listDueDeliveries(now)[0];

    expect(database.waitForConnectivity(delivery.id, now)).toBe(true);
    expect(database.listDueDeliveries(now)).toEqual([]);
    expect(database.nextDeliveryDueAt()).toBeUndefined();
    expect(database.waitingForConnectivityCount()).toBe(1);
    expect(database.getConnectivitySession()).toMatchObject({
      startedAt: now,
      startedByPlugin: true,
      state: "ONLINE",
      observedSwitchOn: true,
      updatedAt: now,
    });

    expect(database.resumeWaitingForConnectivity(now)).toBe(1);
    expect(database.listDueDeliveries(now)).toHaveLength(1);
  });

  it("keeps the original wake-after deadline when an alert is updated", () => {
    const database = new AlertDatabase();
    databases.push(database);
    const lifecycle = new AlertLifecycle(database, ["ntfy-main"]);
    const alert = lifecycle.ingest({
      sourceKey: "notifications.engine.overheat",
      path: "notifications.engine.overheat",
      severity: "alarm",
      state: "active",
    });
    const firstDueAt = new Date("2026-09-05T10:10:00.000Z");
    const laterDueAt = new Date("2026-09-05T10:20:00.000Z");

    database.setWakeDue(alert.id, firstDueAt);
    database.setWakeDue(alert.id, laterDueAt);

    expect(database.listWakeRequests()).toEqual([
      { alertId: alert.id, dueAt: firstDueAt },
    ]);
  });
});
