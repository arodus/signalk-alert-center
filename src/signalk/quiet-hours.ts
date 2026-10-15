import { Path, ServerAPI } from "@signalk/server-api";
import { QuietHoursControl } from "../suppression/store";

export const quietHoursPrefix = "digital.alertCenter.quietHours";

export function publishQuietHoursControl(
  app: ServerAPI,
  state: QuietHoursControl,
): void {
  app.handleMessage("signalk-alert-center", {
    updates: [
      {
        values: [
          {
            path: `${quietHoursPrefix}.enabled` as Path,
            value: state.enabled,
          },
        ],
      },
    ],
  });
}

export function registerQuietHoursPut(
  app: ServerAPI,
  get: () => QuietHoursControl,
  set: (enabled: boolean, source: string) => void,
): void {
  app.registerPutHandler(
    "vessels.self",
    `${quietHoursPrefix}.enabled`,
    (_context, _path, value) => {
      if (typeof value !== "boolean")
        return {
          state: "COMPLETED",
          statusCode: 400,
          message: "enabled must be boolean",
        };
      if (get().enabled !== value) set(value, "signalk-put");
      return { state: "COMPLETED", statusCode: 200 };
    },
  );
}
