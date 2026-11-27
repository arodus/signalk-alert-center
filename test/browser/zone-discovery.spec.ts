import { expect, test } from "@playwright/test";

test("shows zones added after startup without a restart or page refresh", async ({
  page,
  request,
}) => {
  const sensor = `environment.inside.lateZone${test.info().project.name}${Date.now()}.temperature`;
  const path = `notifications.${sensor}`;
  const name = `Late cabin zone (${test.info().project.name})`;
  const fixture = "/plugins/signalk-test-fixture";
  await page.goto("/signalk-alert-center/");
  await expect(page.locator("#updated")).toContainText("Updated");
  await request.post(`${fixture}/reading`, {
    data: { path: sensor, value: 280 },
  });
  await request.post(`${fixture}/zones`, {
    data: {
      path: sensor,
      displayName: name,
      units: "K",
      zones: [{ lower: 290, state: "alarm" }],
    },
  });
  try {
    const row = page.locator(`tr[data-definition-id="path:${path}"]`);
    await expect(row).toBeVisible({ timeout: 4000 });
    await expect(row).toContainText("normal");
    await row.click();
    await expect(page.locator("#drawer-body")).toContainText("Defined zones");
    await page.screenshot({
      path: `test-results/late-zone-${test.info().project.name}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const occurrences = await (
      await request.get(
        `/plugins/signalk-alert-center/occurrences?path=${encodeURIComponent(path)}`,
      )
    ).json();
    expect(occurrences.items).toEqual([]);
  } finally {
    await request.post(`${fixture}/zones`, {
      data: { path: sensor, zones: null },
    });
  }
});
