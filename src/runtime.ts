import path from "node:path";
import {
  Context,
  NotificationId,
  Path,
  PluginRouter,
  ServerAPI,
} from "@signalk/server-api";
import { AlertLifecycle } from "./alerts/lifecycle";
import { normalizeNotification } from "./alerts/normalize";
import { AlertPolicyResolver, EffectivePolicy } from "./alerts/policy";
import {
  AlertDefinitionRecord,
  AlertPolicyField,
  AlertRecord,
  DeliveryRecord,
  Severity,
  severityRank,
} from "./alerts/types";
import { listConfiguredZones } from "./alerts/zones";
import {
  ActionResult,
  AlertCenterChange,
  AlertCenterRepository,
  AlertPolicyPatch,
  DefinitionQuery,
  EventQuery,
  OccurrenceQuery,
  RouterLike,
  registerAlertCenterRoutes,
  registerRoutes,
} from "./api/routes";
import { NotifierConfig, PluginConfig, validateConfig } from "./config";
import { ConnectivityManager } from "./connectivity/manager";
import { createInternetProbe } from "./connectivity/internet";
import { createSignalKSwitch } from "./connectivity/signalk-switch";
import { DeliveryScheduler } from "./delivery/scheduler";
import {
  extractNotificationEntries,
  iterateSnapshotNotificationEntries,
  SignalKNotificationInput,
} from "./signalk/notifications";
import { BoundedIngestionQueue } from "./signalk/ingestion-queue";
import { AlertDatabase } from "./storage/db";
import { DiscordTransport } from "./transports/discord";
import { NtfyTransport } from "./transports/ntfy";
import { PagerDutyTransport } from "./transports/pagerduty";
import { TelegramTransport } from "./transports/telegram";
import { NotificationTransport } from "./transports/transport";
import {
  WyomingAnnouncementApi,
  WyomingAnnouncementContent,
  WyomingAnnouncementSnapshot,
  WyomingTransport,
} from "./transports/wyoming";
import {
  NotificationTestOperation,
  NotificationTestResult,
  testNotificationService,
} from "./transports/test-service";

const MAX_TIMER_DELAY = 2_147_000_000;
const UPSTREAM_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_INGESTION_QUEUE_LIMIT = 2_000;
const DEFAULT_INGESTION_BATCH_SIZE = 100;
const QUEUE_WARNING_INTERVAL_MS = 60_000;

interface PropertyValueEntry {
  value?: unknown;
}

interface PropertyValueApp {
  onPropertyValues?(
    name: string,
    callback: (history: PropertyValueEntry[]) => void,
  ): (() => void) | void;
}

interface DefinitionView extends AlertDefinitionRecord {
  description?: string;
  zone?: string;
  oneTime: boolean;
  fireCount: number;
  lastFiredAt?: Date;
  lastActivityAt?: Date;
  policy: EffectivePolicy;
}

export class AlertCenterRuntime {
  private database?: AlertDatabase;
  private scheduler?: DeliveryScheduler;
  private connectivity?: ConnectivityManager;
  private policy?: AlertPolicyResolver;
  private unsubscribe?: () => void;
  private activationTimer?: ReturnType<typeof setTimeout>;
  private deliveryTimer?: ReturnType<typeof setTimeout>;
  private zoneRefreshTimer?: ReturnType<typeof setInterval>;
  private retentionTimer?: ReturnType<typeof setInterval>;
  private reconcilingStartup = false;
  private ingestionQueue = new BoundedIngestionQueue(
    DEFAULT_INGESTION_QUEUE_LIMIT,
  );
  private ingestionImmediate?: ReturnType<typeof setImmediate>;
  private startupImmediate?: ReturnType<typeof setImmediate>;
  private deliveryImmediate?: ReturnType<typeof setImmediate>;
  private deliveryRun?: Promise<void>;
  private deliveryRerunRequested = false;
  private runtimeGeneration = 0;
  private stopping = false;
  private startCount = 0;
  private stopCount = 0;
  private lastQueueWarningAt = 0;
  private config: PluginConfig = {};
  private transports = new Map<string, NotificationTransport>();
  private notifierTests = new Set<string>();
  private wyomingApi?: WyomingAnnouncementApi;
  private wyomingUnsubscribe?: () => void;
  private wyomingAnnouncementUnsubscribe?: () => void;
  private changeRevision = 0;
  private changeListeners = new Set<(change: AlertCenterChange) => void>();
  private retentionState?: {
    lastRunAt: Date;
    cutoff: Date;
    eligibleOccurrences: number;
    deletedOccurrences: number;
    remainingEligibleOccurrences: number;
  };
  private reconciliationState: {
    state: "idle" | "running" | "complete" | "failed";
    startedAt?: Date;
    completedAt?: Date;
    durationMs?: number;
    snapshotEntries?: number;
    queuedEntries?: number;
    error?: string;
  } = { state: "idle" };

  constructor(private readonly app: ServerAPI) {}

  private db(): AlertDatabase {
    if (!this.database) throw new Error("Plugin is not started");
    return this.database;
  }

  private policies(): AlertPolicyResolver {
    if (!this.policy) throw new Error("Plugin is not started");
    return this.policy;
  }

  private databasePath(options: PluginConfig): string {
    const configuredPath =
      options.storage?.path?.trim() || "alert-center.sqlite";
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.join(this.app.getDataDirPath(), configuredPath);
  }

  resetDatabase(options: PluginConfig): void {
    validateConfig(options);
    const database = new AlertDatabase(this.databasePath(options));
    try {
      database.reset();
    } finally {
      database.close();
    }
  }

  status() {
    const alertStats = this.database?.alertStats();
    const database = this.database?.operationalStatus();
    const ingestion = this.ingestionQueue.stats();
    const scheduler = this.scheduler?.status() ?? {
      running: false,
      activeRequests: 0,
      lastError: undefined,
    };
    const services = (this.config.notifiers ?? []).map((notifier) => {
      const service = database?.services.find(
        (item) => item.id === notifier.name,
      );
      return {
        id: notifier.name,
        name: notifier.name,
        type: notifier.type,
        enabled: notifier.enabled !== false,
        pendingCount: service?.pendingCount ?? 0,
        lastSuccessAt: service?.lastSuccessAt,
        lastFailureAt: service?.lastFailureAt,
        lastFailureCode: service?.lastFailureCode,
      };
    });
    const faultReasons = [
      database && !database.healthy
        ? (database.error ?? "Database schema is not healthy")
        : undefined,
      this.connectivity?.state === "FAULT"
        ? (this.connectivity.lastError ?? "Connectivity is in a fault state")
        : undefined,
      this.reconciliationState.state === "failed"
        ? (this.reconciliationState.error ?? "Startup reconciliation failed")
        : undefined,
    ].filter((reason): reason is string => Boolean(reason));
    const degradedReasons = [
      this.reconciliationState.state === "running"
        ? "Startup reconciliation is still running"
        : undefined,
      scheduler.lastError
        ? `Delivery scheduler failed: ${scheduler.lastError}`
        : undefined,
      ingestion.rejected > 0
        ? `${ingestion.rejected} notification update(s) rejected at the ingestion queue limit`
        : undefined,
      database?.overdueActivationCount
        ? `${database.overdueActivationCount} activation(s) overdue`
        : undefined,
      ...services
        .filter(
          (service) =>
            service.enabled &&
            service.lastFailureAt &&
            (!service.lastSuccessAt ||
              service.lastFailureAt > service.lastSuccessAt),
        )
        .map(
          (service) =>
            `${service.name} last failed${service.lastFailureCode ? ` (${service.lastFailureCode})` : ""}`,
        ),
    ].filter((reason): reason is string => Boolean(reason));
    const health = faultReasons.length
      ? { state: "fault" as const, reasons: faultReasons }
      : degradedReasons.length
        ? { state: "degraded" as const, reasons: degradedReasons }
        : { state: "healthy" as const, reasons: [] as string[] };
    return {
      health,
      runtime: {
        generation: this.runtimeGeneration,
        startCount: this.startCount,
        stopCount: this.stopCount,
        changeListeners: this.changeListeners.size,
      },
      reconciliation: this.reconciliationState,
      scheduler,
      ingestion: {
        ...ingestion,
        batchSize:
          this.config.ingestion?.batchSize ?? DEFAULT_INGESTION_BATCH_SIZE,
        reconcilingStartup: this.reconcilingStartup,
        workerScheduled: Boolean(this.ingestionImmediate),
      },
      connectivity: this.connectivity
        ? {
            state: this.connectivity.state,
            switchOn: this.connectivity.switchOn,
            ownedByPlugin: this.connectivity.ownedByPlugin,
            lastError: this.connectivity.lastError,
            lastTransitionAt: this.connectivity.lastTransitionAt,
            lastTransitionFrom: this.connectivity.lastTransitionFrom,
            lastProbeAt: this.connectivity.lastProbeAt,
            lastProbeSucceeded: this.connectivity.lastProbeSucceeded,
            lastProbeError: this.connectivity.lastProbeError,
            pendingWakeCount: database?.pendingWakeCount ?? 0,
            nextWakeAt:
              database?.nextWakeAt ?? this.connectivity.scheduledWakeAt,
            shutdownDeferredReason:
              this.connectivity.lastShutdownDeferredReason,
          }
        : {
            state: "OFF",
            switchOn: undefined,
            ownedByPlugin: false,
            pendingWakeCount: database?.pendingWakeCount ?? 0,
            nextWakeAt: database?.nextWakeAt,
          },
      alerts: {
        definitions: this.database?.definitionCount() ?? 0,
        total: alertStats?.total ?? 0,
        active: alertStats?.active ?? 0,
        pendingActivation: alertStats?.pendingActivation ?? 0,
        pendingDelivery: this.database?.pendingDeliveryCount() ?? 0,
      },
      database,
      schemaVersion: database?.schemaVersion,
      services,
      retention: {
        enabled: this.config.retention?.enabled ?? false,
        maxAgeDays: this.config.retention?.maxAgeDays ?? 365,
        batchSize: this.config.retention?.batchSize ?? 100,
        intervalHours: this.config.retention?.intervalHours ?? 24,
        ...this.retentionState,
      },
    };
  }

  statusMessage(): string {
    const current = this.status();
    return `${current.health.state}: ${current.alerts.active} active, ${current.alerts.pendingDelivery} deliveries pending`;
  }

  private debug(message: string): void {
    this.app.debug(`[alert-center] ${message}`);
  }

  private reportAsyncError(context: string, error: unknown): void {
    this.app.error(
      `[alert-center] ${context}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (this.database) this.app.setPluginStatus(this.statusMessage());
  }

  private emitChange(reason: string): void {
    const change = {
      revision: ++this.changeRevision,
      reason,
      occurredAt: new Date().toISOString(),
    };
    for (const listener of this.changeListeners) {
      try {
        listener(change);
      } catch (error) {
        this.changeListeners.delete(listener);
        this.app.error(
          `[alert-center] Removed failed dashboard event listener: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.app.setPluginStatus(this.statusMessage());
  }

  private subscribeChanges(
    listener: (change: AlertCenterChange) => void,
  ): () => void {
    this.changeListeners.add(listener);
    listener({
      revision: this.changeRevision,
      reason: "connected",
      occurredAt: new Date().toISOString(),
    });
    return () => this.changeListeners.delete(listener);
  }

  private async runScheduler(): Promise<void> {
    const repeatsCreated = this.database?.processDueRepeats() ?? 0;
    const summary = await this.scheduler?.runOnce();
    if (summary?.processed && this.wyomingApi)
      this.reconcileWyomingAnnouncements(this.wyomingApi);
    if (summary?.processed) {
      const message = `Delivery batch: processed=${summary.processed}, succeeded=${summary.succeeded}, retryableFailures=${summary.retryableFailures}, terminalFailures=${summary.terminalFailures}`;
      if (summary.retryableFailures || summary.terminalFailures)
        this.app.error(`[alert-center] ${message}`);
      else this.debug(message);
    }
    if (this.connectivity && this.database?.pendingDeliveryCount() === 0)
      this.connectivity.beginCooldown();
    this.scheduleNextDelivery();
    if (summary?.processed || repeatsCreated) this.emitChange("deliveries");
  }

  private requestDeliveryRun(): void {
    if (this.stopping) return;
    if (this.deliveryRun) {
      this.deliveryRerunRequested = true;
      return;
    }
    if (this.deliveryImmediate || !this.scheduler || !this.database) return;
    const generation = this.runtimeGeneration;
    this.deliveryImmediate = setImmediate(() => {
      this.deliveryImmediate = undefined;
      if (generation !== this.runtimeGeneration || !this.database) return;
      const running = this.runScheduler();
      this.deliveryRun = running;
      void running
        .catch((error: unknown) =>
          this.reportAsyncError("Delivery scheduler failed", error),
        )
        .finally(() => {
          if (this.deliveryRun === running) this.deliveryRun = undefined;
          if (this.deliveryRerunRequested) {
            this.deliveryRerunRequested = false;
            this.requestDeliveryRun();
          }
        });
    });
  }

  private scheduleNextDelivery(): void {
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    this.deliveryTimer = undefined;
    if (this.stopping) return;
    const dueAt = this.database?.nextDeliveryDueAt();
    if (!dueAt) return;
    const delay = Math.min(
      MAX_TIMER_DELAY,
      Math.max(0, dueAt.getTime() - Date.now()),
    );
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = undefined;
      this.requestDeliveryRun();
    }, delay);
  }

  private scheduleNextWake(): void {
    if (this.stopping) return;
    const nextWake = this.database?.listWakeRequests()[0];
    this.connectivity?.cancelScheduledWake();
    if (nextWake) this.connectivity?.scheduleWakeAt(nextWake.dueAt);
  }

  private scheduleNextActivation(): void {
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.activationTimer = undefined;
    if (this.stopping) return;
    const dueAt = this.database?.nextActivationDueAt();
    if (!dueAt) return;
    const delay = Math.min(
      MAX_TIMER_DELAY,
      Math.max(0, dueAt.getTime() - Date.now()),
    );
    this.activationTimer = setTimeout(() => {
      this.activationTimer = undefined;
      this.database?.processDueActivations(new Date());
      this.scheduleNextActivation();
      this.requestDeliveryRun();
    }, delay);
  }

  private enqueueNotifications(entries: SignalKNotificationInput[]): void {
    let rejected = 0;
    for (const entry of entries)
      if (this.ingestionQueue.enqueue(entry) === "rejected") rejected += 1;
    if (
      rejected > 0 &&
      Date.now() - this.lastQueueWarningAt >= QUEUE_WARNING_INTERVAL_MS
    ) {
      this.lastQueueWarningAt = Date.now();
      const stats = this.ingestionQueue.stats();
      this.app.error(
        `[alert-center] Notification ingestion queue reached its ${stats.limit}-entry limit; rejected=${stats.rejected}, depth=${stats.depth}. Alert transitions may be missing.`,
      );
    }
    if (!this.reconcilingStartup) this.scheduleIngestionDrain();
  }

  private scheduleIngestionDrain(): void {
    if (
      this.ingestionImmediate ||
      !this.database ||
      this.ingestionQueue.depth === 0
    )
      return;
    const generation = this.runtimeGeneration;
    this.ingestionImmediate = setImmediate(() => {
      this.ingestionImmediate = undefined;
      if (generation !== this.runtimeGeneration || !this.database) return;
      this.drainIngestionBatch();
    });
  }

  private drainIngestionBatch(): void {
    const entries = this.ingestionQueue.take(
      this.config.ingestion?.batchSize ?? DEFAULT_INGESTION_BATCH_SIZE,
    );
    let persisted = 0;
    for (const entry of entries) {
      try {
        if (this.ingestEntry(entry, new Date(), false)) persisted += 1;
      } catch (error) {
        this.reportAsyncError("Could not ingest Signal K notification", error);
      }
    }
    try {
      if (persisted > 0) this.afterIngestionBatch();
    } catch (error) {
      this.reportAsyncError("Could not schedule ingested notifications", error);
    } finally {
      this.scheduleIngestionDrain();
    }
  }

  private afterIngestionBatch(): void {
    this.scheduleNextWake();
    this.scheduleNextActivation();
    this.requestDeliveryRun();
    this.emitChange("alerts");
  }

  private seedDefinitions(): void {
    this.policies().seedDefinitions(listConfiguredZones(this.app));
  }

  private runRetention(now = new Date()): void {
    if (!this.config.retention?.enabled || !this.database) return;
    const maxAgeDays = this.config.retention.maxAgeDays ?? 365;
    const batchSize = this.config.retention.batchSize ?? 100;
    const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000);
    const before = this.database.retentionStatus(cutoff);
    const deleted = this.database.pruneOccurrences(cutoff, batchSize);
    const after = this.database.retentionStatus(cutoff);
    this.retentionState = {
      lastRunAt: now,
      cutoff,
      eligibleOccurrences: before.eligibleOccurrences,
      deletedOccurrences: deleted.length,
      remainingEligibleOccurrences: after.eligibleOccurrences,
    };
    this.debug(
      `Retention cleanup: eligible=${before.eligibleOccurrences}, deleted=${deleted.length}, remaining=${after.eligibleOccurrences}`,
    );
    if (deleted.length) this.emitChange("retention");
  }

  private applyConnectivityPolicy(
    occurrence: AlertRecord,
    now: Date,
    schedule = true,
  ): void {
    if (occurrence.currentState === "cleared") {
      this.db().clearWakeDue(occurrence.id);
      if (schedule) this.scheduleNextWake();
      return;
    }
    if (occurrence.activationState === "suppressed") return;
    const eligibleAt = occurrence.activationDueAt ?? now;
    const wakeAt =
      occurrence.connectivity.mode === "wake"
        ? eligibleAt
        : occurrence.connectivity.mode === "wake_after"
          ? new Date(
              eligibleAt.getTime() +
                occurrence.connectivity.delaySeconds * 1000,
            )
          : undefined;
    if (!wakeAt) return;
    this.db().setWakeDue(occurrence.id, wakeAt, now);
    if (schedule) this.scheduleNextWake();
  }

  private ingestEntry(
    entry: SignalKNotificationInput,
    receivedAt = new Date(),
    schedule = true,
  ): AlertRecord | undefined {
    const normalized = normalizeNotification(
      entry.path,
      entry.value,
      entry.source,
      entry.sourceTimestamp,
    );
    const policy = this.policies().forPath(
      normalized.path,
      normalized.severity,
    );
    const configuredNotifiers = new Map(
      (this.config.notifiers ?? []).map((notifier) => [
        notifier.name,
        notifier,
      ]),
    );
    const notifierIds = policy.notifierIds.filter((id) => {
      const notifier = configuredNotifiers.get(id);
      return Boolean(notifier && notifier.enabled !== false);
    });
    const hasRemoteNotifier = notifierIds.some(
      (id) => configuredNotifiers.get(id)?.type !== "wyoming",
    );
    const notifierMinimumSeverity = (id: string): Severity => {
      const notifier = configuredNotifiers.get(id);
      return notifier?.minSeverity ?? "normal";
    };
    const occurrence = new AlertLifecycle(this.db(), []).ingest(
      normalized,
      policy.enabled ? notifierIds : [],
      receivedAt,
      {
        definitionId: this.policies().ensureDefinitionForPath(normalized.path),
        activationDelaySeconds: policy.activationDelaySeconds,
        // Local Wyoming speech must never wake an Internet connection by itself.
        connectivity: hasRemoteNotifier
          ? policy.connectivity
          : { mode: "queue" },
        minimumSeverity: policy.minimumSeverity,
        oneTime: policy.oneTime,
        notifierRepeatIntervals: Object.fromEntries(
          notifierIds.map((id) => [
            id,
            policy.notifierRepeatIntervals[id] ?? 0,
          ]),
        ),
        notifierMinimumSeverities: Object.fromEntries(
          notifierIds.map((id) => [id, notifierMinimumSeverity(id)]),
        ),
        resolvingNotifierIds: notifierIds.filter(
          (id) =>
            configuredNotifiers.get(id)?.type === "pagerduty" ||
            (configuredNotifiers.get(id)?.type === "wyoming" &&
              policy.speechEnabled &&
              policy.speechAnnounceClear),
        ),
        acknowledgingNotifierIds: notifierIds.filter(
          (id) => configuredNotifiers.get(id)?.type === "pagerduty",
        ),
        speechTemplate: policy.speechTemplate,
        soundEnabled: policy.soundEnabled,
        soundId: policy.soundId,
        speechEnabled: policy.speechEnabled,
        speechMinimumSeverity: policy.speechMinimumSeverity,
      },
    );
    if (!occurrence) return undefined;
    this.applyConnectivityPolicy(occurrence, receivedAt, schedule);
    if (schedule) this.afterIngestionBatch();
    return occurrence;
  }

  private async reconcileStartup(generation: number): Promise<void> {
    if (!this.database || generation !== this.runtimeGeneration) return;
    const startedAt = Date.now();
    this.seedDefinitions();
    const entries = iterateSnapshotNotificationEntries(
      this.app.getPath(`${this.app.selfContext}.notifications`),
    );
    let snapshotEntries = 0;
    for (const entry of entries) {
      if (!this.database || generation !== this.runtimeGeneration) return;
      this.ingestEntry(entry, new Date(), false);
      snapshotEntries += 1;
      if (snapshotEntries % 50 === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!this.database || generation !== this.runtimeGeneration) return;
    const queuedCount = this.ingestionQueue.stats().received;
    this.reconcilingStartup = false;
    if (snapshotEntries > 0) this.afterIngestionBatch();
    else {
      this.scheduleNextWake();
      this.scheduleNextActivation();
      this.requestDeliveryRun();
    }
    this.scheduleIngestionDrain();
    this.runRetention();
    const completedAt = new Date();
    this.reconciliationState = {
      state: "complete",
      startedAt: this.reconciliationState.startedAt,
      completedAt,
      durationMs: Date.now() - startedAt,
      snapshotEntries,
      queuedEntries: queuedCount,
    };
    this.app.setPluginStatus(this.statusMessage());
    this.debug(
      `Startup reconciliation complete: snapshotEntries=${snapshotEntries}, queuedEntries=${queuedCount}, durationMs=${Date.now() - startedAt}`,
    );
  }

  private definitionView(definition: AlertDefinitionRecord): DefinitionView {
    const metadata =
      definition.metadata && typeof definition.metadata === "object"
        ? (definition.metadata as Record<string, unknown>)
        : {};
    const policy = this.policies().forDefinition(definition);
    const stats = this.db().definitionStats(definition.id);
    return {
      ...definition,
      description:
        typeof metadata.description === "string"
          ? metadata.description
          : undefined,
      zone: typeof metadata.zone === "string" ? metadata.zone : undefined,
      oneTime: policy.oneTime,
      ...stats,
      policy,
    };
  }

  private occurrenceView(occurrence: AlertRecord, includeAttempts = false) {
    return {
      ...occurrence,
      state: occurrence.currentState,
      startedAt: occurrence.firstSeenAt,
      oneTime: occurrence.oneTime,
      deliveries: this.db()
        .listDeliveriesForAlert(occurrence.id)
        .map((delivery) => ({
          ...delivery,
          playback: this.db().listWyomingPlaybacks(delivery.id),
          ...(includeAttempts
            ? { attempts: this.db().listDeliveryAttempts(delivery.id) }
            : {}),
        })),
    };
  }

  private deliveryView(delivery: DeliveryRecord) {
    const occurrence = delivery.alert
      ? undefined
      : this.getOccurrence(delivery.alertId);
    let definition: AlertDefinitionRecord | undefined;
    if (occurrence?.definitionId) {
      try {
        definition = this.db().getDefinition(occurrence.definitionId);
      } catch {
        definition = undefined;
      }
    }
    const notifier = (this.config.notifiers ?? []).find(
      (item) => item.name === delivery.transportInstanceId,
    );
    return {
      ...delivery,
      playback: this.db().listWyomingPlaybacks(delivery.id),
      alert:
        delivery.alert ??
        (occurrence
          ? {
              occurrenceId: occurrence.id,
              occurrenceNumber: occurrence.occurrenceNumber,
              definitionId: occurrence.definitionId,
              name: definition?.name ?? occurrence.path,
              path: occurrence.path,
              message: occurrence.message,
              severity: occurrence.maxSeverity,
              startedAt: occurrence.firstSeenAt,
            }
          : undefined),
      service: {
        id: delivery.transportInstanceId,
        name: delivery.transportInstanceId,
        type: notifier?.type ?? "unknown",
      },
    };
  }

  private recordWyomingAnnouncement(
    deliveryId: string,
    kind: WyomingAnnouncementContent["kind"],
    snapshot: WyomingAnnouncementSnapshot,
  ): void {
    if (!this.database) return;
    this.database.recordWyomingPlayback(deliveryId, kind, snapshot);
    this.emitChange("wyoming_playback");
  }

  private reconcileWyomingAnnouncements(api: WyomingAnnouncementApi): void {
    if (!this.database || !api.getAnnouncement) return;
    const notifierIds = (this.config.notifiers ?? [])
      .filter(
        (notifier) => notifier.enabled !== false && notifier.type === "wyoming",
      )
      .map((notifier) => notifier.name);
    for (const delivery of this.database.listWyomingDeliveryCandidates(
      notifierIds,
    )) {
      for (const value of delivery.remoteId?.split(",") ?? []) {
        const separator = value.indexOf(":");
        const kind = value.slice(0, separator);
        const announcementId = value.slice(separator + 1);
        if (
          separator < 1 ||
          (kind !== "sound" && kind !== "speech") ||
          !announcementId
        )
          continue;
        const snapshot = api.getAnnouncement(announcementId);
        if (snapshot)
          this.database.recordWyomingPlayback(delivery.id, kind, snapshot);
        else if (!this.database.getWyomingPlayback(announcementId))
          this.database.recordWyomingPlayback(delivery.id, kind, {
            id: announcementId,
            state: "unknown",
            targets: {},
          });
      }
    }
    for (const playback of this.database.listIncompleteWyomingPlaybacks()) {
      const snapshot = api.getAnnouncement(playback.announcementId);
      if (snapshot)
        this.database.recordWyomingPlayback(
          playback.deliveryId,
          playback.kind,
          snapshot,
        );
      else
        this.database.markWyomingPlaybackUnknown(
          playback.announcementId,
          "signalk-wyoming no longer has this announcement after restart",
        );
    }
    this.emitChange("wyoming_playback");
  }

  private page<T extends { id: string }>(
    items: T[],
    limit: number,
    cursor?: string,
  ) {
    const index = cursor ? items.findIndex((item) => item.id === cursor) : -1;
    const start = cursor ? (index < 0 ? items.length : index + 1) : 0;
    const selected = items.slice(start, start + limit);
    return {
      items: selected,
      nextCursor:
        start + limit < items.length ? selected.at(-1)?.id : undefined,
    };
  }

  private getDefinition(id: string): DefinitionView | undefined {
    try {
      return this.definitionView(this.db().getDefinition(id));
    } catch {
      return undefined;
    }
  }

  private getOccurrence(id: string): AlertRecord | undefined {
    try {
      return this.db().getAlert(id);
    } catch {
      return undefined;
    }
  }

  private async upstreamAction(
    occurrence: AlertRecord,
    action: "acknowledge" | "silence",
  ): Promise<Pick<ActionResult, "upstream" | "message">> {
    if (!occurrence.notificationId) return { upstream: "not_requested" };
    try {
      const notificationId = occurrence.notificationId as NotificationId;
      const alarm = this.app.notifications.getId(notificationId) as
        | {
            value?: {
              status?: {
                canAcknowledge?: boolean;
                canSilence?: boolean;
              };
            };
          }
        | undefined;
      const supported =
        action === "acknowledge"
          ? alarm?.value?.status?.canAcknowledge
          : alarm?.value?.status?.canSilence;
      if (!supported)
        return {
          upstream: "unsupported",
          message: `Signal K does not allow ${action} for this notification`,
        };
      const operation = (
        this.app.notifications[action] as (
          id: NotificationId,
        ) => unknown | Promise<unknown>
      )(notificationId);
      if (
        operation &&
        typeof (operation as PromiseLike<unknown>).then === "function"
      )
        await Promise.race([
          Promise.resolve(operation),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("UPSTREAM_ACTION_TIMEOUT")),
              UPSTREAM_ACTION_TIMEOUT_MS,
            ),
          ),
        ]);
      const refreshed = this.app.notifications.getId(notificationId);
      const confirmed =
        action === "acknowledge"
          ? refreshed?.value.status?.acknowledged
          : refreshed?.value.status?.silenced;
      if (!confirmed)
        return {
          upstream: "failed",
          message: `Signal K did not confirm ${action}`,
        };
      return { upstream: "applied" };
    } catch (error) {
      if (error instanceof Error && error.message === "UPSTREAM_ACTION_TIMEOUT")
        return {
          upstream: "timed_out",
          message: `Signal K ${action} timed out after ${UPSTREAM_ACTION_TIMEOUT_MS / 1000} seconds`,
        };
      return {
        upstream: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private repository(): AlertCenterRepository {
    return {
      listDefinitions: (query: DefinitionQuery) => {
        let items = this.db()
          .listDefinitions()
          .map((item) => this.definitionView(item));
        if (query.sourceType)
          items = items.filter((item) => item.sourceType === query.sourceType);
        if (query.zone)
          items = items.filter((item) => item.zone === query.zone);
        if (query.enabled !== undefined)
          items = items.filter((item) => item.policy.enabled === query.enabled);
        return this.page(items, query.limit, query.cursor);
      },
      getDefinition: (id) => this.getDefinition(id),
      updatePolicy: (id: string, patch: AlertPolicyPatch) => {
        const current = this.getDefinition(id);
        if (!current) return undefined;
        const previousOverrides = new Set(current.policy.overriddenFields);
        const changedFields: AlertPolicyField[] = [];
        if (patch.enabled !== undefined) changedFields.push("enabled");
        if (patch.oneTime !== undefined) changedFields.push("oneTime");
        if (patch.minimumSeverity !== undefined)
          changedFields.push("minimumSeverity");
        if (patch.activationDelaySeconds !== undefined)
          changedFields.push("activationDelaySeconds");
        if (patch.connectivity !== undefined)
          changedFields.push("connectivity");
        if (
          patch.notifierIds !== undefined ||
          patch.notifierRepeatOverrides !== undefined
        )
          changedFields.push("notifierIds");
        if (patch.soundEnabled !== undefined)
          changedFields.push("soundEnabled");
        if (patch.soundId !== undefined) changedFields.push("soundId");
        if (patch.speechEnabled !== undefined)
          changedFields.push("speechEnabled");
        if (patch.speechMinimumSeverity !== undefined)
          changedFields.push("speechMinimumSeverity");
        if (patch.speechTemplate !== undefined)
          changedFields.push("speechTemplate");
        if (patch.speechAnnounceClear !== undefined)
          changedFields.push("speechAnnounceClear");
        const overrideFields = patch.overrideFields
          ? [...patch.overrideFields]
          : [...new Set([...previousOverrides, ...changedFields])];
        if (overrideFields.length === 0) {
          this.db().clearPolicy(id);
          const inherited = this.getDefinition(id);
          this.debug(
            `Reset alert policy to global defaults: definitionId=${id}`,
          );
          this.emitChange("policy");
          return inherited;
        }
        this.db().setPolicy(id, {
          enabled: patch.enabled ?? current.policy.enabled,
          oneTime: patch.oneTime ?? current.policy.oneTime,
          minimumSeverity:
            patch.minimumSeverity ?? current.policy.minimumSeverity,
          activationDelaySeconds:
            patch.activationDelaySeconds ??
            current.policy.activationDelaySeconds,
          connectivity: patch.connectivity ?? current.policy.connectivity,
          notifierIds: patch.notifierIds ?? current.policy.notifierIds,
          notifierRepeatOverrides:
            patch.notifierRepeatOverrides ??
            current.policy.notifierRepeatOverrides,
          soundEnabled: patch.soundEnabled ?? current.policy.soundEnabled,
          soundId: patch.soundId ?? current.policy.soundId,
          speechEnabled: patch.speechEnabled ?? current.policy.speechEnabled,
          speechMinimumSeverity:
            patch.speechMinimumSeverity ?? current.policy.speechMinimumSeverity,
          speechTemplate: patch.speechTemplate ?? current.policy.speechTemplate,
          speechAnnounceClear:
            patch.speechAnnounceClear ?? current.policy.speechAnnounceClear,
          overrideFields,
        });
        const updated = this.getDefinition(id);
        this.debug(`Updated alert policy: definitionId=${id}`);
        this.emitChange("policy");
        return updated;
      },
      resetPolicy: (id: string) => {
        const current = this.getDefinition(id);
        if (!current) return undefined;
        this.db().clearPolicy(id);
        const updated = this.getDefinition(id);
        this.debug(`Reset alert policy to global defaults: definitionId=${id}`);
        this.emitChange("policy");
        return updated;
      },
      deleteDefinition: (id: string) => {
        const result = this.db().deleteDefinition(id);
        if (result === "deleted") {
          this.scheduleNextWake();
          this.scheduleNextActivation();
          this.scheduleNextDelivery();
          this.debug(`Removed stored alert: definitionId=${id}`);
          this.emitChange("definition");
        }
        return result;
      },
      listOccurrences: (query: OccurrenceQuery) => {
        const page = this.db().queryOccurrences(query);
        return {
          items: page.items.map((item) => this.occurrenceView(item)),
          nextCursor: page.nextCursor,
        };
      },
      getOccurrence: (id) => {
        const occurrence = this.getOccurrence(id);
        return occurrence ? this.occurrenceView(occurrence, true) : undefined;
      },
      listOccurrenceEvents: (id: string, query: EventQuery) => {
        if (!this.getOccurrence(id)) return undefined;
        let items = this.db()
          .listAlertEvents(id)
          .sort(
            (left, right) =>
              right.occurredAt.getTime() - left.occurredAt.getTime() ||
              right.id - left.id,
          )
          .map((event) => ({
            id: String(event.id),
            occurrenceId: event.alertId,
            eventType: event.eventType,
            occurredAt: event.occurredAt,
            payload: event.payload,
          }));
        if (query.eventType)
          items = items.filter((event) => event.eventType === query.eventType);
        return this.page(items, query.limit, query.cursor);
      },
      listAlertHistory: (query) => this.db().queryAlertHistory(query),
      listDeliveries: (query) => {
        const page = this.db().queryDeliveries(query.limit, query.cursor);
        return {
          items: page.items.map((delivery) => this.deliveryView(delivery)),
          nextCursor: page.nextCursor,
          total: page.total,
        };
      },
      getDelivery: (id) => {
        const delivery = this.db().getDelivery(id);
        return delivery ? this.deliveryView(delivery) : undefined;
      },
      listDeliveryAttempts: (id, query) =>
        this.db().queryDeliveryAttempts(id, query.limit, query.cursor),
      retryDelivery: (id) => {
        const result = this.db().retryDelivery(id);
        if (result === "scheduled") {
          this.debug(`Retrying delivery: deliveryId=${id}`);
          this.requestDeliveryRun();
          this.emitChange("deliveries");
        }
        return result;
      },
      acknowledgeOccurrence: async (id) => {
        const occurrence = this.getOccurrence(id);
        if (!occurrence) return false;
        if (occurrence.currentState !== "active") return "inactive";
        const upstream = await this.upstreamAction(occurrence, "acknowledge");
        this.db().acknowledgeAlert(id);
        this.requestDeliveryRun();
        this.db().recordOccurrenceEvent(
          id,
          `upstream_acknowledge_${upstream.upstream}`,
          {
            message: upstream.message,
          },
        );
        this.debug(
          `Acknowledged occurrence: occurrenceId=${id}, upstream=${upstream.upstream}`,
        );
        this.emitChange("occurrence");
        return { status: "acknowledged", ...upstream };
      },
      silenceOccurrence: async (id) => {
        const occurrence = this.getOccurrence(id);
        if (!occurrence) return false;
        if (occurrence.currentState !== "active") return "inactive";
        const upstream = await this.upstreamAction(occurrence, "silence");
        this.db().silenceAlert(id);
        this.db().recordOccurrenceEvent(
          id,
          `upstream_silence_${upstream.upstream}`,
          {
            message: upstream.message,
          },
        );
        this.debug(
          `Silenced occurrence: occurrenceId=${id}, upstream=${upstream.upstream}`,
        );
        this.emitChange("occurrence");
        return { status: "silenced", ...upstream };
      },
    };
  }

  start(options: PluginConfig): void {
    validateConfig(options);
    if (this.database)
      throw new Error(
        "Signal K Alert Center is already started; stop it before starting again",
      );
    this.stopping = false;
    const generation = ++this.runtimeGeneration;
    this.startCount += 1;
    this.debug(
      `Starting: configuredServices=${options.notifiers?.length ?? 0}, deliveryBatchSize=${options.delivery?.batchSize ?? 50}, deliveryConcurrency=${options.delivery?.concurrency ?? 4}, connectivity=${options.connectivity?.enabled ? "enabled" : "disabled"}`,
    );
    this.config = options;
    this.database = new AlertDatabase(this.databasePath(options));
    if (this.database.migrationApplied)
      this.debug("Migrated the database without removing stored alert data");
    this.database.configureResolvingNotifiers(
      (options.notifiers ?? [])
        .filter(
          (notifier) =>
            notifier.enabled !== false && notifier.type === "pagerduty",
        )
        .map((notifier) => notifier.name),
    );
    this.policy = new AlertPolicyResolver(this.database, options);
    this.reconcilingStartup = true;
    this.reconciliationState = { state: "running", startedAt: new Date() };
    this.ingestionQueue = new BoundedIngestionQueue(
      options.ingestion?.queueLimit ?? DEFAULT_INGESTION_QUEUE_LIMIT,
    );
    this.lastQueueWarningAt = 0;

    this.transports = new Map<string, NotificationTransport>();
    const propertyApp = this.app as ServerAPI & PropertyValueApp;
    if (
      (options.notifiers ?? []).some(
        (notifier) => notifier.enabled !== false && notifier.type === "wyoming",
      ) &&
      typeof propertyApp.onPropertyValues === "function"
    ) {
      const unsubscribe = propertyApp.onPropertyValues(
        "signalk-wyoming.announcements.api",
        (history) => {
          const candidate = [...history]
            .reverse()
            .map((entry) => entry?.value)
            .find((value): value is WyomingAnnouncementApi =>
              Boolean(
                value &&
                typeof value === "object" &&
                (value as WyomingAnnouncementApi).version === 1 &&
                typeof (value as WyomingAnnouncementApi).announce ===
                  "function",
              ),
            );
          if (!candidate) return;
          this.wyomingAnnouncementUnsubscribe?.();
          this.wyomingApi = candidate;
          this.wyomingAnnouncementUnsubscribe = candidate.onAnnouncementEvent?.(
            (event) => {
              const playback = this.database?.getWyomingPlayback(
                event.announcementId,
              );
              const snapshot = candidate.getAnnouncement?.(
                event.announcementId,
              );
              if (playback && snapshot)
                this.recordWyomingAnnouncement(
                  playback.deliveryId,
                  playback.kind,
                  snapshot,
                );
            },
          );
          this.debug("Connected to signalk-wyoming announcement API");
          this.reconcileWyomingAnnouncements(candidate);
          this.requestDeliveryRun();
        },
      );
      this.wyomingUnsubscribe =
        typeof unsubscribe === "function" ? unsubscribe : undefined;
    }
    for (const notifier of options.notifiers ?? []) {
      if (notifier.enabled === false) continue;
      if (notifier.type === "ntfy")
        this.transports.set(
          notifier.name,
          new NtfyTransport({
            server: String(notifier.server),
            topic: String(notifier.topic),
            token: notifier.token ? String(notifier.token) : undefined,
          }),
        );
      if (notifier.type === "pagerduty")
        this.transports.set(
          notifier.name,
          new PagerDutyTransport(String(notifier.routingKey)),
        );
      if (notifier.type === "discord")
        this.transports.set(
          notifier.name,
          new DiscordTransport(String(notifier.webhookUrl)),
        );
      if (notifier.type === "telegram")
        this.transports.set(
          notifier.name,
          new TelegramTransport({
            botToken: notifier.botToken,
            chatId: notifier.chatId,
            messageThreadId: notifier.messageThreadId,
            disableNotification: notifier.disableNotification,
          }),
        );
      if (notifier.type === "wyoming")
        this.transports.set(
          notifier.name,
          new WyomingTransport({
            api: () => this.wyomingApi,
            targets: notifier.targets,
            voice: notifier.voice,
            urgentAt: notifier.urgentAt,
            sounds: notifier.sounds,
            onAnnouncement: (deliveryId, kind, snapshot) =>
              this.recordWyomingAnnouncement(deliveryId, kind, snapshot),
            definitionName: (definitionId) => {
              if (!definitionId) return undefined;
              try {
                return this.database?.getDefinition(definitionId).name;
              } catch {
                return undefined;
              }
            },
          }),
        );
    }
    this.scheduler = new DeliveryScheduler(
      this.database,
      this.transports,
      {
        initialSeconds: options.retry?.initialSeconds ?? 10,
        maxSeconds: options.retry?.maxSeconds ?? 1800,
        multiplier: options.retry?.multiplier ?? 2,
        jitter: options.retry?.jitter ?? 0.2,
      },
      {
        batchSize: options.delivery?.batchSize ?? 50,
        concurrency: options.delivery?.concurrency ?? 4,
        requestTimeoutSeconds: options.delivery?.requestTimeoutSeconds ?? 15,
      },
    );
    const switchConfig = options.connectivity?.switch;
    if (options.connectivity?.enabled && switchConfig)
      this.connectivity = new ConnectivityManager(
        createSignalKSwitch(
          this.app,
          switchConfig.path,
          switchConfig.onValue,
          switchConfig.offValue,
        ),
        (options.connectivity.idleCooldownSeconds ?? 300) * 1000,
        options.connectivity.probe
          ? createInternetProbe({
              url: options.connectivity.probe.url,
              timeoutMs:
                (options.connectivity.probe.timeoutSeconds ?? 10) * 1000,
            })
          : undefined,
        (options.connectivity.bootTimeoutSeconds ?? 240) * 1000,
        (options.connectivity.internetCheckIntervalSeconds ?? 5) * 1000,
        () => ({
          pendingDelivery: (this.database?.pendingDeliveryCount() ?? 0) > 0,
          activeWakeAlert: this.database?.hasActiveConnectivityAlert() ?? false,
          scheduledWake: this.database?.hasWakeRequests() ?? false,
          sendInFlight: this.scheduler?.isRunning ?? false,
        }),
      );

    this.scheduleNextWake();
    this.database.processDueActivations();
    this.scheduleNextActivation();

    const handler = (delta: unknown): void => {
      if (generation !== this.runtimeGeneration || this.stopping) return;
      const entries = extractNotificationEntries(delta);
      this.enqueueNotifications(entries);
    };
    const unsubscribes: Array<() => void> = [];
    this.app.subscriptionmanager.subscribe(
      {
        context: "vessels.self" as Context,
        sourcePolicy: "all",
        subscribe: [{ path: "notifications.*" as Path, policy: "instant" }],
      },
      unsubscribes,
      (error: unknown) =>
        this.reportAsyncError("Notification subscription failed", error),
      handler,
    );
    this.unsubscribe = () => unsubscribes.forEach((stop) => stop());

    // Return control to Signal K before scanning the model. Deltas received
    // after subscribing are queued and applied after the snapshot so an older
    // startup value cannot overwrite a newer update.
    this.startupImmediate = setImmediate(() => {
      this.startupImmediate = undefined;
      void this.reconcileStartup(generation).catch((error: unknown) => {
        if (generation !== this.runtimeGeneration) return;
        this.reconcilingStartup = false;
        const completedAt = new Date();
        this.reconciliationState = {
          state: "failed",
          startedAt: this.reconciliationState.startedAt,
          completedAt,
          durationMs: this.reconciliationState.startedAt
            ? completedAt.getTime() -
              this.reconciliationState.startedAt.getTime()
            : undefined,
          queuedEntries: this.ingestionQueue.stats().received,
          error: error instanceof Error ? error.message : String(error),
        };
        this.reportAsyncError(
          "Could not reconcile current notifications",
          error,
        );
        // The subscription remains live. The bounded ingestion worker drains
        // entries retained while snapshot reconciliation was running.
        this.scheduleIngestionDrain();
      });
    });
    this.zoneRefreshTimer = setInterval(
      () => {
        this.seedDefinitions();
        this.emitChange("definitions");
      },
      (options.discovery?.zoneRefreshSeconds ?? 300) * 1000,
    );
    if (options.retention?.enabled)
      this.retentionTimer = setInterval(
        () => {
          try {
            this.runRetention();
          } catch (error) {
            this.reportAsyncError("Retention cleanup failed", error);
          }
        },
        Math.min(
          MAX_TIMER_DELAY,
          (options.retention.intervalHours ?? 24) * 3_600_000,
        ),
      );
    this.app.setPluginStatus(this.statusMessage());
    this.debug("Started and subscribed to Signal K notifications");
  }

  registerWithRouter(router: PluginRouter): void {
    const compatible = router as unknown as RouterLike;
    const repository = this.repository();
    registerRoutes(
      compatible,
      () => this.database,
      () => this.status(),
      () => this.runScheduler(),
      () =>
        this.database
          ?.listDefinitions()
          .map((item) => this.definitionView(item)) ?? [],
      (id) => Boolean(repository.acknowledgeOccurrence(id)),
      (id) => Boolean(repository.silenceOccurrence(id)),
    );
    registerAlertCenterRoutes(compatible, {
      repository: () => (this.database ? repository : undefined),
      listNotifiers: () =>
        (this.config.notifiers ?? [])
          .filter((notifier) => notifier.enabled !== false)
          .map((notifier) => ({
            id: notifier.name,
            name: notifier.name,
            type: notifier.type,
            enabled: true,
            minimumSeverity: notifier.minSeverity ?? "normal",
            repeatIntervalSeconds: notifier.repeatIntervalSeconds ?? 0,
          })),
      testNotifier: (id, operation) => this.testNotifier(id, operation),
      subscribeChanges: (listener) => this.subscribeChanges(listener),
    });
  }

  private async testNotifier(
    id: string,
    operation: NotificationTestOperation,
  ): Promise<
    | NotificationTestResult
    | "not_found"
    | "disabled"
    | "in_progress"
    | "unsupported"
  > {
    const notifier = (this.config.notifiers ?? []).find(
      (candidate) => candidate.name === id,
    );
    if (!notifier) return "not_found";
    if (notifier.enabled === false) return "disabled";
    if (operation === "resolve" && notifier.type !== "pagerduty")
      return "unsupported";
    if (this.notifierTests.has(id)) return "in_progress";
    this.notifierTests.add(id);
    const startedAt = Date.now();
    try {
      const timeoutMs = Math.min(
        30_000,
        Math.max(
          1_000,
          (this.config.delivery?.requestTimeoutSeconds ?? 15) * 1_000,
        ),
      );
      const result =
        notifier.type === "wyoming"
          ? await this.testWyomingService(notifier, timeoutMs)
          : await testNotificationService(notifier, {
              timeoutMs,
              operation,
            });
      this.debug(
        `Manual service test: service=${notifier.name}, type=${notifier.type}, operation=${operation}, outcome=${result.category}, durationMs=${result.durationMs}`,
      );
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.app.error(
        `[alert-center] Manual service test failed: service=${notifier.name}, type=${notifier.type}, outcome=internal, durationMs=${durationMs}`,
      );
      throw error;
    } finally {
      this.notifierTests.delete(id);
    }
  }

  private async testWyomingService(
    notifier: Extract<NotifierConfig, { type: "wyoming" }>,
    timeoutMs: number,
  ): Promise<NotificationTestResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const transport = new WyomingTransport({
      api: () => this.wyomingApi,
      targets: notifier.targets,
      voice: notifier.voice,
      urgentAt: notifier.urgentAt,
      sounds: notifier.sounds,
    });
    try {
      const result = await transport.announce(
        "Test announcement from Signal K Alert Center.",
        "normal",
        controller.signal,
      );
      return {
        status: result.kind === "success" ? "success" : "error",
        category: result.kind === "success" ? "success" : "transport",
        message:
          result.kind === "success"
            ? "signalk-wyoming queued the spoken test announcement."
            : result.message,
        ...(result.kind === "success" ? {} : { technicalDetail: result.code }),
        durationMs: Date.now() - startedAt,
        operation: "send",
        service: { id: notifier.name, type: notifier.type },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(): Promise<void> {
    this.debug("Stopping");
    this.stopping = true;
    this.runtimeGeneration += 1;
    this.stopCount += 1;
    this.reconcilingStartup = false;
    this.ingestionQueue.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.wyomingUnsubscribe?.();
    this.wyomingUnsubscribe = undefined;
    this.wyomingAnnouncementUnsubscribe?.();
    this.wyomingAnnouncementUnsubscribe = undefined;
    this.wyomingApi = undefined;
    if (this.startupImmediate) clearImmediate(this.startupImmediate);
    if (this.ingestionImmediate) clearImmediate(this.ingestionImmediate);
    if (this.deliveryImmediate) clearImmediate(this.deliveryImmediate);
    this.startupImmediate = undefined;
    this.ingestionImmediate = undefined;
    this.deliveryImmediate = undefined;
    this.deliveryRerunRequested = false;
    if (this.activationTimer) clearTimeout(this.activationTimer);
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    if (this.zoneRefreshTimer) clearInterval(this.zoneRefreshTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    await this.scheduler?.stop();
    await this.deliveryRun;
    this.connectivity?.stop();
    this.database?.close();
    this.database = undefined;
    this.changeListeners.clear();
    this.scheduler = undefined;
    this.deliveryRun = undefined;
    this.connectivity = undefined;
    this.policy = undefined;
    this.transports.clear();
    this.activationTimer = undefined;
    this.deliveryTimer = undefined;
    this.zoneRefreshTimer = undefined;
    this.retentionTimer = undefined;
    this.debug("Stopped");
  }
}
