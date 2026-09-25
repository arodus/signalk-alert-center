import { AlertPolicyField, alertPolicyFields } from "../alerts/types";
import { AlertDatabase } from "../storage/db";
import {
  NotificationTestOperation,
  NotificationTestResult,
} from "../transports/test-service";

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}
export interface DefinitionQuery {
  limit: number;
  cursor?: string;
  zone?: string;
  sourceType?: "zone" | "recognized";
  enabled?: boolean;
}
export interface OccurrenceQuery {
  limit: number;
  cursor?: string;
  definitionId?: string;
  path?: string;
  source?: string;
  state?: "active" | "cleared";
  severity?: "normal" | "warn" | "alert" | "alarm" | "emergency";
  from?: Date;
  to?: Date;
}
export interface EventQuery {
  limit: number;
  cursor?: string;
  eventType?: string;
}
export interface AlertHistoryQuery extends EventQuery {
  definitionId?: string;
  path?: string;
  source?: string;
  state?: "active" | "cleared";
  severity?: "normal" | "warn" | "alert" | "alarm" | "emergency";
  from?: Date;
  to?: Date;
}
export interface DeliveryQuery {
  limit: number;
  cursor?: string;
}
export interface AlertPolicyPatch {
  overrideFields?: AlertPolicyField[];
  enabled?: boolean;
  oneTime?: boolean;
  notifierIds?: string[];
  notifierRepeatOverrides?: Record<string, number>;
  activationDelaySeconds?: number;
  minimumSeverity?: "normal" | "warn" | "alert" | "alarm" | "emergency";
  speechMinimumSeverity?: "normal" | "warn" | "alert" | "alarm" | "emergency";
  speechTemplate?: string;
  speechAnnounceClear?: boolean;
  connectivity?:
    { mode: "queue" | "wake" } | { mode: "wake_after"; delaySeconds: number };
}
export interface ActionResult {
  status: "acknowledged" | "silenced";
  upstream?:
    "applied" | "unsupported" | "failed" | "timed_out" | "not_requested";
  message?: string;
}
type MaybePromise<T> = T | Promise<T>;

/** Storage-agnostic callback surface for the alert-center API. */
export interface AlertCenterRepository {
  listDefinitions(query: DefinitionQuery): MaybePromise<Page<unknown>>;
  getDefinition(id: string): MaybePromise<unknown | undefined>;
  updatePolicy(
    id: string,
    patch: AlertPolicyPatch,
  ): MaybePromise<unknown | undefined>;
  resetPolicy(id: string): MaybePromise<unknown | undefined>;
  deleteDefinition(
    id: string,
  ): MaybePromise<"deleted" | "active" | "not_found">;
  listOccurrences(query: OccurrenceQuery): MaybePromise<Page<unknown>>;
  getOccurrence(id: string): MaybePromise<unknown | undefined>;
  listOccurrenceEvents(
    id: string,
    query: EventQuery,
  ): MaybePromise<Page<unknown> | undefined>;
  listAlertHistory(query: AlertHistoryQuery): MaybePromise<Page<unknown>>;
  listDeliveries(query: DeliveryQuery): MaybePromise<Page<unknown>>;
  getDelivery(id: string): MaybePromise<unknown | undefined>;
  listDeliveryAttempts(
    id: string,
    query: DeliveryQuery,
  ): MaybePromise<Page<unknown> | undefined>;
  retryDelivery(
    id: string,
  ): MaybePromise<"scheduled" | "not_retryable" | "not_found">;
  acknowledgeOccurrence(
    id: string,
  ): MaybePromise<ActionResult | "inactive" | false | undefined>;
  silenceOccurrence(
    id: string,
  ): MaybePromise<ActionResult | "inactive" | false | undefined>;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  json(value: unknown): void;
  setHeader?(name: string, value: string): void;
  flushHeaders?(): void;
  write?(value: string): boolean;
  end?(): void;
  on?(event: "close", listener: () => void): void;
  once?(event: "drain", listener: () => void): void;
  off?(event: "drain", listener: () => void): void;
}
type Handler = (request: RequestLike, response: ResponseLike) => void;
export interface RouterLike {
  get: (...args: unknown[]) => void;
  post: (...args: unknown[]) => void;
  patch?: (...args: unknown[]) => void;
  delete?: (...args: unknown[]) => void;
  access?: (
    level: "readonly" | "readwrite",
  ) => Pick<RouterLike, "get" | "post" | "patch" | "delete">;
}
interface RequestLike {
  params?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
  on?(event: "close", listener: () => void): void;
}
export interface AlertCenterChange {
  revision: number;
  reason: string;
  occurredAt: string;
}
export interface AlertCenterDependencies {
  repository: () => AlertCenterRepository | undefined;
  listNotifiers?: () => MaybePromise<unknown[]>;
  testNotifier?: (
    id: string,
    operation: NotificationTestOperation,
  ) => MaybePromise<
    | NotificationTestResult
    | "not_found"
    | "disabled"
    | "in_progress"
    | "unsupported"
  >;
  subscribeChanges?: (
    listener: (change: AlertCenterChange) => void,
  ) => () => void;
}

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
const fail = (
  response: ResponseLike,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) =>
  response.status(status).json({
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
const wrap =
  (
    handler: (
      request: RequestLike,
      response: ResponseLike,
    ) => MaybePromise<void>,
  ): Handler =>
  (request, response) =>
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      if (error instanceof ApiError)
        return fail(
          response,
          error.statusCode,
          error.code,
          error.message,
          error.details,
        );
      fail(
        response,
        500,
        "INTERNAL_ERROR",
        "The request could not be completed",
      );
    });

function addRoute(
  router: RouterLike,
  method: "get" | "post" | "patch" | "delete",
  path: string,
  access: "readonly" | "readwrite",
  handler: Handler,
): void {
  const target = router.access?.(access) ?? router;
  const registrar = target[method];
  if (!registrar)
    throw new Error(`Router does not support ${method.toUpperCase()}`);
  registrar.call(target, path, handler);
}
const textParam = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value) || typeof value !== "string")
    throw new ApiError(400, "INVALID_QUERY", `${name} must be a string`);
  return value;
};
const enumParam = <T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined => {
  const parsed = textParam(value, name);
  if (parsed === undefined) return undefined;
  if (!allowed.includes(parsed as T))
    throw new ApiError(400, "INVALID_QUERY", `${name} is invalid`, {
      field: name,
      allowed,
    });
  return parsed as T;
};
const boolParam = (value: unknown, name: string): boolean | undefined => {
  const parsed = textParam(value, name);
  if (parsed === undefined) return undefined;
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  throw new ApiError(400, "INVALID_QUERY", `${name} must be true or false`);
};
const dateParam = (value: unknown, name: string): Date | undefined => {
  const parsed = textParam(value, name);
  if (!parsed) return undefined;
  const result = new Date(parsed);
  if (Number.isNaN(result.getTime()))
    throw new ApiError(
      400,
      "INVALID_QUERY",
      `${name} must be an ISO date-time`,
    );
  return result;
};
function pagination(query: Record<string, unknown>) {
  const raw = textParam(query.limit, "limit");
  const limit = raw === undefined ? 30 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError(
      400,
      "INVALID_QUERY",
      "limit must be an integer from 1 to 100",
    );
  const cursor = textParam(query.cursor, "cursor");
  if (cursor && cursor.length > 512)
    throw new ApiError(400, "INVALID_QUERY", "cursor is too long");
  return { limit, cursor };
}
const repository = (factory: () => AlertCenterRepository | undefined) => {
  const result = factory();
  if (!result)
    throw new ApiError(503, "PLUGIN_NOT_STARTED", "Plugin is not started");
  return result;
};
function parseDefinitions(request: RequestLike): DefinitionQuery {
  const q = request.query ?? {};
  return {
    ...pagination(q),
    zone: textParam(q.zone, "zone"),
    sourceType: enumParam(q.sourceType, "sourceType", [
      "zone",
      "recognized",
    ] as const),
    enabled: boolParam(q.enabled, "enabled"),
  };
}
function parseOccurrences(request: RequestLike): OccurrenceQuery {
  const q = request.query ?? {};
  const from = dateParam(q.from, "from");
  const to = dateParam(q.to, "to");
  if (from && to && from > to)
    throw new ApiError(400, "INVALID_QUERY", "from must not be after to");
  return {
    ...pagination(q),
    definitionId: textParam(q.definitionId, "definitionId"),
    path: textParam(q.path, "path"),
    source: textParam(q.source, "source"),
    state: enumParam(q.state, "state", ["active", "cleared"] as const),
    severity: enumParam(q.severity, "severity", [
      "normal",
      "warn",
      "alert",
      "alarm",
      "emergency",
    ] as const),
    from,
    to,
  };
}
function parseAlertHistory(request: RequestLike): AlertHistoryQuery {
  const q = request.query ?? {};
  const from = dateParam(q.from, "from");
  const to = dateParam(q.to, "to");
  if (from && to && from > to)
    throw new ApiError(400, "INVALID_QUERY", "from must not be after to");
  return {
    ...pagination(q),
    definitionId: textParam(q.definitionId, "definitionId"),
    path: textParam(q.path, "path"),
    source: textParam(q.source, "source"),
    state: enumParam(q.state, "state", ["active", "cleared"] as const),
    severity: enumParam(q.severity, "severity", [
      "normal",
      "warn",
      "alert",
      "alarm",
      "emergency",
    ] as const),
    eventType: textParam(q.eventType, "eventType"),
    from,
    to,
  };
}
function parsePolicy(body: unknown): AlertPolicyPatch {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "INVALID_BODY", "Request body must be an object");
  const value = body as Record<string, unknown>;
  const allowed = new Set([
    "enabled",
    "oneTime",
    "notifierIds",
    "notifierRepeatOverrides",
    "activationDelaySeconds",
    "minimumSeverity",
    "connectivity",
    "overrideFields",
    "speechMinimumSeverity",
    "speechTemplate",
    "speechAnnounceClear",
  ]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length)
    throw new ApiError(400, "INVALID_BODY", "Request body has unknown fields", {
      fields: extra,
    });
  const patch: AlertPolicyPatch = {};
  if (value.overrideFields !== undefined) {
    if (
      !Array.isArray(value.overrideFields) ||
      value.overrideFields.some(
        (field) =>
          typeof field !== "string" ||
          !alertPolicyFields.includes(field as AlertPolicyField),
      )
    )
      throw new ApiError(
        400,
        "INVALID_BODY",
        "overrideFields must contain supported policy field names",
      );
    patch.overrideFields = [
      ...new Set(value.overrideFields as AlertPolicyField[]),
    ];
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean")
      throw new ApiError(400, "INVALID_BODY", "enabled must be boolean");
    patch.enabled = value.enabled;
  }
  if (value.oneTime !== undefined) {
    if (typeof value.oneTime !== "boolean")
      throw new ApiError(400, "INVALID_BODY", "oneTime must be boolean");
    patch.oneTime = value.oneTime;
  }
  if (value.notifierIds !== undefined) {
    if (
      !Array.isArray(value.notifierIds) ||
      value.notifierIds.some((id) => typeof id !== "string" || !id.trim())
    )
      throw new ApiError(
        400,
        "INVALID_BODY",
        "notifierIds must contain non-empty strings",
      );
    patch.notifierIds = [...new Set(value.notifierIds as string[])];
  }
  if (value.notifierRepeatOverrides !== undefined) {
    const overrides = value.notifierRepeatOverrides;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
      throw new ApiError(
        400,
        "INVALID_BODY",
        "notifierRepeatOverrides must be an object keyed by notification service name",
      );
    const entries = Object.entries(overrides);
    if (
      entries.some(
        ([id, interval]) =>
          !id.trim() ||
          !Number.isInteger(interval) ||
          Number(interval) < 0 ||
          Number(interval) > 31536000,
      )
    )
      throw new ApiError(
        400,
        "INVALID_BODY",
        "Each notification service repeat override must be an integer from 0 to 31536000 seconds",
      );
    patch.notifierRepeatOverrides = Object.fromEntries(
      entries.map(([id, interval]) => [id, Number(interval)]),
    );
  }
  const delay = value.activationDelaySeconds;
  if (delay !== undefined) {
    if (!Number.isInteger(delay) || Number(delay) < 0 || Number(delay) > 604800)
      throw new ApiError(
        400,
        "INVALID_BODY",
        "activationDelaySeconds must be an integer from 0 to 604800",
      );
    patch.activationDelaySeconds = Number(delay);
  }
  if (value.minimumSeverity !== undefined) {
    if (
      !["normal", "warn", "alert", "alarm", "emergency"].includes(
        String(value.minimumSeverity),
      )
    )
      throw new ApiError(400, "INVALID_BODY", "minimumSeverity is invalid");
    patch.minimumSeverity =
      value.minimumSeverity as AlertPolicyPatch["minimumSeverity"];
  }
  if (value.speechMinimumSeverity !== undefined) {
    if (
      !["normal", "warn", "alert", "alarm", "emergency"].includes(
        String(value.speechMinimumSeverity),
      )
    )
      throw new ApiError(
        400,
        "INVALID_BODY",
        "speechMinimumSeverity is invalid",
      );
    patch.speechMinimumSeverity =
      value.speechMinimumSeverity as AlertPolicyPatch["speechMinimumSeverity"];
  }
  if (value.speechTemplate !== undefined) {
    if (
      typeof value.speechTemplate !== "string" ||
      value.speechTemplate.trim().length === 0 ||
      value.speechTemplate.length > 500
    )
      throw new ApiError(
        400,
        "INVALID_BODY",
        "speechTemplate must contain 1 to 500 characters",
      );
    patch.speechTemplate = value.speechTemplate.trim();
  }
  if (value.speechAnnounceClear !== undefined) {
    if (typeof value.speechAnnounceClear !== "boolean")
      throw new ApiError(
        400,
        "INVALID_BODY",
        "speechAnnounceClear must be boolean",
      );
    patch.speechAnnounceClear = value.speechAnnounceClear;
  }
  if (value.connectivity !== undefined) {
    if (!value.connectivity || typeof value.connectivity !== "object")
      throw new ApiError(400, "INVALID_BODY", "connectivity must be an object");
    const c = value.connectivity as Record<string, unknown>;
    if (c.mode === "queue" || c.mode === "wake")
      patch.connectivity = { mode: c.mode };
    else if (
      c.mode === "wake_after" &&
      Number.isInteger(c.delaySeconds) &&
      Number(c.delaySeconds) >= 0 &&
      Number(c.delaySeconds) <= 604800
    )
      patch.connectivity = {
        mode: "wake_after",
        delaySeconds: Number(c.delaySeconds),
      };
    else throw new ApiError(400, "INVALID_BODY", "connectivity is invalid");
  }
  if (!Object.keys(patch).length)
    throw new ApiError(
      400,
      "INVALID_BODY",
      "At least one policy field is required",
    );
  return patch;
}

export function registerAlertCenterRoutes(
  router: RouterLike,
  dependencies: AlertCenterDependencies,
): void {
  const repo = () => repository(dependencies.repository);
  const subscribeChanges = dependencies.subscribeChanges;
  if (subscribeChanges)
    addRoute(router, "get", "/events", "readonly", (req, res) => {
      if (!res.setHeader || !res.write)
        return fail(
          res,
          501,
          "STREAMING_UNAVAILABLE",
          "This server cannot stream alert updates",
        );
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      res.write("retry: 5000\n\n");

      let closed = false;
      let writable = true;
      let waitingForDrain = false;
      let pending: AlertCenterChange | undefined;
      const waitForDrain = () => {
        if (waitingForDrain) return;
        waitingForDrain = true;
        res.once?.("drain", flushPending);
      };
      const send = (change: AlertCenterChange) => {
        if (closed) return;
        if (!writable) {
          pending = change;
          return;
        }
        writable =
          res.write?.(`event: change\ndata: ${JSON.stringify(change)}\n\n`) !==
          false;
        if (!writable) waitForDrain();
      };
      const flushPending = () => {
        if (closed) return;
        waitingForDrain = false;
        writable = true;
        const change = pending;
        pending = undefined;
        if (change) send(change);
      };
      const unsubscribe = subscribeChanges((change) => {
        send(change);
      });
      const heartbeat = setInterval(() => {
        if (!closed && writable)
          writable = res.write?.(": keepalive\n\n") !== false;
        if (!writable) waitForDrain();
      }, 25_000);
      heartbeat.unref?.();
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        pending = undefined;
        waitingForDrain = false;
        res.off?.("drain", flushPending);
        unsubscribe();
        res.end?.();
      };
      req.on?.("close", close);
      res.on?.("close", close);
    });
  addRoute(
    router,
    "get",
    "/definitions",
    "readonly",
    wrap(async (req, res) =>
      res.json(await repo().listDefinitions(parseDefinitions(req))),
    ),
  );
  if (dependencies.testNotifier)
    addRoute(
      router,
      "post",
      "/notifiers/:id/test",
      "readwrite",
      wrap(async (req, res) => {
        const body = req.body;
        if (
          body !== undefined &&
          (!body || typeof body !== "object" || Array.isArray(body))
        )
          throw new ApiError(
            400,
            "INVALID_BODY",
            "Request body must be an object",
          );
        const value = (body ?? {}) as Record<string, unknown>;
        const extra = Object.keys(value).filter((key) => key !== "operation");
        if (extra.length)
          throw new ApiError(
            400,
            "INVALID_BODY",
            "Request body has unknown fields",
            {
              fields: extra,
            },
          );
        const operation = value.operation ?? "send";
        if (operation !== "send" && operation !== "resolve")
          throw new ApiError(
            400,
            "INVALID_BODY",
            "operation must be send or resolve",
          );
        const result = await dependencies.testNotifier?.(
          req.params?.id ?? "",
          operation,
        );
        if (result === "not_found")
          throw new ApiError(
            404,
            "NOT_FOUND",
            "Notification service was not found",
          );
        if (result === "disabled")
          throw new ApiError(
            409,
            "NOTIFIER_DISABLED",
            "Enable and save this notification service before testing it",
          );
        if (result === "in_progress")
          throw new ApiError(
            409,
            "TEST_IN_PROGRESS",
            "A test is already running for this notification service",
          );
        if (result === "unsupported")
          throw new ApiError(
            400,
            "UNSUPPORTED_TEST_OPERATION",
            "Only PagerDuty services support a separate resolve test",
          );
        res.json(result);
      }),
    );
  addRoute(
    router,
    "delete",
    "/definitions/:id/policy",
    "readwrite",
    wrap(async (req, res) => {
      const result = await repo().resetPolicy(req.params?.id ?? "");
      if (result === undefined)
        throw new ApiError(404, "NOT_FOUND", "Alert definition was not found");
      res.json(result);
    }),
  );
  addRoute(
    router,
    "delete",
    "/definitions/:id",
    "readwrite",
    wrap(async (req, res) => {
      const result = await repo().deleteDefinition(req.params?.id ?? "");
      if (result === "not_found")
        throw new ApiError(404, "NOT_FOUND", "Alert definition was not found");
      if (result === "active")
        throw new ApiError(
          409,
          "ALERT_ACTIVE",
          "Clear the active alert in Signal K before removing its stored data",
        );
      res.json({ status: "deleted" });
    }),
  );
  addRoute(
    router,
    "get",
    "/definitions/:id",
    "readonly",
    wrap(async (req, res) => {
      const result = await repo().getDefinition(req.params?.id ?? "");
      if (result === undefined)
        throw new ApiError(404, "NOT_FOUND", "Alert definition was not found");
      res.json(result);
    }),
  );
  addRoute(
    router,
    "patch",
    "/definitions/:id/policy",
    "readwrite",
    wrap(async (req, res) => {
      const patch = parsePolicy(req.body);
      if (
        (patch.notifierIds || patch.notifierRepeatOverrides) &&
        dependencies.listNotifiers
      ) {
        const known = new Set(
          (await dependencies.listNotifiers()).map((item) =>
            typeof item === "string"
              ? item
              : String((item as { id?: unknown }).id),
          ),
        );
        const referenced = new Set([
          ...(patch.notifierIds ?? []),
          ...Object.keys(patch.notifierRepeatOverrides ?? {}),
        ]);
        const missing = [...referenced].filter((id) => !known.has(id));
        if (missing.length)
          throw new ApiError(
            400,
            "UNKNOWN_NOTIFIER",
            "One or more notification service names are unknown",
            { ids: missing },
          );
      }
      const result = await repo().updatePolicy(req.params?.id ?? "", patch);
      if (result === undefined)
        throw new ApiError(404, "NOT_FOUND", "Alert definition was not found");
      res.json(result);
    }),
  );
  addRoute(
    router,
    "get",
    "/notifiers",
    "readonly",
    wrap(async (_req, res) =>
      res.json({
        items: dependencies.listNotifiers
          ? await dependencies.listNotifiers()
          : [],
      }),
    ),
  );
  addRoute(
    router,
    "get",
    "/alert-history",
    "readonly",
    wrap(async (req, res) =>
      res.json(await repo().listAlertHistory(parseAlertHistory(req))),
    ),
  );
  addRoute(
    router,
    "get",
    "/occurrences",
    "readonly",
    wrap(async (req, res) =>
      res.json(await repo().listOccurrences(parseOccurrences(req))),
    ),
  );
  addRoute(
    router,
    "get",
    "/occurrences/:id",
    "readonly",
    wrap(async (req, res) => {
      const result = await repo().getOccurrence(req.params?.id ?? "");
      if (result === undefined)
        throw new ApiError(404, "NOT_FOUND", "Alert occurrence was not found");
      res.json(result);
    }),
  );
  addRoute(
    router,
    "get",
    "/occurrences/:id/events",
    "readonly",
    wrap(async (req, res) => {
      const q = req.query ?? {};
      const result = await repo().listOccurrenceEvents(req.params?.id ?? "", {
        ...pagination(q),
        eventType: textParam(q.eventType, "eventType"),
      });
      if (result === undefined)
        throw new ApiError(404, "NOT_FOUND", "Alert occurrence was not found");
      res.json(result);
    }),
  );
  addRoute(
    router,
    "get",
    "/deliveries",
    "readonly",
    wrap(async (req, res) =>
      res.json(await repo().listDeliveries(pagination(req.query ?? {}))),
    ),
  );
  addRoute(
    router,
    "get",
    "/deliveries/:id",
    "readonly",
    wrap(async (req, res) => {
      const result = await repo().getDelivery(req.params?.id ?? "");
      if (result === undefined)
        throw new ApiError(404, "NOT_FOUND", "Delivery was not found");
      res.json(result);
    }),
  );
  addRoute(
    router,
    "get",
    "/deliveries/:id/attempts",
    "readonly",
    wrap(async (req, res) => {
      const result = await repo().listDeliveryAttempts(req.params?.id ?? "", {
        ...pagination(req.query ?? {}),
      });
      if (result === undefined)
        throw new ApiError(404, "NOT_FOUND", "Delivery was not found");
      res.json(result);
    }),
  );
  addRoute(
    router,
    "post",
    "/deliveries/:id/retry",
    "readwrite",
    wrap(async (req, res) => {
      const result = await repo().retryDelivery(req.params?.id ?? "");
      if (result === "not_found")
        throw new ApiError(404, "NOT_FOUND", "Delivery was not found");
      if (result === "not_retryable")
        throw new ApiError(
          409,
          "DELIVERY_NOT_RETRYABLE",
          "Only failed deliveries can be retried",
        );
      res.json({ status: "scheduled" });
    }),
  );
  const actions = {
    acknowledge: (id: string) => repo().acknowledgeOccurrence(id),
    silence: (id: string) => repo().silenceOccurrence(id),
  };
  for (const action of Object.keys(actions) as Array<keyof typeof actions>)
    addRoute(
      router,
      "post",
      `/occurrences/:id/${action}`,
      "readwrite",
      wrap(async (req, res) => {
        const result = await actions[action](req.params?.id ?? "");
        if (result === "inactive")
          throw new ApiError(
            409,
            "ALERT_INACTIVE",
            `Only active alerts can be ${action === "acknowledge" ? "acknowledged" : "silenced"}`,
          );
        if (!result)
          throw new ApiError(
            404,
            "NOT_FOUND",
            "Alert occurrence was not found",
          );
        res.json(result);
      }),
    );
}

/** Status, delivery queue, retry, notifier and maintenance endpoints. */
export function registerRoutes(
  router: RouterLike,
  database: () => AlertDatabase | undefined,
  status: () => unknown,
  runScheduler: () => Promise<void>,
  catalog: () => unknown,
  acknowledgeAlert: (id: string) => boolean,
  silenceAlert: (id: string) => boolean,
): void {
  addRoute(router, "get", "/status", "readonly", (_req, res) =>
    res.json(status()),
  );
  addRoute(router, "get", "/alerts", "readonly", (_req, res) =>
    res.json(catalog()),
  );
  for (const [action, callback] of [
    ["acknowledge", acknowledgeAlert],
    ["silence", silenceAlert],
  ] as const)
    addRoute(
      router,
      "post",
      `/alerts/:id/${action}`,
      "readwrite",
      (req, res) => {
        const id = req.params?.id;
        if (!id || !callback(id))
          return fail(res, 404, "NOT_FOUND", "Alert was not found");
        res.json({ status: `${action}d` });
      },
    );
  addRoute(
    router,
    "post",
    "/retry",
    "readwrite",
    wrap(async (_req, res) => {
      const current = database();
      if (!current)
        throw new ApiError(503, "PLUGIN_NOT_STARTED", "Plugin is not started");
      current.retryFailedDeliveries();
      await runScheduler();
      res.json({ status: "scheduled" });
    }),
  );
}
