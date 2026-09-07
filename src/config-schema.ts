import { severities } from "./alerts/types";

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
          default: "/home/node/.signalk/persistent-notifier.sqlite",
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
        enabled: { type: "boolean", title: "Enabled", default: true },
        oneTime: { type: "boolean", title: "One-time occurrence" },
        minSeverity: {
          type: "string",
          title: "Minimum severity",
          enum: [...severities],
          default: "warn",
        },
        activationDelaySeconds: {
          type: "number",
          minimum: 0,
          title: "Must remain active before notifying (seconds)",
          default: 0,
        },
        rearmAfterSeconds: {
          type: "number",
          minimum: 0,
          title: "One-time rearm interval (seconds)",
        },
        connectivity: {
          type: "object",
          title: "Connectivity behavior",
          properties: {
            mode: {
              type: "string",
              enum: ["queue", "wake", "wake_after"],
              default: "queue",
            },
            delaySeconds: { type: "number", minimum: 0 },
          },
          required: ["mode"],
        },
        notifiers: {
          type: "array",
          title: "Default notifier IDs",
          uniqueItems: true,
          items: { type: "string" },
        },
      },
    },
    notifiers: {
      type: "object",
      title: "Notifiers",
      description:
        "Global notifier connections and credentials. Select these notifier IDs per alert in the Alert center.",
      additionalProperties: {
        type: "object",
        title: "Notifier",
        properties: {
          type: {
            type: "string",
            title: "Type",
            enum: ["ntfy", "pagerduty", "discord"],
          },
          enabled: { type: "boolean", title: "Enabled", default: true },
          minSeverity: {
            type: "string",
            title: "Global minimum severity",
            description:
              "This notifier never sends alerts below this severity, even when selected for an alert.",
            enum: [...severities],
            default: "normal",
          },
          server: { type: "string", title: "ntfy server URL" },
          topic: { type: "string", title: "ntfy topic" },
          token: { type: "string", title: "ntfy token (optional)" },
          routingKey: { type: "string", title: "PagerDuty routing key" },
          webhookUrl: { type: "string", title: "Discord webhook URL" },
        },
        required: ["type"],
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
          properties: {
            url: {
              type: "string",
              title: "Probe URL",
              default: "https://example.com/generate_204",
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
