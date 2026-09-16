import { PluginConfig } from "../config";
import { AlertDatabase } from "../storage/db";
import {
  AlertAudioPolicy,
  AlertDefinitionRecord,
  alertPolicyFields,
  AlertPolicyField,
  AlertPolicyRecord,
  ConnectivityMode,
  Severity,
} from "./types";
import { ConfiguredZonePath } from "./zones";

export interface PolicyValues {
  enabled: boolean;
  oneTime: boolean;
  minimumSeverity: Severity;
  activationDelaySeconds: number;
  rearmAfterSeconds?: number;
  connectivity: ConnectivityMode;
  notifierIds: string[];
  audio: AlertAudioPolicy;
}

export interface EffectivePolicy extends PolicyValues {
  provenance: "override" | "partial" | "default";
  overriddenFields: AlertPolicyField[];
  defaults: PolicyValues;
}

export const pathDefinitionId = (notificationPath: string): string =>
  `path:${notificationPath}`;

export class AlertPolicyResolver {
  constructor(
    private readonly database: AlertDatabase,
    private readonly config: PluginConfig,
  ) {}

  private defaults(): PolicyValues {
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
        },
      },
    };
  }

  private applyStored(
    base: PolicyValues,
    stored: AlertPolicyRecord | undefined,
  ): EffectivePolicy {
    const fields = new Set(stored?.overrideFields ?? []);
    const audio = {
      ...base.audio,
      stopOn: { ...base.audio.stopOn },
    };
    const effective: PolicyValues = {
      ...base,
      connectivity: { ...base.connectivity },
      notifierIds: [...base.notifierIds],
      audio,
    };
    if (stored) {
      if (fields.has("enabled") && stored.enabled !== undefined)
        effective.enabled = stored.enabled;
      if (fields.has("oneTime") && stored.oneTime !== undefined)
        effective.oneTime = stored.oneTime;
      if (fields.has("minimumSeverity") && stored.minimumSeverity)
        effective.minimumSeverity = stored.minimumSeverity;
      if (
        fields.has("activationDelaySeconds") &&
        stored.activationDelaySeconds !== undefined
      )
        effective.activationDelaySeconds = stored.activationDelaySeconds;
      if (fields.has("rearmAfterSeconds"))
        effective.rearmAfterSeconds = stored.rearmAfterSeconds;
      if (fields.has("connectivity") && stored.connectivity)
        effective.connectivity = stored.connectivity;
      // The mask distinguishes an explicit empty list from inheritance.
      if (fields.has("notifierIds"))
        effective.notifierIds = [...stored.notifierIds];
      if (stored.audio) {
        if (fields.has("audio.enabled")) audio.enabled = stored.audio.enabled;
        if (fields.has("audio.sound")) audio.sound = stored.audio.sound;
        if (fields.has("audio.minimumSeverity"))
          audio.minimumSeverity = stored.audio.minimumSeverity;
        if (fields.has("audio.mode")) audio.mode = stored.audio.mode;
        if (fields.has("audio.repeatIntervalSeconds"))
          audio.repeatIntervalSeconds = stored.audio.repeatIntervalSeconds;
        if (fields.has("audio.stopOn.clear"))
          audio.stopOn.clear = stored.audio.stopOn.clear;
        if (fields.has("audio.stopOn.acknowledge"))
          audio.stopOn.acknowledge = stored.audio.stopOn.acknowledge;
        if (fields.has("audio.stopOn.silence"))
          audio.stopOn.silence = stored.audio.stopOn.silence;
      }
    }
    const overriddenFields = [...fields];
    return {
      ...effective,
      provenance:
        overriddenFields.length === 0
          ? "default"
          : overriddenFields.length === alertPolicyFields.length
            ? "override"
            : "partial",
      overriddenFields,
      defaults: {
        ...base,
        connectivity: { ...base.connectivity },
        notifierIds: [...base.notifierIds],
        audio: { ...base.audio, stopOn: { ...base.audio.stopOn } },
      },
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
