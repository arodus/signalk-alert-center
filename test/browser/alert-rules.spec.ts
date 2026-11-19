import { expect, test } from "@playwright/test";

test("lists every rule and saves delivery settings before its first occurrence", async ({
  page,
  request,
}) => {
  const slug = `never-fired-${test.info().project.name}`;
  const id = `rule:signalk-alert-rules:${slug}`;
  const endpoint = `/plugins/signalk-alert-center/definitions/${encodeURIComponent(id)}`;
  await request.delete(endpoint);
  const rules = [
    {
      slug,
      rule: { name: "Battery voltage low" },
      alertPath: "electrical.batteries.*.voltageLow",
      state: { ruleState: "enabled" },
    },
    {
      slug: `disabled-${slug}`,
      rule: { name: "Disabled pump rule" },
      alertPath: "bilge.pumpRunning",
      disabled: { since: new Date().toISOString() },
    },
    {
      slug: `invalid-${slug}`,
      invalid: { body: { name: "Invalid stored rule" }, errors: [] },
    },
  ];
  await page.route("**/plugins/signalk-alert-rules/rules", (route) =>
    route.fulfill({ json: rules }),
  );
  await page.goto("/signalk-alert-center/");
  const row = page.locator(`[data-definition-id="${id}"]`);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Never fired");
  await expect(
    page.locator(
      `[data-definition-id="rule:signalk-alert-rules:disabled-${slug}"]`,
    ),
  ).toContainText("Disabled");
  await expect(
    page.locator(
      `[data-definition-id="rule:signalk-alert-rules:invalid-${slug}"]`,
    ),
  ).toContainText("Invalid rule");
  expect((await request.get(endpoint)).status()).toBe(404); // Reading the catalog is side-effect free.
  await row.locator(".cell-title").click();
  await expect(page.locator("#drawer-body")).toContainText("every instance");
  await expect(
    page.getByRole("link", { name: "Open rule in Alert Rules" }),
  ).toHaveAttribute("href", `/admin/#/e/signalk_alert_rules#rule=${slug}`);
  await expect(page.locator("#detail-drawer")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 0)",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/alert-rules-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Alert settings", exact: true })
    .click();
  await expect(page.locator("#policy-remove")).toBeDisabled();
  await page
    .getByRole("button", { name: "Customize wait before sending", exact: true })
    .click();
  await page.locator("#activation-delay").fill("45");
  await page.locator("#policy-save").click();
  await expect(page.locator("#policy-result")).toHaveText("Policy saved.");
  const stored = await (await request.get(endpoint)).json();
  expect(stored).toMatchObject({
    id,
    sourceType: "rule",
    fireCount: 0,
    pathPattern: "alerts.electrical.batteries.*.voltageLow",
    policy: { activationDelaySeconds: 45 },
  });
  expect(
    (
      await (
        await request.get(
          `/plugins/signalk-alert-center/occurrences?definitionId=${encodeURIComponent(id)}`,
        )
      ).json()
    ).items,
  ).toEqual([]);
  await page.reload();
  await expect(row).toHaveCount(1);
  await row.locator(".cell-title").click();
  await page
    .getByRole("button", { name: "Alert settings", exact: true })
    .click();
  await expect(page.locator("#activation-delay")).toHaveValue("45");
  await page.locator("#policy-cancel").click();
  await page.route("**/plugins/signalk-alert-rules/rules", (route) =>
    route.fulfill({ status: 503, json: { error: "stopped" } }),
  );
  await page.reload();
  await expect(page.locator("#rule-catalog-status")).toContainText(
    "unavailable",
  );
  await expect(row).toHaveCount(1);
  expect(
    (await (await request.get(endpoint)).json()).policy.activationDelaySeconds,
  ).toBe(45);
  await page.route("**/plugins/signalk-alert-rules/rules", (route) =>
    route.fulfill({ status: 403, json: { error: "forbidden" } }),
  );
  await page.reload();
  await expect(page.locator("#rule-catalog-status")).toContainText("Sign in");
  await expect(row).toHaveCount(1);
});
