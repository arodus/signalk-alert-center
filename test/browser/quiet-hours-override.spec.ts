import { expect, test } from "@playwright/test";

const putPath =
  "/signalk/v1/api/vessels/self/digital/alertCenter/quietHours/enabled";

test("quiet-hours override remains clearly visible on a narrow screen", async ({
  page,
  request,
}) => {
  await request.put(putPath, { data: { value: false } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/signalk-alert-center/");
  const banner = page.locator("#quiet-hours-override-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Quiet hours disabled");
  await expect(banner).toContainText("will apply again when re-enabled");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/quiet-hours-override-mobile-${test.info().project.name}.png`,
    fullPage: true,
  });
  await request.put(putPath, { data: { value: true } });
  await page.reload();
  await expect(banner).toBeHidden();
});
