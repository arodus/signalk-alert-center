import { expect, test } from "@playwright/test";

const plugin = "/plugins/signalk-alert-center";
const fixture = "/plugins/signalk-test-fixture";

for (const role of [
  "anonymous",
  "readonly",
  "readwrite",
  "admin",
  "disabled",
  "unavailable",
]) {
  test(`${role} session gets appropriate alert controls`, async ({
    page,
    request,
  }) => {
    await request.post(`${fixture}/seed`);
    await page.route("**/loginStatus", (route) =>
      route.fulfill({
        status: role === "unavailable" ? 503 : 200,
        json:
          role === "disabled"
            ? { status: "notLoggedIn", authenticationRequired: false }
            : {
                status: role === "anonymous" ? "notLoggedIn" : "loggedIn",
                authenticationRequired: true,
                userLevel: role,
              },
      }),
    );
    // Keep snooze status visible to every role, independently of its controls.
    const status = await (await request.get(`${plugin}/status`)).json();
    await page.route(`**${plugin}/status`, async (route) => {
      await route.fulfill({
        json: {
          ...status,
          snooze: {
            active: true,
            endsAt: new Date(Date.now() + 600_000).toISOString(),
          },
        },
      });
    });
    const delivery = {
      id: "permission-delivery",
      state: "failed_terminal",
      transportInstanceId: "Mock",
      attemptCount: 1,
      alert: {
        path: "notifications.electrical.test",
        message: "Delivery remains visible",
      },
      service: { name: "Mock", type: "ntfy" },
    };
    await page.route(
      /\/plugins\/signalk-alert-center\/deliveries(?:\/|\?|$)/,
      (route) => {
        const url = new URL(route.request().url());
        return route.fulfill({
          json: url.pathname.endsWith("/attempts")
            ? { items: [] }
            : url.pathname.endsWith(delivery.id)
              ? delivery
              : { items: [delivery], total: 1 },
        });
      },
    );
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(plugin) && request.method() !== "GET")
        writes.push(request.url());
    });
    await page.goto("/signalk-alert-center/");
    await expect(
      page.locator("#definition-list tbody tr").first(),
    ).toBeVisible();
    const admin = role === "admin" || role === "disabled";
    const writer = admin || role === "readwrite";
    await expect(page.locator("html")).toHaveAttribute(
      "data-access",
      admin ? "admin" : writer ? "readwrite" : "readonly",
    );
    await expect(page.locator("#snooze-banner")).toBeVisible();
    await expect(page.locator("#snooze-open")).toBeVisible({ visible: admin });
    await expect(page.locator("#snooze-end")).toBeVisible({ visible: admin });
    await expect(page.locator(".action-cell").first()).toBeVisible({
      visible: writer,
    });
    await expect(page.locator(".occurrence-action").first()).toBeVisible({
      visible: writer,
    });
    await expect(page.locator(".alert-table th:visible")).toHaveCount(
      writer ? 6 : 5,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (role === "readonly")
      await page.screenshot({
        path: `test-results/readonly-overview-${test.info().project.name}.png`,
        fullPage: true,
        animations: "disabled",
      });

    await page.locator("[data-occurrence-id]").first().click();
    await expect(page.locator("#detail-drawer")).toHaveClass(/is-open/);
    await expect(page.locator("#detail-drawer .drawer-settings")).toBeVisible({
      visible: admin,
    });
    await expect(
      page.locator("#detail-drawer .occurrence-action").first(),
    ).toBeVisible({ visible: writer });
    await expect(
      page.getByRole("heading", { name: "Recent occurrences" }),
    ).toBeVisible();
    if (role === "readonly")
      await page.screenshot({
        path: `test-results/readonly-detail-${test.info().project.name}.png`,
        fullPage: false,
        animations: "disabled",
      });
    await page.locator("#drawer-close").click();
    await page.locator("#alert-history-tab").click();
    await expect(page.locator("#alert-history-list")).not.toBeEmpty();
    await page.locator("#deliveries-tab").click();
    await expect(page.locator("#retry")).toBeVisible({ visible: admin });
    await expect(page.locator("#delete-failed")).toBeVisible({
      visible: admin,
    });
    await page.locator(".delivery-row").first().click();
    await expect(page.locator("#delivery-dialog")).toBeVisible();
    await expect(page.locator("#delivery-retry")).toBeVisible({
      visible: admin,
    });
    await expect(page.locator("#delivery-delete")).toBeVisible({
      visible: admin,
    });
    await expect(page.locator("#delivery-dialog-body")).toContainText(
      "Delivery remains visible",
    );
    await page.locator("#delivery-dialog-done").click();
    await page.locator(".system-diagnostics summary").click();
    await expect(page.locator(".service-tests")).toBeVisible({
      visible: admin,
    });
    await expect(page.locator("#diagnostics-list")).toBeVisible();
    expect(writes).toEqual([]);
  });
}

test("refresh updates permissions and a path ACL denial is explained", async ({
  page,
  request,
}) => {
  await request.post(`${fixture}/seed`);
  let userLevel = "readwrite";
  await page.route("**/loginStatus", (route) =>
    route.fulfill({
      json: { status: "loggedIn", authenticationRequired: true, userLevel },
    }),
  );
  await page.route(`**${plugin}/occurrences/*/acknowledge`, (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: "FORBIDDEN",
          message:
            "You do not have permission to acknowledge this alert. Ask a Signal K administrator to grant access to this alert path.",
        },
      },
    }),
  );
  await page.goto("/signalk-alert-center/");
  await expect(
    page.locator('.occurrence-action[data-action="acknowledge"]').first(),
  ).toBeVisible();
  await page
    .locator('.occurrence-action[data-action="acknowledge"]')
    .first()
    .click();
  await expect(page.locator("#error")).toContainText(
    "You do not have permission to acknowledge this alert.",
  );
  await expect(page.locator("#login")).toBeHidden();
  await expect(page.locator("#action-result")).toContainText(
    "Ask a Signal K administrator",
  );
  await page.locator("[data-occurrence-id]").first().click();
  await page
    .locator('#detail-drawer .occurrence-action[data-action="acknowledge"]')
    .click();
  await expect(page.locator("#drawer-result")).toContainText(
    "Ask a Signal K administrator",
  );
  await expect(page.locator("#drawer-result")).toBeInViewport();
  await page.screenshot({
    path: `test-results/permission-error-${test.info().project.name}.png`,
    animations: "disabled",
  });
  await page.locator("#drawer-close").click();
  userLevel = "readonly";
  await page.locator("#refresh").click();
  await expect(page.locator("html")).toHaveAttribute("data-access", "readonly");
  await expect(page.locator(".occurrence-action").first()).toBeHidden();
});

test("explains a server role denial without asking an authenticated user to sign in again", async ({
  page,
  request,
}) => {
  await request.post(`${fixture}/seed`);
  await page.route("**/loginStatus", (route) =>
    route.fulfill({
      json: {
        status: "loggedIn",
        authenticationRequired: true,
        userLevel: "readwrite",
      },
    }),
  );
  await page.route(`**${plugin}/occurrences/*/acknowledge`, (route) =>
    route.fulfill({ status: 401, json: { error: "Permission Denied" } }),
  );
  await page.goto("/signalk-alert-center/");
  await page
    .locator('.occurrence-action[data-action="acknowledge"]')
    .first()
    .click();
  await expect(page.locator("#error")).toContainText(
    "Ask a Signal K administrator for access.",
  );
  await expect(page.locator("#login")).toBeHidden();
});
