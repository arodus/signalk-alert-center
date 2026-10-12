import { expect, test } from "@playwright/test";

test("shows every definition, sorts zones above inactive alerts, and filters zones plus active alerts", async ({
  page,
}) => {
  const definitions = Array.from({ length: 105 }, (_, index) => ({
    id: `overview-${index}`,
    name: `Inactive ${String(index).padStart(3, "0")}`,
    pathPattern: `notifications.test.overview${index}`,
    sourceType: "recognized",
    metadata: {},
  }));
  const zone = {
    id: "overview-zone",
    name: "Zone without history",
    pathPattern: "notifications.test.zone",
    sourceType: "zone",
    metadata: { zones: [{ lower: 0, upper: 10, state: "normal" }] },
  };
  const all = [...definitions, zone];
  const active = {
    id: "overview-active",
    definitionId: "overview-104",
    state: "active",
    currentSeverity: "alarm",
    message: "Active on the second definition page",
  };
  await page.route("**/plugins/signalk-alert-center/definitions?*", (route) => {
    const second = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({
      json: {
        items: second ? all.slice(100) : all.slice(0, 100),
        nextCursor: second ? undefined : "second",
      },
    });
  });
  await page.route("**/plugins/signalk-alert-center/occurrences?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.getAll("limit")).toHaveLength(1);
    if (params.has("source")) {
      return route.fulfill({
        json: {
          items: params.has("cursor")
            ? [
                {
                  ...active,
                  id: "older-match",
                  definitionId: "overview-103",
                  state: "cleared",
                },
              ]
            : [],
          nextCursor: params.has("cursor") ? undefined : "older",
        },
      });
    }
    return route.fulfill({
      json: {
        items: params.get("state") === "active" ? [active] : [],
        // Older history exists, but it must not paginate the overview.
        nextCursor: params.get("state") === "active" ? undefined : "older",
      },
    });
  });
  await page.goto("/signalk-alert-center/");
  const rows = page.locator("#definition-list tbody tr");
  await expect(rows).toHaveCount(106);
  await expect(rows.nth(0)).toHaveAttribute(
    "data-definition-id",
    "overview-104",
  );
  await expect(rows.nth(1)).toHaveAttribute(
    "data-definition-id",
    "overview-zone",
  );
  await expect(rows.nth(1).locator(".alert-state-cell")).toHaveText("normal");
  await expect(rows.nth(2).locator(".alert-state-cell")).toHaveText("inactive");
  await expect(page.locator("#history-more")).toHaveCount(0);
  await page.locator("#state-filter").selectOption("zones-active");
  await expect(rows).toHaveCount(2);
  await page.screenshot({
    path: `test-results/alerts-overview-${test.info().project.name}.png`,
  });
  await page.locator("#severity-filter").selectOption("normal");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute(
    "data-definition-id",
    "overview-zone",
  );
  await page.locator("#severity-filter").selectOption("");
  await page.locator("#state-filter").selectOption("active");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute(
    "data-definition-id",
    "overview-104",
  );
  await page.locator("#state-filter").selectOption("");
  await page
    .locator("#history-filters")
    .getByText("More filters", { exact: true })
    .click();
  await page.locator("#source-filter").fill("older-source");
  await page
    .locator("#history-filters")
    .getByRole("button", { name: "Apply", exact: true })
    .click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute(
    "data-definition-id",
    "overview-103",
  );
});
