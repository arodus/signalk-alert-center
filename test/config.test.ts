import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { pluginConfigSchema } from "../src/config-schema";

describe("validateConfig", () => {
  it("exposes only global settings in the Signal K plugin form", () => {
    expect(pluginConfigSchema.properties).not.toHaveProperty("rules");
    const variants = pluginConfigSchema.properties.notifiers.items.oneOf;
    expect(pluginConfigSchema.properties.notifiers.type).toBe("array");
    expect(variants).toHaveLength(3);
    expect(
      variants.every((variant) =>
        Object.hasOwn(variant.properties, "minSeverity"),
      ),
    ).toBe(true);
    expect(variants.map((variant) => variant.title)).toEqual([
      "ntfy",
      "PagerDuty",
      "Discord",
    ]);
  });

  it("rejects zone refresh intervals below one second", () => {
    expect(() =>
      validateConfig({ discovery: { zoneRefreshSeconds: 0 } }),
    ).toThrow("discovery.zoneRefreshSeconds must be at least 1");
  });

  it("rejects invalid notifier credentials", () => {
    expect(() =>
      validateConfig({
        notifiers: [
          {
            name: "Main ntfy",
            type: "ntfy",
            server: "http://localhost",
            topic: "",
          },
        ],
      }),
    ).toThrow("requires an ntfy topic");
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
        notifiers: [
          {
            name: "local",
            type: "ntfy",
            server: "http://localhost",
            topic: "test",
            minSeverity: "alarm",
          },
        ],
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
        notifiers: [
          {
            name: "local",
            type: "ntfy",
            server: "http://localhost",
            topic: "test",
            minSeverity: "critical" as "alarm",
          },
        ],
      }),
    ).toThrow(/invalid minimum severity/);
  });

  it("requires unique, user-facing notification service names", () => {
    expect(() =>
      validateConfig({
        notifiers: [
          {
            name: "Crew phone",
            type: "ntfy",
            server: "https://ntfy.sh",
            topic: "crew",
          },
          {
            name: "crew PHONE",
            type: "discord",
            webhookUrl: "https://discord.com/api/webhooks/example",
          },
        ],
      }),
    ).toThrow(/name must be unique/);
  });

  it("explains the obsolete map format instead of throwing a runtime type error", () => {
    expect(() =>
      validateConfig({
        notifiers: {} as never,
      }),
    ).toThrow(/must be configured as a list/);
  });
});
