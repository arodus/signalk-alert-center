import { expect, test } from "@playwright/test";

test("formats structured generated zone messages in the overview and retained history", async ({
  page,
  request,
}) => {
  const sensor = "environment.inside.zoneDisplay.temperature";
  const path = `notifications.${sensor}`;
  const fixture = "/plugins/signalk-test-fixture";
  const api = "/plugins/signalk-alert-center";
  const source = `fixture.zone-display.${test.info().project.name}`;
  await request.post(`${fixture}/reading`, {
    data: { path: sensor, value: 278.15 },
  });
  await request.post(`${fixture}/zones`, {
    data: {
      path: sensor,
      displayName: "Cabin temperature",
      units: "K",
      zones: [{ lower: 273.15, upper: 283.15, state: "alarm" }],
    },
  });
  await request.post(`${fixture}/raise`, {
    data: {
      path,
      source,
      message: "Cabin temperature between 273.15 and 283.15",
    },
  });
  let id = "";
  await expect
    .poll(async () => {
      const response = await request.get(
        `${api}/occurrences?source=${source}&state=active`,
      );
      const occurrence = (await response.json()).items[0];
      id = occurrence?.id;
      return occurrence?.messageSample?.generatedZone?.name;
    })
    .toBe("Cabin temperature");
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/definitions?limit=100`);
      return (await response.json()).items.find(
        (item: { pathPattern: string }) => item.pathPattern === path,
      )?.name;
    })
    .toBe("Cabin temperature");
  await page.goto("/signalk-alert-center/");
  const row = page.locator(`tr[data-occurrence-id="${id}"]`);
  await expect(row).toContainText(
    "Cabin temperature between 0 °C and 10 °C (reading 5 °C)",
  );
  await row.click();
  await expect(page.locator("#drawer-body > p").first()).toContainText(
    "Cabin temperature between 0 °C and 10 °C (reading 5 °C)",
  );
  await expect(page.locator("#event-list")).toContainText(
    "Cabin temperature between 0 °C and 10 °C (reading 5 °C)",
  );
  await page.screenshot({
    path: `test-results/zone-238-${test.info().project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await request.post(`${fixture}/clear`, { data: { path, source } });
  await request.post(`${fixture}/zones`, {
    data: { path: sensor, zones: null },
  });
});
