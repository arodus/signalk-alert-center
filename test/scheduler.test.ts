import { describe, expect, it, vi } from "vitest";
import { AlertLifecycle } from "../src/alerts/lifecycle";
import { DeliveryScheduler } from "../src/delivery/scheduler";
import { AlertDatabase } from "../src/storage/db";
import { NotificationTransport } from "../src/transports/transport";

describe("DeliveryScheduler", () => {
  it("queries only deliveries that are due", async () => {
    const database = new AlertDatabase();
    const send = vi.fn(async () => ({
      kind: "retryable" as const,
      code: "OFFLINE",
      message: "offline",
    }));
    const transport: NotificationTransport = { type: "test", send };
    new AlertLifecycle(database, ["test"]).ingest({
      sourceKey: "notifications.due",
      path: "notifications.due",
      severity: "alarm",
      state: "active",
    });
    const scheduler = new DeliveryScheduler(
      database,
      new Map([["test", transport]]),
      { initialSeconds: 60, maxSeconds: 60, multiplier: 1, jitter: 0 },
    );

    await scheduler.runOnce(new Date("2026-01-01T00:00:00Z"));
    expect(send).toHaveBeenCalledTimes(1);
    vi.spyOn(database, "listDeliveries").mockImplementation(() => {
      throw new Error("scheduler must not scan delivery history");
    });
    await scheduler.runOnce(new Date("2026-01-01T00:00:30Z"));
    expect(send).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("waits for an in-flight send before stop returns", async () => {
    const database = new AlertDatabase();
    let resolveSend!: () => void;
    const sendFinished = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const transport: NotificationTransport = {
      type: "test",
      async send() {
        await sendFinished;
        return { kind: "success" };
      },
    };
    const lifecycle = new AlertLifecycle(database, ["test"]);
    lifecycle.ingest({
      sourceKey: "notifications.test",
      path: "notifications.test",
      severity: "alarm",
      state: "active",
    });
    const scheduler = new DeliveryScheduler(
      database,
      new Map([["test", transport]]),
    );

    const sending = scheduler.runOnce();
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveSend();
    await Promise.all([sending, stopping]);
    expect(stopped).toBe(true);
    expect(database.listDeliveries()[0].state).toBe("delivered");
    database.close();
  });
});
