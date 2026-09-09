import { describe, expect, it } from "vitest";
import {
  AlertCenterRepository,
  registerAlertCenterRoutes,
  RouterLike,
} from "../src/api/routes";

type Handler = (
  request: Record<string, unknown>,
  response: FakeResponse,
) => void;
class FakeResponse {
  statusCode = 200;
  body: unknown;
  headers = new Map<string, string>();
  writes: string[] = [];
  private closeListeners: Array<() => void> = [];
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json(value: unknown) {
    this.body = value;
  }
  setHeader(name: string, value: string) {
    this.headers.set(name, value);
  }
  flushHeaders() {}
  write(value: string) {
    this.writes.push(value);
    return true;
  }
  end() {}
  on(event: "close", listener: () => void) {
    if (event === "close") this.closeListeners.push(listener);
  }
  close() {
    for (const listener of this.closeListeners) listener();
  }
}

function fixture() {
  const handlers = new Map<string, Handler>();
  const access: string[] = [];
  const registrar = (method: string) => (path: unknown, handler: unknown) =>
    handlers.set(`${method} ${path}`, handler as Handler);
  const router: RouterLike = {
    get: registrar("GET"),
    post: registrar("POST"),
    patch: registrar("PATCH"),
    delete: registrar("DELETE"),
    access(level) {
      access.push(level);
      return {
        get: registrar("GET"),
        post: registrar("POST"),
        patch: registrar("PATCH"),
        delete: registrar("DELETE"),
      };
    },
  };
  const queries: unknown[] = [];
  let changeListener:
    | ((change: {
        revision: number;
        reason: string;
        occurredAt: string;
      }) => void)
    | undefined;
  let unsubscribeCount = 0;
  const repository: AlertCenterRepository = {
    listDefinitions(query) {
      queries.push(query);
      return { items: [{ id: "bilge" }] };
    },
    getDefinition: (id) => (id === "bilge" ? { id } : undefined),
    updatePolicy: (id, policy) => (id === "bilge" ? { id, policy } : undefined),
    forgetDefinition: (id) => (id === "bilge" ? "deleted" : "not_found"),
    listOccurrences(query) {
      queries.push(query);
      return { items: [] };
    },
    getOccurrence: () => undefined,
    listOccurrenceEvents: () => ({ items: [] }),
    dismissOccurrence: () => ({ status: "dismissed" }),
    acknowledgeOccurrence: (id) =>
      id === "inactive" ? "inactive" : { status: "acknowledged" },
    silenceOccurrence: (id) =>
      id === "inactive" ? "inactive" : { status: "silenced" },
  };
  registerAlertCenterRoutes(router, {
    repository: () => repository,
    listNotifiers: () => [{ id: "ntfy-main", type: "ntfy" }],
    subscribeChanges: (listener) => {
      changeListener = listener;
      listener({
        revision: 0,
        reason: "connected",
        occurredAt: "2026-09-09T00:00:00.000Z",
      });
      return () => {
        unsubscribeCount += 1;
      };
    },
  });
  const invoke = async (
    method: string,
    path: string,
    request: Record<string, unknown> = {},
  ) => {
    const response = new FakeResponse();
    handlers.get(`${method} ${path}`)?.(request, response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return response;
  };
  return {
    access,
    invoke,
    queries,
    emitChange: () =>
      changeListener?.({
        revision: 1,
        reason: "alerts",
        occurredAt: "2026-09-09T00:01:00.000Z",
      }),
    unsubscribeCount: () => unsubscribeCount,
  };
}

describe("alert-center routes", () => {
  it("registers reads and mutations with least-privilege Signal K access", () => {
    const { access } = fixture();
    expect(access).toContain("readonly");
    expect(access).toContain("readwrite");
    expect(access.filter((value) => value === "readonly")).toHaveLength(7);
    expect(access.filter((value) => value === "readwrite")).toHaveLength(5);
  });

  it("streams change notifications and releases closed clients", async () => {
    const current = fixture();
    const response = await current.invoke("GET", "/events");

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.writes.join("")).toContain('"reason":"connected"');
    current.emitChange();
    expect(response.writes.join("")).toContain('"reason":"alerts"');

    response.close();
    expect(current.unsubscribeCount()).toBe(1);
  });

  it("parses bounded occurrence filters", async () => {
    const { invoke, queries } = fixture();
    const response = await invoke("GET", "/occurrences", {
      query: {
        limit: "25",
        cursor: "opaque",
        state: "active",
        dismissed: "false",
        from: "2026-09-01T00:00:00Z",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(queries[0]).toMatchObject({
      limit: 25,
      cursor: "opaque",
      state: "active",
      dismissed: false,
    });
    expect((queries[0] as { from: Date }).from).toBeInstanceOf(Date);
  });

  it("returns structured errors for invalid filters", async () => {
    const response = await fixture().invoke("GET", "/occurrences", {
      query: { limit: "101", dismissed: "sometimes" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "INVALID_QUERY" },
    });
  });

  it("validates and deduplicates policy fields", async () => {
    const response = await fixture().invoke(
      "PATCH",
      "/definitions/:id/policy",
      {
        params: { id: "bilge" },
        body: {
          enabled: true,
          oneTime: true,
          rearmAfterSeconds: 3600,
          notifierIds: ["ntfy-main", "ntfy-main"],
          activationDelaySeconds: 30,
          minimumSeverity: "alarm",
          connectivity: { mode: "wake_after", delaySeconds: 60 },
        },
      },
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      policy: { notifierIds: ["ntfy-main"], activationDelaySeconds: 30 },
    });
  });

  it("rejects unknown notifier ids without touching storage", async () => {
    const response = await fixture().invoke(
      "PATCH",
      "/definitions/:id/policy",
      {
        params: { id: "bilge" },
        body: { notifierIds: ["missing"] },
      },
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "UNKNOWN_NOTIFIER", details: { ids: ["missing"] } },
    });
  });

  it("forgets discovered definitions through a write-protected route", async () => {
    const response = await fixture().invoke("DELETE", "/definitions/:id", {
      params: { id: "bilge" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "deleted" });
  });

  it("rejects acknowledge and silence for inactive occurrences", async () => {
    for (const action of ["acknowledge", "silence"]) {
      const response = await fixture().invoke(
        "POST",
        `/occurrences/:id/${action}`,
        { params: { id: "inactive" } },
      );
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({
        error: { code: "ALERT_INACTIVE" },
      });
    }
  });
});
