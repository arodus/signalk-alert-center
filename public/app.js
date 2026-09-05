const apiBase = "/plugins/signalk-persistent-notifier";
let alerts = [];
let deliveries = [];
let activeView = "all";

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

function renderAlerts() {
  const visible = alerts.filter((alert) => {
    if (activeView === "active") return alert.currentState === "active";
    if (activeView === "history") return alert.currentState === "cleared";
    return true;
  });
  if (!visible.length) {
    elements.alertList.innerHTML = `<div class="empty">${activeView === "active" ? "No active alerts." : "No alert history yet."}</div>`;
    return;
  }
  elements.alertList.innerHTML = visible
    .map(
      (alert) => `
    <article class="alert-card">
      <span class="alert-stripe ${alert.maxSeverity}" aria-hidden="true"></span>
      <div class="alert-content">
        <h3 class="alert-title">${escapeHtml(alert.name)}</h3>
        <p class="alert-message">${escapeHtml(alert.message || alert.pathPattern)}</p>
        <div class="alert-meta">${alert.zone ? `${escapeHtml(alert.zone)} · ` : ""}${alert.configured ? "Configured" : "Recognized automatically"} · ${alert.firstSeenAt ? `First seen ${formatDate(alert.firstSeenAt)} · ` : "Never fired · "}${alert.lastFiredAt ? `Last fired ${formatDate(alert.lastFiredAt)} · ` : ""}${alert.fireCount} fire${alert.fireCount === 1 ? "" : "s"}${alert.clearedAt ? ` · ${duration(alert)}` : ""}</div>
      </div>
      <div class="alert-side">
        <span class="alert-severity ${alert.maxSeverity || "normal"}">${escapeHtml(alert.maxSeverity || "not fired")}</span>
        ${alert.oneTime && alert.alertId ? `<button class="remove-alert" data-id="${escapeHtml(alert.alertId)}" type="button">Remove</button>` : ""}
      </div>
    </article>
  `,
    )
    .join("");
  document
    .querySelectorAll(".remove-alert")
    .forEach((button) =>
      button.addEventListener("click", () => removeAlert(button.dataset.id)),
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
