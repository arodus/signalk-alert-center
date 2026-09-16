const pageParameters = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 30 },
  },
  { name: "cursor", in: "query", schema: { type: "string", maxLength: 512 } },
];
const idParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
};
const json = (schema: unknown) => ({ "application/json": { schema } });
const response = (description: string, schema?: unknown) => ({
  description,
  ...(schema ? { content: json(schema) } : {}),
});
const errors = {
  "400": response("Invalid request", { $ref: "#/components/schemas/Error" }),
  "401": response("Authentication required", {
    $ref: "#/components/schemas/Error",
  }),
  "403": response("Insufficient permission", {
    $ref: "#/components/schemas/Error",
  }),
  "404": response("Resource not found", { $ref: "#/components/schemas/Error" }),
  "500": response("Internal error", { $ref: "#/components/schemas/Error" }),
  "503": response("Plugin not started", { $ref: "#/components/schemas/Error" }),
};
const page = (item: string) => ({
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: { $ref: item } },
    nextCursor: { type: "string" },
  },
});

/** Complete OpenAPI document for routes registered by registerAlertCenterRoutes. */
export function getAlertCenterOpenApi() {
  return {
    openapi: "3.0.3",
    info: { title: "Persistent Notifier Alert Center", version: "1.0.0" },
    paths: {
      "/status": {
        get: {
          summary: "Get plugin, queue, database, and connectivity health",
          responses: {
            "200": response("Plugin status", {
              $ref: "#/components/schemas/OperationalStatus",
            }),
            ...errors,
          },
        },
      },
      "/deliveries": {
        get: {
          summary: "List recent delivery intents and their latest outcome",
          parameters: pageParameters,
          responses: {
            "200": response(
              "Delivery page",
              page("#/components/schemas/Delivery"),
            ),
            ...errors,
          },
        },
      },
      "/deliveries/{id}": {
        get: {
          summary: "Get one delivery with alert and service context",
          parameters: [idParameter],
          responses: {
            "200": response("Delivery detail", {
              $ref: "#/components/schemas/Delivery",
            }),
            ...errors,
          },
        },
      },
      "/deliveries/{id}/attempts": {
        get: {
          summary: "List one delivery's attempt history chronologically",
          parameters: [idParameter, ...pageParameters],
          responses: {
            "200": response(
              "Delivery attempt page",
              page("#/components/schemas/DeliveryAttempt"),
            ),
            ...errors,
          },
        },
      },
      "/deliveries/{id}/retry": {
        post: {
          summary: "Retry one failed delivery",
          parameters: [idParameter],
          responses: {
            "200": response("Retry scheduled", {
              type: "object",
              required: ["status"],
              properties: { status: { type: "string", enum: ["scheduled"] } },
            }),
            "409": response("Delivery is not failed", {
              $ref: "#/components/schemas/Error",
            }),
            ...errors,
          },
        },
      },
      "/retry": {
        post: {
          summary: "Retry failed delivery intents",
          responses: {
            "200": response("Retry scheduled", {
              type: "object",
              required: ["status"],
              properties: { status: { type: "string", enum: ["scheduled"] } },
            }),
            ...errors,
          },
        },
      },
      "/definitions": {
        get: {
          summary:
            "List all known alert definitions, including never-fired zones",
          parameters: [
            ...pageParameters,
            { name: "zone", in: "query", schema: { type: "string" } },
            {
              name: "sourceType",
              in: "query",
              schema: { type: "string", enum: ["zone", "recognized"] },
            },
            { name: "enabled", in: "query", schema: { type: "boolean" } },
          ],
          responses: {
            "200": response(
              "Definition page",
              page("#/components/schemas/Definition"),
            ),
            ...errors,
          },
        },
      },
      "/definitions/{id}": {
        get: {
          summary: "Get an alert definition and effective policy",
          parameters: [idParameter],
          responses: {
            "200": response("Definition", {
              $ref: "#/components/schemas/Definition",
            }),
            ...errors,
          },
        },
        delete: {
          summary:
            "Permanently remove an inactive stored alert, its policy, and history",
          parameters: [idParameter],
          responses: {
            "200": response("Stored alert removed", {
              type: "object",
              required: ["status"],
              properties: { status: { type: "string", enum: ["deleted"] } },
            }),
            "409": response("The alert is still active", {
              $ref: "#/components/schemas/Error",
            }),
            ...errors,
          },
        },
      },
      "/definitions/{id}/policy": {
        patch: {
          summary: "Override delivery policy for an alert definition",
          parameters: [idParameter],
          requestBody: {
            required: true,
            content: json({ $ref: "#/components/schemas/PolicyPatch" }),
          },
          responses: {
            "200": response("Updated definition", {
              $ref: "#/components/schemas/Definition",
            }),
            ...errors,
          },
        },
        delete: {
          summary: "Use current global defaults for an alert definition",
          parameters: [idParameter],
          responses: {
            "200": response("Updated definition", {
              $ref: "#/components/schemas/Definition",
            }),
            ...errors,
          },
        },
      },
      "/notifiers": {
        get: {
          summary: "List configured notifier instances",
          responses: {
            "200": response("Notifier list", {
              type: "object",
              required: ["items"],
              properties: {
                items: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Notifier" },
                },
              },
            }),
            ...errors,
          },
        },
      },
      "/notifiers/{id}/test": {
        post: {
          summary: "Run a manual notification-service test",
          description:
            "Uses the saved service configuration without creating alert occurrences or delivery history. PagerDuty send tests create a real marked test incident; resolve tests close that same test incident.",
          parameters: [idParameter],
          requestBody: {
            content: json({
              type: "object",
              properties: {
                operation: {
                  type: "string",
                  enum: ["send", "resolve"],
                  default: "send",
                },
              },
              additionalProperties: false,
            }),
          },
          responses: {
            "200": response("Test outcome", {
              $ref: "#/components/schemas/NotificationTestResult",
            }),
            "409": response("Service disabled or test already running", {
              $ref: "#/components/schemas/Error",
            }),
            ...errors,
          },
        },
      },
      "/events": {
        get: {
          summary: "Stream alert-center change notifications",
          responses: {
            "200": {
              description:
                "Server-sent events that invalidate dashboard alert data",
              content: {
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            ...errors,
          },
        },
      },
      "/alert-history": {
        get: {
          summary:
            "List alert lifecycle updates without notification-delivery data",
          parameters: [
            ...pageParameters,
            { name: "definitionId", in: "query", schema: { type: "string" } },
            { name: "path", in: "query", schema: { type: "string" } },
            { name: "source", in: "query", schema: { type: "string" } },
            { name: "eventType", in: "query", schema: { type: "string" } },
            {
              name: "state",
              in: "query",
              schema: { type: "string", enum: ["active", "cleared"] },
            },
            {
              name: "severity",
              in: "query",
              schema: { $ref: "#/components/schemas/Severity" },
            },
            {
              name: "from",
              in: "query",
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "to",
              in: "query",
              schema: { type: "string", format: "date-time" },
            },
          ],
          responses: {
            "200": response(
              "Alert history page",
              page("#/components/schemas/AlertHistoryEvent"),
            ),
            ...errors,
          },
        },
      },
      "/occurrences": {
        get: {
          summary:
            "List alert occurrences in stable reverse chronological order",
          parameters: [
            ...pageParameters,
            { name: "definitionId", in: "query", schema: { type: "string" } },
            { name: "path", in: "query", schema: { type: "string" } },
            { name: "source", in: "query", schema: { type: "string" } },
            {
              name: "state",
              in: "query",
              schema: { type: "string", enum: ["active", "cleared"] },
            },
            {
              name: "severity",
              in: "query",
              schema: { $ref: "#/components/schemas/Severity" },
            },
            {
              name: "from",
              in: "query",
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "to",
              in: "query",
              schema: { type: "string", format: "date-time" },
            },
          ],
          responses: {
            "200": response(
              "Occurrence page",
              page("#/components/schemas/Occurrence"),
            ),
            ...errors,
          },
        },
      },
      "/occurrences/{id}": {
        get: {
          summary: "Get an occurrence and notifier outcomes",
          parameters: [idParameter],
          responses: {
            "200": response("Occurrence", {
              $ref: "#/components/schemas/Occurrence",
            }),
            ...errors,
          },
        },
      },
      "/occurrences/{id}/events": {
        get: {
          summary: "List immutable occurrence lifecycle and operator events",
          parameters: [
            ...pageParameters,
            idParameter,
            { name: "eventType", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": response("Event page", page("#/components/schemas/Event")),
            ...errors,
          },
        },
      },
      ...Object.fromEntries(
        ["acknowledge", "silence"].map((action) => [
          `/occurrences/{id}/${action}`,
          {
            post: {
              summary: `${action[0].toUpperCase()}${action.slice(1)} an occurrence`,
              parameters: [idParameter],
              responses: {
                "200": response("Action result", {
                  $ref: "#/components/schemas/ActionResult",
                }),
                "409": response("The occurrence is not active", {
                  $ref: "#/components/schemas/Error",
                }),
                ...errors,
              },
            },
          },
        ]),
      ),
    },
    components: {
      schemas: {
        OperationalStatus: {
          type: "object",
          required: [
            "health",
            "runtime",
            "reconciliation",
            "scheduler",
            "ingestion",
            "connectivity",
            "alerts",
            "services",
          ],
          properties: {
            health: {
              type: "object",
              required: ["state", "reasons"],
              properties: {
                state: {
                  type: "string",
                  enum: ["healthy", "degraded", "fault"],
                },
                reasons: { type: "array", items: { type: "string" } },
              },
            },
            runtime: { type: "object", additionalProperties: true },
            reconciliation: { type: "object", additionalProperties: true },
            scheduler: { type: "object", additionalProperties: true },
            ingestion: { type: "object", additionalProperties: true },
            connectivity: { type: "object", additionalProperties: true },
            alerts: { type: "object", additionalProperties: true },
            database: { type: "object", additionalProperties: true },
            services: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "name", "type", "enabled", "pendingCount"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  type: { type: "string" },
                  enabled: { type: "boolean" },
                  pendingCount: { type: "integer", minimum: 0 },
                  lastSuccessAt: { type: "string", format: "date-time" },
                  lastFailureAt: { type: "string", format: "date-time" },
                  lastFailureCode: { type: "string" },
                },
              },
            },
          },
        },
        Severity: {
          type: "string",
          enum: ["normal", "warn", "alert", "alarm", "emergency"],
        },
        PolicyValues: {
          type: "object",
          required: [
            "enabled",
            "notifierIds",
            "activationDelaySeconds",
            "minimumSeverity",
            "connectivity",
          ],
          properties: {
            enabled: { type: "boolean" },
            oneTime: { type: "boolean" },
            rearmAfterSeconds: {
              type: "integer",
              nullable: true,
              minimum: 0,
              maximum: 31536000,
            },
            notifierIds: {
              type: "array",
              items: { type: "string" },
              uniqueItems: true,
            },
            activationDelaySeconds: {
              type: "integer",
              minimum: 0,
              maximum: 604800,
            },
            minimumSeverity: { $ref: "#/components/schemas/Severity" },
            connectivity: { $ref: "#/components/schemas/Connectivity" },
          },
        },
        Policy: {
          allOf: [
            { $ref: "#/components/schemas/PolicyValues" },
            {
              type: "object",
              required: ["provenance", "overriddenFields", "defaults"],
              properties: {
                provenance: {
                  type: "string",
                  enum: ["override", "partial", "default"],
                },
                overriddenFields: {
                  type: "array",
                  items: { $ref: "#/components/schemas/AlertPolicyField" },
                  uniqueItems: true,
                },
                defaults: { $ref: "#/components/schemas/PolicyValues" },
              },
            },
          ],
        },
        AlertPolicyField: {
          type: "string",
          enum: [
            "enabled",
            "oneTime",
            "minimumSeverity",
            "activationDelaySeconds",
            "rearmAfterSeconds",
            "connectivity",
            "notifierIds",
          ],
        },
        PolicyPatch: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            overrideFields: {
              type: "array",
              items: { $ref: "#/components/schemas/AlertPolicyField" },
              uniqueItems: true,
            },
            enabled: { type: "boolean" },
            oneTime: { type: "boolean" },
            rearmAfterSeconds: {
              type: "integer",
              nullable: true,
              minimum: 0,
              maximum: 31536000,
            },
            notifierIds: {
              type: "array",
              items: { type: "string", minLength: 1 },
              uniqueItems: true,
            },
            activationDelaySeconds: {
              type: "integer",
              minimum: 0,
              maximum: 604800,
            },
            minimumSeverity: { $ref: "#/components/schemas/Severity" },
            connectivity: { $ref: "#/components/schemas/Connectivity" },
          },
        },
        Connectivity: {
          oneOf: [
            {
              type: "object",
              required: ["mode"],
              properties: { mode: { type: "string", enum: ["queue", "wake"] } },
              additionalProperties: false,
            },
            {
              type: "object",
              required: ["mode", "delaySeconds"],
              properties: {
                mode: { type: "string", enum: ["wake_after"] },
                delaySeconds: { type: "integer", minimum: 0, maximum: 604800 },
              },
              additionalProperties: false,
            },
          ],
        },
        Definition: {
          type: "object",
          required: [
            "id",
            "name",
            "sourceType",
            "pathPattern",
            "oneTime",
            "policy",
          ],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            sourceType: {
              type: "string",
              enum: ["zone", "recognized"],
            },
            pathPattern: { type: "string" },
            zone: { type: "string" },
            oneTime: { type: "boolean" },
            lastFiredAt: { type: "string", format: "date-time" },
            lastActivityAt: { type: "string", format: "date-time" },
            fireCount: { type: "integer", minimum: 0 },
            policy: { $ref: "#/components/schemas/Policy" },
          },
        },
        Occurrence: {
          type: "object",
          required: [
            "id",
            "definitionId",
            "path",
            "state",
            "currentSeverity",
            "maxSeverity",
            "startedAt",
          ],
          properties: {
            id: { type: "string" },
            definitionId: { type: "string" },
            path: { type: "string" },
            source: { type: "string" },
            state: { type: "string", enum: ["active", "cleared"] },
            currentSeverity: { $ref: "#/components/schemas/Severity" },
            maxSeverity: { $ref: "#/components/schemas/Severity" },
            message: { type: "string" },
            startedAt: { type: "string", format: "date-time" },
            lastSeenAt: { type: "string", format: "date-time" },
            clearedAt: { type: "string", format: "date-time" },
            acknowledgedAt: { type: "string", format: "date-time" },
            silencedAt: { type: "string", format: "date-time" },
            activationDueAt: { type: "string", format: "date-time" },
            deliveries: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
        },
        Delivery: {
          type: "object",
          required: [
            "id",
            "alertId",
            "transportInstanceId",
            "operation",
            "state",
            "attemptCount",
            "createdAt",
            "updatedAt",
            "service",
          ],
          properties: {
            id: { type: "string" },
            alertId: { type: "string" },
            transportInstanceId: { type: "string" },
            operation: {
              type: "string",
              enum: ["notify", "trigger", "acknowledge", "resolve"],
            },
            state: {
              type: "string",
              enum: [
                "pending",
                "waiting_connectivity",
                "sending",
                "delivered",
                "failed_retryable",
                "failed_terminal",
              ],
            },
            attemptCount: { type: "integer", minimum: 0 },
            nextAttemptAt: { type: "string", format: "date-time" },
            lastAttemptAt: { type: "string", format: "date-time" },
            deliveredAt: { type: "string", format: "date-time" },
            lastErrorCode: { type: "string" },
            lastErrorMessage: { type: "string" },
            remoteId: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            alert: { type: "object", additionalProperties: true },
            service: { type: "object", additionalProperties: true },
          },
        },
        DeliveryAttempt: {
          type: "object",
          required: [
            "id",
            "deliveryId",
            "attemptNumber",
            "startedAt",
            "outcome",
          ],
          properties: {
            id: { type: "integer" },
            deliveryId: { type: "string" },
            attemptNumber: { type: "integer", minimum: 1 },
            startedAt: { type: "string", format: "date-time" },
            finishedAt: { type: "string", format: "date-time" },
            outcome: { type: "string" },
            errorCode: { type: "string" },
            errorMessage: { type: "string" },
            remoteId: { type: "string" },
          },
        },
        Event: {
          type: "object",
          required: ["id", "occurrenceId", "eventType", "occurredAt"],
          properties: {
            id: { type: "string" },
            occurrenceId: { type: "string" },
            eventType: { type: "string" },
            occurredAt: { type: "string", format: "date-time" },
            payload: {},
          },
        },
        AlertHistoryEvent: {
          type: "object",
          required: [
            "id",
            "alertId",
            "definitionId",
            "occurrenceNumber",
            "name",
            "path",
            "sourceKey",
            "state",
            "severity",
            "eventType",
            "occurredAt",
            "startedAt",
          ],
          properties: {
            id: { type: "integer" },
            alertId: { type: "string" },
            definitionId: { type: "string" },
            occurrenceNumber: { type: "integer", minimum: 1 },
            name: { type: "string" },
            path: { type: "string" },
            sourceKey: { type: "string" },
            source: { type: "string" },
            state: { type: "string", enum: ["active", "cleared"] },
            severity: { $ref: "#/components/schemas/Severity" },
            message: { type: "string" },
            eventType: { type: "string" },
            occurredAt: { type: "string", format: "date-time" },
            startedAt: { type: "string", format: "date-time" },
            clearedAt: { type: "string", format: "date-time" },
            payload: {},
          },
          additionalProperties: false,
        },
        Notifier: {
          type: "object",
          required: ["id", "name", "type", "enabled"],
          properties: {
            id: { type: "string" },
            name: {
              type: "string",
              description:
                "Human-readable service name shown in alert Settings; also used as the stable policy key.",
            },
            type: { type: "string" },
            enabled: { type: "boolean" },
            minimumSeverity: { $ref: "#/components/schemas/Severity" },
          },
        },
        NotificationTestResult: {
          type: "object",
          required: [
            "status",
            "category",
            "message",
            "durationMs",
            "operation",
            "service",
          ],
          properties: {
            status: { type: "string", enum: ["success", "error"] },
            category: {
              type: "string",
              enum: [
                "success",
                "timeout",
                "authentication",
                "validation",
                "transport",
                "remote",
              ],
            },
            message: { type: "string" },
            technicalDetail: { type: "string" },
            durationMs: { type: "integer", minimum: 0 },
            operation: { type: "string", enum: ["send", "resolve"] },
            service: {
              type: "object",
              required: ["id", "type"],
              properties: {
                id: { type: "string" },
                type: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        ActionResult: {
          type: "object",
          required: ["status"],
          properties: {
            status: {
              type: "string",
              enum: ["acknowledged", "silenced"],
            },
            upstream: {
              type: "string",
              enum: [
                "applied",
                "unsupported",
                "failed",
                "timed_out",
                "not_requested",
              ],
            },
            message: { type: "string" },
          },
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: {},
              },
            },
          },
        },
      },
    },
  };
}
