import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AlertPolicyResolver } from "../src/alerts/policy";
import { ruleDefinition, ruleDefinitionId } from "../src/signalk/alert-rules";
import { normalizeCoreAlert } from "../src/signalk/core-alerts";
import { AlertDatabase } from "../src/storage/db";
import { coreFixture } from "./fixtures/core-alert";

it("applies a saved rule policy to first and future wildcard instances after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "rule-policy-"));
  const filename = join(directory, "alerts.sqlite");
  let db = new AlertDatabase(filename);
  try {
    const definition = ruleDefinition({
      slug: "battery-low",
      name: "Battery low",
      alertPath: "electrical.batteries.*.voltageLow",
    });
    db.setPolicy(
      definition.id,
      {
        notifierIds: ["crew"],
        notifierRepeatOverrides: {},
        activationDelaySeconds: 30,
        overrideFields: ["notifierIds", "activationDelaySeconds"],
      },
      new Date(),
      definition,
    );
    expect(db.listOccurrences()).toHaveLength(0);
    expect(db.listDeliveries()).toHaveLength(0);
    db.close();
    db = new AlertDatabase(filename);
    const resolver = new AlertPolicyResolver(db, {
      defaults: { notifiers: ["other"] },
    });
    for (const instance of ["house", "engine"]) {
      const normalized = normalizeCoreAlert(
        coreFixture({
          id: instance,
          path: `electrical.batteries.${instance}.voltageLow`,
          $source: "signalk-alert-rules",
          data: { rule: "battery-low", name: "Battery low", instance },
        }),
      );
      const id = resolver.ensureDefinitionForAlert(normalized);
      expect(id).toBe(ruleDefinitionId("battery-low"));
      const policy = resolver.forDefinition(db.getDefinition(id));
      expect(policy).toMatchObject({
        notifierIds: ["crew"],
        activationDelaySeconds: 30,
      });
      db.ingest(normalized, policy.notifierIds, new Date(), {
        definitionId: id,
        activationDelaySeconds: policy.activationDelaySeconds,
      });
    }
    expect(db.listDefinitions()).toHaveLength(1);
    expect(db.listOccurrences()).toHaveLength(2);
    expect(db.getDefinition(definition.id).pathPattern).toBe(
      "alerts.electrical.batteries.*.voltageLow",
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("does not assign another producer or a legacy notification to a rule policy", () => {
  const db = new AlertDatabase();
  try {
    const resolver = new AlertPolicyResolver(db, {});
    const alert = normalizeCoreAlert(
      coreFixture({
        $source: "another-producer",
        data: { rule: "battery-low" },
      }),
    );
    expect(resolver.ensureDefinitionForAlert(alert)).toBe(`path:${alert.path}`);
    expect(
      resolver.ensureDefinitionForAlert({
        ...alert,
        coreAlert: undefined,
        path: "notifications.battery.low",
      }),
    ).toBe("path:notifications.battery.low");
  } finally {
    db.close();
  }
});
