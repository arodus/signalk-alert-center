import path from "node:path";
import { PluginConfig, RuleConfig, validateConfig } from "./config";
import { AlertLifecycle } from "./alerts/lifecycle";
import { normalizeNotification } from "./alerts/normalize";
import { AlertDatabase } from "./storage/db";
import { DeliveryScheduler } from "./delivery/scheduler";
import { DiscordTransport } from "./transports/discord";
import { NtfyTransport } from "./transports/ntfy";
import { PagerDutyTransport } from "./transports/pagerduty";
import { ConnectivityManager } from "./connectivity/manager";
import { createSignalKSwitch } from "./connectivity/signalk-switch";
import { matchRules } from "./alerts/rules";
import { registerRoutes } from "./api/routes";
import { createInternetProbe } from "./connectivity/internet";
import { buildAlertCatalog } from "./alerts/catalog";
import { pluginConfigSchema } from "./config-schema";

export = function persistentNotifier(app: any) {
  let database: AlertDatabase | undefined;
  let scheduler: DeliveryScheduler | undefined;
  let connectivity: ConnectivityManager | undefined;
  let unsubscribe: (() => void) | undefined;
  let configuredRules: RuleConfig[] = [];
  const status = () => ({
    connectivity: connectivity
      ? {
          state: connectivity.state,
          switchOn: connectivity.switchOn,
          ownedByPlugin: connectivity.ownedByPlugin,
          lastError: connectivity.lastError,
        }
      : { state: "OFF", switchOn: undefined, ownedByPlugin: false },
    alerts: {
      total: database?.listAlerts().length ?? 0,
      pendingDelivery: database?.pendingDeliveryCount() ?? 0,
    },
    deliveries: database?.listDeliveries() ?? [],
  });
  const runScheduler = async () => {
    await scheduler?.runOnce();
    if (connectivity && database?.pendingDeliveryCount() === 0) {
      connectivity.beginCooldown();
    }
  };
  const scheduleNextWake = () => {
    const nextWake = database?.listWakeRequests()[0];
    connectivity?.cancelScheduledWake();
    if (nextWake) connectivity?.scheduleWakeAt(nextWake.dueAt);
  };
  return {
    id: "signalk-persistent-notifier",
    name: "Persistent notifier",
    description: "Offline-first durable Signal K alert delivery",
    schema: pluginConfigSchema,
    start(options: PluginConfig = {}) {
      validateConfig(options);
      configuredRules = options.rules ?? [];
      const dataDir = app.getDataDirPath?.() ?? ".";
      database = new AlertDatabase(
        options.storage?.path ??
          path.join(dataDir, "persistent-notifier.sqlite"),
      );
      const transports = new Map<string, any>();
      for (const [id, config] of Object.entries(options.notifiers ?? {})) {
        if (config.enabled === false) continue;
        if (config.type === "ntfy")
          transports.set(
            id,
            new NtfyTransport({
              server: String(config.server),
              topic: String(config.topic),
              token: config.token ? String(config.token) : undefined,
            }),
          );
        if (config.type === "pagerduty")
          transports.set(id, new PagerDutyTransport(String(config.routingKey)));
        if (config.type === "discord")
          transports.set(id, new DiscordTransport(String(config.webhookUrl)));
      }
      const lifecycle = new AlertLifecycle(database, [...transports.keys()]);
      scheduler = new DeliveryScheduler(database, transports, {
        initialSeconds: options.retry?.initialSeconds ?? 10,
        maxSeconds: options.retry?.maxSeconds ?? 1800,
        multiplier: options.retry?.multiplier ?? 2,
        jitter: options.retry?.jitter ?? 0.2,
      });
      const switchConfig = options.connectivity?.switch;
      if (options.connectivity?.enabled && switchConfig)
        connectivity = new ConnectivityManager(
          createSignalKSwitch(
            app,
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
      scheduleNextWake();
      const extractNotificationEntries = (
        delta: any,
      ): Array<{ path: string; value: unknown; source?: string }> => {
        const entries: Array<{
          path: string;
          value: unknown;
          source?: string;
        }> = [];
        const updates = Array.isArray(delta?.updates) ? delta.updates : [];
        for (const update of updates) {
          const source =
            typeof update?.$source === "string" ? update.$source : undefined;
          const values = Array.isArray(update?.values) ? update.values : [];
          for (const entry of values) {
            if (typeof entry?.path === "string") {
              entries.push({ path: entry.path, value: entry.value, source });
            }
          }
        }
        // Fallback for a bare {path, value} delta shape with no updates array.
        if (entries.length === 0 && typeof delta?.path === "string") {
          entries.push({ path: delta.path, value: delta.value });
        }
        return entries;
      };
      const handler = async (delta: any) => {
        for (const { path, value, source } of extractNotificationEntries(
          delta,
        )) {
          const normalized = normalizeNotification(path, value, source);
          const matched = matchRules(
            normalized.path,
            normalized.severity,
            options.rules ?? [],
          );
          const record = lifecycle.ingest(normalized, matched.notifiers);
          if (record.currentState === "cleared") {
            database?.clearWakeDue(record.id);
            scheduleNextWake();
          } else if (matched.connectivity.mode === "wake") {
            database?.setWakeDue(record.id, new Date());
            if (connectivity) await connectivity.requestWake();
          } else if (matched.connectivity.mode === "wake_after") {
            const dueAt = new Date(
              Date.now() + matched.connectivity.delaySeconds * 1000,
            );
            database?.setWakeDue(record.id, dueAt);
            connectivity?.scheduleWakeAt(dueAt);
          }
        }
        void runScheduler();
      };
      if (app.subscriptionmanager?.subscribe) {
        const unsubscribes: Array<() => void> = [];
        app.subscriptionmanager.subscribe(
          {
            context: "vessels.self",
            subscribe: [{ path: "notifications.*", period: 0 }],
          },
          unsubscribes,
          (err: unknown) => app.error?.(`Subscribe failed: ${err}`),
          handler,
        );
        unsubscribe = () => unsubscribes.forEach((f) => f());
      }
      void runScheduler();
      return { status: "started" };
    },
    status,
    registerWithRouter(router: Parameters<typeof registerRoutes>[0]) {
      registerRoutes(
        router,
        () => database,
        status,
        runScheduler,
        () => buildAlertCatalog(database?.listAlerts() ?? [], configuredRules),
        (id) => {
          const entry = buildAlertCatalog(
            database?.listAlerts() ?? [],
            configuredRules,
          ).find((item) => item.alertId === id);
          if (!entry?.oneTime || !database) return false;
          database.removeAlert(id);
          return true;
        },
        (id) => {
          const record = database
            ?.listAlerts()
            .find((alert) => alert.id === id);
          if (!record || !database) return false;
          database.acknowledgeAlert(id);
          if (record.notificationId) {
            try {
              app.notifications?.acknowledge?.(record.notificationId);
            } catch (error) {
              app.debug?.(
                `Could not acknowledge upstream notification: ${error}`,
              );
            }
          }
          return true;
        },
        (id) => {
          const record = database
            ?.listAlerts()
            .find((alert) => alert.id === id);
          if (!record || !database) return false;
          database.silenceAlert(id);
          if (record.notificationId) {
            try {
              app.notifications?.silence?.(record.notificationId);
            } catch (error) {
              app.debug?.(`Could not silence upstream notification: ${error}`);
            }
          }
          return true;
        },
      );
    },
    getOpenApi() {
      return {
        openapi: "3.0.0",
        info: { title: "Persistent notifier", version: "0.1.0" },
        paths: {
          "/status": {
            get: { responses: { "200": { description: "Plugin status" } } },
          },
          "/alerts": {
            get: { responses: { "200": { description: "Stored alerts" } } },
          },
          "/alerts/{id}/remove": {
            post: {
              responses: { "200": { description: "One-time alert removed" } },
            },
          },
          "/alerts/{id}/acknowledge": {
            post: {
              responses: { "200": { description: "Alert acknowledged" } },
            },
          },
          "/alerts/{id}/silence": {
            post: {
              responses: { "200": { description: "Alert silenced" } },
            },
          },
          "/deliveries": {
            get: { responses: { "200": { description: "Delivery records" } } },
          },
          "/retry": {
            post: { responses: { "200": { description: "Retry scheduled" } } },
          },
        },
      };
    },
    async stop() {
      unsubscribe?.();
      await scheduler?.stop();
      connectivity?.stop();
      database?.close();
      database = undefined;
    },
  };
};
