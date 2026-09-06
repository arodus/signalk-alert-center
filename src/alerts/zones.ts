export interface ZoneThreshold {
  lower?: number;
  upper?: number;
  state: string;
  message?: string;
}

export interface ConfiguredZonePath {
  path: string;
  zones: ZoneThreshold[];
  units?: string;
  description?: string;
}

const SKIP_KEYS = new Set([
  "$source",
  "sources",
  "timestamp",
  "value",
  "meta",
  "pgn",
]);

// Signal K stores zone thresholds as `meta.zones` on any path in the full
// data model. There is no single API that lists every path with zones
// defined, so this walks the self vessel tree the same way other plugins
// (e.g. signalk-notification-player) walk it for notification values.
export function listConfiguredZones(app: {
  getSelfPath?: (path: string) => unknown;
}): ConfiguredZonePath[] {
  const results: ConfiguredZonePath[] = [];
  const root = app.getSelfPath?.("");
  if (!root || typeof root !== "object") return results;

  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const meta = record.meta as Record<string, unknown> | undefined;
    if (path && meta && Array.isArray(meta.zones) && meta.zones.length > 0) {
      const zones = (meta.zones as Array<Record<string, unknown>>).map(
        (zone) => ({
          lower: typeof zone.lower === "number" ? zone.lower : undefined,
          upper: typeof zone.upper === "number" ? zone.upper : undefined,
          state: typeof zone.state === "string" ? zone.state : "alert",
          message: typeof zone.message === "string" ? zone.message : undefined,
        }),
      );
      results.push({
        path,
        zones,
        units: typeof meta.units === "string" ? meta.units : undefined,
        description:
          typeof meta.description === "string" ? meta.description : undefined,
      });
    }
    for (const [key, value] of Object.entries(record)) {
      if (SKIP_KEYS.has(key)) continue;
      if (value && typeof value === "object") {
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(root, "");
  return results;
}
