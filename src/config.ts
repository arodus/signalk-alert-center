import { ConnectivityMode, Severity, severities } from "./alerts/types";

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
    })
  | (NotifierBaseConfig & {
      type: "telegram";
      botToken: string;
      chatId: string;
      messageThreadId?: number;
      disableNotification?: boolean;
    })
  | (NotifierBaseConfig & {
      type: "wyoming";
      /** Satellite ids; an empty list lets signalk-wyoming target all satellites. */
      targets?: string[];
      /** Empty uses signalk-wyoming's configured Piper voice. */
      voice?: string;
      /** Alerts at or above this level bypass voice mute and interrupt playback. */
      urgentAt?: Severity;
    });
export interface PluginConfig {
  storage?: { path?: string };
  maintenance?: { resetDatabase?: boolean };
  discovery?: { zoneRefreshSeconds?: number };
  ingestion?: {
    queueLimit?: number;
    batchSize?: number;
  };
  delivery?: {
    batchSize?: number;
    concurrency?: number;
    requestTimeoutSeconds?: number;
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
  defaults?: {
    enabled?: boolean;
    oneTime?: boolean;
    minSeverity?: Severity;
    activationDelaySeconds?: number;
    rearmAfterSeconds?: number;
    connectivity?: ConnectivityMode;
    notifiers?: string[];
    speechMinimumSeverity?: Severity;
    speechTemplate?: string;
    speechAnnounceClear?: boolean;
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
      !["ntfy", "pagerduty", "discord", "telegram", "wyoming"].includes(
        notifier.type,
      )
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
    if (notifier.type === "telegram") {
      requireString(
        notifier.botToken,
        `Notification service ${notifier.name} requires a Telegram bot token`,
      );
      if (/\s/.test(notifier.botToken))
        throw new Error(
          `Notification service ${notifier.name} has an invalid Telegram bot token`,
        );
      requireString(
        notifier.chatId,
        `Notification service ${notifier.name} requires a Telegram chat ID`,
      );
      if (
        notifier.messageThreadId !== undefined &&
        (!Number.isInteger(notifier.messageThreadId) ||
          notifier.messageThreadId <= 0)
      )
        throw new Error(
          `Notification service ${notifier.name} has an invalid Telegram topic ID`,
        );
    }
    if (notifier.type === "wyoming") {
      if (
        notifier.targets !== undefined &&
        (!Array.isArray(notifier.targets) ||
          notifier.targets.some(
            (target) => typeof target !== "string" || !target.trim(),
          ))
      )
        throw new Error(
          `Notification service ${notifier.name} has invalid Wyoming satellite targets`,
        );
      if (
        notifier.urgentAt !== undefined &&
        !severities.includes(notifier.urgentAt)
      )
        throw new Error(
          `Notification service ${notifier.name} has an invalid Wyoming urgent severity`,
        );
    }
  }
  validateRetry(config.retry);
  validateIngestion(config.ingestion);
  validateDelivery(config.delivery);
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

function validateIngestion(ingestion: PluginConfig["ingestion"]): void {
  if (!ingestion) return;
  if (
    ingestion.queueLimit !== undefined &&
    (!Number.isInteger(ingestion.queueLimit) ||
      ingestion.queueLimit < 10 ||
      ingestion.queueLimit > 100_000)
  )
    throw new Error(
      "ingestion.queueLimit must be an integer from 10 to 100000",
    );
  if (
    ingestion.batchSize !== undefined &&
    (!Number.isInteger(ingestion.batchSize) ||
      ingestion.batchSize < 1 ||
      ingestion.batchSize > 1000)
  )
    throw new Error("ingestion.batchSize must be an integer from 1 to 1000");
  if (
    ingestion.queueLimit !== undefined &&
    ingestion.batchSize !== undefined &&
    ingestion.batchSize > ingestion.queueLimit
  )
    throw new Error("ingestion.batchSize must not exceed ingestion.queueLimit");
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
  if (
    delivery.requestTimeoutSeconds !== undefined &&
    (!Number.isInteger(delivery.requestTimeoutSeconds) ||
      delivery.requestTimeoutSeconds < 1 ||
      delivery.requestTimeoutSeconds > 300)
  )
    throw new Error(
      "delivery.requestTimeoutSeconds must be an integer from 1 to 300",
    );
}

function validatePolicy(
  policy:
    | Pick<
        NonNullable<PluginConfig["defaults"]>,
        | "activationDelaySeconds"
        | "rearmAfterSeconds"
        | "notifiers"
        | "minSeverity"
        | "speechMinimumSeverity"
        | "speechTemplate"
        | "speechAnnounceClear"
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
  if (
    policy.speechMinimumSeverity !== undefined &&
    !severities.includes(policy.speechMinimumSeverity)
  )
    throw new Error(`${label} has an invalid spoken-alert minimum severity`);
  if (
    policy.speechTemplate !== undefined &&
    (typeof policy.speechTemplate !== "string" ||
      policy.speechTemplate.trim().length === 0 ||
      policy.speechTemplate.length > 500)
  )
    throw new Error(
      `${label} spoken-alert template must contain 1 to 500 characters`,
    );
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
