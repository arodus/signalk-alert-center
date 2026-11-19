/* The supported read-only rule catalog; no credentials beyond the session cookie. */
const alertRules = (() => {
  let cached;
  let loadedAt = 0;
  const id = (slug) => `rule:signalk-alert-rules:${slug}`;
  const slugValid = (slug) =>
    typeof slug === "string" &&
    slug.length <= 64 &&
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
  const pathValid = (path) =>
    typeof path === "string" &&
    path.length <= 255 &&
    /^(?:[a-zA-Z0-9_-]+|\*)(?:\.(?:[a-zA-Z0-9_-]+|\*))*$/.test(path);
  async function catalog() {
    if (cached && Date.now() - loadedAt < 15000) return cached;
    try {
      const response = await fetch("/plugins/signalk-alert-rules/rules", {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404) cached = { entries: [], unavailable: true };
      else if (response.status === 401 || response.status === 403)
        cached = {
          entries: [],
          unavailable: true,
          message:
            "Sign in with permission to read Alert Rules. Saved delivery settings still apply.",
        };
      else if (!response.ok) throw new Error("unavailable");
      else {
        const entries = await response.json();
        if (
          !Array.isArray(entries) ||
          entries.length > 500 ||
          entries.some((entry) => !entry || !slugValid(entry.slug))
        )
          throw new Error("invalid catalog");
        cached = { entries };
      }
    } catch {
      cached = {
        entries: [],
        unavailable: true,
        message:
          "Alert Rules is unavailable. Saved delivery settings still apply; refresh to try again.",
      };
    }
    loadedAt = Date.now();
    return cached;
  }

  function merge(definitions, catalog, defaults) {
    const merged = new Map(
      definitions.map((definition) => [
        definition.id,
        definition.sourceType === "rule"
          ? {
              ...definition,
              ruleStatus: catalog.unavailable
                ? "Rule status unavailable"
                : "Rule no longer listed",
            }
          : definition,
      ]),
    );
    for (const entry of catalog.entries) {
      const key = id(entry.slug);
      const stored = merged.get(key);
      const rawName = entry.rule?.name ?? entry.invalid?.body?.name;
      const name =
        typeof rawName === "string" && rawName.trim()
          ? rawName.slice(0, 200)
          : entry.slug;
      const alertPath = pathValid(entry.alertPath)
        ? entry.alertPath
        : undefined;
      const rule = {
        slug: entry.slug,
        name,
        ...(alertPath ? { alertPath } : {}),
      };
      merged.set(key, {
        ...(stored ?? {
          id: key,
          fireCount: 0,
          policy: defaults,
          oneTime: false,
        }),
        sourceType: "rule",
        name,
        pathPattern: alertPath ? `alerts.${alertPath}` : "",
        metadata: {
          ...stored?.metadata,
          rule: { provider: "signalk-alert-rules", slug: entry.slug },
        },
        ruleDescriptor: rule,
        ruleStatus: entry.invalid
          ? "Invalid rule"
          : entry.disabled || entry.state?.ruleState === "disabled"
            ? "Rule disabled"
            : entry.state?.condition === "problem"
              ? "Rule needs attention"
              : "Rule enabled",
        catalogOnly: !stored,
      });
    }
    return [...merged.values()];
  }
  return {
    catalog,
    merge,
    invalidate: () => {
      loadedAt = 0;
    },
  };
})();
