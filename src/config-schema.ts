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
    notifiers: {
      type: "object",
      title: "Notifiers",
      description:
        "Each key is a notifier ID referenced by rules. Only fill in the fields for the chosen type.",
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
          server: { type: "string", title: "ntfy server URL" },
          topic: { type: "string", title: "ntfy topic" },
          token: { type: "string", title: "ntfy token (optional)" },
          routingKey: { type: "string", title: "PagerDuty routing key" },
          webhookUrl: { type: "string", title: "Discord webhook URL" },
        },
        required: ["type"],
      },
    },
    rules: {
      type: "array",
      title: "Rules",
      items: {
        type: "object",
        properties: {
          id: { type: "string", title: "Rule ID" },
          name: { type: "string", title: "Name" },
          zone: { type: "string", title: "Zone" },
          oneTime: { type: "boolean", title: "One-time alert", default: false },
          enabled: { type: "boolean", title: "Enabled", default: true },
          match: {
            type: "string",
            title: "Signal K path match (glob)",
            default: "notifications.*",
          },
          minSeverity: {
            type: "string",
            title: "Minimum severity",
            enum: [...severities],
          },
          connectivity: {
            type: "object",
            title: "Connectivity behavior",
            properties: {
              mode: {
                type: "string",
                title: "Mode",
                enum: ["queue", "wake", "wake_after"],
              },
              delaySeconds: {
                type: "number",
                title: "Delay before waking (seconds, wake_after only)",
              },
            },
            required: ["mode"],
          },
          notifiers: {
            type: "array",
            title: "Notifier IDs to use",
            items: { type: "string" },
          },
        },
        required: ["match", "minSeverity", "connectivity", "notifiers"],
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
