import { ConnectivityMode, Severity, severities } from "./alerts/types";

export interface NotifierConfig {
  type: "ntfy" | "pagerduty" | "discord";
  enabled?: boolean;
  [key: string]: unknown;
}
export interface RuleConfig {
  id?: string;
  name?: string;
  zone?: string;
  oneTime?: boolean;
  enabled?: boolean;
  match: string;
  minSeverity: Severity;
  connectivity: ConnectivityMode;
  notifiers: string[];
}
export interface PluginConfig {
  storage?: { path?: string };
  retry?: {
    initialSeconds?: number;
    maxSeconds?: number;
    multiplier?: number;
    jitter?: number;
  };
  notifiers?: Record<string, NotifierConfig>;
  rules?: RuleConfig[];
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
  const notifierIds = new Set(Object.keys(config.notifiers ?? {}));
  for (const [id, notifier] of Object.entries(config.notifiers ?? {})) {
    if (
      !notifier.type ||
      !["ntfy", "pagerduty", "discord"].includes(notifier.type)
    )
      throw new Error(`Invalid notifier type: ${id}`);
    if (notifier.type === "ntfy") {
      requireString(notifier.server, `Notifier ${id} requires server`);
      requireString(notifier.topic, `Notifier ${id} requires topic`);
      requireUrl(notifier.server, `Notifier ${id} has an invalid server URL`, [
        "http:",
        "https:",
      ]);
    }
    if (notifier.type === "pagerduty")
      requireString(notifier.routingKey, `Notifier ${id} requires routingKey`);
    if (notifier.type === "discord") {
      requireString(notifier.webhookUrl, `Notifier ${id} requires webhookUrl`);
      requireUrl(
        notifier.webhookUrl,
        `Notifier ${id} has an invalid webhook URL`,
      );
    }
  }
  validateRetry(config.retry);
  for (const rule of config.rules ?? []) {
    if (!rule.match || !rule.notifiers)
      throw new Error("Rules require match and notifiers");
    if (!severities.includes(rule.minSeverity))
      throw new Error(`Invalid rule severity: ${rule.minSeverity}`);
    if (rule.notifiers.some((id) => !notifierIds.has(id)))
      throw new Error(`Rule references an unknown notifier: ${rule.match}`);
    if (
      rule.connectivity.mode === "wake_after" &&
      rule.connectivity.delaySeconds < 0
    )
      throw new Error("wake_after delay must be non-negative");
  }
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
