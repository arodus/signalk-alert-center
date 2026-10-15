import { expect, test } from "@playwright/test";
const api = "/plugins/signalk-alert-center";
test("global snooze dialog, persistent banner, cancellation and expiry", async ({
  page,
  request,
}) => {
  await request.delete(`${api}/snooze`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/signalk-alert-center/");
  await page.locator("#snooze-open").click();
  const dialog = page.locator("#snooze-dialog");
  await expect(dialog).toContainText("including emergencies");
  await dialog
    .getByRole("button", { name: "Snooze all alerts", exact: true })
    .click();
  await expect(page.locator("#snooze-banner")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/snooze-mobile-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(page.locator("#snooze-summary")).toContainText("remaining");
  await page.locator("#snooze-end").click();
  await expect(page.locator("#snooze-banner")).toBeHidden();
  expect(
    (
      await request.post(`${api}/snooze`, { data: { durationSeconds: 28801 } })
    ).status(),
  ).toBe(400);
  await request.post(`${api}/snooze`, { data: { durationSeconds: 2 } });
  await expect(page.locator("#snooze-banner")).toBeVisible();
  await expect(page.locator("#snooze-banner")).toBeHidden({ timeout: 10000 });
});

test("clearly marks snooze as bypassed while underway", async ({
  page,
  request,
}) => {
  await request.delete(`${api}/snooze`);
  await request.post(`${api}/snooze`, { data: { durationSeconds: 900 } });
  await page.route(`**${api}/status`, async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        snooze: {
          ...status.snooze,
          effective: false,
          bypassed: true,
          guardEnabled: true,
          bypassReason: "navigation_state_not_anchored_or_moored",
          navigationState: { value: "sailing" },
        },
      },
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/signalk-alert-center/");
  await expect(page.locator("#snooze-banner")).toHaveClass(/is-bypassed/);
  await expect(page.locator("#snooze-summary")).toContainText(
    "Snooze active but bypassed",
  );
  await expect(page.locator("#snooze-summary")).toContainText(
    "navigation.state is sailing",
  );
  await page.locator(".system-diagnostics summary").click();
  await expect(page.locator("#diagnostics-list")).toContainText(
    "Snooze navigation guard",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await request.delete(`${api}/snooze`);
});
