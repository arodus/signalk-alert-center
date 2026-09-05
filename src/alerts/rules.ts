import picomatch from "picomatch";
import { ConnectivityMode, Severity, severityRank } from "./types";
import { RuleConfig } from "../config";

export interface MatchedRule {
  connectivity: ConnectivityMode;
  notifiers: string[];
}
export function matchRules(
  path: string,
  severity: Severity,
  rules: RuleConfig[],
): MatchedRule {
  const notifiers = new Set<string>();
  let connectivity: ConnectivityMode = { mode: "queue" };
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (
      picomatch(rule.match)(path) &&
      severityRank(severity) >= severityRank(rule.minSeverity)
    ) {
      for (const notifier of rule.notifiers) notifiers.add(notifier);
      connectivity = rule.connectivity;
    }
  }
  return { connectivity, notifiers: [...notifiers] };
}
