import path from "node:path";
import { PluginConfig, validateConfig } from "./config";
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

export = function persistentNotifier(app: any) {
  let database: AlertDatabase | undefined;
  let scheduler: DeliveryScheduler | undefined;
  let connectivity: ConnectivityManager | undefined;
  let unsubscribe: (() => void) | undefined;
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
  return {
    id: "signalk-persistent-notifier",
    name: "Persistent notifier",
    description: "Offline-first durable Signal K alert delivery",
    schema: { type: "object", additionalProperties: true },
    start(options: PluginConfig = {}) {
      validateConfig(options);
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
      scheduler = new DeliveryScheduler(database, transports);
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
        );
      for (const request of database.listWakeRequests()) {
        if (connectivity) connectivity.scheduleWakeAt(request.dueAt);
      }
      const handler = async (delta: any) => {
        const pathValue = delta?.updates?.[0]?.values?.[0]?.path ?? delta?.path;
        const value = delta?.updates?.[0]?.values?.[0]?.value ?? delta?.value;
        if (typeof pathValue !== "string") return;
        const normalized = normalizeNotification(pathValue, value);
        const record = lifecycle.ingest(normalized);
        const matched = matchRules(
          record.path,
          record.maxSeverity,
          options.rules ?? [],
        );
        if (record.currentState === "cleared") {
          database?.clearWakeDue(record.id);
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
        void runScheduler();
      };
      if (app.subscriptionmanager?.subscribe) {
        app.subscriptionmanager.subscribe(
          {
            context: "vessels.self",
            subscribe: [{ path: "notifications.*", period: 0 }],
          },
          handler,
        );
        unsubscribe = () => undefined;
      }
      void runScheduler();
      return { status: "started" };
    },
    status,
    registerWithRouter(router: Parameters<typeof registerRoutes>[0]) {
      registerRoutes(router, () => database, status, runScheduler);
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
          "/deliveries": {
            get: { responses: { "200": { description: "Delivery records" } } },
          },
          "/retry": {
            post: { responses: { "200": { description: "Retry scheduled" } } },
          },
        },
      };
    },
    stop() {
      unsubscribe?.();
      scheduler?.stop();
      connectivity?.stop();
      database?.close();
      database = undefined;
    },
  };
};
