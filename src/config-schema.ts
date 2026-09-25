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
const serviceRepeatInterval = {
  type: "integer",
  minimum: 0,
  maximum: 31536000,
  title: "Repeat while the alert remains active (seconds)",
  description:
    "After this service delivers successfully, send through it again after this many seconds while the alert remains active. Leave empty or use 0 to send once.",
};
const serviceType = {
  type: "string",
  title: "Service type",
  description:
    "Choose where this service sends notifications. The matching connection fields appear below.",
  enum: ["ntfy", "pagerduty", "discord", "telegram", "wyoming"],
  enumNames: [
    "ntfy",
    "PagerDuty",
    "Discord",
    "Telegram",
    "Signal K Wyoming speech",
  ],
  default: "ntfy",
};

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
          default: "alert-center.sqlite",
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
    ingestion: {
      type: "object",
      title: "Signal K notification ingestion",
      description:
        "Bounds work retained when notifications arrive faster than they can be persisted. Equivalent pending updates are safely combined; alert state, severity, and message transitions keep their order.",
      properties: {
        queueLimit: {
          type: "integer",
          minimum: 10,
          maximum: 100000,
          title: "Maximum queued notification updates",
          description:
            "Hard memory-safety limit for pending Signal K notification updates. Reaching it produces an error and diagnostic counter instead of consuming memory without a bound.",
          default: 2000,
        },
        batchSize: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          title: "Notification updates processed per turn",
          description:
            "Limits synchronous database work before the plugin yields control back to Signal K.",
          default: 100,
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
        requestTimeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 300,
          title: "Notification service timeout (seconds)",
          description:
            "Cancels a notification service request that has not completed within this time so stalled networks cannot retain work indefinitely.",
          default: 15,
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
          title: "Deliver notifications by default",
          description:
            "Newly discovered alerts inherit this value until their Settings are changed in the Alert center. This covers remote services and Wyoming speech.",
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
        connectivity: {
          type: "object",
          title: "When internet is unavailable by default",
          description:
            "Choose whether new alerts stay queued for an existing internet connection or ask Alert Center to turn on the configured connection.",
          properties: {
            mode: {
              type: "string",
              title: "Action while a remote notification is waiting",
              description:
                "Turning a connection on also requires Internet connection control to be enabled.",
              enum: ["queue", "wake", "wake_after"],
              enumNames: [
                "Keep queued until internet is available",
                "Turn on the configured connection immediately",
                "Wait, then turn on the configured connection",
              ],
              default: "queue",
            },
            delaySeconds: {
              type: "number",
              minimum: 0,
              title: "Delay before turning on the connection (seconds)",
              description:
                "Used only with the delayed option. The alert must remain active for this long before Alert Center requests the connection.",
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
        speechMinimumSeverity: {
          type: "string",
          title: "Lowest severity spoken by default",
          description:
            "Applies only to selected Signal K Wyoming speech services. A service's own severity floor can still require a higher level.",
          enum: [...severities],
          default: "warn",
        },
        speechTemplate: {
          type: "string",
          title: "Default spoken alert text",
          description:
            "Template passed to signalk-wyoming. Available placeholders: {name}, {severity}, {message}, {path}, and {state}. Maximum 500 characters.",
          minLength: 1,
          maxLength: 500,
          default: "{name}. {severity}. {message}",
        },
        speechAnnounceClear: {
          type: "boolean",
          title: "Announce clears by default",
          description:
            "When enabled, selected Wyoming speech services also say when an alert clears.",
          default: false,
        },
      },
    },
    notifiers: {
      type: "array",
      title: "Notification services",
      description:
        "Optionally add each ntfy, PagerDuty, Discord, Telegram, or Signal K Wyoming speech service once. Alert Center works without any notification service. Alerts select configured services by name.",
      default: [],
      items: {
        type: "object",
        properties: {
          name: serviceName,
          type: serviceType,
          enabled: serviceEnabled,
          minSeverity: serviceMinimumSeverity,
          repeatIntervalSeconds: serviceRepeatInterval,
        },
        required: ["name", "type"],
        dependencies: {
          type: {
            oneOf: [
              {
                properties: {
                  type: { enum: ["ntfy"] },
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
                required: ["server", "topic"],
              },
              {
                properties: {
                  type: { enum: ["pagerduty"] },
                  routingKey: {
                    type: "string",
                    title: "PagerDuty Events API integration key",
                    description:
                      "Integration key from the PagerDuty service's Events API v2 integration.",
                    format: "password",
                  },
                },
                required: ["routingKey"],
              },
              {
                properties: {
                  type: { enum: ["discord"] },
                  webhookUrl: {
                    type: "string",
                    title: "Discord channel webhook address",
                    description:
                      "Webhook address created in the Discord channel that should receive alerts.",
                    format: "password",
                  },
                },
                required: ["webhookUrl"],
              },
              {
                properties: {
                  type: { enum: ["telegram"] },
                  botToken: {
                    type: "string",
                    title: "Telegram bot token",
                    description:
                      "Bot token created by BotFather. Alert Center uses it only for Telegram Bot API requests.",
                    format: "password",
                  },
                  chatId: {
                    type: "string",
                    title: "Telegram chat ID",
                    description:
                      "Numeric chat ID or public channel username such as @boat_alerts.",
                  },
                  messageThreadId: {
                    type: "integer",
                    minimum: 1,
                    title: "Telegram topic ID",
                    description:
                      "Optional message-thread ID for a topic inside a forum supergroup.",
                  },
                  disableNotification: {
                    type: "boolean",
                    title: "Send silently",
                    description:
                      "Deliver Telegram messages without a notification sound.",
                    default: false,
                  },
                },
                required: ["botToken", "chatId"],
              },
              {
                properties: {
                  type: { enum: ["wyoming"] },
                  targets: {
                    type: "array",
                    title: "Wyoming satellite targets",
                    description:
                      "Optional signalk-wyoming satellite IDs. Leave empty to speak on all configured satellites.",
                    uniqueItems: true,
                    items: {
                      type: "string",
                      minLength: 1,
                      title: "Satellite ID",
                    },
                  },
                  voice: {
                    type: "string",
                    title: "Piper voice override",
                    description:
                      "Optional voice name. Leave empty to use the default configured in signalk-wyoming.",
                  },
                  urgentAt: {
                    type: "string",
                    title: "Urgent playback starts at",
                    description:
                      "Alerts at or above this severity interrupt normal playback and bypass signalk-wyoming mute.",
                    enum: [...severities],
                    default: "alarm",
                  },
                },
              },
            ],
          },
        },
      },
    },
    connectivity: {
      type: "object",
      title: "Internet connection control (for example Starlink)",
      description:
        "Optional. Alert Center can turn a Signal K-controlled connection on when notifications need internet access. It turns the connection off only when it originally turned it on.",
      properties: {
        enabled: {
          type: "boolean",
          title: "Allow Alert Center to control the internet connection",
          default: false,
        },
        switch: {
          type: "object",
          title: "Signal K connection switch",
          description:
            "The Signal K path and values used to turn the connection on and off.",
          properties: {
            path: {
              type: "string",
              title: "Connection switch path",
              default: "electrical.switches.starlink.state",
            },
            onValue: {
              type: "number",
              title: "Value that turns the connection on",
              default: 1,
            },
            offValue: {
              type: "number",
              title: "Value that turns the connection off",
              default: 0,
            },
          },
          required: ["path"],
        },
        probe: {
          type: "object",
          title: "Internet availability check",
          description:
            "The plugin sends an HTTP HEAD request and considers any 2xx response online. Use a lightweight public endpoint that works without authentication.",
          properties: {
            url: {
              type: "string",
              title: "Internet availability check URL",
              description:
                "URL that accepts HEAD requests and returns a 2xx response when the Internet is reachable.",
              default: "https://www.gstatic.com/generate_204",
            },
            timeoutSeconds: {
              type: "number",
              title: "Give up on each check after (seconds)",
              default: 10,
            },
          },
          required: ["url"],
        },
        bootTimeoutSeconds: {
          type: "number",
          title: "Give up waiting after turning the connection on (seconds)",
          default: 240,
        },
        internetCheckIntervalSeconds: {
          type: "number",
          title: "Check for internet every (seconds)",
          default: 5,
        },
        idleCooldownSeconds: {
          type: "number",
          title: "Turn off an Alert Center-started connection after (seconds)",
          description:
            "The timer starts when no notification or scheduled connection request still needs it. Use 0 to turn it off immediately.",
          default: 300,
        },
      },
    },
  },
};

// Signal K passes this to its configuration form renderer.
export const pluginUiSchema = {
  "ui:order": ["*", "maintenance"],
};
