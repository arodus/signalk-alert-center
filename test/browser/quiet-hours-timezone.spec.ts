import { expect, test } from "@playwright/test";

test("quiet hours offers server-local time and a specific timezone", async ({
  page,
}) => {
  await page.goto("/admin/#/apps/configuration/signalk-alert-center");
  await expect(
    page.getByRole("heading", { name: "Alert Center settings" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Notification services", exact: true })
    .click();
  await page.getByRole("button", { name: "Add notification service" }).click();
  const service = page.getByTestId("notification-service").last();
  await service
    .getByRole("checkbox", { name: "Enable quiet hours", exact: true })
    .check();
  const basis = service.getByLabel("Quiet hours time basis", { exact: true });
  const zone = service.getByLabel("Quiet hours timezone", { exact: true });
  await expect(basis).toHaveValue("local");
  await expect(zone).toHaveCount(0);
  await basis.selectOption("specific");
  await zone.fill("America/Curacao");
  await expect(zone).toHaveValue("America/Curacao");
  await basis.selectOption("local");
  await expect(zone).toHaveCount(0);
  await service.screenshot({
    path: `test-results/local-time-${test.info().project.name}.png`,
  });
});
