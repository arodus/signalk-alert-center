import { expect, test } from "@playwright/test";
const api = "/plugins/signalk-alert-center";
test("global snooze dialog, persistent banner, cancellation and expiry", async ({
  page,
  request,
}) => {
  await request.delete(`${api}/snooze`);
  await page.goto("/signalk-alert-center/");
  await page.locator("#snooze-open").click();
  const dialog = page.locator("#snooze-dialog");
  await expect(dialog).toContainText("including emergencies");
  await dialog
    .getByRole("button", { name: "Snooze all alerts", exact: true })
    .click();
  await expect(page.locator("#snooze-banner")).toBeVisible();
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
