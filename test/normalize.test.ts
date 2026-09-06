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
});
