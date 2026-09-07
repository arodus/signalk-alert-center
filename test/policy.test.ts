import { describe, expect, it } from "vitest";
import { AlertPolicyResolver, ruleDefinitionId } from "../src/alerts/policy";
import { PluginConfig } from "../src/config";
import { AlertDatabase } from "../src/storage/db";

describe("AlertPolicyResolver", () => {
  it("uses a matching rule as owner and retains notifier candidates below threshold", () => {
    const database = new AlertDatabase();
    const config: PluginConfig = {
      notifiers: {
        primary: { type: "ntfy", server: "http://ntfy", topic: "boat" },
      },
      rules: [
        {
          id: "navigation",
          match: "notifications.navigation.*",
          minSeverity: "alarm",
          connectivity: { mode: "queue" },
          notifiers: ["primary"],
        },
      ],
    };
    const resolver = new AlertPolicyResolver(database, config);
    resolver.seedDefinitions([]);

    expect(
      resolver.ensureDefinitionForPath("notifications.navigation.anchor"),
    ).toBe(ruleDefinitionId(config.rules![0], 0));
    expect(
      resolver.forPath("notifications.navigation.anchor", "warn"),
    ).toMatchObject({
      minimumSeverity: "alarm",
      notifierIds: ["primary"],
    });
    expect(database.listDefinitions()).toHaveLength(1);
    database.close();
  });
});
