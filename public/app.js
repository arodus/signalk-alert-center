const apiBase = "/plugins/signalk-persistent-notifier";
const state = {
  definitions: [],
  occurrences: [],
  notifiers: [],
  occurrenceCursor: undefined,
  eventCursor: undefined,
  selectedOccurrence: undefined,
};
const $ = (selector) => document.querySelector(selector);
const elements = {
  activeCount: $("#active-count"),
  definitionCount: $("#definition-count"),
  pendingCount: $("#pending-count"),
  connectivityNote: $("#connectivity-note"),
  definitions: $("#definition-list"),
  zoneCount: $("#zone-count"),
  zones: $("#zone-list"),
  deliveries: $("#delivery-list"),
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
function definitionFor(occurrence) {
  return state.definitions.find(
    (definition) => definition.id === occurrence.definitionId,
  );
}
function definitionOrigin(sourceType) {
  return (
    {
      zone: "Signal K threshold",
      recognized: "Discovered path",
    }[sourceType] ?? String(sourceType ?? "Definition").replaceAll("_", " ")
  );
}
function sourceName(sourceKey) {
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
function renderZones() {
  const definitions = state.definitions.filter(
    (definition) => definitionZones(definition).length > 0,
  );
  const zoneCount = definitions.reduce(
    (count, definition) => count + definitionZones(definition).length,
    0,
  );
  elements.zoneCount.textContent = definitions.length
    ? `${definitions.length} path${definitions.length === 1 ? "" : "s"} · ${zoneCount} range${zoneCount === 1 ? "" : "s"}`
    : "None";
  elements.zones.innerHTML = definitions.length
    ? definitions
        .map(
          (definition) =>
            `<div class="zone-row"><div class="zone-name"><strong>${escapeHtml(definition.name ?? definition.pathPattern)}</strong><span title="${escapeHtml(definition.pathPattern)}">${escapeHtml(definition.pathPattern)}</span></div><div class="zone-ranges">${zoneBadges(definition)}</div></div>`,
        )
        .join("")
    : '<div class="empty zone-empty">No Signal K metadata zones are currently defined.</div>';
}

function renderDefinitions() {
  const showActive = $("#state-filter").value === "active";
  const severity = $("#severity-filter").value;
  const visible = state.definitions
    .flatMap((definition) => {
      const occurrences = state.occurrences.filter(
        (occurrence) =>
          occurrence.definitionId === definition.id &&
          ($("#dismissed-filter").checked || !occurrence.dismissedAt),
      );
      const active = occurrences.filter(
        (occurrence) => occurrence.state === "active",
      );
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
    .filter(
      ({ occurrence }) => !severity || occurrence?.currentSeverity === severity,
    )
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        String(left.definition.name).localeCompare(
          String(right.definition.name),
        ),
    );
  elements.definitions.innerHTML = visible.length
    ? `<table class="data-table alert-table">
        <thead><tr><th>Alert</th><th>Status</th><th>Last activity</th><th>Delivery</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${visible
          .map((definition) => {
            const { definition: item, occurrence, active, latest } = definition;
            const policy = item.policy ?? {};
            const notifierCount = (policy.notifierIds ?? []).length;
            const hasHistory = Boolean(latest || item.fireCount);
            const alertSummary = [
              item.pathPattern,
              occurrence
                ? sourceName(occurrence.sourceKey)
                : definitionOrigin(item.sourceType),
              latest?.message,
            ]
              .filter(Boolean)
              .join(" · ");
            const status = active
              ? `<span class="status-summary"><span class="alert-severity ${escapeHtml(latest.currentSeverity)}">${escapeHtml(latest.currentSeverity)}</span><span class="muted">Active${latest.acknowledgedAt ? " · acknowledged" : ""}${latest.silencedAt ? " · silenced" : ""}${latest.dismissedAt ? " · dismissed" : ""}</span></span>`
              : `<span class="muted">${hasHistory ? "Inactive" : "Never fired"}</span>`;
            return `<tr class="clickable-row" data-definition-id="${escapeHtml(item.id)}" ${occurrence ? `data-occurrence-id="${escapeHtml(occurrence.id)}"` : ""} tabindex="0" aria-label="Open ${escapeHtml(item.name ?? item.pathPattern)}">
            <td data-label="Alert"><strong class="cell-title">${escapeHtml(item.name ?? item.pathPattern)}</strong><span class="cell-detail compact-detail" title="${escapeHtml(alertSummary)}">${escapeHtml(alertSummary)}</span></td>
            <td data-label="Status">${status}</td>
            <td data-label="Last activity">${formatDate(latestTimestamp(latest?.dismissedAt, latest?.silencedAt, latest?.acknowledgedAt, latest?.clearedAt, latest?.lastSeenAt, latest?.startedAt, item.lastActivityAt, item.lastFiredAt))}</td>
            <td data-label="Delivery">${policy.enabled === false ? '<span class="muted">Off</span>' : `<span class="delivery-summary"><strong>${escapeHtml(policy.minimumSeverity ?? "normal")}+</strong><span class="muted">${policy.activationDelaySeconds ?? 0}s · ${notifierCount} notifier${notifierCount === 1 ? "" : "s"}</span></span>`}</td>
            <td class="action-cell"><button class="button button-quiet button-small policy-button" data-id="${escapeHtml(item.id)}" type="button">Settings</button></td>
          </tr>`;
          })
          .join("")}</tbody></table>`
    : `<div class="empty">${showActive ? "No active alerts match these filters." : "No alerts have been configured or discovered."}</div>`;
  document.querySelectorAll("[data-definition-id]").forEach((row) => {
    const open = () =>
      row.dataset.occurrenceId
        ? openOccurrence(row.dataset.occurrenceId)
        : openDefinition(row.dataset.definitionId);
    row.addEventListener("click", (event) => {
      if (!event.target.closest("button")) open();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
  document
    .querySelectorAll(".policy-button")
    .forEach((button) =>
      button.addEventListener("click", () => openPolicy(button.dataset.id)),
    );
}

function renderDeliveries(deliveries) {
  elements.deliveries.innerHTML = deliveries.length
    ? deliveries
        .map(
          (delivery) =>
            `<article class="delivery-row"><div><p class="delivery-id">${escapeHtml(delivery.transportInstanceId ?? delivery.notifierId)}</p><div class="delivery-meta">Attempt ${delivery.attemptCount ?? 0}${delivery.lastErrorMessage ? ` · ${escapeHtml(delivery.lastErrorMessage)}` : ""}</div></div><span class="status-pill ${escapeHtml(delivery.state)}">${escapeHtml(String(delivery.state).replaceAll("_", " "))}</span></article>`,
        )
        .join("")
    : '<div class="empty">No deliveries have been queued.</div>';
}
function occurrenceParams(cursor) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) params.set("cursor", cursor);
  return params;
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
async function load() {
  elements.error.hidden = true;
  elements.login.hidden = true;
  try {
    const [
      definitions,
      activeOccurrences,
      occurrences,
      notifiers,
      status,
      deliveries,
    ] = await Promise.all([
      allPages("/definitions"),
      allPages("/occurrences?state=active"),
      api(`/occurrences?${occurrenceParams()}`),
      api("/notifiers"),
      api("/status").catch(() => ({})),
      api("/deliveries").catch(() => []),
    ]);
    state.definitions = definitions;
    state.occurrences = mergeById(activeOccurrences, pageItems(occurrences));
    state.notifiers = pageItems(notifiers);
    state.occurrenceCursor = occurrences.nextCursor;
    elements.activeCount.textContent = activeOccurrences.filter(
      (item) => !item.dismissedAt,
    ).length;
    elements.definitionCount.textContent =
      status.alerts?.definitions ?? state.definitions.length;
    elements.pendingCount.textContent =
      status.alerts?.pendingDelivery ??
      deliveries.filter(
        (item) => !["delivered", "failed_terminal"].includes(item.state),
      ).length;
    elements.connectivityNote.textContent = status.connectivity?.state
      ? `Connectivity ${status.connectivity.state.toLowerCase()}`
      : "delivery intents waiting";
    elements.updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    elements.moreOccurrences.hidden = !state.occurrenceCursor;
    renderZones();
    renderDefinitions();
    renderDeliveries(deliveries);
  } catch (error) {
    showError(error);
  }
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
    const localAction =
      action === "acknowledge"
        ? "Acknowledged"
        : action === "silence"
          ? "Silenced"
          : "Dismissed";
    elements.drawerResult.textContent = result.message
      ? `${localAction} locally. ${result.message}`
      : result.upstream === "applied"
        ? `${localAction} locally and in Signal K.`
        : `${localAction} locally.`;
  } catch (error) {
    showError(error);
  }
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
    elements.drawerBody.innerHTML = `<p>${escapeHtml(occurrence.message ?? occurrence.path)}</p><p class="cell-detail">${escapeHtml(occurrence.path)} · ${escapeHtml(sourceName(occurrence.sourceKey))}</p><dl class="detail-grid"><div><dt>State</dt><dd>${escapeHtml(occurrence.state)}${occurrence.dismissedAt ? " · dismissed" : ""}</dd></div><div><dt>Severity</dt><dd>${escapeHtml(occurrence.maxSeverity)}</dd></div><div><dt>Acknowledged</dt><dd>${formatDate(occurrence.acknowledgedAt)}</dd></div><div><dt>Silenced</dt><dd>${formatDate(occurrence.silencedAt)}</dd></div><div><dt>Started</dt><dd>${formatDate(occurrence.startedAt)}</dd></div><div><dt>Cleared</dt><dd>${formatDate(occurrence.clearedAt)}</dd></div></dl>${definition && definitionZones(definition).length ? `<section class="drawer-zones"><h3>Defined zones</h3><div class="zone-ranges">${zoneBadges(definition)}</div></section>` : ""}<div class="drawer-actions">${definition ? `<button class="button button-primary drawer-settings" data-id="${escapeHtml(definition.id)}" type="button">Alert settings</button>` : ""}${occurrence.state === "active" && !occurrence.acknowledgedAt ? `<button class="button button-quiet drawer-ack" type="button">Acknowledge</button>` : ""}${occurrence.state === "active" && !occurrence.silencedAt ? `<button class="button button-quiet drawer-silence" type="button">Silence</button>` : ""}${!occurrence.dismissedAt ? `<button class="button button-quiet drawer-dismiss" type="button">Dismiss</button>` : ""}</div>${(occurrence.deliveries ?? []).length ? `<h3>Notifier outcomes</h3>${occurrence.deliveries.map((delivery) => `<div class="delivery-meta"><strong>${escapeHtml(delivery.notifierId ?? delivery.transportInstanceId)}</strong> · ${escapeHtml(delivery.state)}${(delivery.attempts ?? []).map((attempt) => `<div>Attempt ${attempt.attemptNumber} · ${escapeHtml(attempt.outcome)} · ${formatDate(attempt.startedAt)}${attempt.errorMessage ? ` · ${escapeHtml(attempt.errorMessage)}` : ""}</div>`).join("")}</div>`).join("")}` : ""}`;
    elements.drawerResult.textContent = "";
    elements.drawerBody
      .querySelector(".drawer-settings")
      ?.addEventListener("click", () => openPolicy(definition.id));
    elements.drawerBody
      .querySelector(".drawer-ack")
      ?.addEventListener("click", () => mutateOccurrence(id, "acknowledge"));
    elements.drawerBody
      .querySelector(".drawer-silence")
      ?.addEventListener("click", () => mutateOccurrence(id, "silence"));
    elements.drawerBody
      .querySelector(".drawer-dismiss")
      ?.addEventListener("click", () => mutateOccurrence(id, "dismiss"));
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

function openPolicy(id) {
  const definition = state.definitions.find((item) => item.id === id);
  if (!definition) return;
  const policy = definition.policy ?? {};
  $("#policy-definition-id").value = id;
  $("#activation-delay").value = policy.activationDelaySeconds ?? 0;
  $("#minimum-severity").value = policy.minimumSeverity ?? "normal";
  $("#policy-enabled").checked = policy.enabled !== false;
  $("#policy-one-time").checked = policy.oneTime ?? definition.oneTime ?? false;
  $("#rearm-after").value = policy.rearmAfterSeconds ?? "";
  $("#connectivity-mode").value = policy.connectivity?.mode ?? "queue";
  $("#wake-delay").value = policy.connectivity?.delaySeconds ?? 0;
  toggleWakeDelay();
  elements.policyResult.textContent = "";
  const forget = $("#policy-forget");
  const hasActive = state.occurrences.some(
    (occurrence) =>
      occurrence.definitionId === id && occurrence.state === "active",
  );
  forget.hidden = definition.sourceType !== "recognized";
  forget.disabled = hasActive;
  forget.title = hasActive
    ? "Clear the active alert before forgetting it"
    : "Permanently remove this discovered alert and its history";
  $("#notifier-options").innerHTML = state.notifiers.length
    ? state.notifiers
        .map((notifier) => {
          const id = typeof notifier === "string" ? notifier : notifier.id;
          return `<label class="check-label"><input type="checkbox" name="notifier" value="${escapeHtml(id)}" ${(policy.notifierIds ?? []).includes(id) ? "checked" : ""} /> ${escapeHtml(notifier.name ?? id)} <small>${escapeHtml(notifier.type ?? "")}${notifier.minimumSeverity ? ` · sends ${escapeHtml(notifier.minimumSeverity)} and above` : ""}</small></label>`;
        })
        .join("")
    : '<p class="alert-meta">No notification services are configured. Add one in the Signal K plugin settings first.</p>';
  elements.policyDialog.showModal();
}
async function forgetDefinition() {
  const id = $("#policy-definition-id").value;
  const definition = state.definitions.find((item) => item.id === id);
  if (
    !definition ||
    !window.confirm(
      `Forget “${definition.name}” and permanently delete its stored history?`,
    )
  )
    return;
  $("#policy-forget").disabled = true;
  try {
    await api(`/definitions/${encodeURIComponent(id)}`, { method: "DELETE" });
    elements.policyDialog.close();
    closeDrawer();
    await load();
  } catch (error) {
    elements.policyResult.textContent = error.message;
    $("#policy-forget").disabled = false;
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
    enabled: $("#policy-enabled").checked,
    oneTime: $("#policy-one-time").checked,
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

$("#refresh").addEventListener("click", load);
$("#history-filters").addEventListener("submit", (event) => {
  event.preventDefault();
});
$("#state-filter").addEventListener("change", renderDefinitions);
$("#severity-filter").addEventListener("change", renderDefinitions);
$("#dismissed-filter").addEventListener("change", () => renderDefinitions());
elements.moreOccurrences.addEventListener("click", () =>
  loadOccurrences(true).catch(showError),
);
elements.moreEvents.addEventListener("click", () => loadEvents(true));
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
$("#policy-forget").addEventListener("click", forgetDefinition);
$("#retry").addEventListener("click", async () => {
  try {
    await api("/retry", { method: "POST" });
    await load();
  } catch (error) {
    showError(error);
  }
});
load();
setInterval(load, 30000);
