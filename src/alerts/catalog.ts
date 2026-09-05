import picomatch from "picomatch";
import { RuleConfig } from "../config";
import { AlertRecord } from "./types";

export interface AlertCatalogEntry {
  id: string;
  alertId?: string;
  configured: boolean;
  definitionId?: string;
  name: string;
  zone?: string;
  pathPattern: string;
  oneTime: boolean;
  enabled: boolean;
  currentState?: AlertRecord["currentState"];
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  lastFiredAt?: Date;
  clearedAt?: Date;
  fireCount: number;
  currentSeverity?: AlertRecord["currentSeverity"];
  maxSeverity?: AlertRecord["maxSeverity"];
  message?: string;
  removedAt?: Date;
}

export function buildAlertCatalog(
  alerts: AlertRecord[],
  rules: RuleConfig[],
): AlertCatalogEntry[] {
  const visibleAlerts = alerts.filter((alert) => !alert.removedAt);
  const claimed = new Set<string>();
  const entries: AlertCatalogEntry[] = [];

  rules.forEach((rule, index) => {
    const matching = visibleAlerts
      .filter((alert) => picomatch(rule.match)(alert.path))
      .sort(
        (left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime(),
      );
    matching.forEach((alert) => claimed.add(alert.id));
    const latest = matching[0];
    entries.push({
      id: `rule:${rule.id ?? index}`,
      alertId: latest?.id,
      configured: true,
      definitionId: rule.id ?? `rule-${index}`,
      name: rule.name ?? rule.match,
      zone: rule.zone,
      pathPattern: rule.match,
      oneTime: rule.oneTime === true,
      enabled: rule.enabled !== false,
      currentState: latest?.currentState,
      firstSeenAt: latest?.firstSeenAt,
      lastSeenAt: latest?.lastSeenAt,
      lastFiredAt: latest?.lastFiredAt,
      clearedAt: latest?.clearedAt,
      fireCount: matching.reduce((total, alert) => total + alert.fireCount, 0),
      currentSeverity: latest?.currentSeverity,
      maxSeverity: latest?.maxSeverity,
      message: latest?.message,
    });
  });

  visibleAlerts
    .filter((alert) => !claimed.has(alert.id))
    .forEach((alert) => {
      entries.push({
        id: alert.id,
        alertId: alert.id,
        configured: false,
        name: alert.path,
        pathPattern: alert.path,
        oneTime: false,
        enabled: true,
        currentState: alert.currentState,
        firstSeenAt: alert.firstSeenAt,
        lastSeenAt: alert.lastSeenAt,
        lastFiredAt: alert.lastFiredAt,
        clearedAt: alert.clearedAt,
        fireCount: alert.fireCount,
        currentSeverity: alert.currentSeverity,
        maxSeverity: alert.maxSeverity,
        message: alert.message,
      });
    });

  return entries;
}
