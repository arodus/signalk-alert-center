// Real PR-server acceptance, exclusively against temporary data and local mocks.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../..", import.meta.url));
const server = process.env.SIGNALK_CORE_SERVER_DIR;
const rules = process.env.SIGNALK_ALERT_RULES_DIR;
assert.ok(
  rules,
  "Set SIGNALK_ALERT_RULES_DIR to a built hatlabs/signalk-alert-rules checkout",
);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rules,
    encoding: "utf8",
  }).trim(),
  "5f6fbb9d32e8e47e614ab11fab81b2bcae90424e",
  "Review rule discovery and identity before updating this pin",
);
assert.ok(
  server,
  "Set SIGNALK_CORE_SERVER_DIR to a built hatlabs/signalk-server checkout",
);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: server,
    encoding: "utf8",
  }).trim(),
  "33f487c7135db583a26b394ce04509b7b6c512ac",
  "Review any upstream API changes before updating this pin",
);
const directory = await mkdtemp(path.join(tmpdir(), "alert-center-core-"));
let child;
let log = "";
let failing = true;
const requests = [];
const mock = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ topic: req.url, body });
  res.writeHead(req.url === "/retry" && failing ? 503 : 200).end("fixture");
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const probe = http.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const ac = "/plugins/signalk-alert-center";
const core = "/signalk/v2/api/alerts";
const configuration = {
  storage: { path: path.join(directory, "alert-center.sqlite") },
  notifiers: ["success", "retry"].map((topic) => ({
    name: topic,
    type: "ntfy",
    server: `http://127.0.0.1:${mock.address().port}`,
    topic,
  })),
  defaults: { notifiers: ["success", "retry"] },
  retry: { initialSeconds: 1, maxSeconds: 1, multiplier: 1, jitter: 0 },
  connectivity: { enabled: false },
};
async function json(route, method = "GET", body) {
  const response = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  assert.ok(
    response.ok,
    `${method} ${route}: ${response.status} ${response.ok ? "" : await response.text()}`,
  );
  return response.json();
}
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (caught) {
      error = caught;
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`, { cause: error });
}
async function occurrence(id) {
  return (await json(`${ac}/occurrences?limit=100`)).items.find(
    (item) => item.coreAlert?.id === id,
  );
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}
async function start() {
  child = spawn(
    process.execPath,
    [path.join(server, "bin/signalk-server"), "-c", directory],
    {
      cwd: server,
      env: {
        ...process.env,
        PORT: String(port),
        SIGNALK_NODE_CONFIG_DIR: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    log = (log + chunk).slice(-20000);
  });
  child.stderr.on("data", (chunk) => {
    log = (log + chunk).slice(-20000);
  });
  await until(
    async () =>
      (await json(`${ac}/status`)).reconciliation.state === "complete",
    "server startup",
    45000,
  );
}

try {
  await mkdir(path.join(directory, "node_modules"));
  await symlink(
    root,
    path.join(directory, "node_modules/signalk-alert-center"),
  );
  await mkdir(path.join(directory, "plugin-config-data"));
  await symlink(
    rules,
    path.join(directory, "node_modules/signalk-alert-rules"),
  );
  const sensorPlugin = path.join(
    directory,
    "node_modules/alert-center-rule-fixture",
  );
  await mkdir(sensorPlugin);
  await writeFile(
    path.join(sensorPlugin, "package.json"),
    JSON.stringify({
      name: "alert-center-rule-fixture",
      version: "1.0.0",
      main: "index.js",
      keywords: ["signalk-node-server-plugin"],
    }),
  );
  await writeFile(
    path.join(sensorPlugin, "index.js"),
    `module.exports = (app) => ({
    id: 'alert-center-rule-fixture', name: 'Rule sensor fixture', schema: {}, start() {}, stop() {},
    registerWithRouter(router) { router.post('/sample', (req, res) => {
      const instance = req.body.instance;
      if (!['house', 'engine', 'coolant'].includes(instance) || typeof req.body.value !== 'number') return res.status(400).json({ error: 'invalid fixture input' });
      app.handleMessage('alert-center-rule-fixture', { updates: [{ values: [{ path: instance === 'coolant' ? 'propulsion.main.coolantTemperature' : 'electrical.batteries.' + instance + '.voltage', value: req.body.value }] }] });
      res.json({ ok: true });
    }); }
  });`,
  );
  for (const name of ["signalk-alert-rules", "alert-center-rule-fixture"]) {
    await writeFile(
      path.join(directory, "plugin-config-data", name + ".json"),
      JSON.stringify({ enabled: true, configuration: {} }),
    );
  }
  await writeFile(
    path.join(directory, "settings.json"),
    JSON.stringify({
      port,
      host: "127.0.0.1",
      mdns: false,
      interfaces: { tcp: false, udp: false },
      plugins: {},
    }),
  );
  await writeFile(
    path.join(directory, "plugin-config-data/signalk-alert-center.json"),
    JSON.stringify({ enabled: true, configuration }),
  );
  await start();
  assert.deepEqual((await json(`${ac}/status`)).alertSources, [
    "notifications",
    "alerts",
  ]);
  const raised = await json(core, "POST", {
    path: "acceptance.bilge",
    priority: "alarm",
    message: "Core bilge fixture",
    references: ["environment.inside.bilge.level"],
  });
  const local = await until(
    () => occurrence(raised.id),
    "native raise persisted",
  );
  assert.notEqual(local.id, raised.id);
  await until(
    () =>
      requests.some((request) => request.topic === "/success") &&
      requests.some((request) => request.topic === "/retry"),
    "independent notifier attempts",
  );
  await json(`${core}/${raised.id}/silence`, "POST", { duration: 1 });
  await until(
    async () => (await occurrence(raised.id)).coreAlert.silenced,
    "silence delta",
  );
  await until(
    async () => !(await occurrence(raised.id)).coreAlert.silenced,
    "unsilence delta",
  );
  await json(`${core}/${raised.id}/condition`, "PUT", { active: false });
  await until(
    async () =>
      (await occurrence(raised.id)).coreAlert.state === "rtn-unacknowledged",
    "condition returned",
  );
  const successCount = requests.filter(
    (request) => request.topic === "/success",
  ).length;
  await stop();
  failing = false;
  await start();
  const recovered = await occurrence(raised.id);
  assert.equal(recovered.id, local.id);
  await until(
    async () =>
      (await json(`${ac}/occurrences/${local.id}`)).deliveries.every(
        (delivery) => delivery.state === "delivered",
      ),
    "pending notifier survives restart",
  );
  assert.equal(
    requests.filter((request) => request.topic === "/success").length,
    successCount,
  );
  assert.ok(
    requests
      .filter((request) => request.topic === "/retry")
      .at(-1)
      .body.includes("Cleared at"),
  );
  const ack = await json(`${ac}/occurrences/${local.id}/acknowledge`, "POST");
  assert.equal(ack.upstream, "applied");
  await until(
    async () => (await occurrence(raised.id)).coreAlert.state === "normal",
    "terminal acknowledgment",
  );
  assert.equal((await occurrence(raised.id)).coreResolutionConfirmed, true);

  const eventRequest = {
    path: "acceptance.waypoint",
    priority: "caution",
    message: "Waypoint reached",
    latching: true,
  };
  const first = await json(core, "POST", eventRequest);
  const event = await until(() => occurrence(first.id), "momentary alert");
  await json(core, "POST", eventRequest);
  await until(
    async () =>
      (await json(`${ac}/occurrences/${event.id}`)).deliveries.length === 4,
    "grouped repeated momentary raise",
  );
  assert.equal((await occurrence(first.id)).id, event.id);
  await json(`${ac}/occurrences/${event.id}/acknowledge`, "POST");
  const next = await json(core, "POST", eventRequest);
  assert.notEqual(next.id, first.id);
  assert.notEqual(
    (
      await until(
        () => occurrence(next.id),
        "new occurrence after acknowledgment",
      )
    ).id,
    event.id,
  );

  // Core now identifies genuine completion in its terminal delta.
  const caution = await json(core, "POST", {
    path: "acceptance.caution",
    priority: "caution",
    message: "Caution fixture",
  });
  await until(() => occurrence(caution.id), "caution persisted");
  await json(`${core}/${caution.id}/condition`, "PUT", { active: false });
  await until(
    async () => (await occurrence(caution.id)).coreAlert.state === "normal",
    "condition completion retained",
  );
  assert.equal((await occurrence(caution.id)).coreResolutionConfirmed, true);
  assert.equal(
    (await occurrence(caution.id)).coreAlert.clearReason,
    "condition",
  );

  const ruleRoute = "/plugins/signalk-alert-rules/rules";
  const ruleEntry = await json(ruleRoute, "POST", {
    slug: "battery-low",
    name: "Battery voltage low",
    condition: "voltageLow",
    signal: { path: "electrical.batteries.*.voltage" },
    detector: {
      type: "sustained",
      direction: "below",
      steps: [{ limit: 12, priority: "alarm" }],
    },
    message: "Battery voltage low",
  });
  assert.equal(ruleEntry.alertPath, "electrical.batteries.*.voltageLow");
  assert.ok(
    (await json(ruleRoute)).some((entry) => entry.slug === "battery-low"),
  );
  const ruleId = "rule:signalk-alert-rules:battery-low";
  const rulePolicy = `${ac}/definitions/${encodeURIComponent(ruleId)}/policy`;
  await json(rulePolicy, "PATCH", {
    rule: {
      slug: ruleEntry.slug,
      name: ruleEntry.rule.name,
      alertPath: ruleEntry.alertPath,
    },
    notifierIds: ["success"],
    activationDelaySeconds: 2,
    overrideFields: ["notifierIds", "activationDelaySeconds"],
  });
  assert.equal(
    (await json(`${ac}/occurrences?definitionId=${encodeURIComponent(ruleId)}`))
      .items.length,
    0,
  );
  const ruleOccurrences = async () =>
    (await json(`${ac}/occurrences?definitionId=${encodeURIComponent(ruleId)}`))
      .items;
  const sample = (instance, value) =>
    json("/plugins/alert-center-rule-fixture/sample", "POST", {
      instance,
      value,
    });
  await sample("house", 11);
  let house = await until(
    async () =>
      (await ruleOccurrences()).find((item) => item.path.includes(".house.")),
    "sensor to rule to core to Alert Center",
  );
  assert.equal(house.coreAlert.data.rule, "battery-low");
  assert.equal(house.activationDelaySeconds, 2);
  await until(async () => {
    const current = await occurrence(house.coreAlert.id);
    return (
      current.deliveries.length === 1 &&
      current.deliveries[0].state === "delivered"
    );
  }, "first rule occurrence uses saved notifier selection");
  const houseDeliveryId = (await occurrence(house.coreAlert.id)).deliveries[0]
    .id;
  await stop();
  await start();
  // No dashboard or rule-catalog request is needed to apply the saved policy.
  await sample("engine", 11);
  const engine = await until(
    async () =>
      (await ruleOccurrences()).find((item) => item.path.includes(".engine.")),
    "new wildcard instance after restart",
  );
  assert.equal(engine.activationDelaySeconds, 2);
  await until(
    async () =>
      (await occurrence(engine.coreAlert.id)).deliveries.some(
        (item) => item.state === "delivered",
      ),
    "second wildcard instance delivered",
  );
  house = await occurrence(house.coreAlert.id);
  assert.equal(house.deliveries.length, 1);
  assert.equal(house.deliveries[0].id, houseDeliveryId);
  assert.equal(house.deliveries[0].attemptCount, 1);
  assert.equal(
    (await json(`${ac}/definitions?limit=100`)).items.filter(
      (item) => item.id === ruleId,
    ).length,
    1,
  );
  await sample("house", 13);
  await until(
    async () =>
      (await occurrence(house.coreAlert.id)).coreAlert.state ===
      "rtn-unacknowledged",
    "rule condition returns",
  );
  await json(`${ac}/occurrences/${house.id}/acknowledge`, "POST", {});
  await until(
    async () =>
      (await occurrence(house.coreAlert.id)).coreAlert.state === "normal",
    "rule alert acknowledged through core",
  );
  assert.equal(
    (await occurrence(house.coreAlert.id)).coreAlert.clearReason,
    "acknowledged",
  );

  // Real producer conversion flows through unchanged to remote delivery.
  await json(ruleRoute, "POST", {
    slug: "coolant-hot",
    name: "Coolant hot",
    condition: "coolantHot",
    signal: { path: "propulsion.main.coolantTemperature" },
    detector: {
      type: "sustained",
      direction: "above",
      steps: [{ limit: 363.15, priority: "alarm" }],
    },
    message: "Coolant {value} above {limit}; difference 5 K",
  });
  await sample("coolant", 373.15);
  const coolant = await until(
    async () =>
      (await json(`${ac}/occurrences?limit=100`)).items.find(
        (item) => item.coreAlert?.data?.rule === "coolant-hot",
      ),
    "rule message in admin units",
  );
  assert.equal(coolant.message, "Coolant 100 °C above 90 °C; difference 5 K");
  await until(
    () => requests.some((request) => request.body.includes(coolant.message)),
    "converted rule text preserved in delivery",
  );

  // Exercise genuine displacement at core's public active-set cap. No private
  // server fields or production configuration: fillers have no delivery targets.
  await json(`${core}/${next.id}/acknowledge`, "POST", {});
  const victim = await json(core, "POST", {
    path: "acceptance.displacementVictim",
    priority: "caution",
    message: "Displacement victim",
  });
  const victimLocal = await until(
    () => occurrence(victim.id),
    "displacement victim retained",
  );
  await stop();
  await writeFile(
    path.join(directory, "plugin-config-data/signalk-alert-center.json"),
    JSON.stringify({
      enabled: true,
      configuration: { ...configuration, defaults: { notifiers: [] } },
    }),
  );
  await start();
  const active = await json(core);
  for (let i = active.length; i < 1000; i++) {
    await json(core, "POST", {
      path: `acceptance.capacity${i}`,
      priority: "warning",
      message: "Capacity fixture",
    });
  }
  await json(core, "POST", {
    path: "acceptance.urgent",
    priority: "emergency",
    message: "Urgent fixture",
  });
  const displaced = await until(async () => {
    const item = await json(`${ac}/occurrences/${victimLocal.id}`);
    return item.coreAlert?.clearReason === "displaced" && item;
  }, "displacement reason in the real terminal delta");
  assert.equal(displaced.coreResolutionConfirmed, false);
  assert.equal(displaced.clearedAt, undefined);
  assert.ok(
    displaced.deliveries.every((delivery) => delivery.operation !== "resolve"),
  );
  console.log(
    "Core alerts acceptance passed: canonical deltas, silence expiry, return/acknowledge, parallel delivery, restart, grouped latching, terminal removal reasons, displacement without recovery, display-unit rule messages, real rule discovery, wildcard policy and sensor-to-delivery after restart.",
  );
} catch (error) {
  console.error(log);
  throw error;
} finally {
  await stop();
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
