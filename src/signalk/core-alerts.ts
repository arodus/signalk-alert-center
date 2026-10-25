import type { ServerAPI } from "@signalk/server-api";
import type { NormalizedAlert, Severity } from "../alerts/types";
import type { SignalKNotificationInput } from "./notifications";

/** Temporary compatibility surface for SignalK/signalk-server#3012, ae7f868.
 * Replace with the server-api exports when the alerts API is published.
 */
export interface CoreAlert {
  id: string;
  path: string;
  $source: string;
  priority: "caution" | "warning" | "alarm" | "emergency";
  state: "normal" | "unacknowledged" | "acknowledged" | "rtn-unacknowledged";
  condition: boolean;
  latching: boolean;
  silenced: boolean;
  silencedUntil?: string;
  message: string;
  raisedAt: string;
  stateChangedAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  clearedAt?: string;
  sourceOnline: boolean;
  lastSourceUpdate: string;
  stale: boolean;
  context?: string;
  references?: string[];
  data?: Record<string, unknown>;
}

export interface CoreAlertsApi {
  list(): CoreAlert[];
  get(id: string): CoreAlert | null;
  acknowledge(id: string): Promise<{
    alert: CoreAlert | null;
    cleared: boolean;
    previousState: CoreAlert["state"];
  }>;
  silence(id: string, durationSeconds?: number): Promise<CoreAlert>;
}

export function coreAlertsApi(app: ServerAPI): CoreAlertsApi | undefined {
  const api = (app as ServerAPI & { alerts?: CoreAlertsApi }).alerts;
  return api &&
    [api.list, api.get, api.acknowledge, api.silence].every(
      (method) => typeof method === "function",
    )
    ? api
    : undefined;
}

export function isCoreAlert(value: unknown): value is CoreAlert {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    ["id", "path", "$source", "message"].every(
      (key) => typeof a[key] === "string",
    ) &&
    ["condition", "latching", "silenced", "sourceOnline", "stale"].every(
      (key) => typeof a[key] === "boolean",
    ) &&
    ["raisedAt", "stateChangedAt", "lastSourceUpdate"].every(
      (key) =>
        typeof a[key] === "string" &&
        Number.isFinite(Date.parse(a[key] as string)),
    ) &&
    ["caution", "warning", "alarm", "emergency"].includes(String(a.priority)) &&
    ["normal", "unacknowledged", "acknowledged", "rtn-unacknowledged"].includes(
      String(a.state),
    ) &&
    (a.references === undefined ||
      (Array.isArray(a.references) &&
        a.references.every((path) => typeof path === "string")))
  );
}

const priorities: Record<CoreAlert["priority"], Severity> = {
  caution: "alert",
  warning: "warn",
  alarm: "alarm",
  emergency: "emergency",
};

export function coreAlertEntry(alert: CoreAlert): SignalKNotificationInput {
  return {
    path: `alerts.${alert.path}`,
    value: structuredClone(alert),
    source: alert.$source,
    sourceTimestamp: new Date(alert.stateChangedAt),
    kind: "core",
  };
}

export function normalizeCoreAlert(alert: CoreAlert): NormalizedAlert {
  return {
    sourceKey: `core:${alert.id}`,
    path: `alerts.${alert.path}`,
    source: alert.$source,
    severity: priorities[alert.priority],
    state: alert.state === "normal" ? "cleared" : "active",
    message: alert.message,
    sourcePayload: alert,
    notificationId: alert.id,
    acknowledged: alert.state === "acknowledged",
    sourceTimestamp: new Date(alert.stateChangedAt),
    coreAlert: alert,
  };
}

/** Ignore producer requests: only the manager's canonical snapshots are input. */
export function extractCoreAlertEntries(
  delta: unknown,
  selfContext: string,
): SignalKNotificationInput[] {
  if (!delta || typeof delta !== "object") return [];
  const record = delta as {
    context?: string;
    updates?: Array<{
      $source?: string;
      values?: Array<{ path?: string; value?: unknown }>;
    }>;
  };
  if (
    record.context &&
    record.context !== "vessels.self" &&
    record.context !== selfContext
  )
    return [];
  return (Array.isArray(record.updates) ? record.updates : []).flatMap(
    (update) =>
      !update || update.$source !== "alertsApi"
        ? []
        : (Array.isArray(update.values) ? update.values : [])
            .filter((entry) => entry && typeof entry === "object")
            .flatMap(({ path, value }) =>
              isCoreAlert(value) &&
              path === `alerts.${value.path}` &&
              isSelfAlert(value, selfContext)
                ? [coreAlertEntry(value)]
                : [],
            ),
  );
}

export function isSelfAlert(alert: CoreAlert, selfContext: string): boolean {
  return (
    !alert.context ||
    alert.context === "vessels.self" ||
    alert.context === selfContext
  );
}

/** Heartbeats refresh the payload, but do not manufacture lifecycle history. */
export function coreAlertSignature(alert: CoreAlert): string {
  return JSON.stringify([
    alert.id,
    alert.$source,
    alert.state,
    alert.priority,
    alert.condition,
    alert.latching,
    alert.silenced,
    alert.silencedUntil,
    alert.message,
    alert.stateChangedAt,
    alert.acknowledgedAt,
    alert.acknowledgedBy,
    alert.stale,
    alert.sourceOnline,
  ]);
}

export function coreNeedsAttention(alert: CoreAlert): boolean {
  return (
    (alert.state === "unacknowledged" ||
      alert.state === "rtn-unacknowledged") &&
    !alert.silenced
  );
}

/** A momentary/latching alert is actionable even though condition is false. */
export function coreConditionActive(alert: CoreAlert): boolean {
  return alert.state !== "normal" && (alert.condition || alert.latching);
}
