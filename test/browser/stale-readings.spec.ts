import { expect, test } from "@playwright/test";

const plugin = "/plugins/signalk-alert-center";
const fixture = "/plugins/signalk-test-fixture";

test("shows stale age and recovery without creating timeout alerts", async ({
  page,
  request,
}) => {
  const sensor = `environment.staleReading.browser${test.info().project.name}`;
  const path = `notifications.${sensor}`;
  const lastValid = new Date(Date.now() - 125_000).toISOString();
  let leaf = {
    value: null as number | null,
    timestamp: new Date().toISOString(),
    state: {
      timedOut: true,
      lastValue: { value: 4.2, timestamp: lastValid },
    } as object | undefined,
  };
  await request.post(`${fixture}/reading`, {
    data: { path: sensor, value: 4.2 },
  });
  // A normal notification discovers the path without raising an occurrence.
  await request.post(`${fixture}/raise`, {
    data: { path, state: "normal", message: "Sensor is normal" },
  });
  let definitionId = "";
  await expect
    .poll(async () => {
      const body = await (
        await request.get(`${plugin}/definitions?limit=100`)
      ).json();
      definitionId = body.items.find((item) => item.pathPattern === path)?.id;
      return Boolean(definitionId);
    })
    .toBe(true);
  const storedWork = async () => {
    const query = `definitionId=${encodeURIComponent(definitionId)}`;
    const [occurrences, history, deliveries] = await Promise.all(
      [
        `${plugin}/occurrences?${query}`,
        `${plugin}/alert-history?${query}`,
        `${plugin}/deliveries?search=${encodeURIComponent(path)}`,
      ].map(async (url) => (await (await request.get(url)).json()).items),
    );
    return { occurrences, history, deliveries };
  };
  const originalWork = await storedWork();
  expect(originalWork.occurrences).toEqual([]);
  expect(originalWork.deliveries).toEqual([]);
  await page.route(
    `**/signalk/v1/api/vessels/self/${sensor.replaceAll(".", "/")}`,
    (route) => route.fulfill({ json: leaf }),
  );
  await page.goto("/signalk-alert-center/");
  await expect(
    page.getByRole("button", { name: "Add data timeout rule" }),
  ).toHaveCount(0);
  const row = page.locator(`tr[data-definition-id="${definitionId}"]`);
  await expect(row.locator('[data-label="Value"]')).toHaveText("Stale");
  await expect(row.locator('[data-label="Age"]')).toHaveText("2m");
  await expect(row.locator('[data-label="State"]')).toHaveText("normal");
  expect(await storedWork()).toEqual(originalWork);
  await page.screenshot({
    path: `test-results/stale-reading-${test.info().project.name}.png`,
    fullPage: true,
  });
  leaf = { value: 5, timestamp: new Date().toISOString(), state: undefined };
  await request.post(`${fixture}/reading`, {
    data: { path: sensor, value: 5 },
  });
  await expect(row.locator('[data-label="Value"]')).toHaveText("5");
  await expect(row.locator('[data-label="Age"]')).toHaveText(/\d+s/);
  expect(await storedWork()).toEqual(originalWork);
  // A final timeout in a burst must not be dropped by leading-only debounce.
  await page.waitForTimeout(150);
  leaf = {
    value: null,
    timestamp: new Date().toISOString(),
    state: { timedOut: true, lastValue: { value: 5, timestamp: lastValid } },
  };
  await request.post(`${fixture}/reading`, {
    data: { path: sensor, value: null },
  });
  await expect(row.locator('[data-label="Value"]')).toHaveText("Stale");
  await expect(row.locator('[data-label="Age"]')).toHaveText("2m");
  await expect(row.locator('[data-label="State"]')).toHaveText("normal");
  expect(await storedWork()).toEqual(originalWork);
  await request.delete(
    `${plugin}/definitions/${encodeURIComponent(definitionId)}`,
  );
});
