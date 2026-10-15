export interface NavigationStateObservation {
  value: string | null;
  source?: string;
  updatedAt?: string;
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : undefined;

const timestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

const observation = (
  value: unknown,
  source?: unknown,
  updatedAt?: unknown,
): NavigationStateObservation | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsedTimestamp = timestamp(updatedAt);
  return {
    value: value.trim(),
    ...(typeof source === "string" ? { source } : {}),
    ...(parsedTimestamp ? { updatedAt: parsedTimestamp } : {}),
  };
};

const unavailableObservation = (
  source?: unknown,
  updatedAt?: unknown,
): NavigationStateObservation => {
  const parsedTimestamp = timestamp(updatedAt);
  return {
    value: null,
    ...(typeof source === "string" ? { source } : {}),
    ...(parsedTimestamp ? { updatedAt: parsedTimestamp } : {}),
  };
};

/** Extract the most recent navigation.state value from a Signal K delta. */
export function extractNavigationState(
  delta: unknown,
): NavigationStateObservation | undefined {
  const record = asRecord(delta);
  const updates = Array.isArray(record?.updates) ? record.updates : [];
  let result: NavigationStateObservation | undefined;
  for (const candidate of updates) {
    const update = asRecord(candidate);
    if (!update) continue;
    const values = Array.isArray(update.values) ? update.values : [];
    for (const rawValue of values) {
      const entry = asRecord(rawValue);
      if (entry?.path !== "navigation.state") continue;
      result =
        observation(
          entry.value,
          update.$source,
          entry.timestamp ?? update.timestamp,
        ) ??
        unavailableObservation(
          update.$source,
          entry.timestamp ?? update.timestamp,
        );
    }
  }
  if (result) return result;
  if (record?.path !== "navigation.state") return undefined;
  return (
    observation(record.value, record.$source, record.timestamp) ??
    unavailableObservation(record.$source, record.timestamp)
  );
}

/** Normalize the priority-resolved value returned by getSelfPath(). */
export function navigationStateSnapshot(
  value: unknown,
): NavigationStateObservation | undefined {
  const leaf = asRecord(value);
  return leaf && Object.prototype.hasOwnProperty.call(leaf, "value")
    ? observation(leaf.value, leaf.$source, leaf.timestamp)
    : observation(value);
}

export function isAnchoredOrMoored(
  observation: NavigationStateObservation | undefined,
): boolean {
  return observation?.value === "anchored" || observation?.value === "moored";
}
