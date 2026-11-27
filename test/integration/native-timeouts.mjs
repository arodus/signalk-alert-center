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
const sensorLeaf = (path) =>
  request(`/signalk/v1/api/vessels/self/${path.replaceAll(".", "/")}`);
async function assertNoTimeoutAlerts() {
  const definitions = await request(`${ac}/definitions?limit=100`);
  assert.ok(
    definitions.items.every((item) => !item.metadata?.nativeTimeout),
    "Sensor freshness must not create an Alert Center timeout rule",
  );
  const occurrences = await request(`${ac}/occurrences?limit=100`);
  assert.ok(
    occurrences.items.every(
      (item) =>
        !item.path.startsWith("notifications.alertCenter.dataTimeout.") &&
        !item.sourcePayload?.data?.nativeTimeout,
    ),
    "Sensor freshness must not create an Alert Center timeout occurrence",
  );
}
try {
  compose("up", "-d", "--build", "--wait", "signalk", "notifier-mock");
  for (const method of ["GET", "POST"]) {
    const response = await fetch(base + `${ac}/native-timeout-rules`, {
      method,
      ...(method === "POST"
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              slug: "removed-rule",
              name: "Removed rule",
              path: "environment.nativeTimeout.fixture",
              severity: "alarm",
            }),
          }
        : {}),
    });
    assert.equal(response.status, 404, `${method} timeout-rule API is absent`);
  }
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
    () => request(`${ac}/status`),
    (status) => status.reconciliation.state === "complete",
    "Alert Center ready after enabling native enforcement",
  );
  const sensor = "environment.nativeTimeout.fixture";
  const delta = await request(`${fixture}/reading`, {
    path: sensor,
    value: 4.2,
  });
  const leaf = await until(
    () => sensorLeaf(sensor),
    (node) => node.value === null && node.state?.timedOut === true,
    "server generated stale state",
  );
  assert.equal(leaf.state.lastValue.timestamp, delta.updates[0].timestamp);
  assert.equal(leaf.state.lastValue.value, 4.2);
  assert.equal(leaf.$source, "fixture.sensor");
  assert.ok(
    Date.parse(leaf.timestamp) > Date.parse(leaf.state.lastValue.timestamp),
    "Timeout event time differs from the last valid reading time",
  );
  await assertNoTimeoutAlerts();
  await request(`${fixture}/reading`, { path: sensor, value: null });
  const unavailable = await until(
    () => sensorLeaf(sensor),
    (node) => node.value === null && node.state?.timedOut !== true,
    "unmarked null remains unavailable rather than stale",
  );
  assert.notEqual(unavailable.state?.timedOut, true);
  const recovery = await request(`${fixture}/reading`, {
    path: sensor,
    value: 5,
  });
  const fresh = await until(
    () => sensorLeaf(sensor),
    (node) => node.value === 5 && node.state?.timedOut !== true,
    "fresh value recovery",
  );
  assert.equal(fresh.timestamp, recovery.updates[0].timestamp);

  // Controls publish only on changes. The real enforcer must leave every leaf
  // intact past its one-second default, including false/zero and ISO timestamps.
  const controls = [
    "quietHours.enabled",
    "snooze.active",
    "snooze.duration",
    "snooze.startedAt",
    "snooze.endsAt",
  ];
  const controlLeaves = () =>
    Promise.all(
      controls.map((path) => sensorLeaf(`digital.alertCenter.${path}`)),
    );
  async function assertStableControls() {
    const before = await controlLeaves();
    for (const leaf of before) {
      assert.equal(leaf.meta.updateContract, "event");
      assert.notEqual(leaf.state?.timedOut, true);
    }
    await delay(2200);
    const after = await controlLeaves();
    after.forEach((leaf, index) => {
      assert.equal(leaf.value, before[index].value, controls[index]);
      assert.equal(leaf.timestamp, before[index].timestamp, controls[index]);
      assert.notEqual(leaf.state?.timedOut, true, controls[index]);
    });
    return after.map((leaf) => leaf.value);
  }
  async function putControl(path, value) {
    const response = await fetch(
      base +
        `/signalk/v1/api/vessels/self/digital/alertCenter/${path.replaceAll(".", "/")}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      },
    );
    assert.ok(response.ok, `PUT ${path}`);
  }
  assert.deepEqual(await assertStableControls(), [true, false, 0, null, null]);
  await putControl("quietHours.enabled", false);
  await putControl("snooze.duration", 120);
  const snoozeBeforeRestart = await request(`${ac}/snooze`);
  const activeValues = await assertStableControls();
  assert.deepEqual(activeValues.slice(0, 2), [false, true]);
  assert.ok(activeValues[2] > 0);
  assert.equal(activeValues[3], snoozeBeforeRestart.startedAt);
  assert.equal(activeValues[4], snoozeBeforeRestart.endsAt);

  compose("restart", "signalk");
  await until(
    () => request(`${ac}/status`),
    (status) => status.reconciliation.state === "complete",
    "Alert Center ready after control state restart",
  );
  const restoredValues = await assertStableControls();
  assert.deepEqual(restoredValues.slice(0, 2), [false, true]);
  assert.ok(restoredValues[2] > 0 && restoredValues[2] <= activeValues[2]);
  assert.deepEqual(restoredValues.slice(3), activeValues.slice(3));
  await putControl("snooze.active", false);
  await putControl("quietHours.enabled", true);
  assert.deepEqual(await assertStableControls(), [true, false, 0, null, null]);
  await putControl("snooze.duration", 2);
  await until(
    () => request(`${ac}/snooze`),
    (state) => !state.active,
    "snooze expires normally with event metadata",
  );
  assert.deepEqual(await assertStableControls(), [true, false, 0, null, null]);

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
  await request(`${fixture}/reading`, {
    path: failoverSensor,
    value: 1,
    source: "fixture.primary",
  });
  // The backup takes over after 300ms, before the primary's 1s native timeout.
  // That later timeout must not replace the selected source's fresh reading.
  let backupDelta;
  for (let i = 0; i < 20; i++) {
    backupDelta = await request(`${fixture}/reading`, {
      path: failoverSensor,
      value: 2,
      source: "fixture.backup",
    });
    await delay(100);
  }
  const selected = await sensorLeaf(failoverSensor);
  assert.equal(selected.$source, "fixture.backup");
  assert.equal(selected.value, 2);
  assert.notEqual(selected.state?.timedOut, true);
  const failedBackup = await until(
    () => sensorLeaf(failoverSensor),
    (node) => node.value === null && node.state?.timedOut === true,
    "selected backup times out",
  );
  assert.equal(failedBackup.$source, "fixture.backup");
  assert.equal(failedBackup.state.lastValue.value, 2);
  assert.equal(
    failedBackup.state.lastValue.timestamp,
    backupDelta.updates[0].timestamp,
  );
  const primaryRecovery = await request(`${fixture}/reading`, {
    path: failoverSensor,
    value: 3,
    source: "fixture.primary",
  });
  const recovered = await until(
    () => sensorLeaf(failoverSensor),
    (node) =>
      node.value === 3 &&
      node.$source === "fixture.primary" &&
      node.state?.timedOut !== true,
    "primary recovery replaces backup stale state",
  );
  assert.equal(recovered.timestamp, primaryRecovery.updates[0].timestamp);
  await assertNoTimeoutAlerts();

  // A user's explicit contract must survive plugin/server restart and retain
  // its normal timeout behavior. Default metadata must not force it to event.
  await putControl("quietHours.enabled.meta", {
    updateContract: "periodic",
    timeout: 1,
    displayName: "Custom quiet-hours control",
  });
  compose("restart", "signalk");
  await until(
    () => request(`${ac}/status`),
    (status) => status.reconciliation.state === "complete",
    "Alert Center ready after user metadata override",
  );
  const overridden = await until(
    () => sensorLeaf("digital.alertCenter.quietHours.enabled"),
    (leaf) => leaf.value === null && leaf.state?.timedOut === true,
    "explicit periodic control still times out",
  );
  assert.equal(overridden.meta.updateContract, "periodic");
  assert.equal(overridden.meta.displayName, "Custom quiet-hours control");
  assert.equal((await request(`${ac}/status`)).quietHours.enabled, true);
  console.log(
    "Signal K 2.38.0 stale state, source recovery, event controls, snooze expiry, restart persistence and user metadata overrides passed without creating timeout alerts.",
  );
} finally {
  compose("down", "-v", "--remove-orphans");
}
