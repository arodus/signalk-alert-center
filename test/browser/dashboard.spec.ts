import { expect, test } from "@playwright/test";

const plugin = "/plugins/signalk-persistent-notifier";
const fixture = "/plugins/signalk-test-fixture";

test.beforeEach(async ({ request }) => {
  await request.post(`${fixture}/seed`);
});

test("shows alerts, opens details, edits settings, and filters exact sources", async ({
  page,
}) => {
  await page.goto("/signalk-persistent-notifier/");
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
  await page.getByRole("button", { name: "Alert settings" }).click();
  await expect(page.locator("#policy-dialog")).toBeVisible();
  await expect(page.getByRole("group", { name: "Local sound" })).toBeVisible();
  await expect(page.locator("#audio-sound")).toHaveValue("severity");
  await expect(page.locator("#audio-sound option")).toHaveCount(5);
  await expect(page.locator("#policy-inheritance-status")).toHaveText(
    "Using global defaults",
  );
  await expect(page.locator("#policy-reset")).toBeDisabled();
  const audioModeSetting = page.locator('[data-policy-field="audio.mode"]');
  await expect(audioModeSetting.locator("#audio-mode")).toBeDisabled();
  await audioModeSetting
    .getByRole("button", { name: "Customize playback behavior" })
    .click();
  await expect(audioModeSetting.locator("#audio-mode")).toBeEnabled();
  await expect(page.locator("#policy-inheritance-status")).toHaveText(
    "1 custom setting",
  );
  await page.locator("#audio-mode").selectOption("repeat");
  await expect(page.locator("#audio-repeat-field")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.locator("#drawer-close").click();

  await page.getByText("More filters").click();
  await page.locator("#source-filter").fill("demo.fridge.sensor");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(fridge).toBeVisible();
  await expect(page.locator("#definition-list")).not.toContainText(
    "High water detected",
  );
});

test("refreshes from the live event stream without a page reload", async ({
  page,
  request,
}) => {
  await page.goto("/signalk-persistent-notifier/");
  const marker = `Browser SSE ${Date.now()}`;
  await request.post(`${fixture}/raise`, {
    data: { source: `browser.sse.${Date.now()}`, message: marker },
  });
  await expect(page.locator("#definition-list")).toContainText(marker);
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
    /\/plugins\/signalk-persistent-notifier\/deliveries(?:\/.*)?(?:\?.*)?$/,
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

  await page.goto("/signalk-persistent-notifier/");
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
  await page.goto("/signalk-persistent-notifier/#deliveries");
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
  await page.goto("/signalk-persistent-notifier/");
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#error")).toContainText("Sign in to Signal K");
});

test("saves a notification service after changing its type", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Configuration is shared by both browser projects.",
  );

  await page.goto("/admin/#/apps/configuration/signalk-persistent-notifier");
  await expect(
    page.getByText("Enable local audio playback", { exact: true }),
  ).toBeVisible();
  const services = page.locator("#root_configuration_notifiers");
  await services.getByRole("button").last().click();
  await page.locator("#root_configuration_notifiers_0_name").fill("Bridge");
  await page
    .locator("#root_configuration_notifiers_0_type")
    .selectOption({ label: "PagerDuty" });
  await page
    .locator("#root_configuration_notifiers_0_routingKey")
    .fill("browser-test-integration-key");
  await page.getByRole("button", { name: "Save Configuration" }).click();

  await expect(
    page.getByText("Configuration saved successfully!"),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Errors" })).toHaveCount(0);
});
