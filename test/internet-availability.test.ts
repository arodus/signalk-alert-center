import { afterEach, describe, expect, it, vi } from "vitest";
import { InternetAvailabilityMonitor } from "../src/connectivity/availability";

describe("Internet availability monitoring", () => {
  const monitors: InternetAvailabilityMonitor[] = [];

  afterEach(() => {
    for (const monitor of monitors) monitor.stop();
    monitors.length = 0;
    vi.useRealTimers();
  });

  it("reports state changes and stops polling after Internet returns", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const changes: string[] = [];
    const monitor = new InternetAvailabilityMonitor(probe, 1_000, ({ state }) =>
      changes.push(state),
    );
    monitors.push(monitor);

    await expect(monitor.checkNow()).resolves.toBe(false);
    monitor.watchOffline();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(monitor.state).toBe("online");
    expect(changes).toEqual(["offline", "online"]);
  });

  it("accepts successful deliveries as proof of Internet availability", () => {
    const monitor = new InternetAvailabilityMonitor(
      async () => false,
      1_000,
      () => undefined,
    );
    monitors.push(monitor);

    monitor.record(true, new Date("2026-10-19T08:00:00Z"));

    expect(monitor.status()).toEqual({
      state: "online",
      lastCheckedAt: new Date("2026-10-19T08:00:00Z"),
    });
  });
});
