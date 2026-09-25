import { expect, test } from "@playwright/test";

const plugin = "/plugins/signalk-alert-center";
const fixture = "/plugins/signalk-test-fixture";

test.beforeEach(async ({ request }) => {
  await request.post(`${fixture}/seed`);
});

test("shows alerts, opens details, edits settings, and filters exact sources", async ({
  page,
}) => {
  await page.goto("/signalk-alert-center/");
  await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
  await expect(page.locator("#health-state")).toHaveText(/healthy|degraded/);
  const diagnostics = page.locator(".system-diagnostics");
  await expect(diagnostics).not.toHaveAttribute("open", "");
  expect(
    await page
      .locator("#deliveries-panel")
      .evaluate((deliveries) =>
        Boolean(
          deliveries.compareDocumentPosition(
            document.querySelector(".system-diagnostics")!,
          ) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
  ).toBe(true);
  const diagnosticsSummary = diagnostics.locator("summary");
  await diagnosticsSummary.focus();
  await diagnosticsSummary.press("Enter");
  await expect(diagnostics).toHaveAttribute("open", "");
  await expect(page.locator("#diagnostics-list")).toContainText("Database");
  await expect(page.locator("#diagnostics-list")).toContainText(
    "Startup reconciliation",
  );
  await diagnosticsSummary.press("Enter");
  await expect(diagnostics).not.toHaveAttribute("open", "");
  const fridge = page
    .locator("tr.clickable-row")
    .filter({ hasText: "Refrigerator temperature" })
    .first();
  await expect(fridge).toBeVisible();
  await fridge.click();
  await expect(page.locator("#detail-drawer")).toHaveClass(/is-open/);
  await expect(
    page.getByRole("heading", { name: "Recent occurrences" }),
  ).toBeVisible();
  const recentOccurrences = page.locator(".recent-occurrence");
  expect(await recentOccurrences.count()).toBeGreaterThan(0);
  expect(await recentOccurrences.count()).toBeLessThanOrEqual(5);
  await expect(recentOccurrences.first()).toContainText("Occurrence");
  await expect(recentOccurrences.first().locator("time")).not.toHaveText("—");
  await page.getByRole("button", { name: "Alert settings" }).click();
  await expect(page.locator("#policy-dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove stored alert" }),
  ).toBeDisabled();
  await expect(page.locator("#policy-remove-help")).toContainText(
    "Clear it in Signal K",
  );
  await expect(page.locator("#policy-inheritance-status")).toHaveText(
    "Using global defaults",
  );
  await expect(page.locator("#policy-reset")).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.locator("#drawer-close").click();

  const alertsPanel = page.locator("#alerts-panel");
  await alertsPanel.getByText("More filters").click();
  await page.locator("#source-filter").fill("demo.fridge.sensor");
  await alertsPanel.getByRole("button", { name: "Apply" }).click();
  await expect(fridge).toBeVisible();
  await expect(page.locator("#definition-list")).not.toContainText(
    "High water detected",
  );
});

test("refreshes from the live event stream without a page reload", async ({
  page,
  request,
}) => {
  await page.goto("/signalk-alert-center/");
  const marker = `Browser SSE ${Date.now()}`;
  await request.post(`${fixture}/raise`, {
    data: { source: `browser.sse.${Date.now()}`, message: marker },
  });
  await expect(page.locator("#definition-list")).toContainText(marker);
});

test("shows alert updates in a separate history tab without delivery data", async ({
  page,
}) => {
  await page.goto("/signalk-alert-center/#history");
  await expect(page.locator("#alert-history-panel")).toBeVisible();
  await expect(page.locator("#alerts-panel")).toBeHidden();
  await expect(page.locator("#deliveries-panel")).toBeHidden();
  await expect(page.locator("#alert-history-list")).toContainText(
    "Refrigerator temperature",
  );
  await expect(page.locator("#alert-history-list")).toContainText("raised");
  await expect(page.locator("#alert-history-list")).not.toContainText(
    "Notification service",
  );

  await page.locator(".alert-history-row").first().click();
  await expect(page.locator("#detail-drawer")).toHaveClass(/is-open/);
  await expect(
    page.getByRole("heading", { name: "Recent occurrences" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Occurrence timeline" }),
  ).toBeVisible();
  await expect(page.locator("#drawer-body")).not.toContainText(
    "Notifier outcomes",
  );
});

test("navigates delivery history, opens attempts, and retries one failure", async ({
  page,
}) => {
  let retryCount = 0;
  const delivery = {
    id: "delivery-1",
    alertId: "occurrence-4",
    transportInstanceId: "Bridge alerts",
    state: "failed_retryable",
    attemptCount: 1,
    lastAttemptAt: "2026-09-10T12:01:00.000Z",
    nextAttemptAt: "2026-09-10T12:02:00.000Z",
    lastErrorCode: "DELIVERY_TIMEOUT",
    lastErrorMessage: "Notification service did not respond",
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:01:00.000Z",
    alert: {
      occurrenceId: "occurrence-4",
      occurrenceNumber: 4,
      name: "High water",
      path: "notifications.bilge.highWater",
      message: "Port bilge water level is high",
    },
    service: { id: "Bridge alerts", name: "Bridge alerts", type: "ntfy" },
  };
  await page.route(
    /\/plugins\/signalk-alert-center\/deliveries(?:\/.*)?(?:\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/delivery-1/retry")) {
        retryCount += 1;
        return route.fulfill({ json: { status: "scheduled" } });
      }
      if (url.pathname.endsWith("/delivery-1/attempts"))
        return route.fulfill({
          json: {
            items: [
              {
                id: 1,
                deliveryId: "delivery-1",
                attemptNumber: 1,
                startedAt: "2026-09-10T12:00:30.000Z",
                finishedAt: "2026-09-10T12:01:00.000Z",
                outcome: "failed_retryable",
                errorCode: "DELIVERY_TIMEOUT",
                errorMessage: "Notification service did not respond",
              },
            ],
          },
        });
      if (url.pathname.endsWith("/delivery-1"))
        return route.fulfill({ json: delivery });
      return route.fulfill({ json: { items: [delivery] } });
    },
  );

  await page.goto("/signalk-alert-center/");
  await expect(page.locator("#alerts-panel")).toBeVisible();
  await expect(page.locator("#deliveries-panel")).toBeHidden();
  await page.getByRole("tab", { name: /Deliveries/ }).click();
  await expect(page.locator("#alerts-panel")).toBeHidden();
  await expect(page.locator("#deliveries-panel")).toBeVisible();
  await page.locator("[data-delivery-id='delivery-1']").click();
  await expect(page.locator("#delivery-dialog")).toBeVisible();
  await expect(page.locator("#delivery-dialog-body")).toContainText(
    "Bridge alerts · ntfy",
  );
  await expect(page.locator("#delivery-attempt-list")).toContainText(
    "Attempt 1 · failed retryable",
  );
  await page.getByRole("button", { name: "Retry this delivery" }).click();
  await expect(page.locator("#delivery-dialog-result")).toContainText(
    "scheduled for retry",
  );
  expect(retryCount).toBe(1);
});

test("shows an empty Deliveries tab", async ({ page }) => {
  await page.route(`**${plugin}/deliveries**`, (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.goto("/signalk-alert-center/#deliveries");
  await expect(page.locator("#deliveries-panel")).toBeVisible();
  await expect(page.locator("#delivery-list")).toContainText(
    "No deliveries yet",
  );
});

test("surfaces authentication failures", async ({ page }) => {
  await page.route(`**${plugin}/**`, async (route) => {
    if (route.request().url().endsWith("/events")) return route.abort();
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"error":"unauthorized"}',
    });
  });
  await page.goto("/signalk-alert-center/");
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#error")).toContainText("Sign in to Signal K");
});

test("tests a PagerDuty alert and resolve without overlapping clicks", async ({
  page,
}) => {
  let calls = 0;
  const operations: string[] = [];
  await page.route(`**${plugin}/status`, async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        services: [
          {
            id: "Test PagerDuty",
            name: "Test PagerDuty",
            type: "pagerduty",
            enabled: true,
            pendingCount: 0,
          },
        ],
      },
    });
  });
  await page.route(
    `**${plugin}/notifiers/Test%20PagerDuty/test`,
    async (route) => {
      calls += 1;
      const body = route.request().postDataJSON() as { operation: string };
      operations.push(body.operation);
      await new Promise((resolve) => setTimeout(resolve, 75));
      await route.fulfill({
        json: {
          status: "success",
          category: "success",
          message:
            body.operation === "resolve"
              ? "PagerDuty accepted the test-incident resolve event."
              : "PagerDuty accepted the test alert. A real test incident was opened or updated.",
          durationMs: 75,
          operation: body.operation,
          service: { id: "Test PagerDuty", type: "pagerduty" },
        },
      });
    },
  );

  await page.goto("/signalk-alert-center/");
  await page.locator(".system-diagnostics summary").click();
  const card = page.locator(".service-test-card").filter({
    hasText: "Test PagerDuty",
  });
  const alertButton = card.getByRole("button", { name: "Test alert" });
  await alertButton.evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(card.getByRole("status")).toContainText("real test incident");
  expect(calls).toBe(1);

  await card.getByRole("button", { name: "Test resolve" }).click();
  await expect(card.getByRole("status")).toContainText("resolve event");
  expect(calls).toBe(2);
  expect(operations).toEqual(["send", "resolve"]);
});

test("saves a Telegram service and selects it as a default", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Configuration is shared by both browser projects.",
  );

  await page.goto("/admin/#/apps/configuration/signalk-alert-center");
  await expect(
    page.getByRole("heading", { name: "Alert Center settings" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Notification services", exact: true })
    .click();
  await page.getByRole("button", { name: "Add notification service" }).click();
  const service = page.getByTestId("notification-service").last();
  await expect(service.getByText(/^Service \d+$/)).toBeVisible();
  await expect(
    service.getByText("Unnamed service", { exact: true }),
  ).toBeVisible();
  await service.getByLabel("Service name").fill("Bridge");
  await expect(service.getByText("Bridge", { exact: true })).toBeVisible();
  await service.getByLabel("Service type").selectOption("telegram");
  await service
    .getByLabel("Telegram bot token")
    .fill("123456:browser-test-bot-token");
  await service.getByLabel("Telegram chat ID").fill("-1001234567890");
  await service
    .getByLabel("Repeat while the alert remains active (seconds)")
    .fill("300");
  await service.getByLabel("Send Telegram messages silently").check();
  await page
    .getByRole("button", { name: "Alert defaults", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Default notification services/ })
    .click();
  await page.getByRole("checkbox", { name: /Bridge/ }).check();
  const savedRequest = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes("/skServer/plugins/signalk-alert-center/config") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await savedRequest).ok()).toBe(true);
  await expect(page.getByText("Save requested.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Errors" })).toHaveCount(0);
});

test("offers database reset as a confirmed action", async ({ page }) => {
  await page.goto("/admin/#/apps/configuration/signalk-alert-center");
  await page.getByRole("button", { name: "Storage & advanced" }).click();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("permanently deletes");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Reset database" }).click();
  await expect(
    page.getByRole("button", { name: "Reset database" }),
  ).toBeEnabled();
});

test("explains internet connection control in user-facing terms", async ({
  page,
}) => {
  await page.goto("/admin/#/apps/configuration/signalk-alert-center");
  await page.getByRole("button", { name: "Connectivity", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Internet connection control" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Allow Alert Center to control the internet connection"),
  ).toBeVisible();
  await expect(
    page.getByLabel(
      "Turn off an Alert Center-started connection after (seconds)",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/only when it originally turned it on/),
  ).toBeVisible();
});
