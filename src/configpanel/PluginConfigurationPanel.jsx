import React, { useEffect, useMemo, useRef, useState } from "react";

const severityOptions = ["normal", "warn", "alert", "alarm", "emergency"];
const notifierTypes = [
  { value: "ntfy", label: "ntfy" },
  { value: "pagerduty", label: "PagerDuty" },
  { value: "discord", label: "Discord" },
  { value: "wyoming", label: "Signal K Wyoming speech" },
];
const tabs = [
  ["defaults", "Alert defaults"],
  ["services", "Notification services"],
  ["connectivity", "Connectivity"],
  ["advanced", "Storage & advanced"],
];

const defaults = {
  storage: { path: "alert-center.sqlite" },
  discovery: { zoneRefreshSeconds: 300 },
  ingestion: { queueLimit: 2000, batchSize: 100 },
  delivery: { batchSize: 50, concurrency: 4, requestTimeoutSeconds: 15 },
  retention: {
    enabled: false,
    maxAgeDays: 365,
    batchSize: 100,
    intervalHours: 24,
  },
  retry: { initialSeconds: 10, maxSeconds: 1800, multiplier: 2, jitter: 0.2 },
  defaults: {
    enabled: true,
    minSeverity: "warn",
    activationDelaySeconds: 0,
    connectivity: { mode: "queue" },
    notifiers: [],
    speechMinimumSeverity: "warn",
    speechTemplate: "{name}. {severity}. {message}",
    speechAnnounceClear: false,
  },
  notifiers: [],
  connectivity: {
    enabled: false,
    switch: {
      path: "electrical.switches.starlink.state",
      onValue: 1,
      offValue: 0,
    },
    probe: { url: "https://www.gstatic.com/generate_204", timeoutSeconds: 10 },
    bootTimeoutSeconds: 240,
    internetCheckIntervalSeconds: 5,
    idleCooldownSeconds: 300,
  },
};

const clone = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const merge = (base, value) => {
  const result = clone(base);
  for (const [key, item] of Object.entries(value ?? {})) {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    )
      result[key] = merge(result[key], item);
    else result[key] = clone(item);
  }
  return result;
};
const initialConfig = (configuration) => merge(defaults, configuration);

const colors = {
  ink: "#17232a",
  muted: "#62727b",
  line: "#d6e1e5",
  soft: "#f4f8f9",
  brand: "#087f83",
  brandDark: "#075e61",
  danger: "#b42318",
};
const styles = {
  root: {
    color: colors.ink,
    fontFamily:
      "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    maxWidth: 1040,
    margin: "0 auto",
    padding: "20px clamp(12px, 3vw, 32px) 40px",
  },
  header: { marginBottom: 18 },
  title: { margin: "0 0 4px", fontSize: 26, lineHeight: 1.2 },
  subtitle: { color: colors.muted, margin: 0, lineHeight: 1.5 },
  tabs: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    padding: 5,
    borderRadius: 10,
    background: "#eaf1f3",
    marginBottom: 18,
  },
  tab: {
    border: 0,
    borderRadius: 7,
    padding: "9px 13px",
    cursor: "pointer",
    fontWeight: 650,
    color: "#3c4c54",
    background: "transparent",
  },
  activeTab: {
    color: colors.brandDark,
    background: "white",
    boxShadow: "0 1px 3px rgba(20, 40, 48, .14)",
  },
  card: {
    background: "white",
    border: `1px solid ${colors.line}`,
    borderRadius: 12,
    padding: "18px clamp(14px, 2.5vw, 24px)",
    marginBottom: 14,
    boxShadow: "0 1px 2px rgba(20, 40, 48, .04)",
  },
  sectionTitle: { margin: "0 0 3px", fontSize: 18 },
  sectionHelp: { color: colors.muted, margin: "0 0 16px", lineHeight: 1.45 },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "15px 20px",
  },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontWeight: 650, fontSize: 14 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 1.4 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    minHeight: 40,
    border: `1px solid ${colors.line}`,
    borderRadius: 7,
    padding: "8px 10px",
    color: colors.ink,
    background: "white",
    fontSize: 14,
  },
  checkbox: { width: 18, height: 18, accentColor: colors.brand },
  checkLabel: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    fontWeight: 650,
  },
  primary: {
    border: 0,
    borderRadius: 7,
    background: colors.brand,
    color: "white",
    padding: "10px 16px",
    fontWeight: 700,
    cursor: "pointer",
  },
  secondary: {
    border: `1px solid ${colors.line}`,
    borderRadius: 7,
    background: "white",
    color: colors.ink,
    padding: "8px 12px",
    fontWeight: 650,
    cursor: "pointer",
  },
  danger: {
    border: `1px solid #f0aaa4`,
    borderRadius: 7,
    background: "#fff7f6",
    color: colors.danger,
    padding: "9px 13px",
    fontWeight: 700,
    cursor: "pointer",
  },
  actions: {
    position: "sticky",
    bottom: 0,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    padding: "12px 0",
    background: "rgba(255,255,255,.94)",
    backdropFilter: "blur(8px)",
  },
};

function Field({ label, hint, children, full = false }) {
  return (
    <label
      style={{ ...styles.field, ...(full ? { gridColumn: "1 / -1" } : {}) }}
    >
      <span style={styles.label}>{label}</span>
      {children}
      {hint && <span style={styles.hint}>{hint}</span>}
    </label>
  );
}

function NumberField({ label, hint, value, min, max, step = 1, onChange }) {
  return (
    <Field label={label} hint={hint}>
      <input
        style={styles.input}
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        onChange={(event) =>
          onChange(
            event.target.value === "" ? undefined : Number(event.target.value),
          )
        }
      />
    </Field>
  );
}

function Card({ title, help, children }) {
  return (
    <section style={styles.card}>
      <h2 style={styles.sectionTitle}>{title}</h2>
      {help && <p style={styles.sectionHelp}>{help}</p>}
      {children}
    </section>
  );
}

function ServicePicker({ services, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    const close = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const names = services.map((item) => item.name).filter(Boolean);
  const value = selected.filter((name) => names.includes(name));
  return (
    <div ref={root} style={{ position: "relative" }}>
      <button
        type="button"
        style={{ ...styles.input, textAlign: "left", cursor: "pointer" }}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        {value.length ? value.join(", ") : "No services selected"}
        <span style={{ float: "right" }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            zIndex: 20,
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            padding: 8,
            border: `1px solid ${colors.line}`,
            borderRadius: 8,
            background: "white",
            boxShadow: "0 8px 24px rgba(20,40,48,.16)",
          }}
        >
          {services.length === 0 ? (
            <div style={{ color: colors.muted, padding: 8 }}>
              Add a notification service first.
            </div>
          ) : (
            services.map((service) => (
              <label
                key={service.name}
                style={{
                  display: "flex",
                  gap: 9,
                  alignItems: "center",
                  padding: 8,
                }}
              >
                <input
                  type="checkbox"
                  style={styles.checkbox}
                  checked={value.includes(service.name)}
                  onChange={() =>
                    onChange(
                      value.includes(service.name)
                        ? value.filter((name) => name !== service.name)
                        : [...value, service.name],
                    )
                  }
                />
                <span>
                  {service.name || "Unnamed service"}{" "}
                  <small style={{ color: colors.muted }}>
                    (
                    {notifierTypes.find((item) => item.value === service.type)
                      ?.label ?? service.type}
                    )
                  </small>
                </span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function AlertDefaults({ config, update }) {
  const policy = config.defaults;
  const set = (patch) => update("defaults", { ...policy, ...patch });
  return (
    <>
      <Card
        title="Defaults for newly discovered alerts"
        help="Each alert starts with these values. You can override them later from that alert's detail window."
      >
        <div style={{ ...styles.grid, marginBottom: 16 }}>
          <label style={styles.checkLabel}>
            <input
              style={styles.checkbox}
              type="checkbox"
              checked={policy.enabled !== false}
              onChange={(event) => set({ enabled: event.target.checked })}
            />
            Send notifications by default
          </label>
        </div>
        <div style={styles.grid}>
          <Field
            label="Default notification services"
            hint="Select the configured services that a new alert should use."
          >
            <ServicePicker
              services={config.notifiers}
              selected={policy.notifiers ?? []}
              onChange={(notifiers) => set({ notifiers })}
            />
          </Field>
          <Field
            label="Lowest severity sent"
            hint="Alerts below this level stay in history but are not sent."
          >
            <select
              style={styles.input}
              value={policy.minSeverity ?? "warn"}
              onChange={(event) => set({ minSeverity: event.target.value })}
            >
              {severityOptions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <NumberField
            label="Wait before sending (seconds)"
            hint="The alert must stay active for this long before it is sent."
            min={0}
            value={policy.activationDelaySeconds}
            onChange={(activationDelaySeconds) =>
              set({ activationDelaySeconds })
            }
          />
          <NumberField
            label="Repeat while active (seconds)"
            hint="Leave empty to create only one occurrence until the alert clears."
            min={0}
            value={policy.rearmAfterSeconds}
            onChange={(rearmAfterSeconds) => set({ rearmAfterSeconds })}
          />
          <Field label="Internet connection behavior">
            <select
              style={styles.input}
              value={policy.connectivity?.mode ?? "queue"}
              onChange={(event) =>
                set({
                  connectivity: {
                    ...policy.connectivity,
                    mode: event.target.value,
                  },
                })
              }
            >
              <option value="queue">Wait until already online</option>
              <option value="wake">Start connectivity immediately</option>
              <option value="wake_after">
                Start connectivity after a delay
              </option>
            </select>
          </Field>
          {policy.connectivity?.mode === "wake_after" && (
            <NumberField
              label="Wait before starting connectivity (seconds)"
              min={0}
              value={policy.connectivity?.delaySeconds}
              onChange={(delaySeconds) =>
                set({ connectivity: { ...policy.connectivity, delaySeconds } })
              }
            />
          )}
        </div>
      </Card>
      {config.notifiers.some((service) => service.type === "wyoming") && (
        <Card
          title="Spoken alert defaults"
          help="These values apply to selected Signal K Wyoming speech services. Individual alerts can override them."
        >
          <div style={styles.grid}>
            <Field label="Lowest severity spoken">
              <select
                style={styles.input}
                value={policy.speechMinimumSeverity ?? "warn"}
                onChange={(event) =>
                  set({ speechMinimumSeverity: event.target.value })
                }
              >
                {severityOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Spoken alert text"
              hint="Available placeholders: {name}, {severity}, {message}, {path}, and {state}."
              full
            >
              <input
                style={styles.input}
                value={policy.speechTemplate ?? ""}
                maxLength={500}
                onChange={(event) =>
                  set({ speechTemplate: event.target.value })
                }
              />
            </Field>
            <label style={styles.checkLabel}>
              <input
                style={styles.checkbox}
                type="checkbox"
                checked={policy.speechAnnounceClear === true}
                onChange={(event) =>
                  set({ speechAnnounceClear: event.target.checked })
                }
              />
              Announce when an alert clears
            </label>
          </div>
        </Card>
      )}
    </>
  );
}

const emptyService = () => ({
  name: "",
  type: "ntfy",
  enabled: true,
  minSeverity: "normal",
  server: "https://ntfy.sh",
  topic: "",
});

function NotificationServices({ config, update }) {
  const change = (index, patch, replace = false) => {
    const items = [...config.notifiers];
    const old = items[index];
    items[index] = replace ? patch : { ...old, ...patch };
    update("notifiers", items);
    if (patch.name !== undefined && old.name && old.name !== patch.name)
      update("defaults", {
        ...config.defaults,
        notifiers: (config.defaults.notifiers ?? []).map((name) =>
          name === old.name ? patch.name : name,
        ),
      });
  };
  const remove = (index) => {
    const removed = config.notifiers[index];
    update(
      "notifiers",
      config.notifiers.filter((_, itemIndex) => itemIndex !== index),
    );
    update("defaults", {
      ...config.defaults,
      notifiers: (config.defaults.notifiers ?? []).filter(
        (name) => name !== removed.name,
      ),
    });
  };
  return (
    <Card
      title="Notification services"
      help="Configure a destination once, then select it in the global defaults or an individual alert."
    >
      {config.notifiers.length === 0 && (
        <p style={{ color: colors.muted }}>
          No notification services configured yet.
        </p>
      )}
      {config.notifiers.map((service, index) => (
        <div
          key={index}
          data-testid="notification-service"
          style={{
            borderTop: index ? `1px solid ${colors.line}` : 0,
            padding: "16px 0",
          }}
        >
          <div style={styles.grid}>
            <Field
              label="Service name"
              hint="A unique name shown when selecting services for an alert."
            >
              <input
                style={styles.input}
                value={service.name ?? ""}
                onChange={(event) =>
                  change(index, { name: event.target.value })
                }
                placeholder="Crew phone"
              />
            </Field>
            <Field label="Service type">
              <select
                style={styles.input}
                value={service.type ?? "ntfy"}
                onChange={(event) => {
                  const type = event.target.value;
                  const shared = {
                    name: service.name,
                    enabled: service.enabled,
                    minSeverity: service.minSeverity,
                    type,
                  };
                  if (type === "ntfy")
                    change(
                      index,
                      {
                        ...shared,
                        server: service.server ?? "https://ntfy.sh",
                        topic: service.topic ?? "",
                      },
                      true,
                    );
                  if (type === "pagerduty")
                    change(
                      index,
                      {
                        ...shared,
                        routingKey: service.routingKey ?? "",
                      },
                      true,
                    );
                  if (type === "discord")
                    change(
                      index,
                      {
                        ...shared,
                        webhookUrl: service.webhookUrl ?? "",
                      },
                      true,
                    );
                  if (type === "wyoming")
                    change(
                      index,
                      {
                        ...shared,
                        targets: service.targets ?? [],
                        voice: service.voice ?? "",
                        urgentAt: service.urgentAt ?? "alarm",
                      },
                      true,
                    );
                }}
              >
                {notifierTypes.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Lowest severity sent">
              <select
                style={styles.input}
                value={service.minSeverity ?? "normal"}
                onChange={(event) =>
                  change(index, { minSeverity: event.target.value })
                }
              >
                {severityOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <label style={{ ...styles.checkLabel, alignSelf: "center" }}>
              <input
                style={styles.checkbox}
                type="checkbox"
                checked={service.enabled !== false}
                onChange={(event) =>
                  change(index, { enabled: event.target.checked })
                }
              />
              Service enabled
            </label>
            {service.type === "ntfy" && (
              <>
                <Field label="ntfy server address">
                  <input
                    style={styles.input}
                    type="url"
                    value={service.server ?? ""}
                    onChange={(event) =>
                      change(index, { server: event.target.value })
                    }
                    placeholder="https://ntfy.sh"
                  />
                </Field>
                <Field label="ntfy topic">
                  <input
                    style={styles.input}
                    value={service.topic ?? ""}
                    onChange={(event) =>
                      change(index, { topic: event.target.value })
                    }
                  />
                </Field>
                <Field
                  label="Access token"
                  hint="Optional for protected topics."
                >
                  <input
                    style={styles.input}
                    type="password"
                    value={service.token ?? ""}
                    onChange={(event) =>
                      change(index, { token: event.target.value })
                    }
                  />
                </Field>
              </>
            )}
            {service.type === "pagerduty" && (
              <Field label="Events API integration key" full>
                <input
                  style={styles.input}
                  type="password"
                  value={service.routingKey ?? ""}
                  onChange={(event) =>
                    change(index, { routingKey: event.target.value })
                  }
                />
              </Field>
            )}
            {service.type === "discord" && (
              <Field label="Discord channel webhook address" full>
                <input
                  style={styles.input}
                  type="password"
                  value={service.webhookUrl ?? ""}
                  onChange={(event) =>
                    change(index, { webhookUrl: event.target.value })
                  }
                />
              </Field>
            )}
            {service.type === "wyoming" && (
              <>
                <Field
                  label="Satellite targets"
                  hint="Optional comma-separated signalk-wyoming satellite IDs. Leave empty for all satellites."
                  full
                >
                  <input
                    style={styles.input}
                    value={(service.targets ?? []).join(", ")}
                    onChange={(event) =>
                      change(index, {
                        targets: event.target.value
                          .split(",")
                          .map((target) => target.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="salon, cockpit"
                  />
                </Field>
                <Field
                  label="Piper voice override"
                  hint="Optional. Leave empty to use signalk-wyoming's configured voice."
                >
                  <input
                    style={styles.input}
                    value={service.voice ?? ""}
                    onChange={(event) =>
                      change(index, { voice: event.target.value })
                    }
                  />
                </Field>
                <Field
                  label="Urgent playback starts at"
                  hint="This severity and above interrupt normal playback and bypass mute."
                >
                  <select
                    style={styles.input}
                    value={service.urgentAt ?? "alarm"}
                    onChange={(event) =>
                      change(index, { urgentAt: event.target.value })
                    }
                  >
                    {severityOptions.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>
          <button
            type="button"
            style={{ ...styles.secondary, marginTop: 14 }}
            onClick={() => remove(index)}
          >
            Remove service
          </button>
        </div>
      ))}
      <button
        type="button"
        style={styles.secondary}
        onClick={() =>
          update("notifiers", [...config.notifiers, emptyService()])
        }
      >
        + Add notification service
      </button>
    </Card>
  );
}

function Connectivity({ config, update }) {
  const value = config.connectivity;
  const set = (patch) => update("connectivity", { ...value, ...patch });
  return (
    <Card
      title="Connectivity manager"
      help="Optionally let Alert Center start and stop a connection such as Starlink when deliveries are waiting."
    >
      <label style={{ ...styles.checkLabel, marginBottom: 18 }}>
        <input
          style={styles.checkbox}
          type="checkbox"
          checked={value.enabled === true}
          onChange={(event) => set({ enabled: event.target.checked })}
        />
        Manage connectivity for queued alerts
      </label>
      <div style={styles.grid}>
        <Field
          label="Signal K switch path"
          hint="Path that turns the connection on and off."
        >
          <input
            style={styles.input}
            value={value.switch?.path ?? ""}
            onChange={(event) =>
              set({ switch: { ...value.switch, path: event.target.value } })
            }
          />
        </Field>
        <NumberField
          label="Switch ON value"
          value={value.switch?.onValue}
          onChange={(onValue) => set({ switch: { ...value.switch, onValue } })}
        />
        <NumberField
          label="Switch OFF value"
          value={value.switch?.offValue}
          onChange={(offValue) =>
            set({ switch: { ...value.switch, offValue } })
          }
        />
        <Field
          label="Internet check URL"
          hint="Must accept HEAD and return a 2xx response."
        >
          <input
            style={styles.input}
            type="url"
            value={value.probe?.url ?? ""}
            onChange={(event) =>
              set({ probe: { ...value.probe, url: event.target.value } })
            }
          />
        </Field>
        <NumberField
          label="Internet check timeout (seconds)"
          min={1}
          value={value.probe?.timeoutSeconds}
          onChange={(timeoutSeconds) =>
            set({ probe: { ...value.probe, timeoutSeconds } })
          }
        />
        <NumberField
          label="Connection startup timeout (seconds)"
          min={1}
          value={value.bootTimeoutSeconds}
          onChange={(bootTimeoutSeconds) => set({ bootTimeoutSeconds })}
        />
        <NumberField
          label="Internet check interval (seconds)"
          min={1}
          value={value.internetCheckIntervalSeconds}
          onChange={(internetCheckIntervalSeconds) =>
            set({ internetCheckIntervalSeconds })
          }
        />
        <NumberField
          label="Idle time before shutdown (seconds)"
          min={0}
          value={value.idleCooldownSeconds}
          onChange={(idleCooldownSeconds) => set({ idleCooldownSeconds })}
        />
      </div>
    </Card>
  );
}

function Advanced({ config, update, resetDatabase, resetRequested }) {
  const section = (key, patch) => update(key, { ...config[key], ...patch });
  return (
    <>
      <Card
        title="Storage"
        help="Relative database paths are stored in Signal K's data directory."
      >
        <Field label="SQLite database file path">
          <input
            style={styles.input}
            value={config.storage.path ?? ""}
            onChange={(event) =>
              section("storage", { path: event.target.value })
            }
          />
        </Field>
      </Card>
      <Card
        title="History retention"
        help="Cleanup never removes active alerts or unfinished delivery work."
      >
        <label style={{ ...styles.checkLabel, marginBottom: 16 }}>
          <input
            style={styles.checkbox}
            type="checkbox"
            checked={config.retention.enabled === true}
            onChange={(event) =>
              section("retention", { enabled: event.target.checked })
            }
          />
          Automatically remove old completed history
        </label>
        <div style={styles.grid}>
          <NumberField
            label="Keep history for at least (days)"
            min={1}
            value={config.retention.maxAgeDays}
            onChange={(maxAgeDays) => section("retention", { maxAgeDays })}
          />
          <NumberField
            label="Maximum occurrences per cleanup"
            min={1}
            max={1000}
            value={config.retention.batchSize}
            onChange={(batchSize) => section("retention", { batchSize })}
          />
          <NumberField
            label="Cleanup interval (hours)"
            min={1}
            value={config.retention.intervalHours}
            onChange={(intervalHours) =>
              section("retention", { intervalHours })
            }
          />
        </div>
      </Card>
      <Card
        title="Performance and retry"
        help="The defaults are suitable for small onboard Signal K servers."
      >
        <div style={styles.grid}>
          <NumberField
            label="Zone refresh interval (seconds)"
            min={1}
            value={config.discovery.zoneRefreshSeconds}
            onChange={(zoneRefreshSeconds) =>
              section("discovery", { zoneRefreshSeconds })
            }
          />
          <NumberField
            label="Maximum queued alert updates"
            min={10}
            max={100000}
            value={config.ingestion.queueLimit}
            onChange={(queueLimit) => section("ingestion", { queueLimit })}
          />
          <NumberField
            label="Alert updates per processing turn"
            min={1}
            max={1000}
            value={config.ingestion.batchSize}
            onChange={(batchSize) => section("ingestion", { batchSize })}
          />
          <NumberField
            label="Deliveries checked per run"
            min={1}
            max={200}
            value={config.delivery.batchSize}
            onChange={(batchSize) => section("delivery", { batchSize })}
          />
          <NumberField
            label="Simultaneous notification sends"
            min={1}
            max={32}
            value={config.delivery.concurrency}
            onChange={(concurrency) => section("delivery", { concurrency })}
          />
          <NumberField
            label="Notification request timeout (seconds)"
            min={1}
            max={300}
            value={config.delivery.requestTimeoutSeconds}
            onChange={(requestTimeoutSeconds) =>
              section("delivery", { requestTimeoutSeconds })
            }
          />
          <NumberField
            label="Initial retry delay (seconds)"
            min={0}
            value={config.retry.initialSeconds}
            onChange={(initialSeconds) => section("retry", { initialSeconds })}
          />
          <NumberField
            label="Maximum retry delay (seconds)"
            min={0}
            value={config.retry.maxSeconds}
            onChange={(maxSeconds) => section("retry", { maxSeconds })}
          />
          <NumberField
            label="Retry backoff multiplier"
            min={1}
            step={0.1}
            value={config.retry.multiplier}
            onChange={(multiplier) => section("retry", { multiplier })}
          />
          <NumberField
            label="Retry jitter (0–1)"
            min={0}
            max={1}
            step={0.1}
            value={config.retry.jitter}
            onChange={(jitter) => section("retry", { jitter })}
          />
        </div>
      </Card>
      <section style={{ ...styles.card, borderColor: "#f0aaa4" }}>
        <h2 style={{ ...styles.sectionTitle, color: colors.danger }}>
          Danger zone
        </h2>
        <p style={styles.sectionHelp}>
          Permanently delete stored alerts, history, delivery attempts, and
          per-alert settings. Global settings and notification-service
          credentials are kept.
        </p>
        <button
          type="button"
          style={styles.danger}
          disabled={resetRequested}
          onClick={resetDatabase}
        >
          {resetRequested ? "Reset requested…" : "Reset database"}
        </button>
      </section>
    </>
  );
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const [baseline, setBaseline] = useState(() => initialConfig(configuration));
  const [config, setConfig] = useState(() => initialConfig(configuration));
  const [activeTab, setActiveTab] = useState("defaults");
  const [saved, setSaved] = useState(false);
  const [resetRequested, setResetRequested] = useState(false);
  useEffect(() => {
    const next = initialConfig(configuration);
    setBaseline(next);
    setConfig(next);
  }, [configuration]);
  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(baseline),
    [config, baseline],
  );
  useEffect(() => {
    const warn = (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const update = (key, value) => {
    setSaved(false);
    setConfig((current) => ({ ...current, [key]: value }));
  };
  const saveConfiguration = () => {
    save(config);
    setBaseline(clone(config));
    setSaved(true);
  };
  const resetDatabase = () => {
    if (
      !window.confirm(
        "Reset the Alert Center database? This permanently deletes all stored alerts, history, deliveries, and per-alert settings. Global configuration is kept.",
      )
    )
      return;
    setResetRequested(true);
    save({
      ...clone(configuration),
      maintenance: {
        ...(configuration?.maintenance ?? {}),
        resetDatabase: true,
      },
    });
  };
  return (
    <main style={styles.root}>
      <header style={styles.header}>
        <h1 style={styles.title}>Alert Center settings</h1>
        <p style={styles.subtitle}>
          Configure global defaults and notification services here. Individual
          alert settings remain in Alert Center.
        </p>
      </header>
      <nav style={styles.tabs} aria-label="Settings sections">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            style={{
              ...styles.tab,
              ...(activeTab === id ? styles.activeTab : {}),
            }}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {activeTab === "defaults" && (
        <AlertDefaults config={config} update={update} />
      )}
      {activeTab === "services" && (
        <NotificationServices config={config} update={update} />
      )}
      {activeTab === "connectivity" && (
        <Connectivity config={config} update={update} />
      )}
      {activeTab === "advanced" && (
        <Advanced
          config={config}
          update={update}
          resetDatabase={resetDatabase}
          resetRequested={resetRequested}
        />
      )}
      <div style={styles.actions}>
        <span
          style={{
            color: saved ? colors.brandDark : colors.muted,
            fontSize: 13,
          }}
        >
          {saved
            ? "Save requested."
            : dirty
              ? "Unsaved changes"
              : "No unsaved changes"}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            style={styles.secondary}
            disabled={!dirty}
            onClick={() => setConfig(clone(baseline))}
          >
            Discard
          </button>
          <button
            type="button"
            style={styles.primary}
            disabled={!dirty}
            onClick={saveConfiguration}
          >
            Save changes
          </button>
        </div>
      </div>
    </main>
  );
}
