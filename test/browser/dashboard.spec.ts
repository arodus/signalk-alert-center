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
  const fridge = page
    .locator("tr.clickable-row")
    .filter({ hasText: "Refrigerator temperature" })
    .first();
  await expect(fridge).toBeVisible();
  await fridge.click();
  await expect(page.locator("#detail-drawer")).toHaveClass(/is-open/);
  await page.getByRole("button", { name: "Alert settings" }).click();
  await expect(page.locator("#policy-dialog")).toBeVisible();
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
