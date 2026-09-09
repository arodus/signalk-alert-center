import { severities } from "./alerts/types";

const serviceName = {
  type: "string",
  title: "Service name",
  description:
    "Choose a unique, recognizable name. This name appears in each alert's Settings, for example “Crew ntfy” or “Emergency PagerDuty”.",
  minLength: 1,
};
const serviceEnabled = {
  type: "boolean",
  title: "Use this service",
  description:
    "Turn this off to keep the connection details without sending notifications through it.",
  default: true,
};
const serviceMinimumSeverity = {
  type: "string",
  title: "Lowest severity sent",
  description:
    "This service will never receive alerts below this level, even when an alert selects it.",
  enum: [...severities],
  default: "normal",
};
const serviceType = (value: string, label: string) => ({
  type: "string",
  title: "Service type",
  description: `Send notifications using ${label}.`,
  enum: [value],
  default: value,
});

// JSON Schema shown by the Signal K admin UI's plugin config form.
export const pluginConfigSchema = {
  type: "object",
  properties: {
    storage: {
      type: "object",
      title: "Storage",
      properties: {
        path: {
          type: "string",
          title: "SQLite database file path",
          description:
            "Relative paths are stored inside Signal K's data directory. Use an absolute path only when the database must live elsewhere.",
          default: "persistent-notifier.sqlite",
        },
      },
    },
    maintenance: {
      type: "object",
      title: "Database maintenance",
      description:
        "Destructive maintenance actions. Signal K automatically turns one-shot actions off after they finish.",
      properties: {
        resetDatabase: {
          type: "boolean",
          title: "Reset database when Save Configuration is clicked",
          description:
            "Permanently deletes every stored alert definition, occurrence, event, delivery, and per-alert policy, then creates a clean database and discovers current Signal K zone definitions again. Notification service configuration is not deleted.",
          default: false,
        },
      },
    },
    discovery: {
      type: "object",
      title: "Definition discovery",
      properties: {
        zoneRefreshSeconds: {
          type: "number",
          minimum: 1,
          title: "Zone metadata refresh interval (seconds)",
          default: 300,
        },
      },
    },
    delivery: {
      type: "object",
      title: "Notification delivery",
      description:
        "Controls bounded parallel sending. Each delivery is saved and claimed independently before its notification service is contacted.",
      properties: {
        batchSize: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          title: "Maximum deliveries checked per run",
          description:
            "Limits how many due deliveries are loaded from the database in one scheduler run.",
          default: 50,
        },
        concurrency: {
          type: "integer",
          minimum: 1,
          maximum: 32,
          title: "Simultaneous notification sends",
          description:
            "Maximum number of notification services contacted at once. Four is a safe default for small Signal K servers.",
          default: 4,
        },
      },
    },
    retention: {
      type: "object",
      title: "History retention",
      description:
        "Optional bounded cleanup for old completed alert history. Active alerts and unfinished delivery or connectivity work are always protected.",
      properties: {
        enabled: {
          type: "boolean",
          title: "Automatically remove old completed history",
          description:
            "Disabled by default. When enabled, cleanup runs after startup and at the configured interval.",
          default: false,
        },
        maxAgeDays: {
          type: "integer",
          minimum: 1,
          title: "Keep completed history for at least (days)",
          description:
            "Only cleared occurrences older than this age can be removed.",
          default: 365,
        },
        batchSize: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          title: "Maximum occurrences removed per cleanup",
          description:
            "Limits each SQLite transaction so cleanup does not monopolize Signal K.",
          default: 100,
        },
        intervalHours: {
          type: "number",
          minimum: 1,
          title: "Cleanup interval (hours)",
          default: 24,
        },
      },
    },
    retry: {
      type: "object",
      title: "Retry policy",
      properties: {
        initialSeconds: {
          type: "number",
          title: "Initial retry delay (seconds)",
          default: 10,
        },
        maxSeconds: {
          type: "number",
          title: "Maximum retry delay (seconds)",
          default: 1800,
        },
        multiplier: {
          type: "number",
          title: "Backoff multiplier",
          default: 2,
        },
        jitter: {
          type: "number",
          title: "Jitter (0-1)",
          default: 0.2,
        },
      },
    },
    defaults: {
      type: "object",
      title: "Default alert policy",
      description:
        "Fallback policy for discovered Signal K definitions without a dashboard override.",
      properties: {
        enabled: {
          type: "boolean",
          title: "Send remote notifications by default",
          description:
            "Newly discovered alerts inherit this value until their Settings are changed in the Alert center.",
          default: true,
        },
        minSeverity: {
          type: "string",
          title: "Lowest severity sent by default",
          description:
            "New alerts do not send remote notifications until they reach this Signal K severity.",
          enum: [...severities],
          default: "warn",
        },
        activationDelaySeconds: {
          type: "number",
          minimum: 0,
          title: "Default wait before sending (seconds)",
          description:
            "How long a new alert must remain active before its first remote notification is created.",
          default: 0,
        },
        rearmAfterSeconds: {
          type: "number",
          minimum: 0,
          title: "Default repeat interval while active (seconds)",
          description:
            "Starts a new occurrence after this interval when an alert never clears. Leave empty to disable repeating.",
        },
        connectivity: {
          type: "object",
          title: "Default Internet connection behavior",
          description:
            "Choose whether new alerts wait for an existing connection or request the configured connection to wake.",
          properties: {
            mode: {
              type: "string",
              title: "Connection action",
              description:
                "Queue waits for connectivity, wake starts it immediately, and wake after waits before starting it.",
              enum: ["queue", "wake", "wake_after"],
              default: "queue",
            },
            delaySeconds: {
              type: "number",
              minimum: 0,
              title: "Wait before waking (seconds)",
              description:
                "Used only with wake after. The alert must remain active for this long before connectivity is requested.",
            },
          },
          required: ["mode"],
        },
        notifiers: {
          type: "array",
          title: "Services used by default",
          description:
            "Enter the service names that new alerts should use. You can change this later in each alert's Settings.",
          uniqueItems: true,
          items: {
            type: "string",
            title: "Service name",
          },
        },
      },
    },
    notifiers: {
      type: "array",
      title: "Notification services",
      description:
        "Add each ntfy, PagerDuty, or Discord connection once. Alerts select these connections by their service name.",
      default: [],
      items: {
        title: "Service type",
        oneOf: [
          {
            type: "object",
            title: "ntfy",
            additionalProperties: false,
            properties: {
              name: serviceName,
              type: serviceType("ntfy", "ntfy"),
              enabled: serviceEnabled,
              minSeverity: serviceMinimumSeverity,
              server: {
                type: "string",
                title: "ntfy server address",
                description:
                  "Base address of the ntfy server, for example https://ntfy.sh or your self-hosted server.",
                default: "https://ntfy.sh",
              },
              topic: {
                type: "string",
                title: "ntfy topic",
                description:
                  "Topic that receives the boat's notifications. Treat an unprotected topic name as public.",
              },
              token: {
                type: "string",
                title: "ntfy access token",
                description:
                  "Optional access token required by a protected ntfy topic.",
                format: "password",
              },
            },
            required: ["name", "type", "server", "topic"],
          },
          {
            type: "object",
            title: "PagerDuty",
            additionalProperties: false,
            properties: {
              name: serviceName,
              type: serviceType("pagerduty", "PagerDuty"),
              enabled: serviceEnabled,
              minSeverity: serviceMinimumSeverity,
              routingKey: {
                type: "string",
                title: "PagerDuty Events API integration key",
                description:
                  "Integration key from the PagerDuty service's Events API v2 integration.",
                format: "password",
              },
            },
            required: ["name", "type", "routingKey"],
          },
          {
            type: "object",
            title: "Discord",
            additionalProperties: false,
            properties: {
              name: serviceName,
              type: serviceType("discord", "Discord"),
              enabled: serviceEnabled,
              minSeverity: serviceMinimumSeverity,
              webhookUrl: {
                type: "string",
                title: "Discord channel webhook address",
                description:
                  "Webhook address created in the Discord channel that should receive alerts.",
                format: "password",
              },
            },
            required: ["name", "type", "webhookUrl"],
          },
        ],
      },
    },
    connectivity: {
      type: "object",
      title: "Connectivity manager (e.g. Starlink)",
      properties: {
        enabled: { type: "boolean", title: "Enabled", default: false },
        switch: {
          type: "object",
          title: "Signal K switch",
          properties: {
            path: {
              type: "string",
              title: "Switch path",
              default: "electrical.switches.starlink.state",
            },
            onValue: { type: "number", title: "ON value", default: 1 },
            offValue: { type: "number", title: "OFF value", default: 0 },
          },
          required: ["path"],
        },
        probe: {
          type: "object",
          title: "Internet reachability probe",
          description:
            "The plugin sends an HTTP HEAD request and considers any 2xx response online. Use a lightweight public endpoint that works without authentication.",
          properties: {
            url: {
              type: "string",
              title: "Internet check URL",
              description:
                "URL that accepts HEAD requests and returns a 2xx response when the Internet is reachable.",
              default: "https://www.gstatic.com/generate_204",
            },
            timeoutSeconds: {
              type: "number",
              title: "Timeout (seconds)",
              default: 10,
            },
          },
          required: ["url"],
        },
        bootTimeoutSeconds: {
          type: "number",
          title: "Boot timeout (seconds)",
          default: 240,
        },
        internetCheckIntervalSeconds: {
          type: "number",
          title: "Internet check interval (seconds)",
          default: 5,
        },
        idleCooldownSeconds: {
          type: "number",
          title: "Idle cooldown before shutdown (seconds)",
          default: 300,
        },
      },
    },
  },
};

// Signal K passes this to its configuration form renderer.
export const pluginUiSchema = {
  "ui:order": ["*", "maintenance"],
  notifiers: {
    items: {
      type: { "ui:widget": "hidden" },
    },
  },
};
