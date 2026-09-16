const apiBase = "/plugins/signalk-persistent-notifier";
const state = {
  definitions: [],
  occurrences: [],
  activeDefinitionIds: new Set(),
  notifiers: [],
  deliveries: [],
  occurrenceCursor: undefined,
  deliveryCursor: undefined,
  eventCursor: undefined,
  deliveryAttemptCursor: undefined,
  deliveryAttempts: [],
  selectedOccurrence: undefined,
  selectedDelivery: undefined,
  loading: false,
  reloadQueued: false,
  policyDefaults: undefined,
  policyHiddenOverrides: [],
};
const $ = (selector) => document.querySelector(selector);
const elements = {
  activeCount: $("#active-count"),
  definitionCount: $("#definition-count"),
  pendingCount: $("#pending-count"),
  connectivityNote: $("#connectivity-note"),
  healthState: $("#health-state"),
  diagnostics: $("#diagnostics-list"),
  definitions: $("#definition-list"),
  deliveries: $("#delivery-list"),
  moreDeliveries: $("#deliveries-more"),
  deliveryTabCount: $("#delivery-tab-count"),
  updated: $("#updated"),
  error: $("#error"),
  login: $("#login"),
  moreOccurrences: $("#history-more"),
  drawer: $("#detail-drawer"),
  backdrop: $("#drawer-backdrop"),
  drawerTitle: $("#drawer-title"),
  drawerBody: $("#drawer-body"),
  drawerResult: $("#drawer-result"),
  events: $("#event-list"),
  moreEvents: $("#events-more"),
  policyDialog: $("#policy-dialog"),
  policyResult: $("#policy-result"),
  deliveryDialog: $("#delivery-dialog"),
  deliveryDialogTitle: $("#delivery-dialog-title"),
  deliveryDialogBody: $("#delivery-dialog-body"),
  deliveryDialogResult: $("#delivery-dialog-result"),
  deliveryAttempts: $("#delivery-attempt-list"),
  moreDeliveryAttempts: $("#delivery-attempts-more"),
  deliveryRetry: $("#delivery-retry"),
};

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ],
  );
const formatDate = (value) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
const latestTimestamp = (...values) =>
  values.filter(Boolean).reduce((latest, value) => {
    return !latest || new Date(value) > new Date(latest) ? value : latest;
  }, undefined);
const pageItems = (value) =>
  Array.isArray(value) ? value : (value?.items ?? []);
const mergeById = (...collections) => [
  ...new Map(collections.flat().map((item) => [item.id, item])).values(),
];
const policyFieldNames = {
  enabled: "remote notifications",
  minimumSeverity: "lowest severity sent",
  activationDelaySeconds: "wait before sending",
  rearmAfterSeconds: "repeat while active",
  connectivity: "internet connection behavior",
  notifierIds: "notification services",
};

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    ...options,
  });
  if (response.status === 401 || response.status === 403) {
    elements.login.hidden = false;
    throw new Error("Sign in to Signal K to view or change alerts.");
  }
  const payload = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(
      payload?.error?.message ?? `Request failed (${response.status})`,
    );
  return payload;
}
async function allPages(path) {
  const items = [];
  let cursor;
  do {
    const page = await api(
      `${path}${path.includes("?") ? "&" : "?"}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...pageItems(page));
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
function showError(error) {
  elements.error.textContent =
    error instanceof Error
      ? error.message
      : "The request could not be completed.";
  elements.error.hidden = false;
}
function renderDiagnostics(status) {
  const health = status.health?.state ?? "fault";
  elements.healthState.textContent = health;
  elements.healthState.className = `health-pill ${health}`;
  const reconciliation = status.reconciliation ?? {};
  const ingestion = status.ingestion ?? {};
  const runtime = status.runtime ?? {};
  const scheduler = status.scheduler ?? {};
  const database = status.database ?? {};
  const connectivity = status.connectivity ?? {};
  const reasons = status.health?.reasons ?? [];
  const services = status.services ?? [];
  const items = [
    [
      "Startup reconciliation",
      `${reconciliation.state ?? "unknown"}${reconciliation.durationMs === undefined ? "" : ` · ${reconciliation.durationMs} ms`} · ${reconciliation.snapshotEntries ?? 0} snapshot / ${reconciliation.queuedEntries ?? 0} queued`,
    ],
    [
      "Delivery scheduler",
      `${scheduler.running ? "Running" : "Idle"} · ${scheduler.activeRequests ?? 0} active requests${scheduler.oldestRequestStartedAt ? ` · oldest started ${formatDate(scheduler.oldestRequestStartedAt)}` : ""} · last completed ${formatDate(scheduler.lastRunCompletedAt)}${scheduler.lastError ? ` · ${scheduler.lastError}` : ""}`,
    ],
    [
      "Notification ingestion",
      `${ingestion.depth ?? 0}/${ingestion.limit ?? 0} queued · high-water ${ingestion.highWaterMark ?? 0} · ${ingestion.received ?? 0} received / ${ingestion.processed ?? 0} processed / ${ingestion.coalesced ?? 0} coalesced / ${ingestion.rejected ?? 0} rejected`,
    ],
    [
      "Runtime lifecycle",
      `Generation ${runtime.generation ?? 0} · ${runtime.changeListeners ?? 0} dashboard streams · ${runtime.startCount ?? 0} starts / ${runtime.stopCount ?? 0} stops`,
    ],
    [
      "Pending work",
      `${status.alerts?.pendingDelivery ?? 0} deliveries · oldest due ${formatDate(database.oldestDueDeliveryAt)} · ${database.overdueActivationCount ?? 0} overdue activations`,
    ],
    [
      "Database",
      `${database.healthy ? "Healthy" : "Fault"} · schema ${database.schemaVersion ?? "—"}/${database.expectedSchemaVersion ?? "—"}${database.error ? ` · ${database.error}` : ""}`,
    ],
    [
      "Connectivity",
      `${connectivity.state ?? "OFF"} · ${connectivity.ownedByPlugin ? "plugin-owned" : "not plugin-owned"} · last transition ${formatDate(connectivity.lastTransitionAt)} · ${connectivity.pendingWakeCount ?? 0} pending wake${connectivity.lastProbeAt ? ` · probe ${connectivity.lastProbeSucceeded ? "passed" : "failed"} ${formatDate(connectivity.lastProbeAt)}` : ""}${connectivity.lastError ? ` · ${connectivity.lastError}` : ""}`,
    ],
    ...services.map((service) => [
      `Service: ${service.name}`,
      `${service.enabled ? "Enabled" : "Disabled"} · ${service.pendingCount} pending · last success ${formatDate(service.lastSuccessAt)} · last failure ${formatDate(service.lastFailureAt)}${service.lastFailureCode ? ` (${service.lastFailureCode})` : ""}`,
    ]),
  ];
  if (reasons.length) items.unshift(["Health reason", reasons.join(" · ")]);
  elements.diagnostics.innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="diagnostic-item"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`,
    )
    .join("");
}
function definitionFor(occurrence) {
  return state.definitions.find(
    (definition) => definition.id === occurrence.definitionId,
  );
}
function alertName(definition) {
  const name = definition.name ?? definition.pathPattern;
  if (name !== definition.pathPattern) return name;
  return name
    .replace(/^notifications\./, "")
    .split(".")
    .map((part) => part.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .join(" › ");
}
function definitionOrigin(sourceType) {
  return (
    {
      zone: "Signal K threshold",
      recognized: "Discovered path",
    }[sourceType] ?? String(sourceType ?? "Definition").replaceAll("_", " ")
  );
}
function sourceName(sourceKey, source) {
  if (source) return source;
  const separator = String(sourceKey ?? "").indexOf("@");
  return separator >= 0 ? sourceKey.slice(separator + 1) : "Signal K";
}

function definitionZones(definition) {
  return Array.isArray(definition?.metadata?.zones)
    ? definition.metadata.zones
    : [];
}
function formatZoneNumber(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 });
}
function formatZoneRange(zone, units) {
  const lower = Number.isFinite(zone.lower)
    ? formatZoneNumber(zone.lower)
    : undefined;
  const upper = Number.isFinite(zone.upper)
    ? formatZoneNumber(zone.upper)
    : undefined;
  const range =
    lower !== undefined && upper !== undefined
      ? `${lower}–${upper}`
      : lower !== undefined
        ? `≥ ${lower}`
        : upper !== undefined
          ? `≤ ${upper}`
          : "Any value";
  return `${range}${units ? ` ${units}` : ""}`;
}
function zoneBadges(definition) {
  const units = definition.metadata?.units;
  return definitionZones(definition)
    .map(
      (zone) =>
        `<span class="zone-badge"><span class="zone-state ${escapeHtml(zone.state)}">${escapeHtml(zone.state)}</span>${escapeHtml(formatZoneRange(zone, units))}${zone.message ? ` · ${escapeHtml(zone.message)}` : ""}</span>`,
    )
    .join("");
}
function renderDefinitions() {
  const showActive = $("#state-filter").value === "active";
  const severity = $("#severity-filter").value;
  const search = $("#alert-search").value.trim().toLocaleLowerCase();
  const historyFiltered = [
    "state-filter",
    "severity-filter",
    "path-filter",
    "source-filter",
    "from-filter",
    "to-filter",
  ].some((id) => $(`#${id}`).value);
  const visible = state.definitions
    .flatMap((definition) => {
      const occurrences = state.occurrences.filter(
        (occurrence) => occurrence.definitionId === definition.id,
      );
      const active = occurrences.filter(
        (occurrence) => occurrence.state === "active",
      );
      if (historyFiltered && occurrences.length === 0) return [];
      if (active.length)
        return active.map((occurrence) => ({
          definition,
          occurrence,
          latest: occurrence,
          active: true,
        }));
      return [
        {
          definition,
          occurrence: undefined,
          latest: occurrences[0],
          active: false,
        },
      ];
    })
    .filter((entry) => !showActive || entry.active)
    .filter(({ latest }) => !severity || latest?.currentSeverity === severity)
    .filter(({ definition, latest }) =>
      [
        definition.name,
        definition.pathPattern,
        latest?.message,
        latest?.sourceKey,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(search),
    )
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        (left.active && right.active
          ? ["normal", "warn", "alert", "alarm", "emergency"].indexOf(
              right.latest?.currentSeverity,
            ) -
            ["normal", "warn", "alert", "alarm", "emergency"].indexOf(
              left.latest?.currentSeverity,
            )
          : 0) ||
        String(left.definition.name).localeCompare(
          String(right.definition.name),
        ),
    );
  $("#list-summary").textContent =
    `${visible.length} shown · ${state.definitions.filter((item) => definitionZones(item).length > 0).length} configured zone paths · active first`;
  elements.definitions.innerHTML = visible.length
    ? `<table class="data-table alert-table">
            <thead><tr><th>Alert</th><th>Status</th><th>Last activity</th><th>Notify via</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${visible
          .map((definition) => {
            const { definition: item, occurrence, active, latest } = definition;
            const policy = item.policy ?? {};
            const notifierCount = (policy.notifierIds ?? []).length;
            const hasHistory = Boolean(latest || item.fireCount);
            const alertSummary = [
              latest?.message,
              definitionZones(item).length
                ? `Configured zone · ${definitionZones(item).length} thresholds`
                : "",
            ]
              .filter(Boolean)
              .join(" · ");
            const status = active
              ? `<span class="status-summary"><span class="alert-severity ${escapeHtml(latest.currentSeverity)}">${escapeHtml(latest.currentSeverity)}</span></span>`
              : `<span class="alert-severity inactive" title="${hasHistory ? "No active alert" : "No alert has been recorded for this definition"}">Inactive</span>`;
            return `<tr class="clickable-row" data-definition-id="${escapeHtml(item.id)}" ${occurrence ? `data-occurrence-id="${escapeHtml(occurrence.id)}"` : ""} tabindex="0" aria-label="Open ${escapeHtml(item.name ?? item.pathPattern)}">
            <td data-label="Alert"><strong class="cell-title" title="${escapeHtml(item.pathPattern)}">${escapeHtml(alertName(item))}</strong><span class="cell-detail compact-detail" title="${escapeHtml(alertSummary)}">${escapeHtml(alertSummary)}</span></td>
            <td data-label="Status">${status}</td>
            <td data-label="Last activity">${formatDate(latestTimestamp(latest?.silencedAt, latest?.acknowledgedAt, latest?.clearedAt, latest?.lastSeenAt, latest?.startedAt, item.lastActivityAt, item.lastFiredAt))}</td>
            <td data-label="Notify via"><span class="cell-title">${(policy.enabled === false ? "" : policy.notifierIds?.join(", ")) || '<span class="muted">No delivery selected</span>'}</span><span class="cell-detail">${policy.enabled === false ? "Remote off" : notifierCount ? `${escapeHtml(policy.minimumSeverity ?? "normal")}+ remote` : ""}</span></td>
            <td class="action-cell">${active ? `<div class="table-actions"><button class="button button-quiet button-small occurrence-action" data-id="${escapeHtml(occurrence.id)}" data-action="acknowledge" type="button" ${latest.acknowledgedAt ? "disabled" : ""}>${latest.acknowledgedAt ? "Acknowledged" : "Acknowledge"}</button><button class="button button-quiet button-small occurrence-action" data-id="${escapeHtml(occurrence.id)}" data-action="silence" type="button" ${latest.silencedAt ? "disabled" : ""}>${latest.silencedAt ? "Silenced" : "Silence"}</button></div>` : ""}</td>
          </tr>`;
          })
          .join("")}</tbody></table>`
    : `<div class="empty"><strong>${search || severity ? "No matching alerts" : showActive ? "No active alerts to show" : "No known alerts yet"}</strong><p>${search || severity ? "Try another search or choose All severities." : showActive ? "Choose All alerts and zones to view inactive alerts and configured thresholds." : "Alerts appear when Signal K reports a notification or defines a zone threshold."}</p></div>`;
  document.querySelectorAll("[data-definition-id]").forEach((row) => {
    const open = () =>
      row.dataset.occurrenceId
        ? openOccurrence(row.dataset.occurrenceId)
        : openDefinition(row.dataset.definitionId);
    row.addEventListener("click", (event) => {
      if (!event.target.closest("button")) open();
    });
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
  document.querySelectorAll(".occurrence-action").forEach((button) =>
    button.addEventListener("click", async () => {
      button.disabled = true;
      await mutateOccurrence(button.dataset.id, button.dataset.action);
      if (button.isConnected) button.disabled = false;
    }),
  );
}

function renderDeliveries(deliveries) {
  elements.deliveries.innerHTML = deliveries.length
    ? `<table class="data-table delivery-table">
        <thead><tr><th>Alert</th><th>Service</th><th>Status</th><th>Timing</th><th>Attempts</th></tr></thead>
        <tbody>${deliveries
          .map((delivery) => {
            const alert = delivery.alert ?? {};
            const service = delivery.service ?? {};
            const alertTitle = alert.path
              ? alertName({
                  name: alert.name ?? alert.path,
                  pathPattern: alert.path,
                })
              : "Unknown alert";
            const failed = ["failed_retryable", "failed_terminal"].includes(
              delivery.state,
            );
            const primaryTime = delivery.lastAttemptAt
              ? `Last attempt ${formatDate(delivery.lastAttemptAt)}`
              : `Queued ${formatDate(delivery.createdAt)}`;
            const outcomeTime = delivery.deliveredAt
              ? `Delivered ${formatDate(delivery.deliveredAt)}`
              : delivery.nextAttemptAt
                ? `Next retry ${formatDate(delivery.nextAttemptAt)}`
                : "No retry scheduled";
            return `<tr class="clickable-row delivery-row" data-delivery-id="${escapeHtml(delivery.id)}" tabindex="0" aria-label="Open delivery for ${escapeHtml(alertTitle)}">
              <td data-label="Alert"><strong class="cell-title">${escapeHtml(alertTitle)}</strong><span class="cell-detail">${escapeHtml(alert.path ?? "Occurrence unavailable")}${alert.occurrenceNumber ? ` · occurrence ${alert.occurrenceNumber}` : ""}</span></td>
              <td data-label="Service"><strong class="cell-title">${escapeHtml(service.name ?? delivery.transportInstanceId)}</strong><span class="cell-detail">${escapeHtml(service.type ?? "unknown service")} · ${escapeHtml(delivery.operation ?? "notify")}</span></td>
              <td data-label="Status"><span class="status-pill ${escapeHtml(delivery.state)}">${escapeHtml(String(delivery.state).replaceAll("_", " "))}</span>${delivery.lastErrorCode ? `<span class="cell-detail error-detail">${escapeHtml(delivery.lastErrorCode)}</span>` : ""}</td>
              <td data-label="Timing"><span class="cell-title">${escapeHtml(primaryTime)}</span><span class="cell-detail">${escapeHtml(outcomeTime)}</span>${delivery.lastErrorMessage ? `<span class="cell-detail compact-detail error-detail" title="${escapeHtml(delivery.lastErrorMessage)}">${escapeHtml(delivery.lastErrorMessage)}</span>` : ""}</td>
              <td data-label="Attempts"><span class="cell-title">${delivery.attemptCount ?? 0}</span>${failed ? '<span class="cell-detail">Can retry</span>' : ""}</td>
            </tr>`;
          })
          .join("")}</tbody></table>`
    : '<div class="empty"><strong>No deliveries yet</strong><p>Delivery attempts appear here after an alert sends to a notification service.</p></div>';
  elements.moreDeliveries.hidden = !state.deliveryCursor;
  document.querySelectorAll("[data-delivery-id]").forEach((row) => {
    const open = () => openDelivery(row.dataset.deliveryId);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}
function occurrenceParams(cursor) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) params.set("cursor", cursor);
  for (const id of ["state", "severity", "path", "source"]) {
    const value = $(`#${id}-filter`).value.trim();
    if (value) params.set(id, value);
  }
  for (const id of ["from", "to"]) {
    const value = $(`#${id}-filter`).value;
    if (value) params.set(id, new Date(value).toISOString());
  }
  return params;
}

function hasHistoryFilters() {
  return [
    "state-filter",
    "severity-filter",
    "path-filter",
    "source-filter",
    "from-filter",
    "to-filter",
  ].some((id) => $(`#${id}`).value);
}

function renderPathOptions() {
  const select = $("#path-filter");
  const selected = select.value;
  const paths = [
    ...new Set(state.definitions.map((item) => item.pathPattern)),
  ].sort();
  select.innerHTML = `<option value="">All paths</option>${paths.map((path) => `<option value="${escapeHtml(path)}">${escapeHtml(path)}</option>`).join("")}`;
  if (paths.includes(selected)) select.value = selected;
}

async function loadOccurrences(append = false) {
  const page = await api(
    `/occurrences?${occurrenceParams(append ? state.occurrenceCursor : undefined)}`,
  );
  state.occurrences = append
    ? mergeById(state.occurrences, pageItems(page))
    : pageItems(page);
  state.occurrenceCursor = page.nextCursor;
  elements.moreOccurrences.hidden = !page.nextCursor;
  renderDefinitions();
}
async function loadDeliveries(append = false) {
  const params = new URLSearchParams({ limit: "50" });
  if (append && state.deliveryCursor)
    params.set("cursor", state.deliveryCursor);
  const page = await api(`/deliveries?${params}`);
  state.deliveries = append
    ? mergeById(state.deliveries, pageItems(page))
    : pageItems(page);
  state.deliveryCursor = page.nextCursor;
  renderDeliveries(state.deliveries);
}
async function load() {
  if (state.loading) {
    state.reloadQueued = true;
    return;
  }
  state.loading = true;
  elements.error.hidden = true;
  elements.login.hidden = true;
  try {
    const [
      definitions,
      activeOccurrences,
      occurrences,
      notifiers,
      status,
      deliveryPage,
    ] = await Promise.all([
      allPages("/definitions"),
      allPages("/occurrences?state=active"),
      api(`/occurrences?${occurrenceParams()}`),
      api("/notifiers"),
      api("/status").catch(() => ({})),
      api("/deliveries?limit=50"),
    ]);
    state.definitions = definitions;
    state.activeDefinitionIds = new Set(
      activeOccurrences.map((item) => item.definitionId),
    );
    renderPathOptions();
    state.occurrences = hasHistoryFilters()
      ? pageItems(occurrences)
      : mergeById(activeOccurrences, pageItems(occurrences));
    state.notifiers = pageItems(notifiers);
    state.deliveries = pageItems(deliveryPage);
    state.deliveryCursor = deliveryPage.nextCursor;
    state.occurrenceCursor = occurrences.nextCursor;
    elements.activeCount.textContent = activeOccurrences.length;
    elements.definitionCount.textContent =
      status.alerts?.definitions ?? state.definitions.length;
    const pendingDeliveryCount =
      status.alerts?.pendingDelivery ??
      state.deliveries.filter(
        (item) => !["delivered", "failed_terminal"].includes(item.state),
      ).length;
    elements.pendingCount.textContent = pendingDeliveryCount;
    elements.deliveryTabCount.textContent = pendingDeliveryCount;
    elements.connectivityNote.textContent = status.connectivity?.state
      ? `${status.health?.state ?? "unknown"} · connectivity ${status.connectivity.state.toLowerCase()}`
      : "delivery intents waiting";
    renderDiagnostics(status);
    elements.updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    elements.moreOccurrences.hidden = !state.occurrenceCursor;
    renderDefinitions();
    renderDeliveries(state.deliveries);
    if (state.selectedDelivery) await refreshDeliveryDetail();
  } catch (error) {
    showError(error);
  } finally {
    state.loading = false;
    if (state.reloadQueued) {
      state.reloadQueued = false;
      void load();
    }
  }
}

let reloadTimer;
let fallbackTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void load(), 150);
}
function enableFallbackPolling() {
  if (!fallbackTimer) fallbackTimer = setInterval(() => void load(), 60_000);
}
function connectLiveUpdates() {
  if (!("EventSource" in window)) {
    enableFallbackPolling();
    return;
  }
  const events = new EventSource(`${apiBase}/events`);
  events.addEventListener("change", scheduleReload);
  events.addEventListener("open", () => {
    clearInterval(fallbackTimer);
    fallbackTimer = undefined;
  });
  events.addEventListener("error", enableFallbackPolling);
}

async function mutateOccurrence(id, action) {
  try {
    const result = await api(
      `/occurrences/${encodeURIComponent(id)}/${action}`,
      {
        method: "POST",
      },
    );
    await load();
    if (state.selectedOccurrence === id) await openOccurrence(id);
    const localAction = action === "acknowledge" ? "Acknowledged" : "Silenced";
    elements.drawerResult.textContent = result.message
      ? `${localAction} locally. ${result.message}`
      : result.upstream === "applied"
        ? `${localAction} locally and in Signal K.`
        : `${localAction} locally.`;
    $("#action-result").textContent = elements.drawerResult.textContent;
  } catch (error) {
    showError(error);
  }
}
function renderDeliveryAttempts() {
  elements.deliveryAttempts.innerHTML = state.deliveryAttempts.length
    ? state.deliveryAttempts
        .map(
          (attempt) =>
            `<article class="event-row"><span class="event-dot"></span><div><strong>Attempt ${attempt.attemptNumber} · ${escapeHtml(String(attempt.outcome).replaceAll("_", " "))}</strong><time>${formatDate(attempt.startedAt)} → ${formatDate(attempt.finishedAt)}</time>${attempt.errorCode || attempt.errorMessage ? `<p>${escapeHtml([attempt.errorCode, attempt.errorMessage].filter(Boolean).join(" · "))}</p>` : ""}${attempt.remoteId ? `<p>Remote ID: ${escapeHtml(attempt.remoteId)}</p>` : ""}</div></article>`,
        )
        .join("")
    : '<div class="empty">No delivery attempt has started yet.</div>';
  elements.moreDeliveryAttempts.hidden = !state.deliveryAttemptCursor;
}
function renderDeliveryDetail(delivery) {
  const alert = delivery.alert ?? {};
  const service = delivery.service ?? {};
  const alertTitle = alert.path
    ? alertName({ name: alert.name ?? alert.path, pathPattern: alert.path })
    : "Delivery details";
  const retryable = ["failed_retryable", "failed_terminal"].includes(
    delivery.state,
  );
  elements.deliveryDialogTitle.textContent = alertTitle;
  elements.deliveryDialogBody.innerHTML = `<p>${escapeHtml(alert.message ?? alert.path ?? "The related alert is no longer available.")}</p><p class="cell-detail">${escapeHtml(alert.path ?? "Unknown alert path")}${alert.occurrenceNumber ? ` · occurrence ${alert.occurrenceNumber}` : ""}</p><dl class="detail-grid"><div><dt>Notification service</dt><dd>${escapeHtml(service.name ?? delivery.transportInstanceId)} · ${escapeHtml(service.type ?? "unknown")}</dd></div><div><dt>Operation</dt><dd>${escapeHtml(delivery.operation ?? "notify")}</dd></div><div><dt>Status</dt><dd><span class="status-pill ${escapeHtml(delivery.state)}">${escapeHtml(String(delivery.state).replaceAll("_", " "))}</span></dd></div><div><dt>Attempts</dt><dd>${delivery.attemptCount ?? 0}</dd></div><div><dt>Last attempt</dt><dd>${formatDate(delivery.lastAttemptAt)}</dd></div><div><dt>Next retry</dt><dd>${formatDate(delivery.nextAttemptAt)}</dd></div><div><dt>Delivered</dt><dd>${formatDate(delivery.deliveredAt)}</dd></div><div><dt>Queued</dt><dd>${formatDate(delivery.createdAt)}</dd></div><div><dt>Remote delivery ID</dt><dd>${escapeHtml(delivery.remoteId ?? "—")}</dd></div></dl>${delivery.lastErrorCode || delivery.lastErrorMessage ? `<section class="delivery-error"><h3>Latest error</h3><p><strong>${escapeHtml(delivery.lastErrorCode ?? "Delivery failed")}</strong>${delivery.lastErrorMessage ? ` · ${escapeHtml(delivery.lastErrorMessage)}` : ""}</p></section>` : ""}`;
  elements.deliveryRetry.hidden = !retryable;
  elements.deliveryRetry.dataset.id = delivery.id;
}
async function refreshDeliveryDetail() {
  if (!state.selectedDelivery) return;
  const id = state.selectedDelivery;
  const [delivery, attempts] = await Promise.all([
    api(`/deliveries/${encodeURIComponent(id)}`),
    api(`/deliveries/${encodeURIComponent(id)}/attempts?limit=50`),
  ]);
  if (state.selectedDelivery !== id) return;
  state.deliveryAttempts = pageItems(attempts);
  state.deliveryAttemptCursor = attempts.nextCursor;
  renderDeliveryDetail(delivery);
  renderDeliveryAttempts();
}
async function openDelivery(id) {
  state.selectedDelivery = id;
  state.deliveryAttempts = [];
  state.deliveryAttemptCursor = undefined;
  elements.deliveryDialogTitle.textContent = "Loading delivery…";
  elements.deliveryDialogBody.innerHTML =
    '<div class="empty">Loading details…</div>';
  elements.deliveryAttempts.innerHTML =
    '<div class="empty">Loading attempts…</div>';
  elements.deliveryDialogResult.textContent = "";
  elements.deliveryRetry.hidden = true;
  if (!elements.deliveryDialog.open) elements.deliveryDialog.showModal();
  try {
    await refreshDeliveryDetail();
  } catch (error) {
    elements.deliveryDialogBody.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}
async function loadMoreDeliveryAttempts() {
  if (!state.selectedDelivery || !state.deliveryAttemptCursor) return;
  try {
    const page = await api(
      `/deliveries/${encodeURIComponent(state.selectedDelivery)}/attempts?limit=50&cursor=${encodeURIComponent(state.deliveryAttemptCursor)}`,
    );
    state.deliveryAttempts = mergeById(state.deliveryAttempts, pageItems(page));
    state.deliveryAttemptCursor = page.nextCursor;
    renderDeliveryAttempts();
  } catch (error) {
    elements.deliveryDialogResult.textContent = error.message;
  }
}
function closeDeliveryDialog() {
  elements.deliveryDialog.close();
  state.selectedDelivery = undefined;
  state.deliveryAttempts = [];
  state.deliveryAttemptCursor = undefined;
}
function openDefinition(id) {
  const definition = state.definitions.find((item) => item.id === id);
  if (!definition) return;
  const latest = state.occurrences.find(
    (occurrence) => occurrence.definitionId === id,
  );
  if (latest) return openOccurrence(latest.id);
  const hasHistory = Boolean(definition.fireCount);
  state.selectedOccurrence = undefined;
  elements.drawerTitle.textContent = definition.name ?? definition.pathPattern;
  elements.drawerBody.innerHTML = `<p class="cell-detail">${escapeHtml(definition.pathPattern)}</p><dl class="detail-grid"><div><dt>Status</dt><dd>${hasHistory ? "Inactive" : "Never fired"}</dd></div><div><dt>Last fired</dt><dd>${formatDate(definition.lastFiredAt)}</dd></div><div><dt>Origin</dt><dd>${escapeHtml(definitionOrigin(definition.sourceType))}</dd></div></dl>${definitionZones(definition).length ? `<section class="drawer-zones"><h3>Defined zones</h3><div class="zone-ranges">${zoneBadges(definition)}</div></section>` : ""}${hasHistory ? '<p class="cell-detail">Older history is not loaded. Use Load more to retrieve it.</p>' : ""}<button class="button button-primary drawer-settings" data-id="${escapeHtml(id)}" type="button">Alert settings</button>`;
  elements.drawerResult.textContent = "";
  elements.events.innerHTML = '<div class="empty">No history recorded.</div>';
  elements.moreEvents.hidden = true;
  elements.backdrop.hidden = false;
  elements.drawer.classList.add("is-open");
  elements.drawer.setAttribute("aria-hidden", "false");
  elements.drawer.focus();
  elements.drawerBody
    .querySelector(".drawer-settings")
    .addEventListener("click", () => openPolicy(id));
}
async function openOccurrence(id) {
  try {
    const occurrence = await api(`/occurrences/${encodeURIComponent(id)}`);
    const definition = state.definitions.find(
      (item) => item.id === occurrence.definitionId,
    );
    state.selectedOccurrence = id;
    state.eventCursor = undefined;
    elements.drawerTitle.textContent = definition?.name ?? occurrence.path;
    elements.drawerBody.innerHTML = `<p>${escapeHtml(occurrence.message ?? occurrence.path)}</p><p class="cell-detail">${escapeHtml(occurrence.path)} · ${escapeHtml(sourceName(occurrence.sourceKey))}</p><dl class="detail-grid"><div><dt>State</dt><dd>${escapeHtml(occurrence.state)}</dd></div><div><dt>Severity</dt><dd>${escapeHtml(occurrence.maxSeverity)}</dd></div><div><dt>Acknowledged</dt><dd>${formatDate(occurrence.acknowledgedAt)}</dd></div><div><dt>Silenced</dt><dd>${formatDate(occurrence.silencedAt)}</dd></div><div><dt>Started</dt><dd>${formatDate(occurrence.startedAt)}</dd></div><div><dt>Cleared</dt><dd>${formatDate(occurrence.clearedAt)}</dd></div></dl>${definition && definitionZones(definition).length ? `<section class="drawer-zones"><h3>Defined zones</h3><div class="zone-ranges">${zoneBadges(definition)}</div></section>` : ""}<div class="drawer-actions">${definition ? `<button class="button button-primary drawer-settings" data-id="${escapeHtml(definition.id)}" type="button">Alert settings</button>` : ""}</div>${(occurrence.deliveries ?? []).length ? `<h3>Notifier outcomes</h3>${occurrence.deliveries.map((delivery) => `<div class="delivery-meta"><strong>${escapeHtml(delivery.notifierId ?? delivery.transportInstanceId)}</strong> · ${escapeHtml(delivery.operation ?? "notify")} · ${escapeHtml(delivery.state)}${(delivery.attempts ?? []).map((attempt) => `<div>Attempt ${attempt.attemptNumber} · ${escapeHtml(attempt.outcome)} · ${formatDate(attempt.startedAt)}${attempt.errorMessage ? ` · ${escapeHtml(attempt.errorMessage)}` : ""}</div>`).join("")}</div>`).join("")}` : ""}`;
    elements.drawerResult.textContent = "";
    elements.drawerBody
      .querySelector(".drawer-settings")
      ?.addEventListener("click", () => openPolicy(definition.id));
    elements.events.innerHTML = '<div class="empty">Loading history…</div>';
    elements.backdrop.hidden = false;
    elements.drawer.classList.add("is-open");
    elements.drawer.setAttribute("aria-hidden", "false");
    elements.drawer.focus();
    await loadEvents(false);
  } catch (error) {
    showError(error);
  }
}
async function loadEvents(append) {
  if (!state.selectedOccurrence) return;
  const params = new URLSearchParams({ limit: "20" });
  if (append && state.eventCursor) params.set("cursor", state.eventCursor);
  try {
    const page = await api(
      `/occurrences/${encodeURIComponent(state.selectedOccurrence)}/events?${params}`,
    );
    const html = pageItems(page)
      .map(
        (event) =>
          `<article class="event-row"><span class="event-dot"></span><div><strong>${escapeHtml(String(event.eventType).replaceAll("_", " "))}</strong><time>${formatDate(event.occurredAt)}</time>${(event.message ?? event.payload?.message) ? `<p>${escapeHtml(event.message ?? event.payload.message)}</p>` : ""}</div></article>`,
      )
      .join("");
    elements.events.innerHTML = append
      ? elements.events.innerHTML + html
      : html || '<div class="empty">No history events recorded.</div>';
    state.eventCursor = page.nextCursor;
    elements.moreEvents.hidden = !page.nextCursor;
  } catch (error) {
    elements.events.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}
function closeDrawer() {
  elements.drawer.classList.remove("is-open");
  elements.drawer.setAttribute("aria-hidden", "true");
  elements.backdrop.hidden = true;
  state.selectedOccurrence = undefined;
}

function setPolicyControlValues(policy) {
  $("#activation-delay").value = policy.activationDelaySeconds ?? 0;
  $("#minimum-severity").value = policy.minimumSeverity ?? "normal";
  $("#policy-enabled").checked = policy.enabled !== false;
  $("#rearm-after").value = policy.rearmAfterSeconds ?? "";
  $("#connectivity-mode").value = policy.connectivity?.mode ?? "queue";
  $("#wake-delay").value = policy.connectivity?.delaySeconds ?? 0;
}

function applyDefaultForField(field) {
  const defaults = state.policyDefaults;
  if (!defaults) return;
  const setters = {
    enabled: () => ($("#policy-enabled").checked = defaults.enabled),
    minimumSeverity: () =>
      ($("#minimum-severity").value = defaults.minimumSeverity),
    activationDelaySeconds: () =>
      ($("#activation-delay").value = defaults.activationDelaySeconds),
    rearmAfterSeconds: () =>
      ($("#rearm-after").value = defaults.rearmAfterSeconds ?? ""),
    connectivity: () => {
      $("#connectivity-mode").value = defaults.connectivity.mode;
      $("#wake-delay").value = defaults.connectivity.delaySeconds ?? 0;
      toggleWakeDelay();
    },
    notifierIds: () => {
      document.querySelectorAll('input[name="notifier"]').forEach((input) => {
        input.checked = defaults.notifierIds.includes(input.value);
      });
    },
  };
  setters[field]?.();
}

function setPolicyOverrideState(field, overridden) {
  const host = document.querySelector(`[data-policy-field="${field}"]`);
  if (!host) return;
  const button = host.querySelector(":scope > .policy-override-button");
  button.setAttribute("aria-pressed", String(overridden));
  button.textContent = overridden ? "Custom" : "Global default";
  button.setAttribute(
    "aria-label",
    `${overridden ? "Use global default for" : "Customize"} ${policyFieldNames[field] ?? field}`,
  );
  button.classList.toggle("is-custom", overridden);
  host
    .querySelectorAll("input, select")
    .forEach((control) => (control.disabled = !overridden));
  if (field === "connectivity") $("#wake-delay").disabled = !overridden;
  if (!overridden) applyDefaultForField(field);
}

function initializePolicyOverrideControls() {
  document.querySelectorAll("[data-policy-field]").forEach((host) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "policy-override-button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const field = host.dataset.policyField;
      const overridden = button.getAttribute("aria-pressed") !== "true";
      setPolicyOverrideState(field, overridden);
      updateInheritanceSummary();
    });
    host.prepend(button);
  });
}

function selectedOverrideFields() {
  const visible = [...document.querySelectorAll(".policy-override-button")]
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.parentElement.dataset.policyField);
  return [...new Set([...state.policyHiddenOverrides, ...visible])];
}

function updateInheritanceSummary() {
  const count = selectedOverrideFields().length;
  $("#policy-inheritance-status").textContent = count
    ? `${count} custom ${count === 1 ? "setting" : "settings"}`
    : "Using global defaults";
  $("#policy-reset").disabled = count === 0;
}

function openPolicy(id) {
  const definition = state.definitions.find((item) => item.id === id);
  if (!definition) return;
  const policy = definition.policy ?? {};
  $("#policy-title").textContent = definition.name ?? definition.pathPattern;
  $("#policy-definition-id").value = id;
  state.policyDefaults = policy.defaults ?? policy;
  setPolicyControlValues(policy);
  toggleWakeDelay();
  elements.policyResult.textContent = "";
  const remove = $("#policy-remove");
  const hasActive = state.activeDefinitionIds.has(id);
  remove.disabled = hasActive;
  remove.title = hasActive
    ? "Clear the active alert in Signal K before removing its stored data"
    : "Permanently remove this alert, its settings, and its complete history";
  $("#policy-remove-help").textContent = hasActive
    ? "This alert is active. Clear it in Signal K before removing its stored data."
    : "Permanently deletes this alert's settings and complete stored history. If Signal K still defines or publishes it, it will be discovered again using the current global defaults.";
  $("#notifier-options").innerHTML = state.notifiers.length
    ? state.notifiers
        .map((notifier) => {
          const id = typeof notifier === "string" ? notifier : notifier.id;
          return `<label class="check-label"><input type="checkbox" name="notifier" value="${escapeHtml(id)}" ${(policy.notifierIds ?? []).includes(id) ? "checked" : ""} /> ${escapeHtml(notifier.name ?? id)} <small>${escapeHtml(notifier.type ?? "")}${notifier.minimumSeverity ? ` · sends ${escapeHtml(notifier.minimumSeverity)} and above` : ""}</small></label>`;
        })
        .join("")
    : '<p class="alert-meta">No notification services are configured. Add one in the Signal K plugin settings first.</p>';
  const overridden = new Set(policy.overriddenFields ?? []);
  state.policyHiddenOverrides = [...overridden].filter(
    (field) => !document.querySelector(`[data-policy-field="${field}"]`),
  );
  document
    .querySelectorAll("[data-policy-field]")
    .forEach((host) =>
      setPolicyOverrideState(
        host.dataset.policyField,
        overridden.has(host.dataset.policyField),
      ),
    );
  updateInheritanceSummary();
  if (!elements.policyDialog.open) elements.policyDialog.showModal();
}
async function removeStoredAlert() {
  const id = $("#policy-definition-id").value;
  const definition = state.definitions.find((item) => item.id === id);
  if (
    !definition ||
    !window.confirm(
      `Remove “${definition.name}” from stored alerts?\n\nThis permanently deletes its settings and complete history. If Signal K still defines or publishes it, the alert will be discovered again using the current global defaults.`,
    )
  )
    return;
  $("#policy-remove").disabled = true;
  try {
    await api(`/definitions/${encodeURIComponent(id)}`, { method: "DELETE" });
    elements.policyDialog.close();
    closeDrawer();
    await load();
  } catch (error) {
    elements.policyResult.textContent = error.message;
    $("#policy-remove").disabled = false;
  }
}
function toggleWakeDelay() {
  $("#wake-delay-field").hidden =
    $("#connectivity-mode").value !== "wake_after";
}
async function savePolicy(event) {
  event.preventDefault();
  const id = $("#policy-definition-id").value;
  const mode = $("#connectivity-mode").value;
  const body = {
    overrideFields: selectedOverrideFields(),
    enabled: $("#policy-enabled").checked,
    rearmAfterSeconds:
      $("#rearm-after").value === "" ? null : Number($("#rearm-after").value),
    activationDelaySeconds: Number($("#activation-delay").value),
    minimumSeverity: $("#minimum-severity").value,
    notifierIds: [
      ...document.querySelectorAll('input[name="notifier"]:checked'),
    ].map((item) => item.value),
    connectivity:
      mode === "wake_after"
        ? { mode, delaySeconds: Number($("#wake-delay").value) }
        : { mode },
  };
  $("#policy-save").disabled = true;
  try {
    const updated = await api(`/definitions/${encodeURIComponent(id)}/policy`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    state.definitions = state.definitions.map((item) =>
      item.id === id ? updated : item,
    );
    renderDefinitions();
    elements.policyResult.textContent = "Policy saved.";
    setTimeout(() => elements.policyDialog.close(), 500);
  } catch (error) {
    elements.policyResult.textContent = error.message;
  } finally {
    $("#policy-save").disabled = false;
  }
}

async function resetPolicy() {
  const id = $("#policy-definition-id").value;
  $("#policy-reset").disabled = true;
  try {
    const updated = await api(`/definitions/${encodeURIComponent(id)}/policy`, {
      method: "DELETE",
    });
    state.definitions = state.definitions.map((item) =>
      item.id === id ? updated : item,
    );
    renderDefinitions();
    openPolicy(id);
    elements.policyResult.textContent = "Now using global defaults.";
  } catch (error) {
    elements.policyResult.textContent = error.message;
    $("#policy-reset").disabled = false;
  }
}

function selectView(view, moveFocus = false) {
  const deliveries = view === "deliveries";
  $("#alerts-panel").hidden = deliveries;
  $("#deliveries-panel").hidden = !deliveries;
  for (const [name, button] of [
    ["alerts", $("#alerts-tab")],
    ["deliveries", $("#deliveries-tab")],
  ]) {
    const selected = name === view;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) button.focus();
  }
  history.replaceState(
    null,
    "",
    deliveries ? "#deliveries" : location.pathname,
  );
}

$("#refresh").addEventListener("click", load);
$("#history-filters").addEventListener("submit", (event) => {
  event.preventDefault();
  void load();
});
$("#state-filter").addEventListener("change", load);
$("#alert-search").addEventListener("input", renderDefinitions);
$("#severity-filter").addEventListener("change", load);
$("#filters-clear").addEventListener("click", () => {
  $("#history-filters").reset();
  void load();
});
elements.moreOccurrences.addEventListener("click", () =>
  loadOccurrences(true).catch(showError),
);
elements.moreDeliveries.addEventListener("click", () =>
  loadDeliveries(true).catch(showError),
);
elements.moreEvents.addEventListener("click", () => loadEvents(true));
elements.moreDeliveryAttempts.addEventListener(
  "click",
  loadMoreDeliveryAttempts,
);
$("#drawer-close").addEventListener("click", closeDrawer);
elements.backdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements.drawer.classList.contains("is-open"))
    closeDrawer();
});
$("#connectivity-mode").addEventListener("change", toggleWakeDelay);
$("#policy-form").addEventListener("submit", savePolicy);
$("#policy-close").addEventListener("click", () =>
  elements.policyDialog.close(),
);
$("#policy-cancel").addEventListener("click", () =>
  elements.policyDialog.close(),
);
$("#policy-remove").addEventListener("click", removeStoredAlert);
$("#policy-reset").addEventListener("click", resetPolicy);
initializePolicyOverrideControls();
for (const [view, button] of [
  ["alerts", $("#alerts-tab")],
  ["deliveries", $("#deliveries-tab")],
]) {
  button.addEventListener("click", () => selectView(view));
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    selectView(view === "alerts" ? "deliveries" : "alerts", true);
  });
}
$("#delivery-dialog-close").addEventListener("click", closeDeliveryDialog);
$("#delivery-dialog-done").addEventListener("click", closeDeliveryDialog);
elements.deliveryDialog.addEventListener("close", () => {
  state.selectedDelivery = undefined;
});
elements.deliveryRetry.addEventListener("click", async () => {
  const id = elements.deliveryRetry.dataset.id;
  if (!id) return;
  elements.deliveryRetry.disabled = true;
  elements.deliveryDialogResult.textContent = "Scheduling this delivery…";
  try {
    await api(`/deliveries/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    });
    elements.deliveryDialogResult.textContent = "Delivery scheduled for retry.";
    await load();
  } catch (error) {
    elements.deliveryDialogResult.textContent = error.message;
  } finally {
    elements.deliveryRetry.disabled = false;
  }
});
$("#retry").addEventListener("click", async () => {
  $("#retry").disabled = true;
  try {
    await api("/retry", { method: "POST" });
    await load();
  } catch (error) {
    showError(error);
  } finally {
    $("#retry").disabled = false;
  }
});
selectView(location.hash === "#deliveries" ? "deliveries" : "alerts");
connectLiveUpdates();
void load();
