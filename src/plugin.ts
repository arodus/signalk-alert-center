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
    start(options: object) {
      runtime.start(options as PluginConfig);
    },
    statusMessage: () => runtime.statusMessage(),
    registerWithRouter: (router) => runtime.registerWithRouter(router),
    getOpenApi: getAlertCenterOpenApi,
    stop: () => runtime.stop(),
  };
};
