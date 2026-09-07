import { Plugin, ServerAPI } from "@signalk/server-api";
import { getAlertCenterOpenApi } from "./api/openapi";
import { PluginConfig } from "./config";
import { pluginConfigSchema } from "./config-schema";
import { PersistentNotifierRuntime } from "./runtime";

export = function persistentNotifier(app: ServerAPI): Plugin {
  const runtime = new PersistentNotifierRuntime(app);

  return {
    id: "signalk-persistent-notifier",
    name: "Persistent notifier",
    description: "Offline-first durable Signal K alert delivery",
    schema: pluginConfigSchema,
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
        runtime.resetDatabase(config);
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
