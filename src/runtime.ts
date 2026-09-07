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
  private config: PluginConfig = {};
  private transports = new Map<string, NotificationTransport>();

  constructor(private readonly app: ServerAPI) {}

  private db(): AlertDatabase {
    if (!this.database) throw new Error("Plugin is not started");
    return this.database;
  }

  private policies(): AlertPolicyResolver {
    if (!this.policy) throw new Error("Plugin is not started");
    return this.policy;
  }

  status() {
    return {
      connectivity: this.connectivity
        ? {
            state: this.connectivity.state,
            switchOn: this.connectivity.switchOn,
            ownedByPlugin: this.connectivity.ownedByPlugin,
            lastError: this.connectivity.lastError,
          }
        : { state: "OFF", switchOn: undefined, ownedByPlugin: false },
      alerts: {
        definitions: this.database?.listDefinitions().length ?? 0,
        total: this.database?.listAlerts().length ?? 0,
        active:
          this.database
            ?.listAlerts()
            .filter(
              (alert) => alert.currentState === "active" && !alert.dismissedAt,
            ).length ?? 0,
        pendingActivation: this.database?.listActivationDeadlines().length ?? 0,
        pendingDelivery: this.database?.pendingDeliveryCount() ?? 0,
      },
      schemaVersion: this.database?.schemaVersion(),
      deliveries: this.database?.listDeliveries() ?? [],
    };
  }

  statusMessage(): string {
    const current = this.status();
    return `${current.alerts.active} active, ${current.alerts.pendingDelivery} deliveries pending`;
  }

  private async runScheduler(): Promise<void> {
    await this.scheduler?.runOnce();
    if (this.connectivity && this.database?.pendingDeliveryCount() === 0)
      this.connectivity.beginCooldown();
    this.scheduleNextDelivery();
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
      void this.runScheduler();
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
      void this.runScheduler();
    }, delay);
  }

  private seedDefinitions(): void {
    this.policies().seedDefinitions(listConfiguredZones(this.app));
  }

  private async applyConnectivityPolicy(
    occurrence: AlertRecord,
    now: Date,
  ): Promise<void> {
    if (occurrence.currentState === "cleared") {
      this.db().clearWakeDue(occurrence.id);
      this.scheduleNextWake();
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
    this.scheduleNextWake();
    if (wakeAt <= now && this.connectivity)
      await this.connectivity.requestWake();
  }

  private async ingestEntry(
    entry: SignalKNotificationInput,
    receivedAt = new Date(),
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
    const notifierIds = policy.notifierIds.filter(
      (id) => this.config.notifiers?.[id]?.enabled !== false,
    );
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
            this.config.notifiers?.[id]?.minSeverity ?? "normal",
          ]),
        ),
      },
    );
    if (!occurrence) return undefined;
    await this.applyConnectivityPolicy(occurrence, receivedAt);
    this.scheduleNextActivation();
    await this.runScheduler();
    return occurrence;
  }

  private definitionView(definition: AlertDefinitionRecord): DefinitionView {
    const metadata =
      definition.metadata && typeof definition.metadata === "object"
        ? (definition.metadata as Record<string, unknown>)
        : {};
    const policy = this.policies().forDefinition(definition);
    const occurrences = this.db()
      .listAlerts()
      .filter((occurrence) => occurrence.definitionId === definition.id);
    const lastFiredAt = occurrences.reduce<Date | undefined>(
      (latest, occurrence) =>
        !latest || occurrence.firstSeenAt > latest
          ? occurrence.firstSeenAt
          : latest,
      undefined,
    );
    const lastActivityAt = occurrences.reduce<Date | undefined>(
      (latest, occurrence) => {
        const candidate = [
          occurrence.lastSeenAt,
          occurrence.clearedAt,
          occurrence.acknowledgedAt,
          occurrence.silencedAt,
          occurrence.dismissedAt,
        ].reduce<Date | undefined>(
          (occurrenceLatest, timestamp) =>
            timestamp && (!occurrenceLatest || timestamp > occurrenceLatest)
              ? timestamp
              : occurrenceLatest,
          undefined,
        );
        return candidate && (!latest || candidate > latest)
          ? candidate
          : latest;
      },
      undefined,
    );
    return {
      ...definition,
      description:
        typeof metadata.description === "string"
          ? metadata.description
          : undefined,
      zone: typeof metadata.zone === "string" ? metadata.zone : undefined,
      oneTime: policy.oneTime,
      fireCount: occurrences.length,
      lastFiredAt,
      lastActivityAt,
      policy,
    };
  }

  private occurrenceView(occurrence: AlertRecord) {
    return {
      ...occurrence,
      state: occurrence.currentState,
      startedAt: occurrence.firstSeenAt,
      oneTime: occurrence.oneTime,
      deliveries: this.db()
        .listDeliveries()
        .filter((delivery) => delivery.alertId === occurrence.id)
        .map((delivery) => ({
          ...delivery,
          attempts: this.db().listDeliveryAttempts(delivery.id),
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

  private upstreamAction(
    occurrence: AlertRecord,
    action: "acknowledge" | "silence",
  ): Pick<ActionResult, "upstream" | "message"> {
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
      this.app.notifications[action](notificationId);
      return { upstream: "applied" };
    } catch (error) {
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
        return this.getDefinition(id);
      },
      forgetDefinition: (id: string) =>
        this.db().forgetDiscoveredDefinition(id),
      listOccurrences: (query: OccurrenceQuery) => {
        let items = this.db()
          .listAlerts()
          .sort(
            (left, right) =>
              right.firstSeenAt.getTime() - left.firstSeenAt.getTime() ||
              right.id.localeCompare(left.id),
          );
        if (query.definitionId)
          items = items.filter(
            (item) => item.definitionId === query.definitionId,
          );
        if (query.state)
          items = items.filter((item) => item.currentState === query.state);
        if (query.severity)
          items = items.filter(
            (item) => item.currentSeverity === query.severity,
          );
        if (query.dismissed !== undefined)
          items = items.filter(
            (item) => Boolean(item.dismissedAt) === query.dismissed,
          );
        if (query.from)
          items = items.filter((item) => item.firstSeenAt >= query.from!);
        if (query.to)
          items = items.filter((item) => item.firstSeenAt <= query.to!);
        return this.page(
          items.map((item) => this.occurrenceView(item)),
          query.limit,
          query.cursor,
        );
      },
      getOccurrence: (id) => {
        const occurrence = this.getOccurrence(id);
        return occurrence ? this.occurrenceView(occurrence) : undefined;
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
        return { status: "dismissed", upstream: "not_requested" };
      },
      acknowledgeOccurrence: (id) => {
        const occurrence = this.getOccurrence(id);
        if (!occurrence) return false;
        if (occurrence.currentState !== "active") return "inactive";
        const upstream = this.upstreamAction(occurrence, "acknowledge");
        this.db().acknowledgeAlert(id);
        this.db().recordOccurrenceEvent(
          id,
          `upstream_acknowledge_${upstream.upstream}`,
          {
            message: upstream.message,
          },
        );
        return { status: "acknowledged", ...upstream };
      },
      silenceOccurrence: (id) => {
        const occurrence = this.getOccurrence(id);
        if (!occurrence) return false;
        if (occurrence.currentState !== "active") return "inactive";
        const upstream = this.upstreamAction(occurrence, "silence");
        this.db().silenceAlert(id);
        this.db().recordOccurrenceEvent(
          id,
          `upstream_silence_${upstream.upstream}`,
          {
            message: upstream.message,
          },
        );
        return { status: "silenced", ...upstream };
      },
    };
  }

  start(options: PluginConfig): void {
    validateConfig(options);
    this.config = options;
    this.database = new AlertDatabase(
      options.storage?.path ??
        path.join(this.app.getDataDirPath(), "persistent-notifier.sqlite"),
    );
    this.policy = new AlertPolicyResolver(this.database, options);

    this.transports = new Map<string, NotificationTransport>();
    for (const [id, notifier] of Object.entries(options.notifiers ?? {})) {
      if (notifier.enabled === false) continue;
      if (notifier.type === "ntfy")
        this.transports.set(
          id,
          new NtfyTransport({
            server: String(notifier.server),
            topic: String(notifier.topic),
            token: notifier.token ? String(notifier.token) : undefined,
          }),
        );
      if (notifier.type === "pagerduty")
        this.transports.set(
          id,
          new PagerDutyTransport(String(notifier.routingKey)),
        );
      if (notifier.type === "discord")
        this.transports.set(
          id,
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
      );

    this.seedDefinitions();
    this.scheduleNextWake();
    this.database.processDueActivations();
    this.scheduleNextActivation();

    const handler = (delta: unknown): void => {
      void (async () => {
        for (const entry of extractNotificationEntries(delta))
          await this.ingestEntry(entry);
      })().catch((error: unknown) =>
        this.app.error(
          `Could not ingest Signal K notification: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
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
        this.app.error(`Notification subscription failed: ${error}`),
      handler,
    );
    this.unsubscribe = () => unsubscribes.forEach((stop) => stop());

    // Subscribe first, then reconcile the full model. Duplicate observations
    // pass through the same idempotent occurrence ingest path.
    void (async () => {
      for (const entry of snapshotNotificationEntries(
        this.app.getPath(`${this.app.selfContext}.notifications`),
      ))
        await this.ingestEntry(entry);
    })().catch((error: unknown) =>
      this.app.error(
        `Could not reconcile current notifications: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    this.zoneRefreshTimer = setInterval(
      () => this.seedDefinitions(),
      (options.discovery?.zoneRefreshSeconds ?? 300) * 1000,
    );
    void this.runScheduler();
    this.app.setPluginStatus("Alert center active");
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
        Object.entries(this.config.notifiers ?? {})
          .filter(([, notifier]) => notifier.enabled !== false)
          .map(([id, notifier]) => ({
            id,
            type: notifier.type,
            enabled: true,
            minimumSeverity: notifier.minSeverity ?? "normal",
          })),
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    if (this.activationTimer) clearTimeout(this.activationTimer);
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    if (this.zoneRefreshTimer) clearInterval(this.zoneRefreshTimer);
    await this.scheduler?.stop();
    this.connectivity?.stop();
    this.database?.close();
    this.database = undefined;
    this.scheduler = undefined;
    this.connectivity = undefined;
    this.policy = undefined;
    this.transports.clear();
  }
}
