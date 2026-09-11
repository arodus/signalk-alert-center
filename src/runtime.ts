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
  AlertRecord,
  audioSounds,
  CustomAudioSound,
  DeliveryRecord,
} from "./alerts/types";
import { listConfiguredZones } from "./alerts/zones";
import {
  AudioCommand,
  AudioPlayer,
  CommandAudioPlayer,
  HookedAudioPlayer,
  SessionAudioPlayer,
} from "./audio/player";
import { AudioScheduler } from "./audio/scheduler";
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
import { PluginConfig, validateConfig } from "./config";
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
import { NotificationTransport } from "./transports/transport";

const MAX_TIMER_DELAY = 2_147_000_000;
const UPSTREAM_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_INGESTION_QUEUE_LIMIT = 2_000;
const DEFAULT_INGESTION_BATCH_SIZE = 100;
const QUEUE_WARNING_INTERVAL_MS = 60_000;

interface DefinitionView extends AlertDefinitionRecord {
  description?: string;
  zone?: string;
  oneTime: boolean;
  fireCount: number;
  lastFiredAt?: Date;
  lastActivityAt?: Date;
  policy: EffectivePolicy;
}

export class PersistentNotifierRuntime {
  private database?: AlertDatabase;
  private scheduler?: DeliveryScheduler;
  private audioScheduler?: AudioScheduler;
  private connectivity?: ConnectivityManager;
  private policy?: AlertPolicyResolver;
  private unsubscribe?: () => void;
  private activationTimer?: ReturnType<typeof setTimeout>;
  private deliveryTimer?: ReturnType<typeof setTimeout>;
  private audioTimer?: ReturnType<typeof setTimeout>;
  private zoneRefreshTimer?: ReturnType<typeof setInterval>;
  private retentionTimer?: ReturnType<typeof setInterval>;
  private reconcilingStartup = false;
  private ingestionQueue = new BoundedIngestionQueue(
    DEFAULT_INGESTION_QUEUE_LIMIT,
  );
  private ingestionImmediate?: ReturnType<typeof setImmediate>;
  private startupImmediate?: ReturnType<typeof setImmediate>;
  private deliveryImmediate?: ReturnType<typeof setImmediate>;
  private audioImmediate?: ReturnType<typeof setImmediate>;
  private deliveryRun?: Promise<void>;
  private audioRun?: Promise<void>;
  private deliveryRerunRequested = false;
  private audioRerunRequested = false;
  private runtimeGeneration = 0;
  private stopping = false;
  private startCount = 0;
  private stopCount = 0;
  private lastQueueWarningAt = 0;
  private config: PluginConfig = {};
  private transports = new Map<string, NotificationTransport>();
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

  constructor(
    private readonly app: ServerAPI,
    private readonly audioPlayerFactory?: (
      options: PluginConfig,
    ) => AudioPlayer,
  ) {}

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
      options.storage?.path?.trim() || "persistent-notifier.sqlite";
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

  async testAudio(options: PluginConfig): Promise<void> {
    validateConfig(options);
    const player = this.createAudioPlayer(options);
    try {
      const result = await player.play("chime");
      this.debug(`Local audio test succeeded: backend=${result.backend}`);
    } catch (error) {
      this.app.error(
        `[persistent-notifier] Local audio test failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await player.stop?.();
    }
  }

  private createAudioPlayer(options: PluginConfig): AudioPlayer {
    let player = this.audioPlayerFactory
      ? this.audioPlayerFactory(options)
      : new CommandAudioPlayer({
          backend: options.audio?.backend ?? "auto",
          outputDevice: options.audio?.outputDevice?.trim() || undefined,
          masterVolume: options.audio?.masterVolume ?? 80,
          timeoutSeconds: options.audio?.playbackTimeoutSeconds ?? 30,
          assetDirectory: path.join(
            this.app.getDataDirPath(),
            "persistent-notifier-audio",
          ),
          customSounds: new Map(
            (options.audio?.customSounds ?? []).map((sound) => [
              `custom:${sound.name}` as CustomAudioSound,
              path.isAbsolute(sound.filePath)
                ? sound.filePath
                : path.join(this.app.getDataDirPath(), sound.filePath),
            ]),
          ),
        });
    const before = configuredAudioCommand(options.audio?.beforePlaybackCommand);
    const after = configuredAudioCommand(options.audio?.afterPlaybackCommand);
    if (before || after)
      player = new HookedAudioPlayer(player, {
        before,
        after,
        timeoutSeconds: options.audio?.commandTimeoutSeconds ?? 10,
        onCommandError: (_stage, message) =>
          this.app.error(`[persistent-notifier] ${message}`),
      });
    const sessionStart = configuredAudioCommand(
      options.audio?.sessionStartCommand,
    );
    const sessionStop = configuredAudioCommand(
      options.audio?.sessionStopCommand,
    );
    if (sessionStart && sessionStop)
      player = new SessionAudioPlayer(player, {
        start: sessionStart,
        stop: sessionStop,
        idleCooldownSeconds: options.audio?.sessionIdleCooldownSeconds ?? 30,
        timeoutSeconds: options.audio?.commandTimeoutSeconds ?? 10,
        onCommandError: (stage, message) =>
          this.app.error(
            `[persistent-notifier] Audio session ${stage} failed: ${message}`,
          ),
        onStateChange: (status) => {
          this.debug(
            `Audio session: state=${status.state}, ownedByPlugin=${status.ownedByPlugin}`,
          );
          this.emitChange("audio-session");
        },
      });
    return player;
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
    const audio = this.audioScheduler?.status() ?? { running: false };
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
      audio.lastError ? `Local audio failed: ${audio.lastError}` : undefined,
      audio.session?.lastError && audio.session.lastError !== audio.lastError
        ? `Local audio session failed: ${audio.session.lastError}`
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
      audio: {
        enabled: this.config.audio?.enabled ?? false,
        pending: this.database?.pendingAudioPlaybackCount() ?? 0,
        ...audio,
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
    return `${current.health.state}: ${current.alerts.active} active, ${current.alerts.pendingDelivery} deliveries pending, ${current.audio.pending} sounds pending`;
  }

  private debug(message: string): void {
    this.app.debug(`[persistent-notifier] ${message}`);
  }

  private reportAsyncError(context: string, error: unknown): void {
    this.app.error(
      `[persistent-notifier] ${context}: ${
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
          `[persistent-notifier] Removed failed dashboard event listener: ${error instanceof Error ? error.message : String(error)}`,
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
    const summary = await this.scheduler?.runOnce();
    if (summary?.processed) {
      const message = `Delivery batch: processed=${summary.processed}, succeeded=${summary.succeeded}, retryableFailures=${summary.retryableFailures}, terminalFailures=${summary.terminalFailures}`;
      if (summary.retryableFailures || summary.terminalFailures)
        this.app.error(`[persistent-notifier] ${message}`);
      else this.debug(message);
    }
    if (this.connectivity && this.database?.pendingDeliveryCount() === 0)
      this.connectivity.beginCooldown();
    this.scheduleNextDelivery();
    if (summary?.processed) this.emitChange("deliveries");
  }

  private async runAudioScheduler(): Promise<void> {
    if (!this.audioScheduler || !this.database) return;
    const before = this.database.pendingAudioPlaybackCount();
    const previous = this.audioScheduler.status();
    await this.audioScheduler?.runOnce();
    this.scheduleNextAudio();
    const current = this.audioScheduler.status();
    if (
      before !== this.database.pendingAudioPlaybackCount() ||
      previous.lastPlayedAt !== current.lastPlayedAt ||
      previous.lastError !== current.lastError
    )
      this.emitChange("audio");
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

  private requestAudioRun(): void {
    if (this.stopping) return;
    if (this.audioRun) {
      this.audioRerunRequested = true;
      return;
    }
    if (this.audioImmediate || !this.audioScheduler || !this.database) return;
    const generation = this.runtimeGeneration;
    this.audioImmediate = setImmediate(() => {
      this.audioImmediate = undefined;
      if (generation !== this.runtimeGeneration || !this.database) return;
      const running = this.runAudioScheduler();
      this.audioRun = running;
      void running
        .catch((error: unknown) =>
          this.reportAsyncError("Local audio scheduler failed", error),
        )
        .finally(() => {
          if (this.audioRun === running) this.audioRun = undefined;
          if (this.audioRerunRequested) {
            this.audioRerunRequested = false;
            this.requestAudioRun();
          }
        });
    });
  }

  private scheduleNextAudio(): void {
    if (this.audioTimer) clearTimeout(this.audioTimer);
    this.audioTimer = undefined;
    if (this.stopping) return;
    const dueAt = this.database?.nextAudioPlaybackDueAt();
    if (!dueAt || !this.audioScheduler) return;
    const delay = Math.min(
      MAX_TIMER_DELAY,
      Math.max(0, dueAt.getTime() - Date.now()),
    );
    this.audioTimer = setTimeout(() => {
      this.audioTimer = undefined;
      this.requestAudioRun();
    }, delay);
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
        `[persistent-notifier] Notification ingestion queue reached its ${stats.limit}-entry limit; rejected=${stats.rejected}, depth=${stats.depth}. Alert transitions may be missing.`,
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
    this.requestAudioRun();
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
    const occurrence = new AlertLifecycle(this.db(), []).ingest(
      normalized,
      policy.enabled ? notifierIds : [],
      receivedAt,
      {
        definitionId: this.policies().ensureDefinitionForPath(normalized.path),
        activationDelaySeconds: policy.activationDelaySeconds,
        connectivity: policy.connectivity,
        minimumSeverity: policy.minimumSeverity,
        oneTime: policy.oneTime,
        rearmAfterSeconds: policy.rearmAfterSeconds,
        notifierMinimumSeverities: Object.fromEntries(
          notifierIds.map((id) => [
            id,
            configuredNotifiers.get(id)?.minSeverity ?? "normal",
          ]),
        ),
      },
    );
    if (!occurrence) return undefined;
    if (occurrence.currentState === "cleared")
      this.audioScheduler?.cancel(occurrence.id, "clear", receivedAt);
    else
      this.audioScheduler?.queue(
        occurrence,
        policy.audio,
        policy.activationDelaySeconds,
        receivedAt,
      );
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
      this.requestAudioRun();
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
          ...(includeAttempts
            ? { attempts: this.db().listDeliveryAttempts(delivery.id) }
            : {}),
        })),
      audioPlayback: this.db().getAudioPlaybackForAlert(occurrence.id),
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
        this.db().setPolicy(id, {
          enabled: patch.enabled ?? current.policy.enabled,
          oneTime: patch.oneTime ?? current.policy.oneTime,
          minimumSeverity:
            patch.minimumSeverity ?? current.policy.minimumSeverity,
          activationDelaySeconds:
            patch.activationDelaySeconds ??
            current.policy.activationDelaySeconds,
          rearmAfterSeconds:
            patch.rearmAfterSeconds === null
              ? 0
              : (patch.rearmAfterSeconds ?? current.policy.rearmAfterSeconds),
          connectivity: patch.connectivity ?? current.policy.connectivity,
          notifierIds: patch.notifierIds ?? current.policy.notifierIds,
          audio: patch.audio ?? current.policy.audio,
        });
        const updated = this.getDefinition(id);
        this.debug(`Updated alert policy: definitionId=${id}`);
        this.emitChange("policy");
        return updated;
      },
      forgetDefinition: (id: string) => {
        const result = this.db().forgetDiscoveredDefinition(id);
        if (result === "deleted") {
          this.debug(`Forgot discovered alert: definitionId=${id}`);
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
      listDeliveries: (query) => {
        const page = this.db().queryDeliveries(query.limit, query.cursor);
        return {
          items: page.items.map((delivery) => this.deliveryView(delivery)),
          nextCursor: page.nextCursor,
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
      dismissOccurrence: (id) => {
        const occurrence = this.getOccurrence(id);
        if (!occurrence) return false;
        this.db().dismissOccurrence(id);
        this.audioScheduler?.cancel(id, "dismiss");
        this.scheduleNextAudio();
        this.debug(`Dismissed occurrence: occurrenceId=${id}`);
        this.emitChange("occurrence");
        return { status: "dismissed", upstream: "not_requested" };
      },
      acknowledgeOccurrence: async (id) => {
        const occurrence = this.getOccurrence(id);
        if (!occurrence) return false;
        if (occurrence.currentState !== "active") return "inactive";
        const upstream = await this.upstreamAction(occurrence, "acknowledge");
        this.db().acknowledgeAlert(id);
        this.audioScheduler?.cancel(id, "acknowledge");
        this.scheduleNextAudio();
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
        this.audioScheduler?.cancel(id, "silence");
        this.scheduleNextAudio();
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
        "Persistent notifier is already started; stop it before starting again",
      );
    this.stopping = false;
    const generation = ++this.runtimeGeneration;
    this.startCount += 1;
    this.debug(
      `Starting: configuredServices=${options.notifiers?.length ?? 0}, deliveryBatchSize=${options.delivery?.batchSize ?? 50}, deliveryConcurrency=${options.delivery?.concurrency ?? 4}, connectivity=${options.connectivity?.enabled ? "enabled" : "disabled"}`,
    );
    this.config = options;
    this.database = new AlertDatabase(this.databasePath(options));
    this.policy = new AlertPolicyResolver(this.database, options);
    this.reconcilingStartup = true;
    this.reconciliationState = { state: "running", startedAt: new Date() };
    this.ingestionQueue = new BoundedIngestionQueue(
      options.ingestion?.queueLimit ?? DEFAULT_INGESTION_QUEUE_LIMIT,
    );
    this.lastQueueWarningAt = 0;

    this.transports = new Map<string, NotificationTransport>();
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
    if (options.audio?.enabled)
      this.audioScheduler = new AudioScheduler(
        this.database,
        this.createAudioPlayer(options),
        {
          queueLimit: options.audio.queueLimit ?? 25,
          failureRetrySeconds: options.audio.failureRetrySeconds ?? 30,
          maxAttempts: options.audio.maxAttempts ?? 3,
          quietHours: options.audio.quietHours,
          onError: (message) =>
            this.app.error(
              `[persistent-notifier] Local audio playback failed: ${message}`,
            ),
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
    this.scheduleNextAudio();

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
    this.debug(
      `Started and subscribed to Signal K notifications; localAudio=${options.audio?.enabled === true}`,
    );
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
      (id) => Boolean(repository.dismissOccurrence(id)),
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
          })),
      listAudioSounds: () => [
        {
          id: "severity",
          name: "Match alert severity",
          type: "automatic",
        },
        ...audioSounds.map((sound) => ({
          id: sound,
          name: sound[0].toUpperCase() + sound.slice(1),
          type: "built-in",
        })),
        ...(this.config.audio?.customSounds ?? []).map((sound) => ({
          id: `custom:${sound.name}`,
          name: sound.name,
          type: "custom",
        })),
      ],
      subscribeChanges: (listener) => this.subscribeChanges(listener),
    });
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
    if (this.startupImmediate) clearImmediate(this.startupImmediate);
    if (this.ingestionImmediate) clearImmediate(this.ingestionImmediate);
    if (this.deliveryImmediate) clearImmediate(this.deliveryImmediate);
    if (this.audioImmediate) clearImmediate(this.audioImmediate);
    this.startupImmediate = undefined;
    this.ingestionImmediate = undefined;
    this.deliveryImmediate = undefined;
    this.audioImmediate = undefined;
    this.deliveryRerunRequested = false;
    this.audioRerunRequested = false;
    if (this.activationTimer) clearTimeout(this.activationTimer);
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    if (this.audioTimer) clearTimeout(this.audioTimer);
    if (this.zoneRefreshTimer) clearInterval(this.zoneRefreshTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    await this.scheduler?.stop();
    await this.audioScheduler?.stop();
    await this.deliveryRun;
    await this.audioRun;
    this.connectivity?.stop();
    this.database?.close();
    this.database = undefined;
    this.changeListeners.clear();
    this.scheduler = undefined;
    this.audioScheduler = undefined;
    this.deliveryRun = undefined;
    this.audioRun = undefined;
    this.connectivity = undefined;
    this.policy = undefined;
    this.transports.clear();
    this.activationTimer = undefined;
    this.deliveryTimer = undefined;
    this.audioTimer = undefined;
    this.zoneRefreshTimer = undefined;
    this.retentionTimer = undefined;
    this.debug("Stopped");
  }
}

function configuredAudioCommand(
  command: Partial<AudioCommand> | undefined,
): AudioCommand | undefined {
  return typeof command?.executable === "string" &&
    command.executable.trim() !== ""
    ? { executable: command.executable, arguments: command.arguments }
    : undefined;
}
