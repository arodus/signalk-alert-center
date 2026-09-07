export interface SignalKNotificationInput {
  path: string;
  value: unknown;
  source?: string;
  sourceTimestamp?: Date;
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : undefined;

const parseTimestamp = (value: unknown): Date | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
};

/**
 * Extract notification path values from a Signal K delta while preserving the
 * source identity and the producer timestamp attached to each update.
 */
export function extractNotificationEntries(
  delta: unknown,
): SignalKNotificationInput[] {
  const record = asRecord(delta);
  const entries: SignalKNotificationInput[] = [];
  const updates = Array.isArray(record?.updates) ? record.updates : [];

  for (const candidate of updates) {
    const update = asRecord(candidate);
    if (!update) continue;
    const source =
      typeof update.$source === "string" ? update.$source : undefined;
    const updateTimestamp = parseTimestamp(update.timestamp);
    const values = Array.isArray(update.values) ? update.values : [];
    for (const rawValue of values) {
      const value = asRecord(rawValue);
      if (!value || typeof value.path !== "string") continue;
      if (!value.path.startsWith("notifications.")) continue;
      entries.push({
        path: value.path,
        value: value.value,
        source,
        sourceTimestamp: parseTimestamp(value.timestamp) ?? updateTimestamp,
      });
    }
  }

  // Retain compatibility with the small bare-delta shape used by tests and
  // fixture publishers. Production Signal K deltas normally use updates[].
  if (
    entries.length === 0 &&
    typeof record?.path === "string" &&
    record.path.startsWith("notifications.")
  ) {
    entries.push({
      path: record.path,
      value: record.value,
      source: typeof record.$source === "string" ? record.$source : undefined,
      sourceTimestamp: parseTimestamp(record.timestamp),
    });
  }

  return entries;
}

/**
 * Flatten the priority-resolved `vessels.self.notifications` subtree returned
 * by getSelfPath(). This is used only for startup reconciliation; ingest remains
 * idempotent so a value seen in both the subscription and snapshot is coalesced.
 */
export function snapshotNotificationEntries(
  notificationsRoot: unknown,
): SignalKNotificationInput[] {
  const entries: SignalKNotificationInput[] = [];

  const walk = (candidate: unknown, suffix: string): void => {
    const node = asRecord(candidate);
    if (!node) return;

    if (Object.prototype.hasOwnProperty.call(node, "value") && suffix) {
      entries.push({
        path: `notifications.${suffix}`,
        value: node.value,
        source: typeof node.$source === "string" ? node.$source : undefined,
        sourceTimestamp: parseTimestamp(node.timestamp),
      });
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "meta" || key === "values" || key.startsWith("$")) continue;
      walk(value, suffix ? `${suffix}.${key}` : key);
    }
  };

  walk(notificationsRoot, "");
  return entries;
}
