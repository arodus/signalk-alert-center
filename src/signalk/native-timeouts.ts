import { ServerAPI } from "@signalk/server-api";
import { isSeverity } from "../alerts/normalize";
import { pathDefinitionId } from "../alerts/policy";
import { AlertDefinitionRecord, Severity } from "../alerts/types";
import { SignalKNotificationInput } from "./notifications";

export const NATIVE_TIMEOUT_SOURCE = "signalk-alert-center.native-timeout";
export interface NativeTimeoutRule {
  slug: string;
  name: string;
  path: string;
  severity: Exclude<Severity, "normal">;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function isNativeTimeoutRule(
  value: unknown,
): value is NativeTimeoutRule {
  const rule = record(value);
  return Boolean(
    rule &&
    Object.keys(rule).every((key) =>
      ["slug", "name", "path", "severity"].includes(key),
    ) &&
    typeof rule.slug === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.slug) &&
    rule.slug.length <= 64 &&
    typeof rule.name === "string" &&
    rule.name.trim() &&
    rule.name.length <= 200 &&
    typeof rule.path === "string" &&
    rule.path.length <= 255 &&
    /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(rule.path) &&
    !rule.path
      .split(".")
      .some((part) =>
        ["__proto__", "constructor", "prototype"].includes(part),
      ) &&
    !/^(notifications|alerts)\./.test(rule.path) &&
    isSeverity(rule.severity) &&
    rule.severity !== "normal",
  );
}

export const nativeTimeoutPath = (slug: string): string =>
  `notifications.alertCenter.dataTimeout.${slug}`;

export function nativeTimeoutDefinition(rule: NativeTimeoutRule) {
  const path = nativeTimeoutPath(rule.slug);
  return {
    id: pathDefinitionId(path),
    sourceType: "recognized" as const,
    pathPattern: path,
    name: rule.name.trim(),
    metadata: {
      nativeTimeout: rule,
      description: `Native data timeout: ${rule.path}`,
    },
  };
}

export function definitionTimeoutRule(
  definition: AlertDefinitionRecord,
): NativeTimeoutRule | undefined {
  const rule = record(definition.metadata)?.nativeTimeout;
  return isNativeTimeoutRule(rule) ? rule : undefined;
}

export function nativeTimeoutStatus(app: unknown) {
  const settings = record(record(record(app)?.config)?.settings);
  const enabled = settings?.enforceDataTimeouts === true;
  return {
    enabled,
    message: enabled
      ? "Uses Signal K native data timeouts and selected-source failover."
      : "Native data timeout enforcement is disabled or unavailable. Enable Data timeouts in Signal K Server 2.38.0 or newer; rules do not run their own timeout clock.",
  };
}

/** Consume a selected model leaf or accepted preferred-source PathValue.
 * Signal K 2.38.0 puts state beside value and uses the synthetic update time
 * for the timeout; state.lastValue.timestamp is the last valid reading time.
 * Absence/null without timedOut is unknown, not evidence of recovery.
 */
export function nativeTimeoutEntry(
  rule: NativeTimeoutRule,
  node: unknown,
): SignalKNotificationInput | undefined {
  const leaf = record(node);
  if (!leaf) return undefined;
  if (typeof leaf.value === "number" && !Number.isFinite(leaf.value))
    return undefined;
  const state = record(leaf.state);
  const timedOut = leaf.value === null && state?.timedOut === true;
  if (
    !timedOut &&
    (leaf.value === null ||
      leaf.value === undefined ||
      state?.timedOut === true)
  )
    return undefined;
  const timestamp =
    typeof leaf.timestamp === "string" ? new Date(leaf.timestamp) : undefined;
  // A malformed or absent timestamp is not a confirmed fresh observation.
  if (!timestamp || !Number.isFinite(timestamp.getTime())) return undefined;
  const last = record(state?.lastValue);
  return {
    path: nativeTimeoutPath(rule.slug),
    source: NATIVE_TIMEOUT_SOURCE,
    sourceTimestamp: timestamp,
    value: {
      state: timedOut ? rule.severity : "normal",
      message: `${rule.name}: ${timedOut ? "data timed out" : "data recovered"}`,
      method: ["visual", "sound"],
      data: {
        nativeTimeout: true,
        path: rule.path,
        source: typeof leaf.$source === "string" ? leaf.$source : undefined,
        lastValidTimestamp: timedOut ? last?.timestamp : leaf.timestamp,
        lastValue: timedOut ? last?.value : leaf.value,
      },
    },
  };
}

export function readNativeTimeout(app: ServerAPI, rule: NativeTimeoutRule) {
  return nativeTimeoutEntry(rule, app.getSelfPath(rule.path));
}

/** The preferred-source subscription is downstream of the server priority
 * filter. Read state from each PathValue, not the update envelope. */
export function nativeTimeoutDeltaEntries(
  delta: unknown,
  rules: NativeTimeoutRule[],
): SignalKNotificationInput[] {
  const entries: SignalKNotificationInput[] = [];
  const updates = record(delta)?.updates;
  if (!Array.isArray(updates)) return entries;
  for (const candidate of updates) {
    const update = record(candidate);
    if (!Array.isArray(update?.values)) continue;
    for (const candidateValue of update.values) {
      const value = record(candidateValue);
      for (const rule of rules) {
        if (rule.path !== value?.path) continue;
        const entry = nativeTimeoutEntry(rule, {
          ...value,
          timestamp: update.timestamp,
          $source: update.$source,
        });
        if (entry) entries.push(entry);
      }
    }
  }
  return entries;
}

export function nativeTimeoutFingerprint(
  entry: SignalKNotificationInput,
): string {
  const value = record(entry.value);
  // Fresh readings are only recovery evidence. Their changing values/times
  // must not write history or schedule work for every sensor update.
  return value?.state === "normal" ? "normal" : JSON.stringify(value);
}
