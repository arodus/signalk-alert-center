import { expect, test } from "@playwright/test";

test("configures Pushover with masked credentials and optional destination settings", async ({
  page,
}, testInfo) => {
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
    .getByLabel("Service name")
    .fill(`Pushover ${testInfo.project.name}`);
  await service.getByLabel("Service type").selectOption("pushover");
  // Disabled fixture: saving must never send messages to the real service.
  await service
    .getByRole("checkbox", { name: "Service enabled", exact: true })
    .uncheck();
  await service
    .getByLabel("Pushover application API token")
    .fill("a".repeat(30));
  await service.getByLabel("Pushover user or group key").fill("u".repeat(30));
  await service.getByLabel("Pushover devices").fill("bridge,phone");
  await service.getByLabel("Pushover sound").fill("siren");
  await expect(
    service.getByLabel("Pushover application API token"),
  ).toHaveAttribute("type", "password");
  await expect(
    service.getByLabel("Pushover user or group key"),
  ).toHaveAttribute("type", "password");
  await service.screenshot({
    path: `test-results/pushover-${testInfo.project.name}.png`,
  });
  const saved = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes("/skServer/plugins/signalk-alert-center/config") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(
    response.request().postDataJSON().configuration.notifiers.at(-1),
  ).toMatchObject({
    type: "pushover",
    enabled: false,
    applicationToken: "a".repeat(30),
    userKey: "u".repeat(30),
    device: "bridge,phone",
    sound: "siren",
  });
  await expect(page.getByRole("heading", { name: "Errors" })).toHaveCount(0);
});
