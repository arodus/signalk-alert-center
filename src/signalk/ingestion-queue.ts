import { normalizeNotification } from "../alerts/normalize";
import { SignalKNotificationInput } from "./notifications";

interface QueueItem {
  entry: SignalKNotificationInput;
  key: string;
  signature: string;
  consumed: boolean;
}

export interface IngestionQueueStats {
  depth: number;
  limit: number;
  highWaterMark: number;
  received: number;
  processed: number;
  coalesced: number;
  rejected: number;
}

export type EnqueueResult = "queued" | "coalesced" | "rejected";

/**
 * Fixed-size notification queue. Only equivalent pending updates for the same
 * source are replaced; state, severity, and message changes retain their order.
 */
export class BoundedIngestionQueue {
  private items: QueueItem[] = [];
  private head = 0;
  private latestByKey = new Map<string, QueueItem>();
  private highWaterMark = 0;
  private received = 0;
  private processed = 0;
  private coalesced = 0;
  private rejected = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Ingestion queue limit must be a positive integer");
  }

  get depth(): number {
    return this.items.length - this.head;
  }

  enqueue(entry: SignalKNotificationInput): EnqueueResult {
    this.received += 1;
    const normalized = normalizeNotification(
      entry.path,
      entry.value,
      entry.source,
      entry.sourceTimestamp,
    );
    const key = normalized.sourceKey;
    const signature = JSON.stringify([
      normalized.state,
      normalized.severity,
      normalized.message ?? null,
    ]);
    const pending = this.latestByKey.get(key);
    if (pending && !pending.consumed && pending.signature === signature) {
      pending.entry = snapshotEntry(entry);
      this.coalesced += 1;
      return "coalesced";
    }
    if (this.depth >= this.limit) {
      this.rejected += 1;
      return "rejected";
    }
    const snapshot = snapshotEntry(entry);
    const item = { entry: snapshot, key, signature, consumed: false };
    this.items.push(item);
    this.latestByKey.set(key, item);
    this.highWaterMark = Math.max(this.highWaterMark, this.depth);
    return "queued";
  }

  take(maxItems: number): SignalKNotificationInput[] {
    const count = Math.min(this.depth, Math.max(1, Math.floor(maxItems)));
    const selected: SignalKNotificationInput[] = [];
    for (let index = 0; index < count; index += 1) {
      const item = this.items[this.head++];
      item.consumed = true;
      if (this.latestByKey.get(item.key) === item)
        this.latestByKey.delete(item.key);
      selected.push(item.entry);
    }
    this.processed += selected.length;
    if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return selected;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
    this.latestByKey.clear();
  }

  stats(): IngestionQueueStats {
    return {
      depth: this.depth,
      limit: this.limit,
      highWaterMark: this.highWaterMark,
      received: this.received,
      processed: this.processed,
      coalesced: this.coalesced,
      rejected: this.rejected,
    };
  }
}

function snapshotEntry(
  entry: SignalKNotificationInput,
): SignalKNotificationInput {
  // Signal K may reuse and mutate objects from its live model after invoking
  // subscribers. Own the small notification value so queued state transitions
  // cannot all turn into the producer's latest value. This happens only for
  // accepted entries; overload rejection remains cheap.
  return {
    ...entry,
    value: structuredClone(entry.value),
    sourceTimestamp: entry.sourceTimestamp
      ? new Date(entry.sourceTimestamp)
      : undefined,
  };
}
