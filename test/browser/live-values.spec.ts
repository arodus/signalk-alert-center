import { expect, test } from "@playwright/test";

const plugin = "/plugins/signalk-alert-center";
const fixture = "/plugins/signalk-test-fixture";

test("shows live converted readings and age while history keeps the receipt value", async ({
  page,
  request,
}) => {
  const sensor = "environment.inside.refrigerator.temperature";
  const path = `notifications.${sensor}`;
  const source = "fixture.live-values";
  await request.post(`${fixture}/clear`, { data: { path, source } });
  await request.post(`${fixture}/reading`, { data: { value: 280.15 } });
  await request.post(`${fixture}/raise`, {
    data: { path, source, message: "273.15 < value < 373.15" },
  });
  let id = "";
  await expect
    .poll(async () => {
      const response = await request.get(
        `${plugin}/occurrences?source=${source}&state=active`,
      );
      const occurrence = (await response.json()).items[0];
      id = occurrence?.id;
      return occurrence?.messageSample?.value;
    })
    .toBe(280.15);
  await page.route(
    "**/signalk/v1/api/vessels/self/environment/inside/refrigerator/temperature/meta",
    (route) =>
      route.fulfill({
        json: {
          units: "K",
          displayUnits: { formula: "value - 273.15", symbol: "°C" },
        },
      }),
  );
  await page.goto("/signalk-alert-center/");
  const row = page.locator(`tr[data-occurrence-id="${id}"]`);
  await expect(row.locator('[data-label="Value"]')).toHaveText("7 °C");
  await expect(row.locator('[data-label="Age"]')).toHaveText(/\d+s/);
  await expect(row.locator(".alert-summary")).toContainText(
    "0 °C ≤ 7 °C < 100 °C",
  );
  await request.post(`${fixture}/reading`, { data: { value: 282.15 } });
  await expect(row.locator('[data-label="Value"]')).toHaveText("9 °C");
  await expect(row.locator(".alert-summary")).toContainText(
    "0 °C ≤ 9 °C < 100 °C",
  );
  await page.screenshot({
    path: `test-results/live-values-overview-${test.info().project.name}.png`,
    fullPage: true,
  });
  await expect(
    row.getByRole("button", { name: "Acknowledge", exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Silence", exact: true }),
  ).toBeVisible();
  expect(
    (await (await request.get(`${plugin}/occurrences/${id}`)).json())
      .messageSample.value,
  ).toBe(280.15);
  await row.click();
  await expect(page.locator("#drawer-body > p").first()).toContainText(
    "0 °C ≤ 7 °C < 100 °C",
  );
  await expect(page.locator("#event-list")).toContainText(
    "0 °C ≤ 7 °C < 100 °C",
  );
  await expect(
    page
      .locator("#drawer-body")
      .getByRole("button", { name: "Acknowledge", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("#drawer-body")
      .getByRole("button", { name: "Silence", exact: true }),
  ).toBeVisible();
  await page
    .locator("#drawer-body")
    .getByRole("button", { name: "Acknowledge", exact: true })
    .click();
  await expect(
    page
      .locator("#drawer-body")
      .getByRole("button", { name: "Acknowledged", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: `test-results/live-values-history-${test.info().project.name}.png`,
    fullPage: true,
  });
  const occurrence = await (
    await request.get(`${plugin}/occurrences/${id}`)
  ).json();
  const history = await (
    await request.get(`${plugin}/occurrences/${id}/events`)
  ).json();
  expect(
    history.items.find((event) => event.eventType === "raised").messageSample
      .value,
  ).toBe(280.15);
  expect(occurrence.message).toBe("273.15 < value < 373.15");
  await request.post(`${fixture}/clear`, { data: { path, source } });
});

test("keeps a learned alert's reading live after it clears", async ({
  page,
  request,
}) => {
  const sensor = "environment.depth.belowKeel";
  const path = `notifications.${sensor}`;
  const source = "fixture.inactive-values";
  await request.post(`${fixture}/clear`, { data: { path, source } });
  await request.post(`${fixture}/reading`, {
    data: { path: sensor, value: 10 },
  });
  await request.post(`${fixture}/raise`, {
    data: { path, source, message: "Depth alert" },
  });
  let definitionId = "";
  await expect
    .poll(async () => {
      const body = await (
        await request.get(`${plugin}/occurrences?source=${source}&state=active`)
      ).json();
      definitionId = body.items[0]?.definitionId;
      return Boolean(definitionId);
    })
    .toBe(true);
  await request.post(`${fixture}/clear`, { data: { path, source } });
  await page.route(
    "**/signalk/v1/api/vessels/self/environment/depth/belowKeel/meta",
    (route) => route.fulfill({ json: { units: "m" } }),
  );
  await page.goto("/signalk-alert-center/");
  const row = page.locator(`tr[data-definition-id="${definitionId}"]`);
  await expect(row.locator('[data-label="State"]')).toHaveText("inactive");
  await expect(row.locator('[data-label="Value"]')).toHaveText("10 m");
  await expect(row.locator('[data-label="Age"]')).toHaveText(/\d+s/);
  await request.post(`${fixture}/reading`, {
    data: { path: sensor, value: 12 },
  });
  await expect(row.locator('[data-label="Value"]')).toHaveText("12 m");
  await expect(row.locator('[data-label="State"]')).toHaveText("inactive");
});
