import type { ServerAPI } from "@signalk/server-api";
import { describe, expect, it, vi } from "vitest";
import { mayWritePath } from "../src/signalk/permissions";

describe("Signal K path authorization", () => {
  it("passes the original request, self context and exact path to the server ACL", () => {
    const request = {
      skPrincipal: { identifier: "crew", permissions: "readwrite" },
    };
    const strategy = {
      shouldAllowPut: vi.fn(function (this: unknown) {
        expect(this).toBe(strategy);
        return true;
      }),
    };
    const app = { securityStrategy: strategy } as unknown as ServerAPI;
    expect(mayWritePath(app, request, "notifications.electrical.battery")).toBe(
      true,
    );
    expect(strategy.shouldAllowPut).toHaveBeenCalledWith(
      request,
      "vessels.self",
      null,
      "notifications.electrical.battery",
    );
  });

  it.each([undefined, {}, { shouldAllowPut: () => false }])(
    "denies writes when authorization is absent or denied: %j",
    (strategy) => {
      const app = { securityStrategy: strategy } as unknown as ServerAPI;
      expect(mayWritePath(app, {}, "notifications.bilge")).toBe(false);
    },
  );

  it("honors the dummy strategy when security is explicitly disabled", () => {
    const app = {
      securityStrategy: { shouldAllowPut: () => true },
    } as unknown as ServerAPI;
    expect(mayWritePath(app, {}, "notifications.bilge")).toBe(true);
  });
});
