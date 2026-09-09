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
import { AlertDefinitionRecord, AlertRecord } from "./alerts/types";
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
import { PluginConfig, validateConfig } from "./config";
import { ConnectivityManager } from "./connectivity/manager";
import { createInternetProbe } from "./connectivity/internet";
import { createSignalKSwitch } from "./connectivity/signalk-switch";
import { DeliveryScheduler } from "./delivery/scheduler";
import {
  extractNotificationEntries,
  SignalKNotificationInput,
  snapshotNotificationEntries,
} from "./signalk/notifications";
import { AlertDatabase } from "./storage/db";
import { DiscordTransport } from "./transports/discord";
import { NtfyTransport } from "./transports/ntfy";
import { PagerDutyTransport } from "./transports/pagerduty";
import { NotificationTransport } from "./transports/transport";

const MAX_TIMER_DELAY = 2_147_000_000;
const UPSTREAM_ACTION_TIMEOUT_MS = 5_000;

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
  private connectivity?: ConnectivityManager;
  private policy?: AlertPolicyResolver;
  private unsubscribe?: () => void;
  private activationTimer?: ReturnType<typeof setTimeout>;
  private deliveryTimer?: ReturnType<typeof setTimeout>;
  private zoneRefreshTimer?: ReturnType<typeof setInterval>;
  private reconcilingStartup = false;
  private startupEntries: SignalKNotificationInput[] = [];
  private config: PluginConfig = {};
  private transports = new Map<string, NotificationTransport>();
  private changeRevision = 0;
  private changeListeners = new Set<(change: AlertCenterChange) => void>();

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

  status() {
    const alertStats = this.database?.alertStats();
    return {
      connectivity: this.connectivity
        ? {
            state: this.connectivity.state,
            switchOn: this.connectivity.switchOn,
            ownedByPlugin: this.connectivity.ownedByPlugin,
            lastError: this.connectivity.lastError,
            shutdownDeferredReason:
              this.connectivity.lastShutdownDeferredReason,
          }
        : { state: "OFF", switchOn: undefined, ownedByPlugin: false },
      alerts: {
        definitions: this.database?.definitionCount() ?? 0,
        total: alertStats?.total ?? 0,
        active: alertStats?.active ?? 0,
        pendingActivation: alertStats?.pendingActivation ?? 0,
        pendingDelivery: this.database?.pendingDeliveryCount() ?? 0,
      },
      schemaVersion: this.database?.schemaVersion(),
    };
  }

  statusMessage(): string {
    const current = this.status();
    return `${current.alerts.active} active, ${current.alerts.pendingDelivery} deliveries pending`;
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
  }

  private emitChange(reason: string): void {
    const change = {
      revision: ++this.changeRevision,
      reason,
      occurredAt: new Date().toISOString(),
    };
    for (const listener of this.changeListeners) listener(change);
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
    this.emitChange("alerts");
  }

  private scheduleNextDelivery(): void {
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    this.deliveryTimer = undefined;
    const dueAt = this.database?.nextDeliveryDueAt();
    if (!dueAt) return;
    const delay = Math.min(
      MAX_TIMER_DELAY,
      Math.max(0, dueAt.getTime() - Date.now()),
    );
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = undefined;
      void this.runScheduler().catch((error: unknown) =>
        this.reportAsyncError("Delivery scheduler failed", error),
      );
    }, delay);
  }

  private scheduleNextWake(): void {
    const nextWake = this.database?.listWakeRequests()[0];
    this.connectivity?.cancelScheduledWake();
    if (nextWake) this.connectivity?.scheduleWakeAt(nextWake.dueAt);
  }

  private scheduleNextActivation(): void {
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.activationTimer = undefined;
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
      void this.runScheduler().catch((error: unknown) =>
        this.reportAsyncError("Activation delivery failed", error),
      );
    }, delay);
  }

  private seedDefinitions(): void {
    this.policies().seedDefinitions(listConfiguredZones(this.app));
  }

  private async applyConnectivityPolicy(
    occurrence: AlertRecord,
    now: Date,
    schedule = true,
  ): Promise<void> {
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
    if (schedule && wakeAt <= now && this.connectivity)
      await this.connectivity.requestWake();
  }

  private async ingestEntry(
    entry: SignalKNotificationInput,
    receivedAt = new Date(),
    schedule = true,
  ): Promise<AlertRecord | undefined> {
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
    await this.applyConnectivityPolicy(occurrence, receivedAt, schedule);
    if (schedule) {
      this.scheduleNextActivation();
      await this.runScheduler();
    }
    return occurrence;
  }

  private async reconcileStartup(): Promise<void> {
    if (!this.database) return;
    const startedAt = Date.now();
    this.seedDefinitions();
    const entries = snapshotNotificationEntries(
      this.app.getPath(`${this.app.selfContext}.notifications`),
    );
    for (let index = 0; index < entries.length; index += 1) {
      if (!this.database) return;
      await this.ingestEntry(entries[index], new Date(), false);
      if ((index + 1) % 50 === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    let queuedCount = 0;
    while (this.startupEntries.length > 0) {
      const queued = this.startupEntries.splice(0, 50);
      queuedCount += queued.length;
      for (const entry of queued) {
        if (!this.database) return;
        await this.ingestEntry(entry, new Date(), false);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.reconcilingStartup = false;
    this.scheduleNextWake();
    this.scheduleNextActivation();
    await this.runScheduler();
    this.debug(
      `Startup reconciliation complete: snapshotEntries=${entries.length}, queuedEntries=${queuedCount}, durationMs=${Date.now() - startedAt}`,
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
      dismissOccurrence: (id) => {
        const occurrence = this.getOccurrence(id);
        if (!occurrence) return false;
        this.db().dismissOccurrence(id);
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
    this.debug(
      `Starting: configuredServices=${options.notifiers?.length ?? 0}, connectivity=${options.connectivity?.enabled ? "enabled" : "disabled"}`,
    );
    this.config = options;
    this.database = new AlertDatabase(this.databasePath(options));
    this.policy = new AlertPolicyResolver(this.database, options);
    this.reconcilingStartup = true;
    this.startupEntries = [];

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
    this.scheduler = new DeliveryScheduler(this.database, this.transports, {
      initialSeconds: options.retry?.initialSeconds ?? 10,
      maxSeconds: options.retry?.maxSeconds ?? 1800,
      multiplier: options.retry?.multiplier ?? 2,
      jitter: options.retry?.jitter ?? 0.2,
    });

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
      const entries = extractNotificationEntries(delta);
      if (this.reconcilingStartup) {
        this.startupEntries.push(...entries);
        return;
      }
      void (async () => {
        for (const entry of entries) await this.ingestEntry(entry);
      })().catch((error: unknown) =>
        this.reportAsyncError("Could not ingest Signal K notification", error),
      );
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
    setImmediate(() => {
      void this.reconcileStartup().catch((error: unknown) => {
        const queued = this.startupEntries.splice(0);
        this.reconcilingStartup = false;
        this.reportAsyncError(
          "Could not reconcile current notifications",
          error,
        );
        // The subscription is already live. Preserve deltas that arrived while
        // the failed snapshot reconciliation was running instead of leaving
        // them stranded in the startup queue.
        void (async () => {
          for (const entry of queued) await this.ingestEntry(entry);
        })().catch((queuedError: unknown) =>
          this.reportAsyncError(
            "Could not ingest queued Signal K notifications",
            queuedError,
          ),
        );
      });
    });
    this.zoneRefreshTimer = setInterval(
      () => {
        this.seedDefinitions();
        this.emitChange("definitions");
      },
      (options.discovery?.zoneRefreshSeconds ?? 300) * 1000,
    );
    this.app.setPluginStatus("Alert center active");
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
      subscribeChanges: (listener) => this.subscribeChanges(listener),
    });
  }

  async stop(): Promise<void> {
    this.debug("Stopping");
    this.reconcilingStartup = false;
    this.startupEntries = [];
    this.unsubscribe?.();
    if (this.activationTimer) clearTimeout(this.activationTimer);
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    if (this.zoneRefreshTimer) clearInterval(this.zoneRefreshTimer);
    await this.scheduler?.stop();
    this.connectivity?.stop();
    this.database?.close();
    this.database = undefined;
    this.changeListeners.clear();
    this.scheduler = undefined;
    this.connectivity = undefined;
    this.policy = undefined;
    this.transports.clear();
    this.debug("Stopped");
  }
}
