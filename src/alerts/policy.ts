import { PluginConfig } from "../config";
import { AlertDatabase } from "../storage/db";
import {
  AlertAudioPolicy,
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
  audio: AlertAudioPolicy;
  provenance: "override" | "default";
}

export const pathDefinitionId = (notificationPath: string): string =>
  `path:${notificationPath}`;

export class AlertPolicyResolver {
  constructor(
    private readonly database: AlertDatabase,
    private readonly config: PluginConfig,
  ) {}

  private defaults(): EffectivePolicy {
    const audio = this.config.audio?.defaults;
    return {
      enabled: this.config.defaults?.enabled ?? true,
      oneTime: this.config.defaults?.oneTime ?? false,
      minimumSeverity: this.config.defaults?.minSeverity ?? "normal",
      activationDelaySeconds: this.config.defaults?.activationDelaySeconds ?? 0,
      rearmAfterSeconds: this.config.defaults?.rearmAfterSeconds,
      connectivity: this.config.defaults?.connectivity ?? { mode: "queue" },
      notifierIds: [...(this.config.defaults?.notifiers ?? [])],
      audio: {
        enabled: audio?.enabled ?? false,
        sound: audio?.sound ?? "severity",
        minimumSeverity: audio?.minimumSeverity ?? "warn",
        mode: audio?.mode ?? "once",
        repeatIntervalSeconds: audio?.repeatIntervalSeconds ?? 60,
        stopOn: {
          clear: audio?.stopOn?.clear ?? true,
          acknowledge: audio?.stopOn?.acknowledge ?? true,
          silence: audio?.stopOn?.silence ?? true,
          dismiss: audio?.stopOn?.dismiss ?? true,
        },
      },
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
      audio: stored.audio ?? base.audio,
      provenance: "override",
    };
  }

  forPath(path: string, _severity?: Severity): EffectivePolicy {
    return this.applyStored(
      this.defaults(),
      this.database.getPolicy(pathDefinitionId(path)),
    );
  }

  forDefinition(definition: AlertDefinitionRecord): EffectivePolicy {
    return this.forPath(definition.pathPattern);
  }

  seedDefinitions(zones: ConfiguredZonePath[]): void {
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
    } catch {}
    this.database.upsertDefinition({
      id,
      sourceType: "recognized",
      pathPattern: path,
      name: path,
    });
    return id;
  }
}
