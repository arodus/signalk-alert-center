import { Plugin, ServerAPI } from "@signalk/server-api";
import { getAlertCenterOpenApi } from "./api/openapi";
import { migrateLegacyRepeatConfig, PluginConfig } from "./config";
import { pluginConfigSchema, pluginUiSchema } from "./config-schema";
import { AlertCenterRuntime } from "./runtime";

export = function alertCenter(app: ServerAPI): Plugin {
  const runtime = new AlertCenterRuntime(app);

  return {
    id: "signalk-alert-center",
    name: "Signal K Alert Center",
    description: "Offline-first durable Signal K alert delivery",
    schema: pluginConfigSchema,
    uiSchema: pluginUiSchema,
    start(options: object, restart: (newConfiguration: object) => void) {
      const config = options as PluginConfig;
      const migratedConfig = migrateLegacyRepeatConfig(config);
      if (migratedConfig) {
        app.debug(
          "[alert-center] Migrating the legacy repeat default to notification services",
        );
        setImmediate(() => restart(migratedConfig));
        return;
      }
      if (config.maintenance?.resetDatabase) {
        const nextConfiguration: PluginConfig = {
          ...config,
          maintenance: {
            ...config.maintenance,
            resetDatabase: false,
          },
        };
        app.debug("[alert-center] Resetting alert database");
        runtime.resetDatabase(config);
        app.debug("[alert-center] Alert database reset complete");
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
