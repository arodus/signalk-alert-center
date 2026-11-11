import { expect, test } from "@playwright/test";

test("uses the zone display name instead of its schema description", async ({
  page,
  request,
}) => {
  const path = "notifications.environment.inside.refrigerator.temperature";
  const source = `fixture.display-name.${test.info().project.name}`;
  await request.post("/plugins/signalk-test-fixture/raise", {
    data: { path, source, message: "Warm refrigerator" },
  });
  let occurrenceId = "";
  await expect
    .poll(async () => {
      const response = await request.get(
        `/plugins/signalk-alert-center/occurrences?source=${source}&state=active`,
      );
      occurrenceId = (await response.json()).items[0]?.id ?? "";
      return occurrenceId;
    })
    .not.toBe("");
  await page.goto("/signalk-alert-center/");
  const row = page.locator(`tr[data-occurrence-id="${occurrenceId}"]`);
  await expect(row.locator(".cell-title")).toHaveText(
    "Refrigerator temperature",
  );
  await expect(page.locator("#definition-list")).not.toContainText(
    "Data should be of type number.",
  );
  await row.click();
  await expect(page.locator("#drawer-title")).toHaveText(
    "Refrigerator temperature",
  );
  await page.screenshot({
    path: `test-results/zone-display-name-${test.info().project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await request.post("/plugins/signalk-test-fixture/clear", {
    data: { path, source },
  });
});

test("uses display names or paths as headings and keeps messages below", async ({
  page,
}) => {
  const description = "Data should be of type number.";
  const definitions = [
    {
      id: "depth",
      pathPattern: "notifications.environment.depth.belowSurface",
      name: "Depth from surface",
      sourceType: "zone",
      metadata: {
        displayName: "Depth from surface",
        description,
        zones: [{ state: "alarm", message: "Shallow water" }],
      },
    },
    {
      id: "bilge",
      pathPattern: "notifications.bilge.pump",
      name: "notifications.bilge.pump",
      sourceType: "recognized",
      metadata: { description },
    },
    {
      id: "zone",
      pathPattern: "notifications.bilge.highWater",
      name: "bilge.highWater",
      sourceType: "zone",
      metadata: {
        displayName: "  ",
        description,
        zones: [
          { state: "normal", message: "Normal water level" },
          { state: "alarm", message: "Bilge water high" },
        ],
      },
    },
    {
      id: "unnamed",
      pathPattern: "notifications.test.unnamed",
      name: "notifications.test.unnamed",
      sourceType: "zone",
      metadata: { description, zones: [{ state: "alarm", message: "  " }] },
    },
  ];
  const occurrences = [
    {
      id: "depth-active",
      definitionId: "depth",
      path: definitions[0].pathPattern,
      message: "Shallow water",
    },
    {
      id: "bilge-one",
      definitionId: "bilge",
      path: definitions[1].pathPattern,
      message: "Bilge pump running",
    },
    {
      id: "bilge-two",
      definitionId: "bilge",
      path: definitions[1].pathPattern,
      message: "Backup bilge pump running",
    },
  ].map((item) => ({
    ...item,
    state: "active",
    currentSeverity: "alarm",
    maxSeverity: "alarm",
    occurrenceNumber: 1,
  }));
  await page.route("**/plugins/signalk-alert-center/definitions?*", (route) =>
    route.fulfill({ json: { items: definitions } }),
  );
  await page.route("**/plugins/signalk-alert-center/occurrences?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        items: params.has("definitionId")
          ? occurrences.filter(
              (item) => item.definitionId === params.get("definitionId"),
            )
          : params.get("state") === "active"
            ? occurrences
            : [],
      },
    });
  });
  await page.route("**/plugins/signalk-alert-center/occurrences/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill({
      json: occurrences.find((item) => item.id === id) ?? { items: [] },
    });
  });
  await page.goto("/signalk-alert-center/");
  const expected = [
    [
      "depth-active",
      "Depth from surface",
      "Shallow water",
      "Depth from surface",
    ],
    [
      "bilge-one",
      "bilge › pump",
      "Bilge pump running",
      "notifications.bilge.pump",
    ],
    [
      "bilge-two",
      "bilge › pump",
      "Backup bilge pump running",
      "notifications.bilge.pump",
    ],
  ];
  for (const [id, title, message, detailTitle] of expected) {
    const row = page.locator(`tr[data-occurrence-id="${id}"]`);
    await expect(row.locator(".cell-title")).toHaveText(title);
    await expect(row.locator(".alert-summary")).toContainText(message);
    await row.click();
    await expect(page.locator("#drawer-title")).toHaveText(detailTitle);
    await expect(page.locator("#drawer-body > p").first()).toHaveText(message);
    await page.locator("#drawer-close").click();
  }
  await expect(
    page.locator('tr[data-definition-id="zone"] .cell-title'),
  ).toHaveText("bilge.highWater");
  await expect(
    page.locator('tr[data-definition-id="unnamed"] .cell-title'),
  ).toHaveText("test › unnamed");
  await expect(page.locator("#definition-list")).not.toContainText(description);
  await page.screenshot({
    path: `test-results/alert-name-fallback-${test.info().project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
});

test("shows every definition, sorts zones above inactive alerts, and filters zones plus active alerts", async ({
  page,
}) => {
  const definitions = Array.from({ length: 105 }, (_, index) => ({
    id: `overview-${index}`,
    name: `Inactive ${String(index).padStart(3, "0")}`,
    pathPattern: `notifications.test.overview${index}`,
    sourceType: "recognized",
    metadata: {},
    ...(index === 0
      ? { lastFiredAt: "2026-10-12T08:30:00.000Z", fireCount: 1 }
      : {}),
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
  await expect(rows.nth(1).locator(".last-triggered-cell")).toHaveText("Never");
  await expect(rows.nth(2).locator(".alert-state-cell")).toHaveText("inactive");
  await expect(
    rows.nth(2).locator(".last-triggered-cell time"),
  ).toHaveAttribute("datetime", "2026-10-12T08:30:00.000Z");
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
