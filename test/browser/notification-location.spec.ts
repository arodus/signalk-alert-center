import { expect, test } from "@playwright/test";

const fixture = "/plugins/signalk-test-fixture";
const plugin = "/plugins/signalk-alert-center";
test("shows escaped locations in the list, details and history", async ({
  page,
  request,
}) => {
  const source = `fixture.location.${test.info().project.name}`;
  const path = "notifications.test.location";
  const location = "Engine room <port> & bilge";
  await request.post(`${fixture}/clear`, { data: { path, source } });
  await request.post(`${fixture}/raise`, {
    data: { path, source, message: "High water", location },
  });
  let id = "";
  await expect
    .poll(async () => {
      const items = (
        await (
          await request.get(
            `${plugin}/occurrences?source=${source}&state=active`,
          )
        ).json()
      ).items;
      id = items[0]?.id;
      return items[0]?.location;
    })
    .toBe(location);
  await page.goto("/signalk-alert-center/");
  const row = page.locator(`tr[data-occurrence-id="${id}"]`);
  await expect(row.locator(".alert-location")).toHaveText(location);
  await row.click();
  await expect(page.locator("#drawer-body .detail-grid")).toContainText(
    location,
  );
  await expect(page.locator("#event-list .event-location").first()).toHaveText(
    `Location: ${location}`,
  );
  await page.screenshot({
    path: `test-results/notification-location-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/notification-location-mobile-${test.info().project.name}.png`,
    fullPage: true,
  });
});
