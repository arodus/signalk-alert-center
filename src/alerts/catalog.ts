import picomatch from "picomatch";
import { RuleConfig } from "../config";
import { AlertRecord } from "./types";
import { ConfiguredZonePath } from "./zones";

export interface AlertCatalogEntry {
  id: string;
  alertId?: string;
  configured: boolean;
  sourceType: "rule" | "zone" | "recognized";
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
  notificationId?: string;
  acknowledgedAt?: Date;
  silencedAt?: Date;
}

export function buildAlertCatalog(
  alerts: AlertRecord[],
  rules: RuleConfig[],
  zonePaths: ConfiguredZonePath[] = [],
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
      sourceType: "rule",
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
      notificationId: latest?.notificationId,
      acknowledgedAt: latest?.acknowledgedAt,
      silencedAt: latest?.silencedAt,
    });
  });

  zonePaths.forEach((zonePath) => {
    const notificationPath = `notifications.${zonePath.path}`;
    const alreadyRuleCovered = rules.some((rule) =>
      picomatch(rule.match)(notificationPath),
    );
    if (alreadyRuleCovered) return;
    const matching = visibleAlerts
      .filter((alert) => alert.path === notificationPath)
      .sort(
        (left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime(),
      );
    matching.forEach((alert) => claimed.add(alert.id));
    const latest = matching[0];
    const thresholds = zonePath.zones
      .map((zone) => {
        const range = [zone.lower, zone.upper]
          .filter((value) => value !== undefined)
          .join("-");
        return range ? `${zone.state} ${range}` : zone.state;
      })
      .join(", ");
    entries.push({
      id: `zone:${zonePath.path}`,
      alertId: latest?.id,
      configured: true,
      sourceType: "zone",
      definitionId: zonePath.path,
      name: zonePath.description ?? zonePath.path,
      pathPattern: notificationPath,
      oneTime: false,
      enabled: true,
      currentState: latest?.currentState,
      firstSeenAt: latest?.firstSeenAt,
      lastSeenAt: latest?.lastSeenAt,
      lastFiredAt: latest?.lastFiredAt,
      clearedAt: latest?.clearedAt,
      fireCount: latest?.fireCount ?? 0,
      currentSeverity: latest?.currentSeverity,
      maxSeverity: latest?.maxSeverity,
      message: latest?.message ?? `Zone thresholds: ${thresholds}`,
      notificationId: latest?.notificationId,
      acknowledgedAt: latest?.acknowledgedAt,
      silencedAt: latest?.silencedAt,
    });
  });

  visibleAlerts
    .filter((alert) => !claimed.has(alert.id))
    .forEach((alert) => {
      entries.push({
        id: alert.id,
        alertId: alert.id,
        configured: false,
        sourceType: "recognized",
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
        notificationId: alert.notificationId,
        acknowledgedAt: alert.acknowledgedAt,
        silencedAt: alert.silencedAt,
      });
    });

  return entries;
}
