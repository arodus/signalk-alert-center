import { NormalizedAlert, Severity, severities } from "./types";

const severityAliases: Record<string, Severity> = {
  normal: "normal",
  nominal: "normal",
  warn: "warn",
  warning: "warn",
  alert: "alert",
  alarm: "alarm",
  emergency: "emergency",
  critical: "emergency",
};

export function normalizeSeverity(value: unknown): Severity {
  const normalized =
    typeof value === "string"
      ? severityAliases[value.toLowerCase()]
      : undefined;
  return normalized ?? "alert";
}

export function normalizeNotification(
  path: string,
  value: unknown,
  source?: string,
  sourceTimestamp?: Date,
): NormalizedAlert {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const severity =
    value === null
      ? "normal"
      : normalizeSeverity(record.state ?? record.severity ?? record.level);
  const stateValue = String(record.state ?? record.status ?? "").toLowerCase();
  const state =
    value === null ||
    stateValue === "normal" ||
    stateValue === "nominal" ||
    stateValue === "cleared" ||
    severity === "normal"
      ? "cleared"
      : "active";
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.description === "string"
        ? record.description
        : undefined;
  const notificationId = typeof record.id === "string" ? record.id : undefined;
  return {
    // Multiple sources can legitimately raise the same path independently
    // (e.g. two GPS units both losing signal); coalesce per source instead
    // of collapsing them into a single alert.
    sourceKey: source ? `${path}@${source}` : path,
    path,
    source,
    severity,
    state,
    message,
    sourcePayload: value,
    notificationId,
    sourceTimestamp,
  };
}

export function isSeverity(value: unknown): value is Severity {
  return (
    typeof value === "string" &&
    (severities as readonly string[]).includes(value)
  );
}
