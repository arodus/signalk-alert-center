import { ConnectivityMode, Severity, severities } from "./alerts/types";

export interface NotifierConfig { type: "ntfy" | "pagerduty" | "discord"; enabled?: boolean; [key: string]: unknown }
export interface RuleConfig { id?: string; match: string; minSeverity: Severity; connectivity: ConnectivityMode; notifiers: string[] }
export interface PluginConfig {
  storage?: { path?: string };
  retry?: { initialSeconds?: number; maxSeconds?: number; multiplier?: number; jitter?: number };
  notifiers?: Record<string, NotifierConfig>;
  rules?: RuleConfig[];
  connectivity?: { enabled?: boolean; switch?: { path: string; onValue: unknown; offValue: unknown }; idleCooldownSeconds?: number };
}

export function validateConfig(config: PluginConfig): void {
  for (const [id, notifier] of Object.entries(config.notifiers ?? {})) {
    if (!notifier.type || !["ntfy", "pagerduty", "discord"].includes(notifier.type)) throw new Error(`Invalid notifier type: ${id}`);
  }
  for (const rule of config.rules ?? []) {
    if (!rule.match || !rule.notifiers) throw new Error("Rules require match and notifiers");
    if (!severities.includes(rule.minSeverity)) throw new Error(`Invalid rule severity: ${rule.minSeverity}`);
    if (rule.connectivity.mode === "wake_after" && rule.connectivity.delaySeconds < 0) throw new Error("wake_after delay must be non-negative");
  }
}