import { expect, test } from "@playwright/test";
import { coreFixture } from "../fixtures/core-alert";

test("shows core attention state and does not present a failed action as success", async ({
  page,
}) => {
  const definition = {
    id: "native-ui-definition",
    name: "Bilge water",
    pathPattern: "alerts.bilge.highWater",
    sourceType: "recognized",
    metadata: {},
    fireCount: 1,
  };
  const occurrence = {
    id: "native-ui-occurrence",
    definitionId: definition.id,
    path: definition.pathPattern,
    source: "bilge-sensor",
    sourceKey: "core:core-1",
    state: "active",
    currentSeverity: "alarm",
    maxSeverity: "alarm",
    occurrenceNumber: 1,
    message: "Bilge water returned to normal",
    startedAt: "2026-10-25T08:00:00Z",
    deliveries: [],
    coreResolutionConfirmed: true,
    coreAlert: coreFixture({
      state: "rtn-unacknowledged",
      condition: false,
      references: ["environment.inside.bilge.level"],
    }),
  };
  await page.route("**/plugins/signalk-alert-center/definitions?*", (route) =>
    route.fulfill({ json: { items: [definition] } }),
  );
  await page.route("**/plugins/signalk-alert-center/occurrences?*", (route) =>
    route.fulfill({ json: { items: [occurrence] } }),
  );
  await page.route(
    "**/plugins/signalk-alert-center/occurrences/native-ui-occurrence",
    (route) => route.fulfill({ json: occurrence }),
  );
  await page.route(
    "**/plugins/signalk-alert-center/occurrences/native-ui-occurrence/events?*",
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    "**/plugins/signalk-alert-center/occurrences/native-ui-occurrence/acknowledge",
    (route) =>
      route.fulfill({
        json: {
          status: "failed",
          upstream: "failed",
          message: "Core unavailable",
        },
      }),
  );
  await page.goto("/signalk-alert-center/");
  const row = page.locator('[data-occurrence-id="native-ui-occurrence"]');
  await expect(row.locator(".alert-state-cell")).toHaveText(
    "Ended · awaiting acknowledgment",
  );
  await expect(row.locator(".alert-state-cell")).toHaveCSS(
    "background-color",
    "rgb(244, 162, 109)",
  );
  await row.locator(".cell-title").click();
  await expect(page.locator("#drawer-body")).toContainText("Core alert ID");
  await expect(page.locator("#drawer-body")).toContainText(
    "environment.inside.bilge.level",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator("#detail-drawer")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 0)",
  );
  expect(
    await page
      .locator("#detail-drawer")
      .evaluate((drawer) => drawer.scrollWidth <= drawer.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/core-alert-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page
    .locator("#drawer-body")
    .getByRole("button", { name: "Acknowledge", exact: true })
    .click();
  await expect(page.locator("#action-result")).toHaveText("Core unavailable");
  await expect(
    page
      .locator("#drawer-body")
      .getByRole("button", { name: "Acknowledge", exact: true }),
  ).toBeEnabled();
});

test("preserves rule-authored units and explains displacement without implying recovery", async ({
  page,
}) => {
  const definition = {
    id: "rule:signalk-alert-rules:coolant-difference",
    name: "Coolant difference",
    pathPattern: "alerts.propulsion.coolantDifference",
    sourceType: "rule",
    fireCount: 1,
    metadata: {
      units: "K",
      displayUnits: { formula: "value - 273.15", symbol: "°C" },
      rule: { provider: "signalk-alert-rules", slug: "coolant-difference" },
    },
  };
  const message = "Difference 5 K; coolant 95 °C; roll 0.4 rad";
  const occurrence = {
    id: "displaced-rule",
    definitionId: definition.id,
    path: definition.pathPattern,
    state: "cleared",
    currentSeverity: "alarm",
    maxSeverity: "alarm",
    occurrenceNumber: 1,
    startedAt: "2026-10-25T08:00:00Z",
    deliveries: [],
    message,
    messageSample: {
      units: "K",
      message,
      value: 300,
      capturedAt: "2026-10-25T08:00:00Z",
    },
    coreResolutionConfirmed: false,
    coreAlert: coreFixture({
      $source: "signalk-alert-rules",
      state: "normal",
      condition: false,
      clearReason: "displaced",
      message,
    }),
  };
  await page.route("**/plugins/signalk-alert-rules/rules", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.route("**/plugins/signalk-alert-center/definitions?*", (route) =>
    route.fulfill({ json: { items: [definition] } }),
  );
  await page.route("**/plugins/signalk-alert-center/occurrences?*", (route) =>
    route.fulfill({ json: { items: [occurrence] } }),
  );
  await page.route(
    "**/plugins/signalk-alert-center/occurrences/displaced-rule",
    (route) => route.fulfill({ json: occurrence }),
  );
  const event = {
    id: "rule-event",
    alertId: occurrence.id,
    definitionId: definition.id,
    eventType: "core_removed",
    source: "signalk-alert-rules",
    sourceKey: "core:core-1",
    path: definition.pathPattern,
    message,
    severity: "alarm",
    occurrenceNumber: 1,
    occurredAt: occurrence.startedAt,
    payload: occurrence.coreAlert,
    messageSample: occurrence.messageSample,
  };
  await page.route(
    "**/plugins/signalk-alert-center/occurrences/displaced-rule/events?*",
    (route) => route.fulfill({ json: { items: [event] } }),
  );
  await page.route("**/plugins/signalk-alert-center/alert-history?*", (route) =>
    route.fulfill({ json: { items: [event] } }),
  );
  await page.goto("/signalk-alert-center/");
  await page.locator("#state-filter").selectOption("");
  await page
    .locator(
      '[data-definition-id="rule:signalk-alert-rules:coolant-difference"] .cell-title',
    )
    .click();
  const drawer = page.locator("#drawer-body");
  await expect(drawer).toContainText(message);
  await expect(page.locator("#event-list")).toContainText(message);
  await expect(drawer).toContainText("Displaced · recovery not confirmed");
  await expect(drawer).toContainText("Unknown after displacement");
  await expect(drawer).not.toContainText("−268");
  await expect(
    drawer.getByRole("button", { name: "Acknowledge", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator("#detail-drawer")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 0)",
  );
  expect(
    await page
      .locator("#detail-drawer")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/displaced-rule-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.goto("/signalk-alert-center/#history");
  await expect(page.locator("#alert-history-list")).toContainText(message);
  await expect(page.locator("#alert-history-list")).not.toContainText(
    "-268.15",
  );
});
