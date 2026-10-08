import { createHash } from "node:crypto";

export const serviceHealthPathPrefix =
  "notifications.plugins.signalkAlertCenter.services.";

export type ServiceHealthState = "normal" | "alert" | "warn";

export interface ServiceHealthSnapshot {
  id: string;
  name: string;
  type: string;
  retryingFailureCount: number;
  terminalFailureCount: number;
  lastFailureCode?: string;
}

const servicePathSegment = (id: string): string => {
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(id)) return id;
  const readable = id
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, 24);
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `${readable || "service"}${hash}`;
};

export const serviceHealthPath = (id: string): string =>
  `${serviceHealthPathPrefix}${servicePathSegment(id)}`;

export const isServiceHealthPath = (path: string): boolean =>
  path.startsWith(serviceHealthPathPrefix);

export const serviceHealthState = (
  service: ServiceHealthSnapshot,
): ServiceHealthState =>
  service.terminalFailureCount > 0
    ? "warn"
    : service.retryingFailureCount > 0
      ? "alert"
      : "normal";

export const serviceHealthMessage = (
  service: ServiceHealthSnapshot,
): string => {
  const code = service.lastFailureCode
    ? ` Last error: ${service.lastFailureCode}.`
    : "";
  if (service.terminalFailureCount > 0)
    return `${service.name} has ${service.terminalFailureCount} failed notification ${service.terminalFailureCount === 1 ? "delivery" : "deliveries"} that will not be retried${service.retryingFailureCount > 0 ? ` and ${service.retryingFailureCount} awaiting retry` : ""}.${code}`;
  if (service.retryingFailureCount > 0)
    return `${service.name} has ${service.retryingFailureCount} failed notification ${service.retryingFailureCount === 1 ? "delivery" : "deliveries"} awaiting retry.${code}`;
  return `${service.name} notification delivery is operating normally.`;
};
