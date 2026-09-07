import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";

describe("validateConfig", () => {
  it("rejects zone refresh intervals below one second", () => {
    expect(() =>
      validateConfig({ discovery: { zoneRefreshSeconds: 0 } }),
    ).toThrow("discovery.zoneRefreshSeconds must be at least 1");
  });

  it("rejects invalid notifier credentials and rule references", () => {
    expect(() =>
      validateConfig({
        notifiers: {
          "ntfy-main": { type: "ntfy", server: "http://localhost", topic: "" },
        },
        rules: [
          {
            match: "notifications.*",
            minSeverity: "warn",
            connectivity: { mode: "queue" },
            notifiers: ["missing"],
          },
        ],
      }),
    ).toThrow("requires topic");
  });

  it("rejects invalid retry ranges and incomplete connectivity config", () => {
    expect(() =>
      validateConfig({ retry: { initialSeconds: 20, maxSeconds: 10 } }),
    ).toThrow("maxSeconds");
    expect(() => validateConfig({ connectivity: { enabled: true } })).toThrow(
      "switch configuration",
    );
    expect(() =>
      validateConfig({
        connectivity: {
          enabled: true,
          switch: { path: "switch", onValue: 1, offValue: 0 },
        },
      }),
    ).toThrow("Internet probe");
  });

  it("accepts non-negative activation delays and rejects invalid policies", () => {
    expect(() =>
      validateConfig({
        notifiers: {
          local: { type: "ntfy", server: "http://localhost", topic: "test" },
        },
        defaults: {
          activationDelaySeconds: 10,
          minSeverity: "warn",
          notifiers: ["local"],
        },
        rules: [
          {
            match: "notifications.bilge.*",
            minSeverity: "alarm",
            activationDelaySeconds: 30,
            connectivity: { mode: "queue" },
            notifiers: ["local"],
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      validateConfig({
        defaults: { activationDelaySeconds: -1 },
      }),
    ).toThrow(/activation delay must be non-negative/);
  });
});
