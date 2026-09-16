import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const compose = [
  "compose",
  "-p",
  "alert-center-restart",
  "-f",
  "docker-compose.acceptance.yml",
];
const base = process.env.SIGNALK_RESTART_URL ?? "http://127.0.0.1:3300";
const api = `${base}/plugins/signalk-alert-center`;
const fixture = `${base}/plugins/signalk-test-fixture`;
const mock = process.env.NOTIFIER_MOCK_URL ?? "http://127.0.0.1:18080";
const run = (args) => {
  const result = spawnSync("docker", [...compose, ...args], {
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(`docker compose failed with ${result.status}`);
};
const json = async (url, options) => {
  const response = await fetch(url, options);
  assert.equal(
    response.ok,
    true,
    `${options?.method ?? "GET"} ${url}: ${response.status}`,
  );
  return response.json();
};
const eventually = async (load, predicate, label) => {
  let value;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      value = await load();
      if (predicate(value)) return value;
    } catch (error) {
      value = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`${label}: ${JSON.stringify(value)}`);
};

try {
  run(["up", "-d", "--build", "--wait", "signalk", "notifier-mock"]);
  const definitions = await eventually(
    () => json(`${api}/definitions?limit=100`),
    (page) =>
      page.items.some(
        (item) =>
          item.pathPattern ===
          "notifications.environment.inside.refrigerator.temperature",
      ),
    "zone definition",
  );
  const definition = definitions.items.find(
    (item) =>
      item.pathPattern ===
      "notifications.environment.inside.refrigerator.temperature",
  );
  const plugins = await json(`${base}/skServer/plugins`);
  const notifierPlugin = plugins.find(
    (plugin) => plugin.id === "signalk-alert-center",
  );
  await json(`${base}/skServer/plugins/signalk-alert-center/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...notifierPlugin.data,
      configuration: {
        ...notifierPlugin.data.configuration,
        retry: { initialSeconds: 5, maxSeconds: 5, multiplier: 1, jitter: 0 },
        notifiers: [
          {
            name: "Restart mock",
            type: "ntfy",
            server: "http://notifier-mock:8080",
            topic: "alerts",
          },
        ],
      },
    }),
  });
  await eventually(
    () => json(`${api}/notifiers`),
    (page) => page.items?.some((item) => item.id === "Restart mock"),
    "mock notifier configuration",
  );
  run(["stop", "signalk"]);
  run([
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "sh",
    "signalk",
    "-c",
    "mv /home/node/.signalk/plugin-config-data/signalk-alert-center.json /home/node/.signalk/plugin-config-data/signalk-persistent-notifier.json",
  ]);
  run(["up", "-d", "--wait", "signalk"]);
  run([
    "exec",
    "-T",
    "signalk",
    "test",
    "-f",
    "/home/node/.signalk/plugin-config-data/signalk-alert-center.json",
  ]);
  run([
    "exec",
    "-T",
    "signalk",
    "test",
    "!",
    "-e",
    "/home/node/.signalk/plugin-config-data/signalk-persistent-notifier.json",
  ]);
  await eventually(
    () => json(`${api}/notifiers`),
    (page) => page.items?.some((item) => item.id === "Restart mock"),
    "notifier retained after plugin-id migration",
  );
  await json(`${api}/definitions/${encodeURIComponent(definition.id)}/policy`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      activationDelaySeconds: 3,
      notifierIds: ["Restart mock"],
    }),
  });
  await json(`${mock}/reset`, { method: "POST" });
  await json(`${mock}/outcomes`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { status: 503, headers: { "retry-after": "5" }, body: "retry" },
      { status: 204 },
    ]),
  });
  const source = `restart.acceptance.${Date.now()}`;
  await json(`${fixture}/raise`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, message: "Restart persistence alert" }),
  });
  const before = await eventually(
    () =>
      json(
        `${api}/occurrences?definitionId=${encodeURIComponent(definition.id)}&source=${encodeURIComponent(source)}&limit=10`,
      ),
    (page) => page.items.length === 1,
    "occurrence before restart",
  );
  const id = before.items[0].id;
  assert.equal(before.items[0].activationState, "pending");
  run(["restart", "signalk"]);
  await eventually(() => json(`${base}/signalk`), Boolean, "Signal K restart");
  const after = await eventually(
    () => json(`${api}/occurrences/${id}`),
    (item) => item.id === id && item.message === "Restart persistence alert",
    "persisted occurrence after restart",
  );
  assert.equal(after.state, "active");
  await eventually(
    () => json(`${api}/deliveries`),
    (page) =>
      page.items.some(
        (delivery) =>
          delivery.alertId === id && delivery.state === "failed_retryable",
      ),
    "retryable delivery before second restart",
  );
  run(["restart", "signalk"]);
  await eventually(
    () => json(`${base}/signalk`),
    Boolean,
    "second Signal K restart",
  );
  await eventually(
    () => json(`${api}/deliveries`),
    (page) =>
      page.items.some(
        (delivery) => delivery.alertId === id && delivery.state === "delivered",
      ),
    "retry delivery after restart",
  );
  const events = await json(`${api}/occurrences/${id}/events`);
  assert.equal(
    events.items.some((event) => event.eventType === "raised"),
    true,
  );
  console.log("Docker restart persistence test passed");
} finally {
  spawnSync("docker", [...compose, "down", "-v", "--remove-orphans"], {
    stdio: "inherit",
  });
}
