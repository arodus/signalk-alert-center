export const INTERNET_STATE_PATH = "network.internet.state";

export type SignalKInternetState = "online" | "offline" | "metered" | "captive";

export interface InternetStateObservation {
  value: SignalKInternetState | null;
  source?: string;
  updatedAt?: Date;
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : undefined;

const timestamp = (value: unknown): Date | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const state = (value: unknown): SignalKInternetState | null => {
  if (
    value === "online" ||
    value === "offline" ||
    value === "metered" ||
    value === "captive"
  )
    return value;
  return null;
};

const observation = (
  value: unknown,
  source?: unknown,
  updatedAt?: unknown,
): InternetStateObservation => {
  const parsedTimestamp = timestamp(updatedAt);
  return {
    value: state(value),
    ...(typeof source === "string" ? { source } : {}),
    ...(parsedTimestamp ? { updatedAt: parsedTimestamp } : {}),
  };
};

/** Extract the preferred network.internet.state value from a Signal K delta. */
export function extractInternetState(
  delta: unknown,
): InternetStateObservation | undefined {
  const record = asRecord(delta);
  const updates = Array.isArray(record?.updates) ? record.updates : [];
  let result: InternetStateObservation | undefined;
  for (const candidate of updates) {
    const update = asRecord(candidate);
    if (!update) continue;
    const values = Array.isArray(update.values) ? update.values : [];
    for (const rawValue of values) {
      const entry = asRecord(rawValue);
      if (entry?.path !== INTERNET_STATE_PATH) continue;
      result = observation(
        entry.value,
        update.$source,
        entry.timestamp ?? update.timestamp,
      );
    }
  }
  if (result) return result;
  if (record?.path !== INTERNET_STATE_PATH) return undefined;
  return observation(record.value, record.$source, record.timestamp);
}

/** Normalize the priority-resolved value returned by getSelfPath(). */
export function internetStateSnapshot(
  value: unknown,
): InternetStateObservation | undefined {
  if (value === undefined) return undefined;
  const leaf = asRecord(value);
  return leaf && Object.prototype.hasOwnProperty.call(leaf, "value")
    ? observation(leaf.value, leaf.$source, leaf.timestamp)
    : observation(value);
}

export function internetStateAvailability(
  value: SignalKInternetState | null,
): boolean | undefined {
  if (value === "online" || value === "metered") return true;
  if (value === "offline" || value === "captive") return false;
  return undefined;
}
