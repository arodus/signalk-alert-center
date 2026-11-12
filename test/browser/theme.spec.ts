import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

const fixture = "/plugins/signalk-test-fixture";
const storageKey = "signalk-alert-center.theme";
const modeUrl = "**/signalk/v1/api/vessels/self/environment/mode";

async function choose(page: Page, name: string) {
  if (
    !(await page
      .locator("#theme-picker")
      .evaluate((el) => (el as HTMLDetailsElement).open))
  )
    await page.locator("#theme-toggle").click();
  await page.getByRole("radio", { name, exact: true }).check();
}

test.beforeEach(async ({ request, page }) => {
  await request.post(`${fixture}/seed`);
  await request.post(`${fixture}/reading`, {
    data: { path: "environment.mode", value: "day" },
  });
  await page.emulateMedia({ colorScheme: "light" });
});

test.afterEach(async ({ request }) => {
  await request.post(`${fixture}/reading`, {
    data: { path: "environment.mode", value: null },
  });
});

test("defaults to Auto and follows live shared mode while overrides persist", async ({
  page,
  request,
}) => {
  const setMode = (value: string | null) =>
    request.post(`${fixture}/reading`, {
      data: { path: "environment.mode", value },
    });
  await page.goto("/signalk-alert-center/");
  await page.getByRole("button", { name: "Appearance", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("radio", { name: "Auto — follow Signal K" }),
  ).toBeChecked();
  await expect(page.locator("#theme-status")).toHaveText(
    "Light · following Signal K",
  );
  await setMode("night");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#theme-status")).toHaveText(
    "Dark · following Signal K",
  );
  await choose(page, "Light");
  await setMode("day");
  await setMode("night");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await choose(page, "Auto — follow Signal K");
  await expect(page.locator("#theme-status")).toHaveText(
    "Dark · following Signal K",
  );
  expect(
    await page.evaluate((key) => localStorage.getItem(key), storageKey),
  ).toBeNull();
  await setMode("day");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await choose(page, "Dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate((key) => localStorage.getItem(key), storageKey),
  ).toBe("dark");
  const mode = await (
    await request.get("/signalk/v1/api/vessels/self/environment/mode")
  ).json();
  expect(mode.value).toBe("day");
});

test("falls back to device for missing, invalid and inaccessible mode and recovers", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route(modeUrl, (route) => route.fulfill({ status: 404 }));
  await page.goto("/signalk-alert-center/");
  await page.locator("#theme-toggle").click();
  await expect(page.locator("#theme-status")).toHaveText(
    "Dark · following device",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  for (const status of [401, 403, 500]) {
    await page.route(modeUrl, (route) => route.fulfill({ status }));
    await page.reload();
    await expect(page.locator("#theme-status")).toHaveText(
      "Light · following device",
    );
  }
  await page.unroute(modeUrl);
  await request.post(`${fixture}/reading`, {
    data: { path: "environment.mode", value: "night" },
  });
  await expect(page.locator("#theme-status")).toHaveText(
    "Dark · following Signal K",
  );
  for (const value of ["unknown", null]) {
    await request.post(`${fixture}/reading`, {
      data: { path: "environment.mode", value },
    });
    await expect(page.locator("#theme-status")).toHaveText(
      "Light · following device",
    );
  }
});

test("keeps browser choices separate, synchronizes tabs and resets when storage clears", async ({
  page,
  context,
  browser,
}) => {
  await page.goto("/signalk-alert-center/");
  await choose(page, "Dark");
  const tab = await context.newPage();
  await tab.goto("/signalk-alert-center/");
  await expect(tab.locator("html")).toHaveAttribute("data-theme", "dark");
  await choose(tab, "Light");
  await expect(
    page.getByRole("radio", { name: "Light", exact: true }),
  ).toBeChecked();
  const separate = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    colorScheme: "light",
  });
  try {
    const other = await separate.newPage();
    await other.goto(new URL("/signalk-alert-center/", page.url()).href);
    await expect(other.locator("#theme-status")).toHaveText(
      "Light · following Signal K",
    );
  } finally {
    await separate.close();
  }
  await tab.evaluate(() => localStorage.clear());
  await expect(
    page.getByRole("radio", { name: "Auto — follow Signal K" }),
  ).toBeChecked();
  await tab.close();
});

test("handles unavailable storage and corrupt preferences without breaking alerts", async ({
  page,
}) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, "invalid"),
    storageKey,
  );
  await page.goto("/signalk-alert-center/");
  await page.locator("#theme-toggle").click();
  await expect(
    page.getByRole("radio", { name: "Auto — follow Signal K" }),
  ).toBeChecked();
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("Storage blocked");
    };
    Storage.prototype.removeItem = () => {
      throw new Error("Storage blocked");
    };
  });
  await page.reload();
  await choose(page, "Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#theme-storage-note")).toContainText(
    "This choice lasts for this page only",
  );
  await expect(page.locator("#definition-list tbody tr").first()).toBeVisible();
});

test("uses the selected theme throughout desktop, tablet and narrow layouts", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/signalk-alert-center/");
  await expect(page.locator("#definition-list tbody tr").first()).toBeVisible();
  await choose(page, "Light");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(228, 229, 230)",
  );
  await choose(page, "Dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(20, 27, 36)",
  );
  await expect(page.locator("#alerts-tab")).toHaveCSS(
    "background-color",
    "rgb(30, 41, 54)",
  );
  await page.screenshot({
    path: `test-results/theme-menu-${test.info().project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("radio", { name: "Dark", exact: true }).press("Escape");
  await expect(page.locator("#theme-toggle")).toBeFocused();
  await expect(page.locator("#theme-picker")).not.toHaveAttribute("open", "");
  await page.screenshot({
    path: `test-results/theme-dark-${test.info().project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page
    .locator("tr.clickable-row")
    .filter({ hasText: "Refrigerator temperature" })
    .first()
    .click();
  await expect(page.locator("#detail-drawer")).toHaveCSS(
    "background-color",
    "rgb(30, 41, 54)",
  );
  await page.screenshot({
    path: `test-results/theme-drawer-${test.info().project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Alert settings" }).click();
  await expect(page.locator("#policy-dialog")).toHaveCSS(
    "background-color",
    "rgb(30, 41, 54)",
  );
  await page.screenshot({
    path: `test-results/theme-settings-${test.info().project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator("#drawer-close").click();
  for (const tab of ["alert-history-tab", "deliveries-tab"]) {
    await page.locator(`#${tab}`).click();
    await page.screenshot({
      path: `test-results/theme-${tab}-${test.info().project.name}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#theme-toggle").click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const menu = await page.locator(".theme-menu").boundingBox();
  expect(menu!.x).toBeGreaterThanOrEqual(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `test-results/theme-mobile-${test.info().project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
});

test("falls back on stream disconnect and reads the current mode after reconnect", async ({
  page,
  request,
}) => {
  let connection: WebSocketRoute | undefined;
  await page.routeWebSocket("**/signalk/v1/stream?subscribe=none", (socket) => {
    connection = socket;
    socket.connectToServer();
  });
  await page.goto("/signalk-alert-center/");
  await expect(page.locator("#definition-list tbody tr").first()).toBeVisible();
  await expect(page.locator("#theme-status")).toHaveText(
    "Light · following Signal K",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await connection!.close();
  await expect(page.locator("#theme-status")).toHaveText(
    "Dark · following device",
  );
  await expect(page.locator("#theme-status")).toHaveText(
    "Light · following Signal K",
    { timeout: 15000 },
  );
  await request.post(`${fixture}/reading`, {
    data: { path: "environment.mode", value: "night" },
  });
  await expect(page.locator("#theme-status")).toHaveText(
    "Dark · following Signal K",
  );
});
