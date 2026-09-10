import { describe, expect, it } from "vitest";
import { AlertPolicyResolver, pathDefinitionId } from "../src/alerts/policy";
import { PluginConfig } from "../src/config";
import { AlertDatabase } from "../src/storage/db";

describe("AlertPolicyResolver", () => {
  it("uses global defaults until a discovered alert gets a dashboard override", () => {
    const database = new AlertDatabase();
    const config: PluginConfig = {
      notifiers: [
        {
          name: "primary",
          type: "ntfy",
          server: "http://ntfy",
          topic: "boat",
        },
      ],
      defaults: { minSeverity: "warn", notifiers: ["primary"] },
      audio: {
        defaults: {
          enabled: true,
          minimumSeverity: "alert",
          mode: "once",
        },
      },
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
      audio: { enabled: true, sound: "severity", minimumSeverity: "alert" },
      provenance: "default",
    });
    database.setPolicy(pathDefinitionId("notifications.navigation.anchor"), {
      enabled: false,
      notifierIds: [],
      audio: {
        enabled: true,
        sound: "alarm",
        minimumSeverity: "alarm",
        mode: "repeat",
        repeatIntervalSeconds: 30,
        stopOn: {
          clear: true,
          acknowledge: true,
          silence: true,
          dismiss: true,
        },
      },
    });
    expect(
      resolver.forPath("notifications.navigation.anchor", "alarm"),
    ).toMatchObject({
      enabled: false,
      audio: { sound: "alarm", mode: "repeat" },
      provenance: "override",
    });
    expect(database.listDefinitions()).toHaveLength(1);
    database.close();
  });
});
