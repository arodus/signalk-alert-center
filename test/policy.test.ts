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
      overrideFields: [
        "enabled",
        "notifierIds",
        "audio.enabled",
        "audio.sound",
        "audio.minimumSeverity",
        "audio.mode",
        "audio.repeatIntervalSeconds",
        "audio.stopOn.clear",
        "audio.stopOn.acknowledge",
        "audio.stopOn.silence",
        "audio.stopOn.dismiss",
      ],
    });
    expect(
      resolver.forPath("notifications.navigation.anchor", "alarm"),
    ).toMatchObject({
      enabled: false,
      audio: { sound: "alarm", mode: "repeat" },
      provenance: "partial",
    });
    expect(database.listDefinitions()).toHaveLength(1);
    database.close();
  });

  it("keeps inherited fields live while preserving partial and empty-list overrides", () => {
    const database = new AlertDatabase();
    const config: PluginConfig = {
      defaults: {
        minSeverity: "warn",
        activationDelaySeconds: 5,
        notifiers: ["primary"],
      },
      audio: {
        defaults: { enabled: true, sound: "severity", mode: "once" },
      },
    };
    const path = "notifications.environment.inside.refrigerator.temperature";
    const definitionId = pathDefinitionId(path);
    const resolver = new AlertPolicyResolver(database, config);
    resolver.ensureDefinitionForPath(path);

    database.setPolicy(definitionId, {
      minimumSeverity: "alert",
      notifierIds: [],
      audio: {
        enabled: true,
        sound: "alarm",
        minimumSeverity: "warn",
        mode: "once",
        repeatIntervalSeconds: 60,
        stopOn: {
          clear: true,
          acknowledge: true,
          silence: true,
          dismiss: true,
        },
      },
      overrideFields: ["minimumSeverity", "notifierIds", "audio.sound"],
    });
    expect(resolver.forPath(path)).toMatchObject({
      minimumSeverity: "alert",
      activationDelaySeconds: 5,
      notifierIds: [],
      audio: { sound: "alarm", mode: "once" },
      provenance: "partial",
      overriddenFields: ["minimumSeverity", "notifierIds", "audio.sound"],
    });

    config.defaults = {
      minSeverity: "emergency",
      activationDelaySeconds: 45,
      notifiers: ["secondary"],
    };
    config.audio = {
      defaults: { enabled: true, sound: "warning", mode: "repeat" },
    };
    expect(resolver.forPath(path)).toMatchObject({
      minimumSeverity: "alert",
      activationDelaySeconds: 45,
      notifierIds: [],
      audio: { sound: "alarm", mode: "repeat" },
      defaults: {
        minimumSeverity: "emergency",
        activationDelaySeconds: 45,
        notifierIds: ["secondary"],
      },
    });

    expect(database.clearPolicy(definitionId)).toBe(true);
    expect(resolver.forPath(path)).toMatchObject({
      minimumSeverity: "emergency",
      activationDelaySeconds: 45,
      notifierIds: ["secondary"],
      provenance: "default",
      overriddenFields: [],
    });
    expect(database.getDefinition(definitionId)).toBeDefined();

    const inherited = resolver.forPath(path);
    const first = database.ingest(
      {
        sourceKey: path,
        path,
        state: "active",
        severity: "emergency",
        message: "Warm",
      },
      inherited.notifierIds,
      new Date("2026-09-11T10:00:00.000Z"),
      {
        definitionId,
        minimumSeverity: inherited.minimumSeverity,
        activationDelaySeconds: inherited.activationDelaySeconds,
      },
    )!;
    database.ingest(
      {
        sourceKey: path,
        path,
        state: "cleared",
        severity: "normal",
      },
      inherited.notifierIds,
      new Date("2026-09-11T10:01:00.000Z"),
      { definitionId },
    );
    config.defaults = {
      minSeverity: "normal",
      activationDelaySeconds: 2,
      notifiers: ["third"],
    };
    const changed = resolver.forPath(path);
    const second = database.ingest(
      {
        sourceKey: path,
        path,
        state: "active",
        severity: "warn",
        message: "Warm again",
      },
      changed.notifierIds,
      new Date("2026-09-11T10:02:00.000Z"),
      {
        definitionId,
        minimumSeverity: changed.minimumSeverity,
        activationDelaySeconds: changed.activationDelaySeconds,
      },
    )!;
    expect(database.getAlert(first.id)).toMatchObject({
      minimumSeverity: "emergency",
      activationDelaySeconds: 45,
    });
    expect(second).toMatchObject({
      minimumSeverity: "normal",
      activationDelaySeconds: 2,
    });
    database.setPolicy(definitionId, {
      enabled: false,
      notifierIds: [],
      overrideFields: ["enabled", "notifierIds"],
    });
    expect(database.clearPolicy(definitionId)).toBe(true);
    expect(database.listOccurrences()).toHaveLength(2);
    expect(database.getDefinition(definitionId)).toBeDefined();
    database.close();
  });
});
