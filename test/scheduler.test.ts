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

  it("records a fast success while another notifier is still in flight", async () => {
    const database = new AlertDatabase();
    let releaseSlow!: () => void;
    const slowFinished = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const lifecycle = new AlertLifecycle(database, ["slow", "fast"]);
    lifecycle.ingest({
      sourceKey: "notifications.concurrent",
      path: "notifications.concurrent",
      severity: "alarm",
      state: "active",
    });
    const scheduler = new DeliveryScheduler(
      database,
      new Map([
        [
          "slow",
          {
            type: "test",
            async send() {
              markSlowStarted();
              await slowFinished;
              return { kind: "success" as const };
            },
          },
        ],
        [
          "fast",
          {
            type: "test",
            send: vi.fn(async () => ({ kind: "success" as const })),
          },
        ],
      ]),
      undefined,
      { concurrency: 2 },
    );

    const running = scheduler.runOnce(new Date("2026-01-01T00:00:00Z"));
    await slowStarted;
    await vi.waitFor(() => {
      expect(
        database
          .listDeliveries()
          .find((delivery) => delivery.transportInstanceId === "fast")?.state,
      ).toBe("delivered");
    });
    expect(
      database
        .listDeliveries()
        .find((delivery) => delivery.transportInstanceId === "slow")?.state,
    ).toBe("sending");

    releaseSlow();
    await running;
    database.close();
  });

  it("bounds simultaneous sends and records mixed outcomes independently", async () => {
    const database = new AlertDatabase();
    const notifierIds = ["success", "retry", "terminal", "timeout", "throw"];
    new AlertLifecycle(database, notifierIds).ingest({
      sourceKey: "notifications.mixed",
      path: "notifications.mixed",
      severity: "alarm",
      state: "active",
    });
    let active = 0;
    let maximumActive = 0;
    const result = async <T>(value: T): Promise<T> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value;
    };
    const scheduler = new DeliveryScheduler(
      database,
      new Map([
        [
          "success",
          { type: "test", send: () => result({ kind: "success" as const }) },
        ],
        [
          "retry",
          {
            type: "test",
            send: () =>
              result({
                kind: "retryable" as const,
                code: "OFFLINE",
                message: "offline",
              }),
          },
        ],
        [
          "terminal",
          {
            type: "test",
            send: () =>
              result({
                kind: "terminal" as const,
                code: "REJECTED",
                message: "rejected",
              }),
          },
        ],
        [
          "timeout",
          {
            type: "test",
            send: () =>
              result({
                kind: "retryable" as const,
                code: "TIMEOUT",
                message: "timed out",
              }),
          },
        ],
        [
          "throw",
          {
            type: "test",
            async send() {
              await result(undefined);
              throw new Error("adapter crashed");
            },
          },
        ],
      ]),
      { initialSeconds: 60, maxSeconds: 60, multiplier: 1, jitter: 0 },
      { batchSize: 5, concurrency: 2 },
    );

    await expect(
      scheduler.runOnce(new Date("2026-01-01T00:00:00Z")),
    ).resolves.toEqual({
      processed: 5,
      succeeded: 1,
      retryableFailures: 3,
      terminalFailures: 1,
    });
    expect(maximumActive).toBe(2);
    expect(
      Object.fromEntries(
        database
          .listDeliveries()
          .map((delivery) => [delivery.transportInstanceId, delivery.state]),
      ),
    ).toEqual({
      success: "delivered",
      retry: "failed_retryable",
      terminal: "failed_terminal",
      timeout: "failed_retryable",
      throw: "failed_retryable",
    });
    database.close();
  });

  it("loads no more than the configured due batch size", async () => {
    const database = new AlertDatabase();
    const notifierIds = ["one", "two", "three"];
    new AlertLifecycle(database, notifierIds).ingest({
      sourceKey: "notifications.batch-limit",
      path: "notifications.batch-limit",
      severity: "alarm",
      state: "active",
    });
    const send = vi.fn(async () => ({ kind: "success" as const }));
    const scheduler = new DeliveryScheduler(
      database,
      new Map(
        notifierIds.map((id) => [
          id,
          { type: "test", send } satisfies NotificationTransport,
        ]),
      ),
      undefined,
      { batchSize: 2, concurrency: 2 },
    );

    await expect(
      scheduler.runOnce(new Date("2026-01-01T00:00:00Z")),
    ).resolves.toMatchObject({ processed: 2, succeeded: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      database
        .listDeliveries()
        .filter((delivery) => delivery.state === "pending"),
    ).toHaveLength(1);

    await scheduler.runOnce(new Date("2026-01-01T00:00:00Z"));
    expect(send).toHaveBeenCalledTimes(3);
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

  it("waits for every in-flight send before stop returns", async () => {
    const database = new AlertDatabase();
    let resolveFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecond!: () => void;
    const secondFinished = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const lifecycle = new AlertLifecycle(database, ["first", "second"]);
    lifecycle.ingest({
      sourceKey: "notifications.test",
      path: "notifications.test",
      severity: "alarm",
      state: "active",
    });
    const scheduler = new DeliveryScheduler(
      database,
      new Map([
        [
          "first",
          {
            type: "test",
            async send() {
              await firstFinished;
              return { kind: "success" as const };
            },
          },
        ],
        [
          "second",
          {
            type: "test",
            async send() {
              await secondFinished;
              return { kind: "success" as const };
            },
          },
        ],
      ]),
    );

    const sending = scheduler.runOnce();
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveFirst();
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveSecond();
    await Promise.all([sending, stopping]);
    expect(stopped).toBe(true);
    expect(
      database
        .listDeliveries()
        .every((delivery) => delivery.state === "delivered"),
    ).toBe(true);
    database.close();
  });
});
