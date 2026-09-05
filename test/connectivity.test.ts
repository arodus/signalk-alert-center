import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectivityManager,
  SwitchAdapter,
} from "../src/connectivity/manager";
import { AlertDatabase } from "../src/storage/db";
import { AlertLifecycle } from "../src/alerts/lifecycle";

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

  it("preserves plugin ownership when another alert needs the active connection", async () => {
    const adapter = new FakeSwitch();
    const manager = new ConnectivityManager(adapter, 0);
    managers.push(manager);

    await manager.requestWake();
    await manager.requestWake();

    expect(adapter.commands).toEqual([true]);
    expect(manager.ownedByPlugin).toBe(true);
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
});
