import { describe, expect, it } from "vitest";
import {
  isServiceHealthPath,
  serviceHealthMessage,
  serviceHealthPath,
  serviceHealthState,
} from "../src/signalk/service-health";

describe("notification service health", () => {
  it("maps retrying and terminal failures to Signal K severity", () => {
    const healthy = {
      id: "crew",
      name: "Crew",
      type: "ntfy",
      retryingFailureCount: 0,
      terminalFailureCount: 0,
    };
    expect(serviceHealthState(healthy)).toBe("normal");
    expect(serviceHealthMessage(healthy)).toBe(
      "Crew notification delivery is operating normally.",
    );
    expect(serviceHealthState({ ...healthy, retryingFailureCount: 2 })).toBe(
      "alert",
    );
    expect(
      serviceHealthState({
        ...healthy,
        retryingFailureCount: 2,
        terminalFailureCount: 1,
      }),
    ).toBe("warn");
  });

  it("creates stable Signal K paths for simple and human-readable names", () => {
    expect(serviceHealthPath("crew")).toBe(
      "notifications.plugins.signalkAlertCenter.services.crew",
    );
    const path = serviceHealthPath("Cabin audio");
    expect(path).toMatch(
      /^notifications\.plugins\.signalkAlertCenter\.services\.Cabinaudio[0-9a-f]{8}$/,
    );
    expect(isServiceHealthPath(path)).toBe(true);
    expect(isServiceHealthPath("notifications.navigation.anchor")).toBe(false);
  });
});
