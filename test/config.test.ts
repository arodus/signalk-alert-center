import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { pluginConfigSchema } from "../src/config-schema";

describe("validateConfig", () => {
  it("exposes only global settings in the Signal K plugin form", () => {
    expect(pluginConfigSchema.properties).not.toHaveProperty("rules");
    expect(
      pluginConfigSchema.properties.notifiers.additionalProperties.properties,
    ).toHaveProperty("minSeverity");
  });

  it("rejects zone refresh intervals below one second", () => {
    expect(() =>
      validateConfig({ discovery: { zoneRefreshSeconds: 0 } }),
    ).toThrow("discovery.zoneRefreshSeconds must be at least 1");
  });

  it("rejects invalid notifier credentials", () => {
    expect(() =>
      validateConfig({
        notifiers: {
          "ntfy-main": { type: "ntfy", server: "http://localhost", topic: "" },
        },
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
          local: {
            type: "ntfy",
            server: "http://localhost",
            topic: "test",
            minSeverity: "alarm",
          },
        },
        defaults: {
          activationDelaySeconds: 10,
          minSeverity: "warn",
          notifiers: ["local"],
        },
      }),
    ).not.toThrow();

    expect(() =>
      validateConfig({
        defaults: { activationDelaySeconds: -1 },
      }),
    ).toThrow(/activation delay must be non-negative/);

    expect(() =>
      validateConfig({
        notifiers: {
          local: {
            type: "ntfy",
            server: "http://localhost",
            topic: "test",
            minSeverity: "critical" as "alarm",
          },
        },
      }),
    ).toThrow(/invalid minimum severity/);
  });
});
