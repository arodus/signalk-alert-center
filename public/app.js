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
  occurrences: $("#occurrence-list"),
  deliveries: $("#delivery-list"),
  updated: $("#updated"),
  error: $("#error"),
  login: $("#login"),
  moreOccurrences: $("#history-more"),
  drawer: $("#detail-drawer"),
  backdrop: $("#drawer-backdrop"),
  drawerTitle: $("#drawer-title"),
  drawerBody: $("#drawer-body"),
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
const pageItems = (value) =>
  Array.isArray(value) ? value : (value?.items ?? []);

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
      rule: "Configured rule",
      zone: "Signal K threshold",
      recognized: "Discovered path",
    }[sourceType] ?? String(sourceType ?? "Definition").replaceAll("_", " ")
  );
}
function sourceName(sourceKey) {
  const separator = String(sourceKey ?? "").indexOf("@");
  return separator >= 0 ? sourceKey.slice(separator + 1) : "Signal K";
}

function renderDefinitions() {
  elements.definitions.innerHTML = state.definitions.length
    ? `<table class="data-table definition-table">
        <thead><tr><th>Alert definition</th><th>Origin</th><th>Activity</th><th>Delivery</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${state.definitions
          .map((definition) => {
            const policy = definition.policy ?? {};
            const fireCount = definition.fireCount ?? 0;
            const notifierCount = (policy.notifierIds ?? []).length;
            return `<tr>
            <td data-label="Alert definition"><strong class="cell-title">${escapeHtml(definition.name ?? definition.pathPattern)}</strong><span class="cell-detail">${escapeHtml(definition.pathPattern)}</span></td>
            <td data-label="Origin">${escapeHtml(definitionOrigin(definition.sourceType))}</td>
            <td data-label="Activity">${fireCount ? `${fireCount} alert${fireCount === 1 ? "" : "s"}<span class="cell-detail">Last ${formatDate(definition.lastFiredAt)}</span>` : '<span class="muted">Never triggered</span>'}</td>
            <td data-label="Delivery">${policy.enabled === false ? '<span class="muted">Off</span>' : `<strong>${escapeHtml(policy.minimumSeverity ?? "normal")}+</strong><span class="cell-detail">${policy.activationDelaySeconds ?? 0}s delay · ${notifierCount} notifier${notifierCount === 1 ? "" : "s"}</span>`}</td>
            <td class="action-cell"><button class="button button-quiet button-small policy-button" data-id="${escapeHtml(definition.id)}" type="button">Settings</button></td>
          </tr>`;
          })
          .join("")}</tbody></table>`
    : '<div class="empty">No alert definitions have been configured or discovered.</div>';
  document
    .querySelectorAll(".policy-button")
    .forEach((button) =>
      button.addEventListener("click", () => openPolicy(button.dataset.id)),
    );
}

function renderOccurrences() {
  elements.occurrences.innerHTML = state.occurrences.length
    ? `<table class="data-table alert-table">
        <thead><tr><th>Alert</th><th>Status</th><th>Started</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${state.occurrences
          .map((occurrence) => {
            const definition = definitionFor(occurrence);
            const dismissed = Boolean(occurrence.dismissedAt);
            const oneTime =
              occurrence.oneTime ??
              definition?.oneTime ??
              definition?.policy?.oneTime;
            return `<tr class="clickable-row ${occurrence.state === "cleared" ? "is-resolved" : ""} ${dismissed ? "is-dismissed" : ""}" data-occurrence-id="${escapeHtml(occurrence.id)}" tabindex="0" aria-label="Open history for ${escapeHtml(definition?.name ?? occurrence.path)}">
            <td data-label="Alert"><strong class="cell-title">${escapeHtml(definition?.name ?? occurrence.name ?? occurrence.path)}</strong><span class="cell-detail message-detail">${escapeHtml(occurrence.message ?? occurrence.path)}</span><span class="cell-detail">${escapeHtml(occurrence.path)} · ${escapeHtml(sourceName(occurrence.sourceKey))}</span></td>
            <td data-label="Status"><span class="alert-severity ${escapeHtml(occurrence.maxSeverity)}">${escapeHtml(occurrence.maxSeverity)}</span><span class="cell-detail">${escapeHtml(occurrence.state)}${dismissed ? " · dismissed" : ""}</span></td>
            <td data-label="Started"><time>${formatDate(occurrence.startedAt ?? occurrence.firstSeenAt)}</time></td>
            <td class="action-cell"><div class="row-actions">${occurrence.state === "active" && !occurrence.acknowledgedAt ? `<button class="ack-alert" data-id="${escapeHtml(occurrence.id)}" type="button">Acknowledge</button>` : ""}${occurrence.state === "active" && !occurrence.silencedAt ? `<button class="silence-alert" data-id="${escapeHtml(occurrence.id)}" type="button">Silence</button>` : ""}${oneTime && !dismissed ? `<button class="remove-alert" data-id="${escapeHtml(occurrence.id)}" type="button">Delete</button>` : ""}</div></td>
          </tr>`;
          })
          .join("")}</tbody></table>`
    : '<div class="empty">No alerts match these filters.</div>';
  document.querySelectorAll("[data-occurrence-id]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (!event.target.closest("button"))
        openOccurrence(card.dataset.occurrenceId);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openOccurrence(card.dataset.occurrenceId);
      }
    });
  });
  for (const action of ["ack", "silence", "remove"])
    document
      .querySelectorAll(`.${action}-alert`)
      .forEach((button) =>
        button.addEventListener("click", () =>
          mutateOccurrence(
            button.dataset.id,
            action === "ack"
              ? "acknowledge"
              : action === "remove"
                ? "dismiss"
                : action,
          ),
        ),
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
  const params = new URLSearchParams({ limit: "30" });
  if ($("#state-filter").value) params.set("state", $("#state-filter").value);
  if ($("#severity-filter").value)
    params.set("severity", $("#severity-filter").value);
  if (!$("#dismissed-filter").checked) params.set("dismissed", "false");
  if (cursor) params.set("cursor", cursor);
  return params;
}

async function loadOccurrences(append = false) {
  const page = await api(
    `/occurrences?${occurrenceParams(append ? state.occurrenceCursor : undefined)}`,
  );
  state.occurrences = append
    ? [...state.occurrences, ...pageItems(page)]
    : pageItems(page);
  state.occurrenceCursor = page.nextCursor;
  elements.moreOccurrences.hidden = !page.nextCursor;
  renderOccurrences();
}
async function load() {
  elements.error.hidden = true;
  elements.login.hidden = true;
  try {
    const [definitions, occurrences, notifiers, status, deliveries] =
      await Promise.all([
        api("/definitions?limit=100"),
        api(`/occurrences?${occurrenceParams()}`),
        api("/notifiers"),
        api("/status").catch(() => ({})),
        api("/deliveries").catch(() => []),
      ]);
    state.definitions = pageItems(definitions);
    state.occurrences = pageItems(occurrences);
    state.notifiers = pageItems(notifiers);
    state.occurrenceCursor = occurrences.nextCursor;
    elements.activeCount.textContent =
      status.alerts?.active ??
      state.occurrences.filter(
        (item) => item.state === "active" && !item.dismissedAt,
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
    renderDefinitions();
    renderOccurrences();
    renderDeliveries(deliveries);
  } catch (error) {
    showError(error);
  }
}

async function mutateOccurrence(id, action) {
  try {
    await api(`/occurrences/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
    });
    await load();
    if (state.selectedOccurrence === id) await openOccurrence(id);
  } catch (error) {
    showError(error);
  }
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
    elements.drawerBody.innerHTML = `<p>${escapeHtml(occurrence.message ?? occurrence.path)}</p><dl class="detail-grid"><div><dt>State</dt><dd>${escapeHtml(occurrence.state)}</dd></div><div><dt>Severity</dt><dd>${escapeHtml(occurrence.maxSeverity)}</dd></div><div><dt>Started</dt><dd>${formatDate(occurrence.startedAt)}</dd></div><div><dt>Cleared</dt><dd>${formatDate(occurrence.clearedAt)}</dd></div></dl>${(occurrence.deliveries ?? []).length ? `<h3>Notifier outcomes</h3>${occurrence.deliveries.map((delivery) => `<div class="delivery-meta"><strong>${escapeHtml(delivery.notifierId ?? delivery.transportInstanceId)}</strong> · ${escapeHtml(delivery.state)}${(delivery.attempts ?? []).map((attempt) => `<div>Attempt ${attempt.attemptNumber} · ${escapeHtml(attempt.outcome)} · ${formatDate(attempt.startedAt)}${attempt.errorMessage ? ` · ${escapeHtml(attempt.errorMessage)}` : ""}</div>`).join("")}</div>`).join("")}` : ""}`;
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
          `<article class="event-row"><span class="event-dot"></span><div><strong>${escapeHtml(String(event.eventType).replaceAll("_", " "))}</strong><time>${formatDate(event.occurredAt)}</time>${event.message ? `<p>${escapeHtml(event.message)}</p>` : ""}</div></article>`,
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
  $("#notifier-options").innerHTML = state.notifiers.length
    ? state.notifiers
        .map((notifier) => {
          const id = typeof notifier === "string" ? notifier : notifier.id;
          return `<label class="check-label"><input type="checkbox" name="notifier" value="${escapeHtml(id)}" ${(policy.notifierIds ?? []).includes(id) ? "checked" : ""} /> ${escapeHtml(id)} <small>${escapeHtml(notifier.type ?? "")}</small></label>`;
        })
        .join("")
    : '<p class="alert-meta">No notifier instances configured.</p>';
  elements.policyDialog.showModal();
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
  loadOccurrences().catch(showError);
});
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
