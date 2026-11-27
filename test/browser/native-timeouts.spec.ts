import { expect, test } from "@playwright/test";

const plugin = "/plugins/signalk-alert-center";
const fixture = "/plugins/signalk-test-fixture";

test("creates a native timeout rule with prerequisite guidance and shows stale last-valid age", async ({
  page,
  request,
}) => {
  const sensor = `environment.nativeTimeout.browser${test.info().project.name}`;
  const name = `Depth timeout ${test.info().project.name}`;
  const lastValid = new Date(Date.now() - 125_000).toISOString();
  let leaf = {
    value: null as number | null,
    timestamp: new Date().toISOString(),
    state: {
      timedOut: true,
      lastValue: { value: 4.2, timestamp: lastValid },
    } as object | undefined,
  };
  await page.route(
    `**/signalk/v1/api/vessels/self/${sensor.replaceAll(".", "/")}`,
    (route) => route.fulfill({ json: leaf }),
  );
  await page.goto("/signalk-alert-center/");
  await page.getByRole("button", { name: "Add data timeout rule" }).click();
  await expect(page.locator("#native-timeout-prerequisite")).toContainText(
    "disabled or unavailable",
  );
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Signal K sensor path").fill(sensor);
  await page.screenshot({
    path: `test-results/native-timeout-dialog-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect(page.locator("#policy-dialog")).toBeVisible();
  await page.locator("#policy-close").click();
  await expect(page.locator("#native-timeout-status")).toBeVisible();
  await expect(page.locator("#native-timeout-status")).toContainText(
    "disabled or unavailable",
  );
  const body = await (
    await request.get(`${plugin}/definitions?limit=100`)
  ).json();
  const definition = body.items.find((item) => item.name === name);
  expect(definition.metadata.nativeTimeout.path).toBe(sensor);
  const row = page.locator(`tr[data-definition-id="${definition.id}"]`);
  await expect(row.locator('[data-label="Value"]')).toHaveText("Stale");
  await expect(row.locator('[data-label="Age"]')).toHaveText("2m");
  await page.screenshot({
    path: `test-results/native-timeout-stale-${test.info().project.name}.png`,
    fullPage: true,
  });
  leaf = { value: 5, timestamp: new Date().toISOString(), state: undefined };
  await request.post(`${fixture}/reading`, {
    data: { path: sensor, value: 5 },
  });
  await expect(row.locator('[data-label="Value"]')).toHaveText("5");
  await expect(row.locator('[data-label="Age"]')).toHaveText(/\d+s/);
  // A timeout shortly after a fresh update must not be dropped by a server
  // leading-only minPeriod debounce and leave a permanently fresh display.
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
  expect(
    (
      await (
        await request.get(
          `${plugin}/occurrences?definitionId=${encodeURIComponent(definition.id)}`,
        )
      ).json()
    ).items,
  ).toEqual([]);
  await request.delete(
    `${plugin}/definitions/${encodeURIComponent(definition.id)}`,
  );
});
