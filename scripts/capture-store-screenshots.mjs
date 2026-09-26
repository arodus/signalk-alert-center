import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = fileURLToPath(new URL("../docs/screenshots", import.meta.url));
const baseUrl = "http://127.0.0.1:3310";
const compose = [
  "compose",
  "-p",
  "alert-center-store-shots",
  "-f",
  "docker-compose.acceptance.yml",
];
const environment = {
  ...process.env,
  SIGNALK_ACCEPTANCE_PORT: "3310",
  NOTIFIER_MOCK_PORT: "18180",
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(`${command} exited with status ${result.status}`);
}

async function json(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok)
    throw new Error(
      `${path} returned ${response.status}: ${await response.text()}`,
    );
  return response.json();
}

async function eventually(action, predicate, description) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await action();
      if (predicate(last)) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${description}: ${String(last)}`);
}

async function configure(configuration) {
  const plugins = await json("/skServer/plugins");
  const plugin = plugins.find((item) => item.id === "signalk-alert-center");
  if (!plugin) throw new Error("Signal K Alert Center is not installed");
  await json("/skServer/plugins/signalk-alert-center/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...plugin.data, configuration }),
  });
  await eventually(
    () => json("/plugins/signalk-alert-center/status"),
    (status) => status.database?.healthy === true,
    "Alert Center did not restart with a healthy database",
  );
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (process.platform !== "darwin") throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

async function preparePage(browser, viewport) {
  return browser.newPage({ viewport });
}

async function capture(page, name) {
  const path = `${output}/${name}`;
  await page.screenshot({ path, animations: "disabled" });
  const bytes = statSync(path).size;
  if (bytes > 500_000)
    throw new Error(
      `${name} is ${bytes} bytes; Store screenshots must stay below 500 KB`,
    );
  console.log(`Captured ${name} (${Math.ceil(bytes / 1024)} KB)`);
}

mkdirSync(output, { recursive: true });
let browser;
try {
  run("docker", [...compose, "down", "-v", "--remove-orphans"]);
  run("docker", [
    ...compose,
    "up",
    "-d",
    "--build",
    "--wait",
    "signalk",
    "notifier-mock",
  ]);

  const plugins = await json("/skServer/plugins");
  const plugin = plugins.find((item) => item.id === "signalk-alert-center");
  const baseConfiguration = plugin?.data?.configuration ?? {};
  await configure({
    ...baseConfiguration,
    defaults: {
      enabled: true,
      minSeverity: "warn",
      activationDelaySeconds: 0,
      connectivity: { mode: "queue" },
      notifiers: ["Crew notifications"],
      soundEnabled: true,
      speechEnabled: true,
      speechMinimumSeverity: "alarm",
      speechTemplate: "{name}. {severity}. {message}",
      speechAnnounceClear: false,
    },
    notifiers: [
      {
        name: "Crew notifications",
        type: "ntfy",
        enabled: true,
        minSeverity: "warn",
        repeatIntervalSeconds: 900,
        server: "http://notifier-mock:8080",
        topic: "store-demo-alerts",
      },
    ],
  });
  await json("/plugins/signalk-test-fixture/seed", { method: "POST" });
  await eventually(
    () => json("/plugins/signalk-alert-center/definitions?limit=100"),
    (page) => page.items.length >= 6,
    "Demo definitions were not discovered",
  );
  await eventually(
    () => json("/plugins/signalk-alert-center/deliveries?limit=100"),
    (page) =>
      page.items.length >= 5 && page.items.some((item) => item.deliveredAt),
    "Demo deliveries were not completed",
  );

  browser = await launchBrowser();
  const desktop = await preparePage(browser, { width: 1280, height: 800 });
  await desktop.goto(`${baseUrl}/signalk-alert-center/`);
  await desktop.locator("#definition-list tr.clickable-row").first().waitFor();
  await capture(desktop, "alert-center-overview.png");

  const detailRow = desktop
    .locator("#definition-list tr.clickable-row")
    .filter({ hasText: "Anchor" })
    .first();
  await detailRow.click();
  await desktop.locator("#detail-drawer.is-open").waitFor();
  await capture(desktop, "alert-details.png");

  await desktop.getByRole("button", { name: "Alert settings" }).click();
  await desktop.locator("#policy-dialog").waitFor();
  await capture(desktop, "alert-settings.png");
  await desktop.getByRole("button", { name: "Cancel" }).click();
  await desktop.locator("#drawer-close").click();

  await desktop.getByRole("tab", { name: /Deliveries/ }).click();
  await desktop.locator("#delivery-list tr.delivery-row").first().waitFor();
  await capture(desktop, "delivery-history.png");

  const tablet = await preparePage(browser, { width: 820, height: 1000 });
  await tablet.goto(`${baseUrl}/signalk-alert-center/`);
  await tablet.locator("#definition-list tr.clickable-row").first().waitFor();
  await capture(tablet, "alert-center-tablet.png");
  await tablet.close();

  await configure({
    ...baseConfiguration,
    defaults: {
      enabled: true,
      minSeverity: "warn",
      activationDelaySeconds: 30,
      connectivity: { mode: "queue" },
      notifiers: ["Crew notifications", "Cabin audio"],
      soundEnabled: true,
      speechEnabled: true,
      speechMinimumSeverity: "alarm",
      speechTemplate: "{name}. {severity}. {message}",
      speechAnnounceClear: true,
    },
    notifiers: [
      {
        name: "Crew notifications",
        type: "ntfy",
        enabled: false,
        minSeverity: "warn",
        repeatIntervalSeconds: 900,
        server: "https://ntfy.example",
        topic: "demo-vessel-alerts",
        token: "REDACTED",
      },
      {
        name: "Cabin audio",
        type: "wyoming",
        enabled: false,
        minSeverity: "warn",
        repeatIntervalSeconds: 300,
        targets: ["saloon", "cockpit"],
        urgentAt: "alarm",
        sounds: {
          normal: "chime",
          warn: "warning",
          alert: "warning",
          alarm: "alarm",
          emergency: "alarm",
        },
      },
    ],
  });
  await desktop.goto(
    `${baseUrl}/admin/#/apps/configuration/signalk-alert-center`,
  );
  await desktop
    .getByRole("heading", { name: "Alert Center settings" })
    .waitFor();
  await capture(desktop, "plugin-defaults.png");
  await desktop
    .getByRole("button", { name: "Notification services", exact: true })
    .click();
  await desktop.getByTestId("notification-service").first().waitFor();
  await capture(desktop, "plugin-settings.png");
  await desktop.close();
} finally {
  await browser?.close();
  run("docker", [...compose, "down", "-v", "--remove-orphans"]);
}
