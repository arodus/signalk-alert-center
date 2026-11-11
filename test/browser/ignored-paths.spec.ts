import { expect, test } from "@playwright/test";

test("edits ignored paths, saves patterns, and allows an explicit empty list", async ({
  page,
  request,
}, testInfo) => {
  const configUrl = "/skServer/plugins/signalk-alert-center/config";
  const plugins = await (await request.get("/skServer/plugins")).json();
  const original = plugins.find(
    (item) => item.id === "signalk-alert-center",
  ).data;
  const open = async () => {
    await page.goto("/admin/#/apps/configuration/signalk-alert-center");
    await page
      .getByRole("button", { name: "Storage & advanced", exact: true })
      .click();
  };
  const save = async () => {
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes(configUrl) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    const response = await saved;
    expect(response.ok()).toBe(true);
    return response.request().postDataJSON().configuration.ignoredPaths;
  };
  try {
    const { ignoredPaths: _removed, ...withoutIgnoredPaths } =
      original.configuration;
    expect(
      (
        await request.post(configUrl, {
          data: { ...original, configuration: withoutIgnoredPaths },
        })
      ).ok(),
    ).toBe(true);
    await open();
    const paths = page.getByLabel("Ignored path patterns");
    await expect(paths).toHaveValue("navigation.closestApproach.*");
    await paths.fill(
      "navigation.closestApproach.*\n notifications.test.ignored.* \n\n",
    );
    expect(await save()).toEqual([
      "navigation.closestApproach.*",
      "notifications.test.ignored.*",
    ]);
    await page.reload();
    await page
      .getByRole("button", { name: "Storage & advanced", exact: true })
      .click();
    await expect(paths).toHaveValue(
      "navigation.closestApproach.*\nnotifications.test.ignored.*",
    );
    const card = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Notification paths to leave out",
      }),
    });
    await card.screenshot({
      path: `test-results/ignored-paths-${testInfo.project.name}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await paths.fill("");
    expect(await save()).toEqual([]);
    await page.reload();
    await page
      .getByRole("button", { name: "Storage & advanced", exact: true })
      .click();
    await expect(paths).toHaveValue("");
    await paths.fill("test.discard.*");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(paths).toHaveValue("");
  } finally {
    expect((await request.post(configUrl, { data: original })).ok()).toBe(true);
  }
});
