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
          summary: "List delivery intents and their latest outcome",
          responses: {
            "200": response("Delivery records", {
              type: "array",
              items: { type: "object", additionalProperties: true },
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
          summary: "Forget an inactive discovered definition and its history",
          parameters: [idParameter],
          responses: {
            "200": response("Definition forgotten", {
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
            { name: "dismissed", in: "query", schema: { type: "boolean" } },
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
        ["dismiss", "acknowledge", "silence"].map((action) => [
          `/occurrences/{id}/${action}`,
          {
            post: {
              summary: `${action[0].toUpperCase()}${action.slice(1)} an occurrence`,
              parameters: [idParameter],
              responses: {
                "200": response("Action result", {
                  $ref: "#/components/schemas/ActionResult",
                }),
                ...(action === "dismiss"
                  ? {}
                  : {
                      "409": response("The occurrence is not active", {
                        $ref: "#/components/schemas/Error",
                      }),
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
            "reconciliation",
            "scheduler",
            "audio",
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
            reconciliation: { type: "object", additionalProperties: true },
            scheduler: { type: "object", additionalProperties: true },
            audio: { type: "object", additionalProperties: true },
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
        Policy: {
          type: "object",
          required: [
            "enabled",
            "notifierIds",
            "activationDelaySeconds",
            "minimumSeverity",
            "connectivity",
            "audio",
            "provenance",
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
            audio: { $ref: "#/components/schemas/AudioPolicy" },
            provenance: {
              type: "string",
              enum: ["override", "default"],
            },
          },
        },
        PolicyPatch: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
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
            audio: { $ref: "#/components/schemas/AudioPolicy" },
          },
        },
        AudioPolicy: {
          type: "object",
          additionalProperties: false,
          required: [
            "enabled",
            "sound",
            "minimumSeverity",
            "mode",
            "repeatIntervalSeconds",
            "stopOn",
          ],
          properties: {
            enabled: { type: "boolean" },
            sound: {
              type: "string",
              enum: ["chime", "warning", "alarm", "emergency"],
            },
            minimumSeverity: { $ref: "#/components/schemas/Severity" },
            mode: { type: "string", enum: ["once", "repeat"] },
            repeatIntervalSeconds: {
              type: "integer",
              minimum: 1,
              maximum: 86400,
            },
            stopOn: {
              type: "object",
              additionalProperties: false,
              required: ["clear", "acknowledge", "silence", "dismiss"],
              properties: {
                clear: { type: "boolean" },
                acknowledge: { type: "boolean" },
                silence: { type: "boolean" },
                dismiss: { type: "boolean" },
              },
            },
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
            dismissedAt: { type: "string", format: "date-time" },
            acknowledgedAt: { type: "string", format: "date-time" },
            silencedAt: { type: "string", format: "date-time" },
            activationDueAt: { type: "string", format: "date-time" },
            audioPlayback: {
              $ref: "#/components/schemas/AudioPlayback",
            },
            deliveries: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
        },
        AudioPlayback: {
          type: "object",
          required: [
            "id",
            "alertId",
            "state",
            "sound",
            "minimumSeverity",
            "mode",
            "repeatIntervalSeconds",
            "stopOn",
            "attemptCount",
            "playCount",
          ],
          properties: {
            id: { type: "string" },
            alertId: { type: "string" },
            state: {
              type: "string",
              enum: [
                "queued",
                "waiting_severity",
                "playing",
                "completed",
                "cancelled",
                "failed_retryable",
                "failed_terminal",
              ],
            },
            sound: {
              type: "string",
              enum: ["chime", "warning", "alarm", "emergency"],
            },
            minimumSeverity: { $ref: "#/components/schemas/Severity" },
            mode: { type: "string", enum: ["once", "repeat"] },
            repeatIntervalSeconds: { type: "integer", minimum: 1 },
            stopOn: {
              type: "object",
              required: ["clear", "acknowledge", "silence", "dismiss"],
              properties: {
                clear: { type: "boolean" },
                acknowledge: { type: "boolean" },
                silence: { type: "boolean" },
                dismiss: { type: "boolean" },
              },
              additionalProperties: false,
            },
            attemptCount: { type: "integer", minimum: 0 },
            playCount: { type: "integer", minimum: 0 },
            nextPlayAt: { type: "string", format: "date-time" },
            lastStartedAt: { type: "string", format: "date-time" },
            lastFinishedAt: { type: "string", format: "date-time" },
            lastErrorCode: { type: "string" },
            lastErrorMessage: { type: "string" },
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
        ActionResult: {
          type: "object",
          required: ["status"],
          properties: {
            status: {
              type: "string",
              enum: ["dismissed", "acknowledged", "silenced"],
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
