// Owns an isolated real-server environment; never accepts a vessel/server URL.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const project = "alert-center-native-timeouts";
const port = process.env.SIGNALK_NATIVE_TIMEOUT_PORT ?? "3333";
const env = {
  ...process.env,
  SIGNALK_SERVER_IMAGE: "cr.signalk.io/signalk/signalk-server:v2.38.0",
  SIGNALK_ACCEPTANCE_PORT: port,
  NOTIFIER_MOCK_PORT: process.env.NATIVE_TIMEOUT_MOCK_PORT ?? "18383",
};
const compose = (...args) =>
  execFileSync(
    "docker",
    ["compose", "-p", project, "-f", "docker-compose.acceptance.yml", ...args],
    { env, stdio: "inherit" },
  );
const base = `http://127.0.0.1:${port}`;
const ac = "/plugins/signalk-alert-center";
const fixture = "/plugins/signalk-test-fixture";
async function request(path, body) {
  const result = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  assert.ok(
    result.ok,
    `${path}: ${result.status} ${await result.clone().text()}`,
  );
  return result.json();
}
async function until(read, check, label) {
  const deadline = Date.now() + 15_000;
  do {
    try {
      const result = await read();
      if (check(result)) return result;
    } catch {}
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
try {
  compose("up", "-d", "--build", "--wait", "signalk", "notifier-mock");
  assert.equal((await request(`${ac}/native-timeout-rules`)).enabled, false);
  // This volume belongs exclusively to this test project.
  compose(
    "exec",
    "-T",
    "signalk",
    "node",
    "-e",
    `const fs=require('node:fs'); const path=require('node:path'); const p=path.join(process.env.SIGNALK_NODE_CONFIG_DIR ?? path.join(require('node:os').homedir(),'.signalk'),'settings.json'); const settings=JSON.parse(fs.readFileSync(p)); Object.assign(settings,{enforceDataTimeouts:true,defaultTimeout:1,staleCheckIntervalMs:100}); fs.writeFileSync(p,JSON.stringify(settings));`,
  );
  compose("restart", "signalk");
  await until(
    () => request(`${ac}/native-timeout-rules`),
    (status) => status.enabled,
    "native enforcement enabled",
  );
  const sensor = "environment.nativeTimeout.fixture";
  const definition = await request(`${ac}/native-timeout-rules`, {
    slug: "native-contract",
    name: "Native contract",
    path: sensor,
    severity: "alarm",
  });
  const occurrences = () =>
    request(
      `${ac}/occurrences?definitionId=${encodeURIComponent(definition.id)}`,
    );
  assert.equal((await occurrences()).items.length, 0);
  const delta = await request(`${fixture}/reading`, {
    path: sensor,
    value: 4.2,
  });
  const first = await until(
    occurrences,
    (body) => body.items[0]?.state === "active",
    "server generated timeout",
  );
  const occurrence = first.items[0];
  const leaf = await request(
    `/signalk/v1/api/vessels/self/${sensor.replaceAll(".", "/")}`,
  );
  assert.equal(leaf.value, null);
  assert.equal(leaf.state.timedOut, true);
  assert.equal(leaf.state.lastValue.timestamp, delta.updates[0].timestamp);
  assert.equal(
    occurrence.sourcePayload.data.lastValidTimestamp,
    delta.updates[0].timestamp,
  );
  assert.equal(occurrence.sourcePayload.data.lastValue, 4.2);
  assert.equal(occurrence.sourcePayload.data.source, "fixture.sensor");
  await delay(400);
  assert.equal((await occurrences()).items.length, 1);
  await request(`${fixture}/reading`, { path: sensor, value: null });
  await delay(100);
  assert.equal(
    (await occurrences()).items[0].state,
    "active",
    "unmarked null must not fabricate recovery",
  );
  await request(`${fixture}/reading`, { path: sensor, value: 5 });
  await until(
    occurrences,
    (body) =>
      body.items.find((item) => item.id === occurrence.id)?.state === "cleared",
    "fresh value recovery",
  );
  const events = await request(`${ac}/occurrences/${occurrence.id}/events`);
  assert.ok(events.items.some((event) => event.eventType === "raised"));
  assert.ok(events.items.some((event) => event.eventType === "cleared"));
  const failoverSensor = "environment.nativeTimeout.failover";
  const priorities = await fetch(base + "/skServer/priorityOverrides", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      [failoverSensor]: [
        { sourceRef: "fixture.primary", timeout: 0 },
        { sourceRef: "fixture.backup", timeout: 300 },
      ],
    }),
  });
  assert.ok(priorities.ok, "Set test source priorities");
  const failoverRule = await request(`${ac}/native-timeout-rules`, {
    slug: "native-failover",
    name: "Preferred-source timeout",
    path: failoverSensor,
    severity: "alarm",
  });
  const failoverOccurrences = () =>
    request(
      `${ac}/occurrences?definitionId=${encodeURIComponent(failoverRule.id)}`,
    );
  await request(`${fixture}/reading`, {
    path: failoverSensor,
    value: 1,
    source: "fixture.primary",
  });
  // The backup takes over after 300ms, before the primary's 1s native timeout.
  // That later timeout must not steal the path or raise an occurrence.
  for (let i = 0; i < 20; i++) {
    await request(`${fixture}/reading`, {
      path: failoverSensor,
      value: 2,
      source: "fixture.backup",
    });
    await delay(100);
  }
  const selected = await request(
    `/signalk/v1/api/vessels/self/${failoverSensor.replaceAll(".", "/")}`,
  );
  assert.equal(selected.$source, "fixture.backup");
  assert.equal(selected.value, 2);
  assert.equal(
    (await failoverOccurrences()).items.length,
    0,
    "Losing primary timeout must not raise an alert",
  );
  const failedBackup = await until(
    failoverOccurrences,
    (body) => body.items[0]?.state === "active",
    "selected backup times out",
  );
  await request(`${fixture}/reading`, {
    path: failoverSensor,
    value: 3,
    source: "fixture.primary",
  });
  await until(
    failoverOccurrences,
    (body) =>
      body.items.find((item) => item.id === failedBackup.items[0].id)?.state ===
      "cleared",
    "primary recovery clears backup timeout",
  );
  console.log(
    "Signal K 2.38.0 native timeout contract, last valid timestamp, null handling, deduplication, source failover and recovery passed.",
  );
} finally {
  compose("down", "-v", "--remove-orphans");
}
