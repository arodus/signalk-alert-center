import { describe, expect, it } from "vitest";
import { AlertPolicyResolver, pathDefinitionId } from "../src/alerts/policy";
import { PluginConfig } from "../src/config";
import { AlertDatabase } from "../src/storage/db";

describe("AlertPolicyResolver", () => {
  it("uses global defaults until a discovered alert gets a dashboard override", () => {
    const database = new AlertDatabase();
    const config: PluginConfig = {
      notifiers: {
        primary: { type: "ntfy", server: "http://ntfy", topic: "boat" },
      },
      defaults: { minSeverity: "warn", notifiers: ["primary"] },
    };
    const resolver = new AlertPolicyResolver(database, config);
    resolver.seedDefinitions([]);

    expect(
      resolver.ensureDefinitionForPath("notifications.navigation.anchor"),
    ).toBe(pathDefinitionId("notifications.navigation.anchor"));
    expect(
      resolver.forPath("notifications.navigation.anchor", "warn"),
    ).toMatchObject({
      minimumSeverity: "warn",
      notifierIds: ["primary"],
      provenance: "default",
    });
    database.setPolicy(pathDefinitionId("notifications.navigation.anchor"), {
      enabled: false,
      notifierIds: [],
    });
    expect(
      resolver.forPath("notifications.navigation.anchor", "alarm"),
    ).toMatchObject({ enabled: false, provenance: "override" });
    expect(database.listDefinitions()).toHaveLength(1);
    database.close();
  });
});
