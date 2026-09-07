import picomatch from "picomatch";
import { PluginConfig, RuleConfig } from "../config";
import { AlertDatabase } from "../storage/db";
import {
  AlertDefinitionRecord,
  AlertPolicyRecord,
  ConnectivityMode,
  Severity,
} from "./types";
import { ConfiguredZonePath } from "./zones";

export interface EffectivePolicy {
  enabled: boolean;
  oneTime: boolean;
  minimumSeverity: Severity;
  activationDelaySeconds: number;
  rearmAfterSeconds?: number;
  connectivity: ConnectivityMode;
  notifierIds: string[];
  provenance: "override" | "rule" | "default";
}

export const pathDefinitionId = (notificationPath: string): string =>
  `path:${notificationPath}`;

export const ruleDefinitionId = (rule: RuleConfig, index: number): string =>
  `rule:${rule.id ?? index}`;

export class AlertPolicyResolver {
  constructor(
    private readonly database: AlertDatabase,
    private readonly config: PluginConfig,
  ) {}

  private defaults(): EffectivePolicy {
    return {
      enabled: this.config.defaults?.enabled ?? true,
      oneTime: this.config.defaults?.oneTime ?? false,
      minimumSeverity: this.config.defaults?.minSeverity ?? "normal",
      activationDelaySeconds: this.config.defaults?.activationDelaySeconds ?? 0,
      rearmAfterSeconds: this.config.defaults?.rearmAfterSeconds,
      connectivity: this.config.defaults?.connectivity ?? { mode: "queue" },
      notifierIds: [...(this.config.defaults?.notifiers ?? [])],
      provenance: "default",
    };
  }

  private applyStored(
    base: EffectivePolicy,
    stored: AlertPolicyRecord | undefined,
  ): EffectivePolicy {
    if (!stored) return base;
    return {
      enabled: stored.enabled ?? base.enabled,
      oneTime: stored.oneTime ?? base.oneTime,
      minimumSeverity: stored.minimumSeverity ?? base.minimumSeverity,
      activationDelaySeconds:
        stored.activationDelaySeconds ?? base.activationDelaySeconds,
      rearmAfterSeconds: stored.rearmAfterSeconds ?? base.rearmAfterSeconds,
      connectivity: stored.connectivity ?? base.connectivity,
      // A stored empty list intentionally disables remote delivery.
      notifierIds: [...stored.notifierIds],
      provenance: "override",
    };
  }

  forRule(rule: RuleConfig, index: number): EffectivePolicy {
    const configured: EffectivePolicy = {
      ...this.defaults(),
      enabled: rule.enabled !== false,
      oneTime: rule.oneTime === true,
      minimumSeverity: rule.minSeverity,
      activationDelaySeconds: rule.activationDelaySeconds ?? 0,
      rearmAfterSeconds: rule.rearmAfterSeconds,
      connectivity: rule.connectivity,
      notifierIds: [...rule.notifiers],
      provenance: "rule",
    };
    return this.applyStored(
      configured,
      this.database.getPolicy(ruleDefinitionId(rule, index)),
    );
  }

  forPath(path: string, _severity?: Severity): EffectivePolicy {
    let effective = this.defaults();
    const notifierIds = new Set(effective.notifierIds);

    for (const [index, rule] of (this.config.rules ?? []).entries()) {
      if (!picomatch(rule.match)(path)) continue;
      const candidate = this.forRule(rule, index);
      // Later matching rules retain the existing configuration precedence for
      // scalar fields. Eligible notifier targets are safely unioned.
      effective = { ...candidate, notifierIds: [...notifierIds] };
      if (candidate.enabled) {
        candidate.notifierIds.forEach((id) => notifierIds.add(id));
      }
      effective.notifierIds = [...notifierIds];
    }

    effective = this.applyStored(
      effective,
      this.database.getPolicy(pathDefinitionId(path)),
    );
    return effective;
  }

  forDefinition(definition: AlertDefinitionRecord): EffectivePolicy {
    const ruleIndex = (this.config.rules ?? []).findIndex(
      (rule, index) => ruleDefinitionId(rule, index) === definition.id,
    );
    return ruleIndex >= 0
      ? this.forRule(this.config.rules![ruleIndex], ruleIndex)
      : this.forPath(definition.pathPattern);
  }

  seedDefinitions(zones: ConfiguredZonePath[]): void {
    (this.config.rules ?? []).forEach((rule, index) => {
      this.database.upsertDefinition({
        id: ruleDefinitionId(rule, index),
        sourceType: "rule",
        pathPattern: rule.match,
        name: rule.name ?? rule.match,
        metadata: { zone: rule.zone },
      });
    });
    zones.forEach((zone) => {
      const path = `notifications.${zone.path}`;
      this.database.upsertDefinition({
        id: pathDefinitionId(path),
        sourceType: "zone",
        pathPattern: path,
        name: zone.description ?? zone.path,
        metadata: zone,
      });
    });
  }

  ensureDefinitionForPath(path: string): string {
    const id = pathDefinitionId(path);
    try {
      this.database.getDefinition(id);
      return id;
    } catch {
      // A configured rule owns paths that do not have a more-specific zone
      // definition. Later matching rules retain configuration precedence.
      let owningRule: string | undefined;
      (this.config.rules ?? []).forEach((rule, index) => {
        if (picomatch(rule.match)(path))
          owningRule = ruleDefinitionId(rule, index);
      });
      if (owningRule) return owningRule;
    }
    this.database.upsertDefinition({
      id,
      sourceType: "recognized",
      pathPattern: path,
      name: path,
    });
    return id;
  }
}
