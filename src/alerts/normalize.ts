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
): NormalizedAlert {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const severity = normalizeSeverity(
    record.state ?? record.severity ?? record.level,
  );
  const stateValue = String(record.state ?? record.status ?? "").toLowerCase();
  const state =
    stateValue === "normal" || stateValue === "cleared" || severity === "normal"
      ? "cleared"
      : "active";
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.description === "string"
        ? record.description
        : undefined;
  return {
    sourceKey: path,
    path,
    severity,
    state,
    message,
    sourcePayload: value,
  };
}

export function isSeverity(value: unknown): value is Severity {
  return (
    typeof value === "string" &&
    (severities as readonly string[]).includes(value)
  );
}
