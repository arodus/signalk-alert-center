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
assert.ok(
  server,
  "Set SIGNALK_CORE_SERVER_DIR to a built hatlabs/signalk-server checkout",
);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: server,
    encoding: "utf8",
  }).trim(),
  "ae7f8684514c96cbca9208a3da3c1e8440840021",
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

  // A normal snapshot alone remains unclassified, even for a genuine clear.
  const caution = await json(core, "POST", {
    path: "acceptance.caution",
    priority: "caution",
    message: "Caution fixture",
  });
  await until(() => occurrence(caution.id), "caution persisted");
  await json(`${core}/${caution.id}/condition`, "PUT", { active: false });
  await until(
    async () => (await occurrence(caution.id)).coreAlert.state === "normal",
    "unclassified removal retained",
  );
  assert.equal((await occurrence(caution.id)).coreResolutionConfirmed, false);
  console.log(
    "Core alerts acceptance passed: canonical deltas, silence expiry, return/acknowledge, parallel delivery, restart, grouped latching, deferred removal classification.",
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
