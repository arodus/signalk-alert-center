import { describe, expect, it } from "vitest";
import { BoundedIngestionQueue } from "../src/signalk/ingestion-queue";

const entry = (state: string, message = state, timestamp = 0) => ({
  path: "notifications.test.bilge",
  source: "fixture",
  sourceTimestamp: new Date(timestamp),
  value: { state, message },
});

describe("BoundedIngestionQueue", () => {
  it("coalesces equivalent pending updates and retains the latest payload", () => {
    const queue = new BoundedIngestionQueue(3);
    expect(queue.enqueue(entry("alarm", "Flooding", 1))).toBe("queued");
    expect(queue.enqueue(entry("alarm", "Flooding", 2))).toBe("coalesced");

    expect(queue.stats()).toMatchObject({
      depth: 1,
      received: 2,
      coalesced: 1,
      rejected: 0,
    });
    expect(queue.take(10)[0].sourceTimestamp).toEqual(new Date(2));
  });

  it("preserves state, severity, and message transitions in source order", () => {
    const queue = new BoundedIngestionQueue(10);
    queue.enqueue(entry("warn", "Rising"));
    queue.enqueue(entry("alarm", "Rising"));
    queue.enqueue(entry("alarm", "Flooding"));
    queue.enqueue({ ...entry("normal"), value: null });
    queue.enqueue(entry("alarm", "Flooding again"));

    expect(queue.take(10).map((item) => item.value)).toEqual([
      { state: "warn", message: "Rising" },
      { state: "alarm", message: "Rising" },
      { state: "alarm", message: "Flooding" },
      null,
      { state: "alarm", message: "Flooding again" },
    ]);
  });

  it("snapshots values that an upstream producer mutates after enqueue", () => {
    const queue = new BoundedIngestionQueue(10);
    const value = { state: "alarm", message: "Original" };
    queue.enqueue({ ...entry("alarm"), value });

    value.state = "normal";
    value.message = "Mutated";

    expect(queue.take(1)[0].value).toEqual({
      state: "alarm",
      message: "Original",
    });
  });

  it("never grows beyond its limit and reports rejected transitions", () => {
    const queue = new BoundedIngestionQueue(2);
    queue.enqueue(entry("warn"));
    queue.enqueue(entry("alarm"));
    expect(queue.enqueue({ ...entry("normal"), value: null })).toBe("rejected");
    expect(queue.stats()).toMatchObject({
      depth: 2,
      highWaterMark: 2,
      rejected: 1,
    });
  });

  it("keeps bounded storage during a large stream of duplicates", () => {
    const queue = new BoundedIngestionQueue(100);
    for (let index = 0; index < 100_000; index += 1)
      queue.enqueue(entry("alarm", "Flooding", index));

    expect(queue.stats()).toEqual({
      depth: 1,
      limit: 100,
      highWaterMark: 1,
      received: 100_000,
      processed: 0,
      coalesced: 99_999,
      rejected: 0,
    });
  });
});
