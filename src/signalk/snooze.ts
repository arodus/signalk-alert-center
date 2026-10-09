import { Path, ServerAPI } from "@signalk/server-api";
import { SnoozeState, snoozeSeconds } from "../suppression/store";

export const snoozePrefix = "digital.alertCenter.snooze";
export function publishSnooze(app: ServerAPI, state: SnoozeState): void {
  app.handleMessage("signalk-alert-center", {
    updates: [
      {
        values: [
          { path: `${snoozePrefix}.active` as Path, value: state.active },
          {
            path: `${snoozePrefix}.duration` as Path,
            value: state.active
              ? Math.max(
                  0,
                  Math.ceil((Date.parse(state.endsAt!) - Date.now()) / 1000),
                )
              : 0,
          },
          { path: `${snoozePrefix}.startedAt` as Path, value: state.startedAt },
          { path: `${snoozePrefix}.endsAt` as Path, value: state.endsAt },
        ],
      },
    ],
  });
}
export function registerSnoozePuts(
  app: ServerAPI,
  get: () => SnoozeState,
  set: (seconds: number, source: string) => void,
): void {
  for (const control of ["active", "duration"] as const)
    app.registerPutHandler(
      "vessels.self",
      `${snoozePrefix}.${control}`,
      (_context, _path, value) => {
        try {
          if (control === "active") {
            if (typeof value !== "boolean")
              throw new Error("active must be boolean");
            if (value && get().active)
              return { state: "COMPLETED", statusCode: 200 };
            set(value ? 3600 : 0, "signalk-put");
          } else set(snoozeSeconds(value), "signalk-put");
          return { state: "COMPLETED", statusCode: 200 };
        } catch (error) {
          return {
            state: "COMPLETED",
            statusCode: 400,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
}
