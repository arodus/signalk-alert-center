import { expect, test, type Page } from "@playwright/test";

const plugin = "/plugins/signalk-alert-center";

async function openSettings(page: Page) {
  await page.goto("/signalk-alert-center/");
  await page
    .locator("tr.clickable-row")
    .filter({ hasText: "Refrigerator temperature" })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Alert settings", exact: true })
    .click();
  await expect(page.locator("#policy-dialog")).toBeVisible();
}

let originalConfig;
test.beforeAll(async ({ request }) => {
  const plugins = await (await request.get("/skServer/plugins")).json();
  originalConfig = plugins.find(
    (item) => item.id === "signalk-alert-center",
  ).data;
  const response = await request.post(
    "/skServer/plugins/signalk-alert-center/config",
    {
      data: {
        ...originalConfig,
        configuration: {
          ...originalConfig.configuration,
          defaults: {
            ...originalConfig.configuration.defaults,
            notifiers: ["Settings test"],
            connectivity: { mode: "queue" },
          },
          notifiers: [
            {
              name: "Settings test",
              type: "ntfy",
              enabled: true,
              server: "http://notifier-mock:8080",
              topic: "settings-test",
            },
          ],
        },
      },
    },
  );
  expect(response.ok()).toBe(true);
  await expect
    .poll(async () => {
      const response = await request.get(`${plugin}/notifiers`);
      return response.ok() ? JSON.stringify(await response.json()) : "";
    })
    .toContain("Settings test");
});

test.afterAll(async ({ request }) => {
  if (originalConfig) {
    expect(
      (
        await request.post("/skServer/plugins/signalk-alert-center/config", {
          data: originalConfig,
        })
      ).ok(),
    ).toBe(true);
  }
});

test.beforeEach(async ({ request }) => {
  await request.post("/plugins/signalk-test-fixture/seed");
  const definitions = await (
    await request.get(`${plugin}/definitions?limit=100`)
  ).json();
  const fridge = definitions.items.find(
    (item) =>
      item.pathPattern ===
      "notifications.environment.inside.refrigerator.temperature",
  );
  expect(fridge).toBeTruthy();
  expect(
    (await request.delete(`${plugin}/definitions/${fridge.id}/policy`)).ok(),
  ).toBe(true);
});

test("keeps each override action inside its setting on wide and narrow screens", async ({
  page,
}) => {
  await openSettings(page);
  for (const width of [page.viewportSize()!.width, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const fields = page.locator("[data-policy-field]");
    for (const field of await fields.all()) {
      const button = field.getByRole("button");
      await expect(button).toHaveText("Customize");
      await button.scrollIntoViewIfNeeded();
      const box = (await field.boundingBox())!;
      const action = (await button.boundingBox())!;
      const header = (await field
        .locator(".policy-field-header")
        .boundingBox())!;
      expect(action.x).toBeGreaterThanOrEqual(box.x);
      expect(action.x + action.width).toBeLessThanOrEqual(box.x + box.width);
      expect(action.y).toBeGreaterThanOrEqual(header.y);
      expect(action.y + action.height).toBeLessThanOrEqual(
        header.y + header.height + 1,
      );
    }
    expect(
      await page
        .locator("#policy-dialog")
        .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
    ).toBe(true);
    await page
      .locator("#policy-dialog")
      .evaluate((dialog) => (dialog.scrollTop = 0));
    await page.screenshot({
      path: `test-results/alert-settings-${test.info().project.name}-${width}.png`,
    });
  }
});

test("saves independent overrides and restores only the chosen setting", async ({
  page,
}) => {
  await openSettings(page);
  const delay = page.locator('[data-policy-field="activationDelaySeconds"]');
  const sound = page.locator('[data-policy-field="soundEnabled"]');
  const connectivity = page.locator('[data-policy-field="connectivity"]');
  const services = page.locator('[data-policy-field="notifierIds"]');
  const defaultDelay = await page.locator("#activation-delay").inputValue();
  const defaultSound = await page.locator("#sound-enabled").isChecked();
  await delay.getByRole("button").focus();
  await delay.getByRole("button").press("Enter");
  await page.locator("#activation-delay").fill("45");
  await expect(delay.getByRole("button")).toHaveText("Use global default");
  await expect(page.locator("#minimum-severity")).toBeDisabled();
  await sound.getByRole("button").click();
  await page.locator("#sound-enabled").setChecked(!defaultSound);
  await connectivity.getByRole("button").click();
  await page.locator("#connectivity-mode").selectOption("wake_after");
  await expect(connectivity.locator("#wake-delay-field")).toBeVisible();
  await page.locator("#wake-delay").fill("120");
  await services.getByRole("button").click();
  const service = services.locator(".notifier-policy-option").first();
  await service.getByRole("checkbox").check();
  await service.locator(".notifier-repeat").fill("60");
  await service.getByRole("checkbox").uncheck();
  await expect(service.locator(".notifier-repeat")).toBeDisabled();
  await service.getByRole("checkbox").check();
  await expect(service.locator(".notifier-repeat")).toBeEnabled();

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/policy") &&
      response.request().method() === "PATCH",
  );
  await page.locator("#policy-save").click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({
    overrideFields: [
      "activationDelaySeconds",
      "notifierIds",
      "soundEnabled",
      "connectivity",
    ],
    activationDelaySeconds: 45,
    soundEnabled: !defaultSound,
    connectivity: { mode: "wake_after", delaySeconds: 120 },
  });
  await expect(page.locator("#policy-dialog")).not.toBeVisible();
  await openSettings(page);
  await expect(page.locator("#activation-delay")).toHaveValue("45");
  await expect(page.locator("#wake-delay")).toHaveValue("120");
  await expect(service.locator(".notifier-repeat")).toHaveValue("60");
  await delay.getByRole("button").click();
  await expect(page.locator("#activation-delay")).toBeDisabled();
  await expect(page.locator("#activation-delay")).toHaveValue(defaultDelay);
  await expect(sound.getByRole("button")).toHaveText("Use global default");
  await expect(page.locator("#sound-enabled")).toBeChecked({
    checked: !defaultSound,
  });
  await connectivity.getByRole("button").click();
  await expect(page.locator("#wake-delay")).toBeDisabled();
  await expect(page.locator("#wake-delay-field")).toBeHidden();
  await services.getByRole("button").click();
  await expect(service.locator(".notifier-repeat")).toBeDisabled();
  await expect(service.locator(".notifier-repeat")).toHaveValue("");
  await page.locator("#policy-save").click();
  await expect(page.locator("#policy-dialog")).not.toBeVisible();
  await openSettings(page);
  await expect(page.locator("#policy-inheritance-status")).toHaveText(
    "1 custom setting",
  );
  await expect(page.locator("#activation-delay")).toBeDisabled();
  await expect(sound.getByRole("button")).toHaveText("Use global default");
  await page.locator("#policy-reset").click();
  await expect(page.locator("#policy-inheritance-status")).toHaveText(
    "Using global defaults",
  );
});
