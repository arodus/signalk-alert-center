import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { pluginConfigSchema } from "../src/config-schema";

describe("validateConfig", () => {
  it("exposes only global settings in the Signal K plugin form", () => {
    expect(pluginConfigSchema.properties).not.toHaveProperty("rules");
    expect(pluginConfigSchema.properties).not.toHaveProperty("audio");
    const notifierItems = pluginConfigSchema.properties.notifiers.items;
    const variants = notifierItems.dependencies.type.oneOf;
    expect(pluginConfigSchema.properties.notifiers.type).toBe("array");
    expect(variants).toHaveLength(3);
    expect(notifierItems.properties.type.enum).toEqual([
      "ntfy",
      "pagerduty",
      "discord",
    ]);
    expect(notifierItems.properties.type.default).toBe("ntfy");
    expect(variants.map((variant) => variant.properties.type.enum[0])).toEqual([
      "ntfy",
      "pagerduty",
      "discord",
    ]);
  });

  it("uses a public endpoint suitable for the HEAD-based Internet probe", () => {
    expect(
      pluginConfigSchema.properties.connectivity.properties.probe.properties.url
        .default,
    ).toBe("https://www.gstatic.com/generate_204");
  });

  it("uses a portable database filename by default", () => {
    const storagePath = pluginConfigSchema.properties.storage.properties.path;
    expect(storagePath.default).toBe("persistent-notifier.sqlite");
    expect(storagePath.description).toContain("Signal K's data directory");
  });

  it("rejects zone refresh intervals below one second", () => {
    expect(() =>
      validateConfig({ discovery: { zoneRefreshSeconds: 0 } }),
    ).toThrow("discovery.zoneRefreshSeconds must be at least 1");
  });

  it("keeps retention opt-in and validates bounded cleanup batches", () => {
    const retention = pluginConfigSchema.properties.retention;
    expect(retention.properties.enabled.default).toBe(false);
    expect(retention.properties.maxAgeDays.default).toBe(365);
    expect(() =>
      validateConfig({ retention: { enabled: true, batchSize: 100 } }),
    ).not.toThrow();
    expect(() =>
      validateConfig({ retention: { enabled: true, maxAgeDays: 0 } }),
    ).toThrow("retention.maxAgeDays");
    expect(() =>
      validateConfig({ retention: { enabled: true, batchSize: 1001 } }),
    ).toThrow("retention.batchSize");
  });

  it("exposes and validates bounded delivery concurrency", () => {
    const delivery = pluginConfigSchema.properties.delivery;
    expect(delivery.properties.batchSize.default).toBe(50);
    expect(delivery.properties.concurrency.default).toBe(4);
    expect(delivery.properties.requestTimeoutSeconds.default).toBe(15);
    expect(() =>
      validateConfig({
        delivery: {
          batchSize: 200,
          concurrency: 32,
          requestTimeoutSeconds: 15,
        },
      }),
    ).not.toThrow();
    expect(() => validateConfig({ delivery: { batchSize: 201 } })).toThrow(
      "delivery.batchSize",
    );
    expect(() => validateConfig({ delivery: { concurrency: 0 } })).toThrow(
      "delivery.concurrency",
    );
    expect(() =>
      validateConfig({ delivery: { requestTimeoutSeconds: 301 } }),
    ).toThrow("delivery.requestTimeoutSeconds");
  });

  it("exposes and validates a bounded notification ingestion queue", () => {
    const ingestion = pluginConfigSchema.properties.ingestion;
    expect(ingestion.properties.queueLimit.default).toBe(2000);
    expect(ingestion.properties.batchSize.default).toBe(100);
    expect(() =>
      validateConfig({ ingestion: { queueLimit: 100, batchSize: 25 } }),
    ).not.toThrow();
    expect(() =>
      validateConfig({ ingestion: { queueLimit: 9, batchSize: 2 } }),
    ).toThrow("ingestion.queueLimit");
    expect(() =>
      validateConfig({ ingestion: { queueLimit: 10, batchSize: 11 } }),
    ).toThrow("must not exceed");
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
