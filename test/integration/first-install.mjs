// Install the actual npm archive into a clean Signal K 2.37.0 data directory.
// Deliberately bypass docker-entrypoint.sh: it seeds an enabled configuration.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const image = "cr.signalk.io/signalk/signalk-server:v2.37.0";
const id = `alert-center-first-install-${process.pid}`;
const directory = mkdtempSync(join(tmpdir(), `${id}-`));
// The container's node user must be able to read this archive on Linux too.
chmodSync(directory, 0o755);
const api = "/plugins/signalk-alert-center";
let base;
let browser;
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
async function json(route, body) {
  const response = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  assert.ok(response.ok, `${route}: ${response.status}`);
  return response.json();
}
async function until(check, label) {
  let error;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const result = await check();
      if (result) return result;
    } catch (caught) {
      error = caught;
    }
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`, { cause: error });
}
async function ready() {
  // Docker can assign a different ephemeral host port after a restart.
  base = `http://${docker("port", id, "3000/tcp")}`;
  await until(async () => {
    const plugins = await json("/skServer/plugins");
    return plugins.some((plugin) => plugin.id === "signalk-alert-center");
  }, "Signal K startup");
}
async function running() {
  await until(
    async () =>
      (await json(`${api}/status`)).reconciliation.state === "complete",
    "Alert Center startup",
  );
  const status = await json(`${api}/status`);
  assert.deepEqual(status.services, []);
  assert.equal(status.connectivity.state, "OFF");
  assert.equal(status.connectivity.ownedByPlugin, false);
  assert.equal(status.alerts.pendingDelivery, 0);
  assert.deepEqual((await json(`${api}/deliveries`)).items, []);
}
async function panel(page) {
  await page.goto(`${base}/admin/#/apps/configuration/signalk-alert-center`);
  await page.getByRole("heading", { name: "Alert Center settings" }).waitFor();
}
async function saveDefaults(page) {
  const save = page.getByRole("button", { name: "Save changes" });
  assert.equal(await save.isEnabled(), true);
  assert.equal(
    await page
      .getByRole("button", { name: "Discard", exact: true })
      .isEnabled(),
    false,
  );
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${api}/config`) &&
      response.request().method() === "POST",
  );
  await save.click();
  assert.equal((await saved).ok(), true);
  const options = await json(`${api}/config`);
  assert.equal(options.enabled, true);
  assert.deepEqual(options.configuration.notifiers, []);
  assert.deepEqual(options.configuration.defaults.notifiers, []);
  assert.equal(options.configuration.connectivity.enabled, false);
  await running();
}

try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", directory], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  // Only test data and zero notification services; expose HTTP on loopback.
  docker("network", "create", id);
  docker(
    "run",
    "-d",
    "--name",
    id,
    "--network",
    id,
    "-p",
    "127.0.0.1::3000",
    "-v",
    `${directory}:/package:ro`,
    "-v",
    `${resolve("test/integration/fixture-plugin")}:/fixture:ro`,
    "--entrypoint",
    "sh",
    image,
    "-ec",
    `
      mkdir -p /tmp/first-install
      npm install --prefix /tmp/first-install /package/${packed[0].filename} --offline --ignore-scripts --omit=dev --no-audit --no-fund
      mkdir -p /tmp/first-install/node_modules/signalk-test-fixture
      cp -R /fixture/. /tmp/first-install/node_modules/signalk-test-fixture/
      mkdir -p /tmp/first-install/plugin-config-data
      echo '{"enabled":true,"configuration":{"seedOnStart":false}}' > /tmp/first-install/plugin-config-data/signalk-test-fixture.json
      exec /home/node/signalk/node_modules/signalk-server/bin/signalk-server -c /tmp/first-install
    `,
  );
  await ready();
  assert.equal(
    docker(
      "exec",
      id,
      "node",
      "-p",
      "require('/home/node/signalk/node_modules/signalk-server/package.json').version",
    ),
    "2.37.0",
  );
  await running();
  assert.deepEqual(await json(`${api}/config`), {
    enabled: true,
    configuration: {},
  });
  assert.ok(
    (await json("/skServer/webapps")).some(
      (app) => app.name === "signalk-alert-center",
    ),
  );
  for (const asset of ["", "remoteEntry.js"]) {
    assert.equal(
      (await fetch(`${base}/signalk-alert-center/${asset}`)).status,
      200,
    );
  }
  browser = await chromium.launch({
    channel: "chromium",
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  mkdirSync("test-results", { recursive: true });
  for (const [name, viewport] of Object.entries({
    desktop: { width: 1440, height: 1000 },
    tablet: { width: 820, height: 1180 },
  })) {
    const page = await browser.newPage({ viewport });
    await panel(page);
    assert.equal(
      await page.getByRole("button", { name: "Save changes" }).isEnabled(),
      true,
    );
    await page.screenshot({
      path: `test-results/first-install-${name}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Notification services", exact: true })
      .click();
    assert.equal(await page.getByTestId("notification-service").count(), 0);
    await page.goto(`${base}/signalk-alert-center/`);
    await page.getByRole("tab", { name: "Alerts", exact: true }).waitFor();
    await page.close();
  }
  const page = await browser.newPage();
  await panel(page);
  await saveDefaults(page);
  await page.reload();
  await page.getByRole("heading", { name: "Alert Center settings" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save changes" }).isEnabled(),
    false,
  );
  const severity = page.getByLabel("Lowest severity sent");
  await severity.selectOption("alarm");
  assert.equal(
    await page.getByRole("button", { name: "Save changes" }).isEnabled(),
    true,
  );
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  assert.equal(await severity.inputValue(), "warn");
  assert.equal(
    await page.getByRole("button", { name: "Save changes" }).isEnabled(),
    false,
  );
  // Older/unsaved options can omit configuration entirely.
  await json(`${api}/config`, { enabled: true });
  await running();
  await page.reload();
  await page.getByRole("heading", { name: "Alert Center settings" }).waitFor();
  await saveDefaults(page);

  await json("/plugins/signalk-test-fixture/raise", {
    source: "acceptance.firstInstall",
    message: "Local history without notification services",
  });
  const occurrence = await until(
    async () =>
      (await json(`${api}/occurrences`)).items.find(
        (item) =>
          item.message === "Local history without notification services",
      ),
    "local alert persisted without services",
  );
  assert.ok(
    (await json(`${api}/occurrences/${occurrence.id}/events`)).items.length > 0,
  );
  await running();
  docker("restart", id);
  await ready();
  await running();
  assert.ok(
    (await json(`${api}/occurrences`)).items.some(
      (item) => item.id === occurrence.id,
    ),
  );

  const disabled = { ...(await json(`${api}/config`)), enabled: false };
  await json(`${api}/config`, disabled);
  await until(
    async () =>
      !(await json("/skServer/webapps")).some(
        (app) => app.name === "signalk-alert-center",
      ),
    "disabled webapp removed",
  );
  docker("restart", id);
  await ready();
  assert.deepEqual(await json(`${api}/config`), disabled);
  assert.equal((await json(`${api}`)).enabled, false);
  assert.equal((await json(`${api}/status`)).runtime.startCount, 0);
  assert.equal(
    (await json("/skServer/webapps")).some(
      (app) => app.name === "signalk-alert-center",
    ),
    false,
  );
  // Explicit re-enablement remains possible through the server's own controls.
  await json(`${api}/config`, { ...disabled, enabled: true });
  await running();
  await panel(page);
  console.log(
    "Signal K 2.37.0: fresh archive install, zero services, webapp/panel, initial Save, history/restart, and explicit disablement passed.",
  );
} catch (error) {
  try {
    console.error(docker("logs", "--tail", "80", id));
  } catch {
    /* Container may not exist yet. */
  }
  throw error;
} finally {
  await browser?.close();
  try {
    docker("rm", "-f", "-v", id);
  } catch {
    /* Container may not exist yet. */
  }
  try {
    docker("network", "rm", id);
  } catch {
    /* Network may not exist yet. */
  }
  rmSync(directory, { recursive: true, force: true });
}
