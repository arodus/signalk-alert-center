import type { ServerAPI } from "@signalk/server-api";
import { describe, expect, it, vi } from "vitest";
import { normalizeNotification } from "../src/alerts/normalize";
import type { Handler } from "../src/api/routes";
import { AlertCenterRuntime } from "../src/runtime";
import { AlertDatabase } from "../src/storage/db";

for (const prefix of ["occurrences", "alerts"]) {
  for (const action of ["acknowledge", "silence"] as const) {
    describe(`legacy /${prefix}/:id/${action}`, () => {
      for (const grants of [
        [],
        ["path"],
        ["collection"],
        ["path", "collection"],
      ]) {
        it(`requires both grants for server-managed notifications: ${grants.join(",") || "none"}`, async () => {
          const path = "notifications.electrical.battery";
          const status = {
            canAcknowledge: true,
            canSilence: true,
            acknowledged: false,
            silenced: false,
          };
          const notifications = {
            getId: () => ({ value: { status } }),
            acknowledge: vi.fn(() => {
              status.acknowledged = true;
            }),
            silence: vi.fn(() => {
              status.silenced = true;
            }),
          };
          const shouldAllowPut = vi.fn(
            (
              _request: object,
              _context: string,
              _source: null,
              checked: string,
            ) => grants.includes(checked === path ? "path" : "collection"),
          );
          const app = {
            notifications,
            securityStrategy: { shouldAllowPut },
            debug: vi.fn(),
            setPluginStatus: vi.fn(),
          } as unknown as ServerAPI;
          const runtime = new AlertCenterRuntime(app);
          const database = new AlertDatabase();
          (runtime as unknown as { database: AlertDatabase }).database =
            database;
          try {
            const occurrence = database.ingest(
              normalizeNotification(path, {
                id: "notification-1",
                state: "alarm",
                message: "Low voltage",
              }),
              ["mock"],
            )!;
            const handlers = new Map<string, Handler>();
            const router = {
              get: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
              post: (route: string, handler: Handler) =>
                handlers.set(route, handler),
              access: () => router,
            };
            runtime.registerWithRouter(
              router as unknown as Parameters<
                typeof runtime.registerWithRouter
              >[0],
            );
            const before = {
              occurrence: database.getAlert(occurrence.id),
              events: database.listAlertEvents(),
              deliveries: database.listDeliveries(),
            };
            const request = {
              params: { id: occurrence.id },
              body: { path: "notifications.allowed" },
              skPrincipal: { identifier: "crew", permissions: "readwrite" },
            };
            let code = 200;
            const result = await new Promise<unknown>((resolve) => {
              const response = {
                status: (value: number) => {
                  code = value;
                  return response;
                },
                json: resolve,
              };
              handlers.get(`/${prefix}/:id/${action}`)!(request, response);
            });
            expect(shouldAllowPut).toHaveBeenCalledWith(
              request,
              "vessels.self",
              null,
              path,
            );
            if (grants.includes("path"))
              expect(shouldAllowPut).toHaveBeenCalledWith(
                request,
                "vessels.self",
                null,
                "notifications",
              );
            if (grants.length === 2) {
              expect(code).toBe(200);
              expect(notifications[action]).toHaveBeenCalledWith(
                "notification-1",
              );
            } else {
              expect(code).toBe(403);
              expect(result).toMatchObject({ error: { code: "FORBIDDEN" } });
              expect(notifications.acknowledge).not.toHaveBeenCalled();
              expect(notifications.silence).not.toHaveBeenCalled();
              expect({
                occurrence: database.getAlert(occurrence.id),
                events: database.listAlertEvents(),
                deliveries: database.listDeliveries(),
              }).toEqual(before);
            }
          } finally {
            database.close();
          }
        });
      }
    });
  }
}
