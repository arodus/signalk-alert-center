import { describe, expect, it } from "vitest";
import { AlertLifecycle } from "../src/alerts/lifecycle";
import { DeliveryScheduler } from "../src/delivery/scheduler";
import { AlertDatabase } from "../src/storage/db";
import { NotificationTransport } from "../src/transports/transport";

describe("DeliveryScheduler", () => {
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
