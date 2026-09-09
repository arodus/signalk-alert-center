import { describe, expect, it, vi } from "vitest";
import { AlertLifecycle } from "../src/alerts/lifecycle";
import { DeliveryScheduler } from "../src/delivery/scheduler";
import { AlertDatabase } from "../src/storage/db";
import { NotificationTransport } from "../src/transports/transport";

describe("DeliveryScheduler", () => {
  it("reports per-service success, retry, terminal failure, and overdue activation", async () => {
    const database = new AlertDatabase();
    const now = new Date("2026-01-01T00:00:00Z");
    const ingest = (sourceKey: string, transport: string, delay = 0) =>
      database.ingest(
        {
          sourceKey,
          path: sourceKey,
          severity: "alarm",
          state: "active",
        },
        [transport],
        now,
        { activationDelaySeconds: delay },
      );
    ingest("notifications.success", "success");
    ingest("notifications.retry", "retry");
    ingest("notifications.terminal", "terminal");
    ingest("notifications.delayed", "success", 30);
    const scheduler = new DeliveryScheduler(
      database,
      new Map([
        [
          "success",
          {
            type: "test",
            send: vi.fn(async () => ({ kind: "success" as const })),
          },
        ],
        [
          "retry",
          {
            type: "test",
            send: vi.fn(async () => ({
              kind: "retryable" as const,
              code: "OFFLINE",
              message: "offline",
            })),
          },
        ],
        [
          "terminal",
          {
            type: "test",
            send: vi.fn(async () => ({
              kind: "terminal" as const,
              code: "REJECTED",
              message: "rejected",
            })),
          },
        ],
      ]),
      { initialSeconds: 60, maxSeconds: 60, multiplier: 1, jitter: 0 },
    );

    await scheduler.runOnce(now);
    const status = database.operationalStatus(new Date("2026-01-01T00:01:01Z"));

    expect(scheduler.status()).toMatchObject({
      running: false,
      lastRunStartedAt: now,
      lastSummary: {
        succeeded: 1,
        retryableFailures: 1,
        terminalFailures: 1,
      },
    });
    expect(status.overdueActivationCount).toBe(1);
    expect(status.oldestPendingDeliveryAt).toEqual(
      new Date("2026-01-01T00:01:00Z"),
    );
    expect(status.oldestDueDeliveryAt).toEqual(
      new Date("2026-01-01T00:01:00Z"),
    );
    expect(status.services).toMatchObject([
      { id: "retry", pendingCount: 1, lastFailureCode: "OFFLINE" },
      { id: "success", pendingCount: 0, lastSuccessAt: now },
      { id: "terminal", pendingCount: 0, lastFailureCode: "REJECTED" },
    ]);
    database.close();
  });

  it("records thrown transport errors and reports a retryable failure", async () => {
    const database = new AlertDatabase();
    const transport: NotificationTransport = {
      type: "test",
      send: vi.fn(async () => {
        throw new Error("transport crashed");
      }),
    };
    new AlertLifecycle(database, ["test"]).ingest({
      sourceKey: "notifications.transport-error",
      path: "notifications.transport-error",
      severity: "alarm",
      state: "active",
    });
    const scheduler = new DeliveryScheduler(
      database,
      new Map([["test", transport]]),
      { initialSeconds: 60, maxSeconds: 60, multiplier: 1, jitter: 0 },
    );

    await expect(
      scheduler.runOnce(new Date("2026-01-01T00:00:00Z")),
    ).resolves.toMatchObject({
      processed: 1,
      succeeded: 0,
      retryableFailures: 1,
      terminalFailures: 0,
    });
    expect(database.listDeliveries()[0]).toMatchObject({
      state: "failed_retryable",
      lastErrorCode: "TRANSPORT_ERROR",
      lastErrorMessage: "transport crashed",
    });
    database.close();
  });

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
