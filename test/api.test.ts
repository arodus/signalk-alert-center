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
  backpressured = false;
  private closeListeners: Array<() => void> = [];
  private drainListeners: Array<() => void> = [];
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
    return !this.backpressured;
  }
  end() {}
  on(event: "close", listener: () => void) {
    if (event === "close") this.closeListeners.push(listener);
  }
  once(event: "drain", listener: () => void) {
    if (event === "drain") this.drainListeners.push(listener);
  }
  off(event: "drain", listener: () => void) {
    if (event === "drain")
      this.drainListeners = this.drainListeners.filter(
        (candidate) => candidate !== listener,
      );
  }
  drain() {
    const listeners = this.drainListeners.splice(0);
    for (const listener of listeners) listener();
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
    resetPolicy: (id) => (id === "bilge" ? { id, reset: true } : undefined),
    deleteDefinition: (id) =>
      id === "bilge" ? "deleted" : id === "active" ? "active" : "not_found",
    listOccurrences(query) {
      queries.push(query);
      return { items: [] };
    },
    getOccurrence: () => undefined,
    listOccurrenceEvents: () => ({ items: [] }),
    listAlertHistory(query) {
      queries.push(query);
      return {
        items: [
          {
            id: 3,
            alertId: "occurrence-1",
            eventType: "raised",
          },
        ],
        nextCursor: "3",
      };
    },
    listDeliveries(query) {
      queries.push(query);
      return { items: [{ id: "delivery-1" }], nextCursor: "delivery-1" };
    },
    getDelivery: (id) => (id === "delivery-1" ? { id } : undefined),
    listDeliveryAttempts: (id, query) =>
      id === "delivery-1"
        ? { items: [{ id: 1, attemptNumber: 1, query }] }
        : undefined,
    retryDelivery: (id) =>
      id === "delivery-1"
        ? "scheduled"
        : id === "pending"
          ? "not_retryable"
          : "not_found",
    acknowledgeOccurrence: (id) =>
      id === "inactive" ? "inactive" : { status: "acknowledged" },
    silenceOccurrence: (id) =>
      id === "inactive" ? "inactive" : { status: "silenced" },
  };
  registerAlertCenterRoutes(router, {
    repository: () => repository,
    listNotifiers: () => [{ id: "ntfy-main", type: "ntfy" }],
    testNotifier: (id, operation) =>
      id === "ntfy-main"
        ? {
            status: "success",
            category: "success",
            message: "Test accepted",
            durationMs: 12,
            operation,
            service: { id, type: "ntfy" },
          }
        : id === "busy"
          ? "in_progress"
          : "not_found",
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
    emitChange: (revision = 1) =>
      changeListener?.({
        revision,
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
    expect(access.filter((value) => value === "readonly")).toHaveLength(11);
    expect(access.filter((value) => value === "readwrite")).toHaveLength(7);
  });

  it("runs dedicated service tests and validates their operation", async () => {
    const current = fixture();
    const result = await current.invoke("POST", "/notifiers/:id/test", {
      params: { id: "ntfy-main" },
      body: { operation: "send" },
    });
    expect(result.body).toMatchObject({
      status: "success",
      operation: "send",
      service: { id: "ntfy-main" },
    });

    const invalid = await current.invoke("POST", "/notifiers/:id/test", {
      params: { id: "ntfy-main" },
      body: { operation: "trigger" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toMatchObject({
      error: { code: "INVALID_BODY" },
    });

    const busy = await current.invoke("POST", "/notifiers/:id/test", {
      params: { id: "busy" },
      body: { operation: "send" },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.body).toMatchObject({ error: { code: "TEST_IN_PROGRESS" } });
  });

  it("pages delivery summaries, details, attempts, and retries", async () => {
    const current = fixture();
    const list = await current.invoke("GET", "/deliveries", {
      query: { limit: "25", cursor: "previous" },
    });
    expect(list.body).toMatchObject({
      items: [{ id: "delivery-1" }],
      nextCursor: "delivery-1",
    });
    expect(current.queries.at(-1)).toEqual({
      limit: 25,
      cursor: "previous",
    });

    const detail = await current.invoke("GET", "/deliveries/:id", {
      params: { id: "delivery-1" },
    });
    expect(detail.body).toEqual({ id: "delivery-1" });

    const attempts = await current.invoke("GET", "/deliveries/:id/attempts", {
      params: { id: "delivery-1" },
      query: { limit: "10", cursor: "4" },
    });
    expect(attempts.body).toMatchObject({
      items: [{ attemptNumber: 1, query: { limit: 10, cursor: "4" } }],
    });

    const retry = await current.invoke("POST", "/deliveries/:id/retry", {
      params: { id: "delivery-1" },
    });
    expect(retry.body).toEqual({ status: "scheduled" });
    const conflict = await current.invoke("POST", "/deliveries/:id/retry", {
      params: { id: "pending" },
    });
    expect(conflict.statusCode).toBe(409);
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

  it("coalesces stream changes while an SSE client is backpressured", async () => {
    const current = fixture();
    const response = await current.invoke("GET", "/events");
    const initialWrites = response.writes.length;
    response.backpressured = true;

    current.emitChange(1);
    current.emitChange(2);
    current.emitChange(3);
    expect(response.writes).toHaveLength(initialWrites + 1);

    response.backpressured = false;
    response.drain();
    expect(response.writes).toHaveLength(initialWrites + 2);
    expect(response.writes.at(-1)).toContain('"revision":3');
    response.close();
  });

  it("parses bounded occurrence filters", async () => {
    const { invoke, queries } = fixture();
    const response = await invoke("GET", "/occurrences", {
      query: {
        limit: "25",
        cursor: "opaque",
        definitionId: "anchor",
        path: "notifications.navigation.anchor",
        source: "gps.primary",
        state: "active",
        from: "2026-09-01T00:00:00Z",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(queries[0]).toMatchObject({
      limit: 25,
      cursor: "opaque",
      definitionId: "anchor",
      path: "notifications.navigation.anchor",
      source: "gps.primary",
      state: "active",
    });
    expect((queries[0] as { from: Date }).from).toBeInstanceOf(Date);
  });

  it("pages and filters alert updates separately from deliveries", async () => {
    const { invoke, queries } = fixture();
    const response = await invoke("GET", "/alert-history", {
      query: {
        limit: "20",
        cursor: "8",
        definitionId: "anchor",
        source: "gps.primary",
        state: "cleared",
        severity: "alarm",
        eventType: "severity_changed",
        from: "2026-09-01T00:00:00Z",
        to: "2026-09-02T00:00:00Z",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      items: [{ id: 3, alertId: "occurrence-1", eventType: "raised" }],
      nextCursor: "3",
    });
    expect(queries.at(-1)).toMatchObject({
      limit: 20,
      cursor: "8",
      definitionId: "anchor",
      source: "gps.primary",
      state: "cleared",
      severity: "alarm",
      eventType: "severity_changed",
    });
    expect((queries.at(-1) as { from: Date }).from).toBeInstanceOf(Date);
    expect((queries.at(-1) as { to: Date }).to).toBeInstanceOf(Date);
  });

  it("returns structured errors for invalid filters", async () => {
    const response = await fixture().invoke("GET", "/occurrences", {
      query: { limit: "101" },
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
          overrideFields: [
            "notifierIds",
            "notifierIds",
            "soundEnabled",
            "soundId",
            "speechEnabled",
            "speechMinimumSeverity",
            "speechTemplate",
            "speechAnnounceClear",
          ],
          enabled: true,
          oneTime: true,
          notifierIds: ["ntfy-main", "ntfy-main"],
          notifierRepeatOverrides: { "ntfy-main": 3600 },
          activationDelaySeconds: 30,
          minimumSeverity: "alarm",
          soundEnabled: true,
          soundId: "bilge_alarm",
          speechEnabled: false,
          speechMinimumSeverity: "alert",
          speechTemplate: "{name}. {message}",
          speechAnnounceClear: true,
          connectivity: { mode: "wake_after", delaySeconds: 60 },
        },
      },
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      policy: {
        overrideFields: [
          "notifierIds",
          "soundEnabled",
          "soundId",
          "speechEnabled",
          "speechMinimumSeverity",
          "speechTemplate",
          "speechAnnounceClear",
        ],
        notifierIds: ["ntfy-main"],
        notifierRepeatOverrides: { "ntfy-main": 3600 },
        activationDelaySeconds: 30,
        soundEnabled: true,
        soundId: "bilge_alarm",
        speechEnabled: false,
        speechMinimumSeverity: "alert",
        speechTemplate: "{name}. {message}",
        speechAnnounceClear: true,
      },
    });
  });

  it("rejects the removed audio policy field", async () => {
    const response = await fixture().invoke(
      "PATCH",
      "/definitions/:id/policy",
      {
        params: { id: "bilge" },
        body: {
          audio: { enabled: true },
        },
      },
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "INVALID_BODY" },
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

  it("removes stored alerts through a write-protected route", async () => {
    const response = await fixture().invoke("DELETE", "/definitions/:id", {
      params: { id: "bilge" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "deleted" });
  });

  it("rejects removal while an alert is active", async () => {
    const response = await fixture().invoke("DELETE", "/definitions/:id", {
      params: { id: "active" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "ALERT_ACTIVE" } });
  });

  it("resets an alert policy without deleting its definition", async () => {
    const response = await fixture().invoke(
      "DELETE",
      "/definitions/:id/policy",
      { params: { id: "bilge" } },
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ id: "bilge", reset: true });
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
