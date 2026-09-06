const apiBase = "/plugins/signalk-persistent-notifier";
let alerts = [];
let deliveries = [];
let activeView = "all";
let activeZone = "all";

const elements = {
  activeCount: document.querySelector("#active-count"),
  pendingCount: document.querySelector("#pending-count"),
  connectivityState: document.querySelector("#connectivity-state"),
  connectivityNote: document.querySelector("#connectivity-note"),
  alertList: document.querySelector("#alert-list"),
  deliveryList: document.querySelector("#delivery-list"),
  updated: document.querySelector("#updated"),
  error: document.querySelector("#error"),
  retry: document.querySelector("#retry"),
  zoneFilter: document.querySelector("#zone-filter"),
};

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function duration(alert) {
  if (!alert.clearedAt) return `Last seen ${formatDate(alert.lastSeenAt)}`;
  const minutes = Math.max(
    0,
    Math.round(
      (new Date(alert.clearedAt) - new Date(alert.firstSeenAt)) / 60000,
    ),
  );
  return `Cleared ${formatDate(alert.clearedAt)} after ${minutes} min`;
}

function populateZoneFilter() {
  const zones = [
    ...new Set(alerts.map((alert) => alert.zone).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  const current = elements.zoneFilter.value || activeZone;
  const hasUnzoned = alerts.some((alert) => !alert.zone);
  elements.zoneFilter.innerHTML =
    `<option value="all">All zones</option>` +
    zones
      .map(
        (zone) =>
          `<option value="${escapeHtml(zone)}">${escapeHtml(zone)}</option>`,
      )
      .join("") +
    (hasUnzoned ? `<option value="__none__">No zone</option>` : "");
  const options = [...elements.zoneFilter.options].map(
    (option) => option.value,
  );
  elements.zoneFilter.value = options.includes(current) ? current : "all";
  activeZone = elements.zoneFilter.value;
}

function renderAlertCard(alert) {
  const resolved = alert.currentState === "cleared";
  return `
    <article class="alert-card${resolved ? " is-resolved" : ""}">
      <span class="alert-stripe ${resolved ? "resolved" : alert.maxSeverity}" aria-hidden="true"></span>
      <div class="alert-content">
        <h3 class="alert-title">${escapeHtml(alert.name)}</h3>
        <p class="alert-message">${escapeHtml(alert.message || alert.pathPattern)}</p>
        <div class="alert-meta">${alert.zone ? `${escapeHtml(alert.zone)} · ` : ""}${alert.configured ? "Configured" : "Recognized automatically"} · ${alert.firstSeenAt ? `First seen ${formatDate(alert.firstSeenAt)} · ` : "Never fired · "}${alert.lastFiredAt ? `Last fired ${formatDate(alert.lastFiredAt)} · ` : ""}${alert.fireCount} fire${alert.fireCount === 1 ? "" : "s"}${resolved ? ` · ${duration(alert)}` : ""}${!resolved && alert.acknowledgedAt ? ` · Acknowledged ${formatDate(alert.acknowledgedAt)}` : ""}${!resolved && alert.silencedAt ? ` · Silenced ${formatDate(alert.silencedAt)}` : ""}</div>
      </div>
      <div class="alert-side">
        ${resolved ? `<span class="resolved-pill">✓ Resolved</span>` : `<span class="alert-severity ${alert.maxSeverity || "normal"}">${escapeHtml(alert.maxSeverity || "not fired")}</span>`}
        ${!resolved && alert.alertId ? `<div class="alert-actions">${!alert.acknowledgedAt ? `<button class="ack-alert" data-id="${escapeHtml(alert.alertId)}" type="button">Acknowledge</button>` : ""}${!alert.silencedAt ? `<button class="silence-alert" data-id="${escapeHtml(alert.alertId)}" type="button">Silence</button>` : ""}</div>` : ""}
        ${alert.oneTime && alert.alertId ? `<button class="remove-alert" data-id="${escapeHtml(alert.alertId)}" type="button">Remove</button>` : ""}
      </div>
    </article>
  `;
}

function renderAlerts() {
  const visible = alerts.filter((alert) => {
    if (activeView === "active" && alert.currentState !== "active")
      return false;
    if (activeView === "history" && alert.currentState !== "cleared")
      return false;
    if (activeZone === "__none__") return !alert.zone;
    if (activeZone !== "all") return alert.zone === activeZone;
    return true;
  });
  if (!visible.length) {
    elements.alertList.innerHTML = `<div class="empty">${activeView === "active" ? "No active alerts." : "No alert history yet."}</div>`;
    return;
  }
  const groups = new Map();
  for (const alert of visible) {
    const key = alert.zone || "No zone";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(alert);
  }
  const zoneNames = [...groups.keys()].sort((a, b) => {
    if (a === "No zone") return 1;
    if (b === "No zone") return -1;
    return a.localeCompare(b);
  });
  const showHeadings = activeZone === "all" && zoneNames.length > 1;
  elements.alertList.innerHTML = zoneNames
    .map((zoneName) => {
      const cards = groups
        .get(zoneName)
        .map((alert) => renderAlertCard(alert))
        .join("");
      return `${showHeadings ? `<h3 class="zone-heading">${escapeHtml(zoneName)}</h3>` : ""}${cards}`;
    })
    .join("");
  document.querySelectorAll(".remove-alert");
  document
    .querySelectorAll(".remove-alert")
    .forEach((button) =>
      button.addEventListener("click", () => removeAlert(button.dataset.id)),
    );
  document
    .querySelectorAll(".ack-alert")
    .forEach((button) =>
      button.addEventListener("click", () =>
        acknowledgeAlert(button.dataset.id),
      ),
    );
  document
    .querySelectorAll(".silence-alert")
    .forEach((button) =>
      button.addEventListener("click", () => silenceAlert(button.dataset.id)),
    );
}

async function removeAlert(id) {
  try {
    const response = await fetch(
      `${apiBase}/alerts/${encodeURIComponent(id)}/remove`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error("Only one-time alerts can be removed.");
    await load();
  } catch (error) {
    elements.error.textContent =
      error instanceof Error ? error.message : "Unable to remove alert.";
    elements.error.hidden = false;
  }
}

async function acknowledgeAlert(id) {
  try {
    const response = await fetch(
      `${apiBase}/alerts/${encodeURIComponent(id)}/acknowledge`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error("Unable to acknowledge alert.");
    await load();
  } catch (error) {
    elements.error.textContent =
      error instanceof Error ? error.message : "Unable to acknowledge alert.";
    elements.error.hidden = false;
  }
}

async function silenceAlert(id) {
  try {
    const response = await fetch(
      `${apiBase}/alerts/${encodeURIComponent(id)}/silence`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error("Unable to silence alert.");
    await load();
  } catch (error) {
    elements.error.textContent =
      error instanceof Error ? error.message : "Unable to silence alert.";
    elements.error.hidden = false;
  }
}

function renderDeliveries() {
  if (!deliveries.length) {
    elements.deliveryList.innerHTML = `<div class="empty">No deliveries have been queued.</div>`;
    return;
  }
  elements.deliveryList.innerHTML = deliveries
    .map(
      (delivery) => `
    <article class="delivery-row">
      <div>
        <p class="delivery-id">${escapeHtml(delivery.transportInstanceId)}</p>
        <div class="delivery-meta">Attempt ${delivery.attemptCount}${delivery.lastErrorMessage ? ` · ${escapeHtml(delivery.lastErrorMessage)}` : ""}</div>
      </div>
      <span class="status-pill ${delivery.state}">${escapeHtml(delivery.state.replaceAll("_", " "))}</span>
    </article>
  `,
    )
    .join("");
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ],
  );
}

async function load() {
  elements.error.hidden = true;
  try {
    const [statusResponse, alertsResponse, deliveriesResponse] =
      await Promise.all([
        fetch(`${apiBase}/status`),
        fetch(`${apiBase}/alerts`),
        fetch(`${apiBase}/deliveries`),
      ]);
    if (
      ![statusResponse, alertsResponse, deliveriesResponse].every(
        (response) => response.ok,
      )
    )
      throw new Error("The plugin API returned an error.");
    const status = await statusResponse.json();
    alerts = await alertsResponse.json();
    deliveries = await deliveriesResponse.json();
    const activeCount = alerts.filter(
      (alert) => alert.currentState === "active",
    ).length;
    elements.activeCount.textContent = activeCount;
    elements.pendingCount.textContent = status.alerts.pendingDelivery;
    elements.connectivityState.textContent = status.connectivity.state;
    elements.connectivityNote.textContent = status.connectivity.ownedByPlugin
      ? "owned by plugin"
      : status.connectivity.switchOn
        ? "already enabled"
        : "switch off";
    elements.updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    populateZoneFilter();
    renderAlerts();
    renderDeliveries();
  } catch (error) {
    elements.error.textContent =
      error instanceof Error ? error.message : "Unable to load plugin status.";
    elements.error.hidden = false;
  }
}

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    activeView = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((item) => {
      const selected = item === tab;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    renderAlerts();
  }),
);
document.querySelector("#refresh").addEventListener("click", load);
elements.zoneFilter.addEventListener("change", () => {
  activeZone = elements.zoneFilter.value;
  renderAlerts();
});
elements.retry.addEventListener("click", async () => {
  elements.retry.disabled = true;
  try {
    const response = await fetch(`${apiBase}/retry`, { method: "POST" });
    if (!response.ok) throw new Error("Retry request failed.");
    await load();
  } catch (error) {
    elements.error.textContent =
      error instanceof Error ? error.message : "Retry request failed.";
    elements.error.hidden = false;
  } finally {
    elements.retry.disabled = false;
  }
});

load();
setInterval(load, 30000);
