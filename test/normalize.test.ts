import { describe, expect, it } from "vitest";
import { normalizeNotification } from "../src/alerts/normalize";

describe("normalizeNotification", () => {
  it("uses the path alone as the source key when no source is given", () => {
    const alert = normalizeNotification("notifications.navigation.gnss", {
      state: "alarm",
    });
    expect(alert.sourceKey).toBe("notifications.navigation.gnss");
    expect(alert.path).toBe("notifications.navigation.gnss");
  });

  it("keys distinct sources on the same path separately", () => {
    const first = normalizeNotification(
      "notifications.navigation.gnss",
      { state: "alarm" },
      "gps1",
    );
    const second = normalizeNotification(
      "notifications.navigation.gnss",
      { state: "alarm" },
      "gps2",
    );

    expect(first.sourceKey).not.toBe(second.sourceKey);
    expect(first.path).toBe(second.path);
  });

  it("keeps the same source key for repeated updates from one source", () => {
    const first = normalizeNotification(
      "notifications.navigation.gnss",
      { state: "warn" },
      "gps1",
    );
    const second = normalizeNotification(
      "notifications.navigation.gnss",
      { state: "alarm" },
      "gps1",
    );

    expect(first.sourceKey).toBe(second.sourceKey);
  });

  it("treats a null Signal K notification value as a clear", () => {
    const alert = normalizeNotification(
      "notifications.navigation.gnss",
      null,
      "gps1",
      new Date("2026-09-07T00:00:00.000Z"),
    );

    expect(alert.state).toBe("cleared");
    expect(alert.severity).toBe("normal");
    expect(alert.sourcePayload).toBeNull();
    expect(alert.sourceTimestamp?.toISOString()).toBe(
      "2026-09-07T00:00:00.000Z",
    );
  });

  it("treats Signal K normal as a clear", () => {
    const alert = normalizeNotification("notifications.navigation.gnss", {
      state: "normal",
      message: "Position available",
    });

    expect(alert.state).toBe("cleared");
    expect(alert.severity).toBe("normal");
  });

  it("retains Signal K acknowledgement status", () => {
    const alert = normalizeNotification("notifications.navigation.gnss", {
      state: "alarm",
      status: { acknowledged: true },
    });

    expect(alert.acknowledged).toBe(true);
  });
});
