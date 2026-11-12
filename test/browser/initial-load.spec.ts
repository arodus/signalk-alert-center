import { expect, test, type Page, type Route } from "@playwright/test";

const plugin = "/plugins/signalk-alert-center";
const definitions = Array.from({ length: 9 }, (_, index) => ({
  id: `depth-${index}`,
  name: `Depth ${index}`,
  pathPattern: `notifications.test.depth${index}`,
  sourceType: "zone",
  metadata: { units: "m", zones: [{ state: "alarm", upper: 2 }] },
}));
const occurrences = definitions.slice(0, 2).map((definition, index) => ({
  id: `occurrence-${index}`,
  definitionId: definition.id,
  path: definition.pathPattern,
  state: index === 0 ? "active" : "cleared",
  currentSeverity: "alarm",
  maxSeverity: "alarm",
  message: "Shallow water",
  startedAt: "2026-01-01T10:00:00Z",
}));
const metadata = {
  units: "m",
  displayUnits: { formula: "value * 3.28084", symbol: "ft" },
};

function heldResponses() {
  const routes: Route[] = [];
  let released = false;
  const fulfill = (route: Route) => route.fulfill({ json: metadata });
  return {
    routes,
    handle: (route: Route) => {
      routes.push(route);
      if (released) return fulfill(route);
    },
    release: async () => {
      released = true;
      await Promise.all(routes.map(fulfill));
    },
  };
}

async function mockDashboard(page: Page) {
  // Synthetic reads only: no vessel, notification services, or live SSE changes.
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() {
        super();
        document.addEventListener("test-alert-change", () =>
          this.dispatchEvent(new Event("change")),
        );
      }
    } as typeof EventSource;
  });
  await page.routeWebSocket("**/signalk/v1/stream?subscribe=none", () => {});
  await page.route("**/loginStatus", (route) =>
    route.fulfill({ json: { authenticationRequired: false } }),
  );
  await page.route(`**${plugin}/**`, (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.split("/").pop();
    if (endpoint === "definitions")
      return route.fulfill({ json: { items: definitions } });
    if (endpoint === "occurrences")
      return route.fulfill({
        json: {
          items:
            url.searchParams.get("state") === "active"
              ? occurrences.slice(0, 1)
              : occurrences,
        },
      });
    if (endpoint === "summary" || endpoint === "status")
      return route.fulfill({
        json: {
          alerts: { pendingDelivery: 3, undeliveredDelivery: 4 },
          health: { state: "healthy" },
        },
      });
    return route.fulfill({ json: { items: [] } });
  });
  await page.route("**/signalk/v1/api/vessels/self/**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("/meta")
        ? metadata
        : { value: 1, timestamp: new Date().toISOString() },
    }),
  );
}

test.beforeEach(async ({ page }) => mockDashboard(page));

test("renders and refreshes alerts while metadata, access, and summary are pending", async ({
  page,
}) => {
  const metadataResponses = heldResponses();
  const statusResponses: Route[] = [];
  const accessResponses: Route[] = [];
  const hiddenRequests: string[] = [];
  page.on("request", (request) => {
    if (
      /\/(alert-history|deliveries|notifiers|status)(\?|$)/.test(request.url())
    )
      hiddenRequests.push(request.url());
  });
  await page.route(
    "**/signalk/v1/api/vessels/self/**/meta",
    metadataResponses.handle,
  );
  await page.route(`**${plugin}/summary`, (route) => {
    statusResponses.push(route);
  });
  await page.route("**/loginStatus", (route) => {
    accessResponses.push(route);
  });
  await page.goto("/signalk-alert-center/");
  await expect(page.locator("#definition-list tbody tr")).toHaveCount(9, {
    timeout: 2000,
  });
  await expect(page.locator("#active-count")).toHaveText("1");
  await expect(page.locator("html")).toHaveAttribute("data-access", "readonly");
  await expect(page.locator("#delivery-tab-count")).toBeHidden();
  await expect.poll(() => metadataResponses.routes.length).toBe(4);
  expect(hiddenRequests).toEqual([]);
  await page.screenshot({
    path: `test-results/initial-load-pending-${test.info().project.name}.png`,
    fullPage: true,
  });

  // A refresh must not wait behind the metadata worker or start another batch.
  await page.route(`**${plugin}/definitions?*`, (route) =>
    route.fulfill({
      json: {
        items: definitions.map((item) => ({
          ...item,
          name: `${item.name} refreshed`,
        })),
      },
    }),
  );
  await page.locator("#refresh").click();
  await expect(page.locator("#definition-list")).toContainText(
    "Depth 0 refreshed",
    { timeout: 2000 },
  );
  expect(metadataResponses.routes).toHaveLength(4);
  expect(hiddenRequests).toEqual([]);

  await metadataResponses.release();
  await Promise.all(
    statusResponses.map((route) =>
      route.fulfill({
        json: {
          alerts: { pendingDelivery: 3, undeliveredDelivery: 4 },
          health: { state: "healthy" },
        },
      }),
    ),
  );
  await Promise.all(
    accessResponses.map((route) =>
      route.fulfill({ json: { authenticationRequired: false } }),
    ),
  );
  await expect(page.locator("#pending-count")).toHaveText("3");
  await expect(page.locator("#delivery-tab-count")).toHaveText("4");
  await expect(page.locator("html")).toHaveAttribute("data-access", "admin");
  await expect(
    page.locator('[data-definition-id="depth-0"] .live-value'),
  ).toContainText("ft");
  await expect(
    page.locator('[data-definition-id="depth-8"] .live-value'),
  ).toContainText("ft");
  expect(metadataResponses.routes).toHaveLength(9);
  await page.screenshot({
    path: `test-results/initial-load-ready-${test.info().project.name}.png`,
    fullPage: true,
  });
});

for (const failure of ["unavailable", "timeout"]) {
  test(`keeps alerts usable when metadata is ${failure}`, async ({ page }) => {
    await page.route("**/signalk/v1/api/vessels/self/**/meta", (route) =>
      failure === "unavailable"
        ? route.fulfill({ status: 503, json: {} })
        : undefined,
    );
    await page.goto("/signalk-alert-center/");
    await expect(page.locator("#definition-list tbody tr")).toHaveCount(9, {
      timeout: 2000,
    });
    await page.locator("#alert-search").fill("Depth 8");
    await expect(page.locator("#definition-list tbody tr")).toHaveCount(1);
    if (failure === "timeout") {
      // Cross the real fetch timeout while exercising the visible list.
      await expect
        .poll(() => page.evaluate(() => performance.now()), { timeout: 7000 })
        .toBeGreaterThan(5100);
    }
    await expect(page.locator("#definition-list")).toContainText("Depth 8");
    await expect(page.locator("#error")).toBeHidden();
  });
}

for (const view of ["history", "deliveries"] as const) {
  const endpoint = view === "history" ? "alert-history" : "deliveries";
  const tab = view === "history" ? "alert-history-tab" : "deliveries-tab";
  const panel = view === "history" ? "alert-history-list" : "delivery-list";
  const more = view === "history" ? "alert-history-more" : "deliveries-more";
  const item = (id: string) =>
    view === "history"
      ? {
          id,
          alertId: "occurrence-0",
          path: definitions[0].pathPattern,
          definitionId: "depth-0",
          eventType: "raised",
          occurredAt: "2026-01-01T10:00:00Z",
          message: id,
        }
      : {
          id,
          state: "delivered",
          alert: { path: definitions[0].pathPattern, name: id },
          service: { name: "Mock", type: "ntfy" },
        };

  test(`loads ${view} on selection, paginates, and refreshes only while visible`, async ({
    page,
  }) => {
    const calls: URL[] = [];
    await page.route(`**${plugin}/${endpoint}?*`, (route) => {
      const url = new URL(route.request().url());
      calls.push(url);
      return route.fulfill({
        json: url.searchParams.has("cursor")
          ? { items: [item("Older entry")], total: 2 }
          : { items: [item("Newest entry")], total: 2, nextCursor: "older" },
      });
    });
    await page.goto("/signalk-alert-center/");
    await expect(page.locator("#definition-list tbody tr")).toHaveCount(9);
    expect(calls).toHaveLength(0);
    await page.locator(`#${tab}`).click();
    await expect(page.locator(`#${panel}`)).toContainText("Newest entry");
    await page.locator(`#${more}`).click();
    await expect(page.locator(`#${panel}`)).toContainText("Older entry");
    expect(calls[1].searchParams.get("cursor")).toBe("older");
    if (view === "deliveries") {
      expect(calls[0].searchParams.get("includeTotal")).toBe("false");
      await expect(page.locator("#delivery-tab-count")).toHaveText("4");
    }
    await page.evaluate(() =>
      document.dispatchEvent(new Event("test-alert-change")),
    );
    await expect.poll(() => calls.length).toBe(3);
    await expect(page.locator(`#${panel}`)).toContainText("Newest entry");
    if (view === "history")
      await expect(page.locator(`#${panel}`)).toContainText("Older entry");
    await page.locator("#alerts-tab").click();
    await page.locator("#refresh").click();
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector("#updated")?.textContent),
      )
      .toContain("Updated");
    expect(calls).toHaveLength(3);
    await page.locator(`#${tab}`).click();
    await expect.poll(() => calls.length).toBe(4);
  });

  test(`opens a direct ${view} link and retries after a failed tab request`, async ({
    page,
  }) => {
    let fail = true;
    const calls: string[] = [];
    await page.route(`**${plugin}/${endpoint}?*`, (route) => {
      calls.push(route.request().url());
      return route.fulfill(
        fail
          ? { status: 503, json: { error: { message: "History unavailable" } } }
          : { json: { items: [item("Recovered entry")] } },
      );
    });
    await page.goto(`/signalk-alert-center/#${view}`);
    await expect(page.locator(`#${tab}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#error")).toContainText("History unavailable");
    expect(calls).toHaveLength(1);
    await page.locator("#alerts-tab").click();
    await expect(page.locator("#definition-list tbody tr")).toHaveCount(9);
    fail = false;
    await page.locator(`#${tab}`).click();
    await expect(page.locator(`#${panel}`)).toContainText("Recovered entry");
  });
}

test("a pending hidden tab does not block alert refreshes or replace newer filtered history", async ({
  page,
}) => {
  const pending: Route[] = [];
  let calls = 0;
  await page.route(`**${plugin}/alert-history?*`, (route) => {
    calls++;
    if (calls === 1) {
      pending.push(route);
      return;
    }
    return route.fulfill({
      json: {
        items: [
          {
            id: "new-filter",
            path: definitions[0].pathPattern,
            eventType: "cleared",
            message: "Current filter result",
          },
        ],
      },
    });
  });
  await page.goto("/signalk-alert-center/#history");
  await expect.poll(() => pending.length).toBe(1);
  await page.locator("#alerts-tab").click();
  await expect(page.locator("#definition-list tbody tr")).toHaveCount(9);
  await page.route(`**${plugin}/definitions?*`, (route) =>
    route.fulfill({
      json: { items: definitions.slice(0, 3) },
    }),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("test-alert-change")),
  );
  await expect(page.locator("#definition-list tbody tr")).toHaveCount(3);
  expect(calls).toBe(1);

  await page.locator("#alert-history-tab").click();
  await expect(page.locator("#alert-history-list")).toContainText(
    "Current filter result",
  );
  await page.locator("#history-event-filter").selectOption("cleared");
  await expect.poll(() => calls).toBe(3);
  const oldResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/alert-history?") &&
      !new URL(response.url()).searchParams.has("eventType"),
  );
  await pending[0].fulfill({
    json: {
      items: [
        {
          id: "old-filter",
          path: definitions[0].pathPattern,
          eventType: "raised",
          message: "Stale filter result",
        },
      ],
    },
  });
  await oldResponse;
  await expect(page.locator("#alert-history-list")).toContainText(
    "Current filter result",
  );
  await expect(page.locator("#alert-history-list")).not.toContainText(
    "Stale filter result",
  );
});

test("shows only the undelivered count while the tab retains completed and suppressed history", async ({
  page,
}) => {
  let undelivered = 6;
  await page.route(`**${plugin}/summary`, (route) =>
    route.fulfill({
      json: {
        alerts: {
          pendingDelivery: Math.min(5, undelivered),
          undeliveredDelivery: undelivered,
        },
      },
    }),
  );
  await page.route(`**${plugin}/deliveries?*`, (route) =>
    route.fulfill({
      json: {
        total: 100000,
        items: [
          "pending",
          "failed_retryable",
          "paused",
          "failed_terminal",
          "delivered",
          "suppressed",
        ].map((state) => ({
          id: state,
          state,
          alert: {
            path: `notifications.test.${state}`,
            name: `History ${state}`,
          },
          service: { name: "Mock", type: "ntfy" },
        })),
      },
    }),
  );
  await page.goto("/signalk-alert-center/");
  await expect(page.locator("#delivery-tab-count")).toHaveText("6");
  await expect(page.locator("#delivery-tab-count")).toHaveAttribute(
    "title",
    /undelivered.*including failures/,
  );
  await page.locator("#deliveries-tab").click();
  await expect(page.locator("#delivery-list tbody tr")).toHaveCount(6);
  await expect(page.locator("#delivery-list")).toContainText(
    "History delivered",
  );
  await expect(page.locator("#delivery-list")).toContainText(
    "History suppressed",
  );
  await expect(page.locator("#delivery-tab-count")).toHaveText("6");
  await page.locator("#alerts-tab").click();
  undelivered = 0;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("test-alert-change")),
  );
  await expect(page.locator("#delivery-tab-count")).toHaveText("0");
  await page.screenshot({
    path: `test-results/undelivered-badge-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("loads full diagnostics only while expanded", async ({ page }) => {
  let diagnosticsCalls = 0;
  await page.route(`**${plugin}/status`, (route) => {
    diagnosticsCalls++;
    return route.fulfill({
      json: {
        health: { state: "healthy" },
        database: { healthy: true, schemaVersion: 4, expectedSchemaVersion: 4 },
        services: [
          {
            id: "Mock",
            name: "Mock",
            type: "ntfy",
            enabled: true,
            pendingCount: 0,
          },
        ],
      },
    });
  });
  await page.goto("/signalk-alert-center/");
  await expect(page.locator("#definition-list tbody tr")).toHaveCount(9);
  await expect(page.locator("#delivery-tab-count")).toHaveText("4");
  expect(diagnosticsCalls).toBe(0);
  await page.locator(".system-diagnostics summary").click();
  await expect(page.locator("#health-state")).toHaveText("healthy");
  await expect(page.locator("#diagnostics-list")).toContainText("schema 4/4");
  expect(diagnosticsCalls).toBe(1);
  await page.locator("#refresh").click();
  await expect.poll(() => diagnosticsCalls).toBe(2);
  await page.locator(".system-diagnostics summary").click();
  await page.route(`**${plugin}/summary`, (route) =>
    route.fulfill({
      json: {
        alerts: { pendingDelivery: 3, undeliveredDelivery: 4 },
        snooze: {
          active: true,
          endsAt: new Date(Date.now() + 600000).toISOString(),
        },
      },
    }),
  );
  await page.locator("#refresh").click();
  await expect(page.locator("#delivery-tab-count")).toHaveText("4");
  await expect(page.locator("#notifier-tests button")).toBeDisabled();
  expect(diagnosticsCalls).toBe(2);
});
