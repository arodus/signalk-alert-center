import {
  AlertAudioPolicy,
  audioSoundSelections,
  ConnectivityMode,
  Severity,
  severities,
} from "./alerts/types";
import type { AudioCommand } from "./audio/player";

interface NotifierBaseConfig {
  /** Unique user-facing name used by alert policies. */
  name: string;
  enabled?: boolean;
  minSeverity?: Severity;
}
export type NotifierConfig =
  | (NotifierBaseConfig & {
      type: "ntfy";
      server: string;
      topic: string;
      token?: string;
    })
  | (NotifierBaseConfig & {
      type: "pagerduty";
      routingKey: string;
    })
  | (NotifierBaseConfig & {
      type: "discord";
      webhookUrl: string;
    });
export interface PluginConfig {
  storage?: { path?: string };
  maintenance?: { resetDatabase?: boolean };
  discovery?: { zoneRefreshSeconds?: number };
  delivery?: {
    batchSize?: number;
    concurrency?: number;
  };
  retention?: {
    enabled?: boolean;
    maxAgeDays?: number;
    batchSize?: number;
    intervalHours?: number;
  };
  retry?: {
    initialSeconds?: number;
    maxSeconds?: number;
    multiplier?: number;
    jitter?: number;
  };
  notifiers?: NotifierConfig[];
  audio?: {
    enabled?: boolean;
    backend?: "auto" | "aplay" | "paplay" | "afplay";
    outputDevice?: string;
    masterVolume?: number;
    testSoundOnSave?: boolean;
    queueLimit?: number;
    playbackTimeoutSeconds?: number;
    failureRetrySeconds?: number;
    maxAttempts?: number;
    beforePlaybackCommand?: Partial<AudioCommand>;
    afterPlaybackCommand?: Partial<AudioCommand>;
    commandTimeoutSeconds?: number;
    quietHours?: { enabled?: boolean; start?: string; end?: string };
    defaults?: Partial<AlertAudioPolicy> & {
      stopOn?: Partial<AlertAudioPolicy["stopOn"]>;
    };
  };
  defaults?: {
    enabled?: boolean;
    oneTime?: boolean;
    minSeverity?: Severity;
    activationDelaySeconds?: number;
    rearmAfterSeconds?: number;
    connectivity?: ConnectivityMode;
    notifiers?: string[];
  };
  connectivity?: {
    enabled?: boolean;
    switch?: { path: string; onValue: unknown; offValue: unknown };
    probe?: { url: string; timeoutSeconds?: number };
    bootTimeoutSeconds?: number;
    internetCheckIntervalSeconds?: number;
    idleCooldownSeconds?: number;
  };
}

export function validateConfig(config: PluginConfig): void {
  if (config.notifiers !== undefined && !Array.isArray(config.notifiers))
    throw new Error(
      "Notification services must be configured as a list; open the plugin settings and add each service by name",
    );
  const notifierNames = new Set<string>();
  const normalizedNotifierNames = new Set<string>();
  for (const notifier of config.notifiers ?? []) {
    requireString(notifier.name, "Each notification service needs a name");
    if (notifier.name !== notifier.name.trim())
      throw new Error(
        "Notification service names cannot start or end with spaces",
      );
    const normalizedName = notifier.name.toLocaleLowerCase();
    if (normalizedNotifierNames.has(normalizedName))
      throw new Error(
        `Notification service name must be unique: ${notifier.name}`,
      );
    notifierNames.add(notifier.name);
    normalizedNotifierNames.add(normalizedName);
    if (
      !notifier.type ||
      !["ntfy", "pagerduty", "discord"].includes(notifier.type)
    )
      throw new Error(`Invalid notification service type: ${notifier.name}`);
    if (
      notifier.minSeverity !== undefined &&
      !severities.includes(notifier.minSeverity)
    )
      throw new Error(
        `Notification service ${notifier.name} has an invalid minimum severity`,
      );
    if (notifier.type === "ntfy") {
      requireString(
        notifier.server,
        `Notification service ${notifier.name} requires an ntfy server URL`,
      );
      requireString(
        notifier.topic,
        `Notification service ${notifier.name} requires an ntfy topic`,
      );
      requireUrl(
        notifier.server,
        `Notification service ${notifier.name} has an invalid ntfy server URL`,
        ["http:", "https:"],
      );
    }
    if (notifier.type === "pagerduty")
      requireString(
        notifier.routingKey,
        `Notification service ${notifier.name} requires a PagerDuty integration key`,
      );
    if (notifier.type === "discord") {
      requireString(
        notifier.webhookUrl,
        `Notification service ${notifier.name} requires a Discord webhook URL`,
      );
      requireUrl(
        notifier.webhookUrl,
        `Notification service ${notifier.name} has an invalid Discord webhook URL`,
      );
    }
  }
  validateRetry(config.retry);
  validateDelivery(config.delivery);
  validateAudio(config.audio);
  if ((config.discovery?.zoneRefreshSeconds ?? 300) < 1)
    throw new Error("discovery.zoneRefreshSeconds must be at least 1");
  if (
    config.retention?.maxAgeDays !== undefined &&
    (!Number.isInteger(config.retention.maxAgeDays) ||
      config.retention.maxAgeDays < 1)
  )
    throw new Error("retention.maxAgeDays must be a positive integer");
  if (
    config.retention?.batchSize !== undefined &&
    (!Number.isInteger(config.retention.batchSize) ||
      config.retention.batchSize < 1 ||
      config.retention.batchSize > 1000)
  )
    throw new Error("retention.batchSize must be an integer from 1 to 1000");
  if (
    config.retention?.intervalHours !== undefined &&
    (!Number.isFinite(config.retention.intervalHours) ||
      config.retention.intervalHours < 1)
  )
    throw new Error("retention.intervalHours must be at least 1");
  validatePolicy(config.defaults, "defaults", notifierNames);
  if (config.connectivity?.enabled && !config.connectivity.switch)
    throw new Error("Enabled connectivity requires a switch configuration");
  if (config.connectivity?.enabled && !config.connectivity.probe)
    throw new Error("Enabled connectivity requires an Internet probe");
  if (config.connectivity?.probe) {
    requireString(
      config.connectivity.probe.url,
      "Connectivity probe requires a URL",
    );
    requireUrl(
      config.connectivity.probe.url,
      "Connectivity probe has an invalid URL",
    );
    if ((config.connectivity.probe.timeoutSeconds ?? 10) <= 0)
      throw new Error("Connectivity probe timeout must be positive");
  }
  if ((config.connectivity?.bootTimeoutSeconds ?? 240) <= 0)
    throw new Error("bootTimeoutSeconds must be positive");
  if ((config.connectivity?.internetCheckIntervalSeconds ?? 5) <= 0)
    throw new Error("internetCheckIntervalSeconds must be positive");
  if ((config.connectivity?.idleCooldownSeconds ?? 0) < 0)
    throw new Error("idleCooldownSeconds must be non-negative");
}

function validateDelivery(delivery: PluginConfig["delivery"]): void {
  if (!delivery) return;
  if (
    delivery.batchSize !== undefined &&
    (!Number.isInteger(delivery.batchSize) ||
      delivery.batchSize < 1 ||
      delivery.batchSize > 200)
  )
    throw new Error("delivery.batchSize must be an integer from 1 to 200");
  if (
    delivery.concurrency !== undefined &&
    (!Number.isInteger(delivery.concurrency) ||
      delivery.concurrency < 1 ||
      delivery.concurrency > 32)
  )
    throw new Error("delivery.concurrency must be an integer from 1 to 32");
}

function validateAudio(audio: PluginConfig["audio"]): void {
  if (!audio) return;
  if (
    audio.outputDevice !== undefined &&
    (audio.outputDevice.length > 128 || audio.outputDevice.includes("\0"))
  )
    throw new Error("audio.outputDevice is invalid");
  if (
    audio.backend !== undefined &&
    !["auto", "aplay", "paplay", "afplay"].includes(audio.backend)
  )
    throw new Error("audio.backend is not supported");
  if (
    audio.masterVolume !== undefined &&
    (!Number.isFinite(audio.masterVolume) ||
      audio.masterVolume < 0 ||
      audio.masterVolume > 100)
  )
    throw new Error("audio.masterVolume must be between 0 and 100");
  if (
    audio.queueLimit !== undefined &&
    (!Number.isInteger(audio.queueLimit) ||
      audio.queueLimit < 1 ||
      audio.queueLimit > 100)
  )
    throw new Error("audio.queueLimit must be an integer from 1 to 100");
  for (const [name, value] of [
    ["playbackTimeoutSeconds", audio.playbackTimeoutSeconds],
    ["failureRetrySeconds", audio.failureRetrySeconds],
    ["maxAttempts", audio.maxAttempts],
    ["commandTimeoutSeconds", audio.commandTimeoutSeconds],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1))
      throw new Error(`audio.${name} must be a positive integer`);
  }
  if (audio.maxAttempts !== undefined && audio.maxAttempts > 20)
    throw new Error("audio.maxAttempts must not exceed 20");
  if (
    audio.commandTimeoutSeconds !== undefined &&
    audio.commandTimeoutSeconds > 300
  )
    throw new Error("audio.commandTimeoutSeconds must not exceed 300");
  validateAudioCommand(audio.beforePlaybackCommand, "beforePlaybackCommand");
  validateAudioCommand(audio.afterPlaybackCommand, "afterPlaybackCommand");
  if (
    audio.defaults?.repeatIntervalSeconds !== undefined &&
    audio.defaults.repeatIntervalSeconds > 86_400
  )
    throw new Error(
      "audio.defaults.repeatIntervalSeconds must not exceed 86400",
    );
  const defaults = audio.defaults;
  if (defaults?.sound && !audioSoundSelections.includes(defaults.sound))
    throw new Error("audio.defaults.sound is not a supported sound selection");
  if (
    defaults?.minimumSeverity &&
    !severities.includes(defaults.minimumSeverity)
  )
    throw new Error("audio.defaults.minimumSeverity is invalid");
  if (defaults?.mode && !["once", "repeat"].includes(defaults.mode))
    throw new Error("audio.defaults.mode is invalid");
  if (
    defaults?.repeatIntervalSeconds !== undefined &&
    (!Number.isInteger(defaults.repeatIntervalSeconds) ||
      defaults.repeatIntervalSeconds < 1)
  )
    throw new Error(
      "audio.defaults.repeatIntervalSeconds must be a positive integer",
    );
  const quiet = audio.quietHours;
  if (quiet?.enabled) {
    if (!isClockTime(quiet.start) || !isClockTime(quiet.end))
      throw new Error("Enabled audio quiet hours require HH:MM start and end");
    if (quiet.start === quiet.end)
      throw new Error("Audio quiet-hours start and end must differ");
  }
}

function validateAudioCommand(
  command: Partial<AudioCommand> | undefined,
  name: string,
): void {
  if (!command) return;
  const executable = command.executable;
  if (typeof executable !== "string" || executable.trim() === "") {
    if ((command.arguments?.length ?? 0) === 0) return;
    throw new Error(`audio.${name}.executable must name an executable`);
  }
  requireString(executable, `audio.${name}.executable must name an executable`);
  if (
    executable !== executable.trim() ||
    executable.length > 512 ||
    executable.includes("\0") ||
    /[\r\n]/.test(executable)
  )
    throw new Error(`audio.${name}.executable is invalid`);
  if (command.arguments !== undefined && !Array.isArray(command.arguments))
    throw new Error(`audio.${name}.arguments must be a list`);
  if ((command.arguments?.length ?? 0) > 32)
    throw new Error(`audio.${name}.arguments must contain at most 32 items`);
  for (const argument of command.arguments ?? []) {
    if (
      typeof argument !== "string" ||
      argument.length > 2048 ||
      argument.includes("\0")
    )
      throw new Error(`audio.${name}.arguments contains an invalid value`);
  }
}

function isClockTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validatePolicy(
  policy:
    | Pick<
        NonNullable<PluginConfig["defaults"]>,
        | "activationDelaySeconds"
        | "rearmAfterSeconds"
        | "notifiers"
        | "minSeverity"
      >
    | PluginConfig["defaults"],
  label: string,
  notifierIds: Set<string>,
): void {
  if (!policy) return;
  if (
    policy.activationDelaySeconds !== undefined &&
    policy.activationDelaySeconds < 0
  )
    throw new Error(`${label} activation delay must be non-negative`);
  if (policy.rearmAfterSeconds !== undefined && policy.rearmAfterSeconds < 0)
    throw new Error(`${label} rearm delay must be non-negative`);
  if (
    policy.minSeverity !== undefined &&
    !severities.includes(policy.minSeverity)
  )
    throw new Error(`${label} has an invalid minimum severity`);
  if (policy.notifiers?.some((id) => !notifierIds.has(id)))
    throw new Error(`${label} references an unknown notifier`);
}

function requireString(
  value: unknown,
  message: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(message);
}

function requireUrl(
  value: unknown,
  message: string,
  protocols = ["https:"],
): void {
  try {
    const url = new URL(String(value));
    if (!protocols.includes(url.protocol)) throw new Error(message);
  } catch {
    throw new Error(message);
  }
}

function validateRetry(retry: PluginConfig["retry"]): void {
  if (!retry) return;
  if (retry.initialSeconds !== undefined && retry.initialSeconds <= 0)
    throw new Error("retry.initialSeconds must be positive");
  if (retry.maxSeconds !== undefined && retry.maxSeconds <= 0)
    throw new Error("retry.maxSeconds must be positive");
  if (
    retry.initialSeconds !== undefined &&
    retry.maxSeconds !== undefined &&
    retry.maxSeconds < retry.initialSeconds
  )
    throw new Error("retry.maxSeconds must be at least initialSeconds");
  if (retry.multiplier !== undefined && retry.multiplier < 1)
    throw new Error("retry.multiplier must be at least 1");
  if (retry.jitter !== undefined && (retry.jitter < 0 || retry.jitter > 1))
    throw new Error("retry.jitter must be between 0 and 1");
}
