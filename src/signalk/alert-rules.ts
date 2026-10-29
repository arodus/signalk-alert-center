import type { AlertDefinitionRecord, NormalizedAlert } from "../alerts/types";

/** Public identity contract of hatlabs/signalk-alert-rules at 5f6fbb9. */
export const RULES_PROVIDER = "signalk-alert-rules";
export const ruleDefinitionId = (slug: string): string =>
  `rule:${RULES_PROVIDER}:${slug}`;
export const isRuleSlug = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);

export interface RuleDescriptor {
  slug: string;
  name: string;
  /** Without alerts.; absent for an invalid rule without a known path. */
  alertPath?: string;
}

export function isRuleDescriptor(value: unknown): value is RuleDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((key) =>
      ["slug", "name", "alertPath"].includes(key),
    ) &&
    isRuleSlug(v.slug) &&
    typeof v.name === "string" &&
    v.name.trim().length > 0 &&
    v.name.length <= 200 &&
    (v.alertPath === undefined ||
      (typeof v.alertPath === "string" &&
        v.alertPath.length <= 255 &&
        /^(?:[a-zA-Z0-9_-]+|\*)(?:\.(?:[a-zA-Z0-9_-]+|\*))*$/.test(
          v.alertPath,
        )))
  );
}

export function ruleDefinition(
  rule: RuleDescriptor,
  now = new Date(),
): AlertDefinitionRecord {
  return {
    id: ruleDefinitionId(rule.slug),
    sourceType: "rule",
    name: rule.name,
    pathPattern: rule.alertPath ? `alerts.${rule.alertPath}` : "",
    metadata: { rule: { provider: RULES_PROVIDER, slug: rule.slug } },
    createdAt: now,
    updatedAt: now,
  };
}

export function ruleFromAlert(
  alert: NormalizedAlert,
): RuleDescriptor | undefined {
  const core = alert.coreAlert;
  if (core?.$source !== RULES_PROVIDER || !isRuleSlug(core.data?.rule))
    return undefined;
  return {
    slug: core.data.rule,
    name:
      typeof core.data.name === "string" && core.data.name.trim()
        ? core.data.name.slice(0, 200)
        : core.data.rule,
    alertPath: core.path,
  };
}
