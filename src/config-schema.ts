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
const serviceType = {
  type: "string",
  title: "Service type",
  description:
    "Choose where this service sends notifications. The matching connection fields appear below.",
  enum: ["ntfy", "pagerduty", "discord"],
  enumNames: ["ntfy", "PagerDuty", "Discord"],
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
        type: "object",
        properties: {
          name: serviceName,
          type: serviceType,
          enabled: serviceEnabled,
          minSeverity: serviceMinimumSeverity,
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
            ],
          },
        },
      },
    },
    audio: {
      type: "object",
      title: "Local audio playback",
      description:
        "Plays built-in alert sounds on the Signal K server. Playback is server-side and does not require the Alert center to be open.",
      properties: {
        enabled: {
          type: "boolean",
          title: "Enable local audio playback",
          description:
            "Allows alerts with local sound enabled in their Alert center settings to use the server's audio output.",
          default: false,
        },
        backend: {
          type: "string",
          title: "Audio player",
          description:
            "Auto uses afplay on macOS, or PulseAudio then ALSA on Linux. Choose a specific player when auto detection is unsuitable.",
          enum: ["auto", "aplay", "paplay", "afplay"],
          enumNames: [
            "Automatic",
            "ALSA (aplay)",
            "PulseAudio (paplay)",
            "macOS (afplay)",
          ],
          default: "auto",
        },
        outputDevice: {
          type: "string",
          maxLength: 128,
          title: "Output device",
          description:
            "Optional ALSA or PulseAudio device name. Leave empty to use the server's default audio output.",
        },
        masterVolume: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          title: "Master volume (percent)",
          description:
            "Applied while the plugin generates its built-in sounds. This does not change the operating system mixer.",
          default: 80,
        },
        testSoundOnSave: {
          type: "boolean",
          title: "Play a test chime when saving",
          description:
            "One-shot test of the selected player and output. The checkbox turns itself off after the test and the result is written to the Signal K log.",
          default: false,
        },
        queueLimit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          title: "Maximum sounds processed per queue run",
          description:
            "Bounds work on small servers. Sounds play one at a time in occurrence order.",
          default: 25,
        },
        playbackTimeoutSeconds: {
          type: "integer",
          minimum: 1,
          title: "Playback timeout (seconds)",
          description: "Stops a stuck audio-player process after this time.",
          default: 30,
        },
        failureRetrySeconds: {
          type: "integer",
          minimum: 1,
          title: "Retry delay after playback failure (seconds)",
          default: 30,
        },
        maxAttempts: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          title: "Maximum attempts per queued sound",
          description:
            "After this many failures the sound is marked failed in alert history. Remote notification delivery continues independently.",
          default: 3,
        },
        beforePlaybackCommand: {
          type: "object",
          title: "Command before each sound",
          description:
            "Optional server command that must finish successfully before each sound starts. Use it to pause music, enable an amplifier, or change a mixer. Enter the executable and each argument separately; shell expressions are not evaluated.",
          properties: {
            executable: {
              type: "string",
              maxLength: 512,
              title: "Executable",
              description:
                "Program available to the Signal K process, for example /usr/bin/mpc or /usr/local/bin/amplifier-on.",
            },
            arguments: {
              type: "array",
              maxItems: 32,
              title: "Arguments",
              description:
                "Optional arguments in order. Add one list item per argument, for example pause. Do not include the executable here.",
              items: { type: "string", maxLength: 2048 },
            },
          },
        },
        afterPlaybackCommand: {
          type: "object",
          title: "Command after each sound",
          description:
            "Optional cleanup command run after every attempted sound, including failed or cancelled playback. A failure is logged but does not replay a sound that already completed.",
          properties: {
            executable: {
              type: "string",
              maxLength: 512,
              title: "Executable",
              description:
                "Program available to the Signal K process, for example /usr/bin/mpc or /usr/local/bin/amplifier-off.",
            },
            arguments: {
              type: "array",
              maxItems: 32,
              title: "Arguments",
              description:
                "Optional arguments in order. Add one list item per argument, for example play. Do not include the executable here.",
              items: { type: "string", maxLength: 2048 },
            },
          },
        },
        sessionStartCommand: {
          type: "object",
          title: "Command when audio becomes active",
          description:
            "Optional server command run once before the first sound in an audio session. Configure it together with the stop command. Use this for hardware that should stay on across queued or repeating alerts, such as an amplifier.",
          properties: {
            executable: {
              type: "string",
              maxLength: 512,
              title: "Start executable",
              description:
                "Program available to the Signal K process, for example /usr/local/bin/amplifier-on.",
            },
            arguments: {
              type: "array",
              maxItems: 32,
              title: "Start arguments",
              description:
                "Optional arguments in order. Add one list item per argument; shell expressions are not evaluated.",
              items: { type: "string", maxLength: 2048 },
            },
          },
        },
        sessionStopCommand: {
          type: "object",
          title: "Command when audio becomes idle",
          description:
            "Optional server command run after the audio queue has stayed idle for the cooldown. Configure it together with the start command. New playback during the cooldown keeps the current session active.",
          properties: {
            executable: {
              type: "string",
              maxLength: 512,
              title: "Stop executable",
              description:
                "Program available to the Signal K process, for example /usr/local/bin/amplifier-off.",
            },
            arguments: {
              type: "array",
              maxItems: 32,
              title: "Stop arguments",
              description:
                "Optional arguments in order. Add one list item per argument; shell expressions are not evaluated.",
              items: { type: "string", maxLength: 2048 },
            },
          },
        },
        sessionIdleCooldownSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          title: "Audio session idle cooldown (seconds)",
          description:
            "How long to keep session-managed hardware active after a sound ends. Another sound during this period cancels the pending stop.",
          default: 30,
        },
        commandTimeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 300,
          title: "Command timeout (seconds)",
          description:
            "Stops a per-sound or audio-session command that does not finish within this time.",
          default: 10,
        },
        customSounds: {
          type: "array",
          title: "Custom sounds",
          description:
            "Register WAV files once so they appear by name in every alert's Sound list. Relative paths start in Signal K's data directory; absolute paths are also supported.",
          default: [],
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                minLength: 1,
                maxLength: 64,
                pattern: "^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$",
                title: "Sound name",
                description:
                  "Unique name shown in alert settings, for example Ship bell or Anchor alarm.",
              },
              filePath: {
                type: "string",
                minLength: 5,
                maxLength: 1024,
                pattern: "\\.[Ww][Aa][Vv]$",
                title: "WAV file path",
                description:
                  "Path visible to the Signal K process. For example sounds/ship-bell.wav uses the sounds folder inside Signal K's data directory.",
              },
            },
            required: ["name", "filePath"],
          },
        },
        quietHours: {
          type: "object",
          title: "Quiet hours",
          description:
            "Optional local-time window that postpones queued sounds. Alerts remain stored and remote notifications continue.",
          properties: {
            enabled: {
              type: "boolean",
              title: "Enable quiet hours",
              default: false,
            },
            start: {
              type: "string",
              title: "Quiet hours start (HH:MM)",
              default: "22:00",
              pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
            },
            end: {
              type: "string",
              title: "Quiet hours end (HH:MM)",
              default: "07:00",
              pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
            },
          },
        },
        defaults: {
          type: "object",
          title: "Default local sound policy",
          description:
            "Newly discovered alerts inherit these values until their local sound settings are changed in the Alert center. Their sound automatically follows severity: chime for warn, warning for alert, alarm for alarm, and emergency for emergency.",
          properties: {
            enabled: {
              type: "boolean",
              title: "Play local sound by default",
              default: false,
            },
            minimumSeverity: {
              type: "string",
              title: "Lowest severity that plays",
              enum: [...severities],
              default: "warn",
            },
            mode: {
              type: "string",
              title: "Playback behavior",
              enum: ["once", "repeat"],
              enumNames: ["Play once", "Repeat while active"],
              default: "once",
            },
            repeatIntervalSeconds: {
              type: "integer",
              minimum: 1,
              title: "Repeat interval (seconds)",
              default: 60,
            },
            stopOn: {
              type: "object",
              title: "Stop playback when",
              properties: {
                clear: {
                  type: "boolean",
                  title: "Alert clears",
                  default: true,
                },
                acknowledge: {
                  type: "boolean",
                  title: "Alert is acknowledged",
                  default: true,
                },
                silence: {
                  type: "boolean",
                  title: "Alert is silenced",
                  default: true,
                },
                dismiss: {
                  type: "boolean",
                  title: "Alert is dismissed",
                  default: true,
                },
              },
            },
          },
        },
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
};
