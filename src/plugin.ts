import { Plugin, ServerAPI } from "@signalk/server-api";
import { getAlertCenterOpenApi } from "./api/openapi";
import { PluginConfig } from "./config";
import { pluginConfigSchema, pluginUiSchema } from "./config-schema";
import { PersistentNotifierRuntime } from "./runtime";

export = function persistentNotifier(app: ServerAPI): Plugin {
  const runtime = new PersistentNotifierRuntime(app);

  return {
    id: "signalk-persistent-notifier",
    name: "Persistent notifier",
    description: "Offline-first durable Signal K alert delivery",
    schema: pluginConfigSchema,
    uiSchema: pluginUiSchema,
    start(options: object, restart: (newConfiguration: object) => void) {
      const config = options as PluginConfig;
      if (config.maintenance?.resetDatabase) {
        const nextConfiguration: PluginConfig = {
          ...config,
          maintenance: {
            ...config.maintenance,
            resetDatabase: false,
          },
        };
        app.debug("[persistent-notifier] Resetting alert database");
        runtime.resetDatabase(config);
        app.debug("[persistent-notifier] Alert database reset complete");
        setImmediate(() => restart(nextConfiguration));
        return;
      }
      runtime.start(config);
    },
    statusMessage: () => runtime.statusMessage(),
    registerWithRouter: (router) => runtime.registerWithRouter(router),
    getOpenApi: getAlertCenterOpenApi,
    stop: () => runtime.stop(),
  };
};
