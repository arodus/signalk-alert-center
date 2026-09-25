import assert from "node:assert/strict";

const signalkUrl = process.env.SIGNALK_URL ?? "http://127.0.0.1:3000";
const mockUrl = process.env.NOTIFIER_MOCK_URL ?? "http://127.0.0.1:18080";

async function json(url, options) {
  const response = await fetch(url, options);
  assert.equal(
    response.ok,
    true,
    `${options?.method ?? "GET"} ${url}: ${response.status}`,
  );
  return response.status === 204 ? undefined : response.json();
}

async function eventually(load, predicate, label) {
  let value;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      value = await load();
      if (predicate(value)) return value;
    } catch (error) {
      value = { transientError: String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

await json(`${mockUrl}/reset`, { method: "POST" });
await json(`${mockUrl}/outcomes`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify([
    { status: 503, headers: { "retry-after": "1" }, body: "retry" },
    { status: 204 },
  ]),
});
let response = await fetch(`${mockUrl}/probe`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-fixture": "one" },
  body: JSON.stringify({ attempt: 1 }),
});
assert.equal(response.status, 503);
response = await fetch(`${mockUrl}/probe`, { method: "POST" });
assert.equal(response.status, 204);
const captured = await json(`${mockUrl}/requests`);
assert.equal(captured.length, 2);
assert.deepEqual(captured[0].json, { attempt: 1 });
assert.equal(captured[0].headers["x-fixture"], "one");

await json(`${signalkUrl}/signalk`);
const eventController = new AbortController();
const eventResponse = await fetch(
  `${signalkUrl}/plugins/signalk-alert-center/events`,
  { signal: eventController.signal },
);
assert.equal(eventResponse.status, 200);
assert.match(
  eventResponse.headers.get("content-type") ?? "",
  /text\/event-stream/,
);
const eventChunk = new TextDecoder().decode(
  (await eventResponse.body.getReader().read()).value,
);
assert.match(eventChunk, /event: change/);
eventController.abort();
await json(`${signalkUrl}/plugins/signalk-test-fixture/reset`, {
  method: "POST",
});
const definitionPage = await eventually(
  () =>
    json(`${signalkUrl}/plugins/signalk-alert-center/definitions?limit=100`),
  (page) =>
    page.items.some(
      (item) =>
        item.pathPattern ===
        "notifications.environment.inside.refrigerator.temperature",
    ),
  "zone definition was not discovered",
);
const definition = definitionPage.items.find(
  (item) =>
    item.pathPattern ===
    "notifications.environment.inside.refrigerator.temperature",
);
const updatedDefinition = await json(
  `${signalkUrl}/plugins/signalk-alert-center/definitions/${encodeURIComponent(definition.id)}/policy`,
  {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      oneTime: true,
      minimumSeverity: "alarm",
      activationDelaySeconds: 2,
      connectivity: { mode: "queue" },
      notifierIds: [],
      notifierRepeatOverrides: {},
    }),
  },
);
assert.equal(updatedDefinition.policy.oneTime, true);
assert.equal(updatedDefinition.policy.activationDelaySeconds, 2);
await json(`${signalkUrl}/plugins/signalk-test-fixture/raise`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    source: "fixture.acceptance",
    message: "Acceptance alert",
  }),
});
const fixture = await json(`${signalkUrl}/plugins/signalk-test-fixture/state`);
assert.equal(fixture.zonePath, "environment.inside.refrigerator.temperature");
assert.equal(
  fixture.events.some(
    (event) =>
      event.path ===
        "notifications.environment.inside.refrigerator.temperature" &&
      event.source === "fixture.acceptance",
  ),
  true,
);
const occurrencePage = await eventually(
  () =>
    json(
      `${signalkUrl}/plugins/signalk-alert-center/occurrences?definitionId=${encodeURIComponent(definition.id)}&limit=20`,
    ),
  (page) => page.items.length === 1,
  "raised occurrence was not persisted",
);
const occurrence = occurrencePage.items[0];
assert.equal(occurrence.oneTime, true);
assert.equal(occurrence.message, "Acceptance alert");
const events = await json(
  `${signalkUrl}/plugins/signalk-alert-center/occurrences/${occurrence.id}/events`,
);
assert.equal(
  events.items.some((event) => event.eventType === "raised"),
  true,
);
const alertHistory = await json(
  `${signalkUrl}/plugins/signalk-alert-center/alert-history?definitionId=${encodeURIComponent(definition.id)}&limit=20`,
);
const raisedHistory = alertHistory.items.find(
  (event) => event.alertId === occurrence.id && event.eventType === "raised",
);
assert.equal(Boolean(raisedHistory), true);
assert.equal(raisedHistory.message, "Acceptance alert");
assert.equal(Object.hasOwn(raisedHistory, "deliveries"), false);
const activeRemoval = await fetch(
  `${signalkUrl}/plugins/signalk-alert-center/definitions/${encodeURIComponent(definition.id)}`,
  { method: "DELETE" },
);
assert.equal(activeRemoval.status, 409);

const status = await json(`${signalkUrl}/plugins/signalk-alert-center/status`);
assert.equal(status.alerts.total >= 1, true);
assert.equal(
  ["healthy", "degraded", "fault"].includes(status.health.state),
  true,
);
assert.equal(status.database.healthy, true);
assert.equal(status.database.schemaVersion, 1);
assert.equal(status.reconciliation.state, "complete");
assert.equal(typeof status.scheduler.running, "boolean");
assert.equal(Array.isArray(status.services), true);
const alerts = await json(`${signalkUrl}/plugins/signalk-alert-center/alerts`);
assert.equal(
  alerts.some(
    (alert) =>
      alert.pathPattern ===
      "notifications.environment.inside.refrigerator.temperature",
  ),
  true,
);
await json(`${signalkUrl}/plugins/signalk-test-fixture/clear`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ source: "fixture.acceptance" }),
});
await json(`${signalkUrl}/plugins/signalk-test-fixture/raise`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    source: "fixture.acceptance",
    message: "Acceptance alert again",
  }),
});
const repeated = await eventually(
  () =>
    json(
      `${signalkUrl}/plugins/signalk-alert-center/occurrences?definitionId=${encodeURIComponent(definition.id)}&limit=20`,
    ),
  (page) => page.items.length === 2,
  "re-raised occurrence was not persisted",
);
assert.notEqual(repeated.items[0].id, occurrence.id);
await json(`${signalkUrl}/plugins/signalk-test-fixture/clear`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ source: "fixture.acceptance" }),
});
await eventually(
  () =>
    json(
      `${signalkUrl}/plugins/signalk-alert-center/occurrences/${repeated.items[0].id}`,
    ),
  (item) => item.state === "cleared",
  "re-raised occurrence did not clear",
);
await json(
  `${signalkUrl}/plugins/signalk-alert-center/definitions/${encodeURIComponent(definition.id)}`,
  { method: "DELETE" },
);
const removedDefinition = await fetch(
  `${signalkUrl}/plugins/signalk-alert-center/definitions/${encodeURIComponent(definition.id)}`,
);
assert.equal(removedDefinition.status, 404);
const removedOccurrences = await json(
  `${signalkUrl}/plugins/signalk-alert-center/occurrences?definitionId=${encodeURIComponent(definition.id)}&limit=20`,
);
assert.equal(removedOccurrences.items.length, 0);

const seeded = await json(`${signalkUrl}/plugins/signalk-test-fixture/seed`, {
  method: "POST",
});
assert.equal(seeded.published, 12);
const demoOccurrences = await eventually(
  () =>
    json(`${signalkUrl}/plugins/signalk-alert-center/occurrences?limit=100`),
  (page) => page.items.length >= 9,
  "demo deltas were not persisted",
);
assert.equal(
  demoOccurrences.items.filter(
    (item) => item.path === "notifications.bilge.highWater",
  ).length,
  2,
);

const plugins = await json(`${signalkUrl}/skServer/plugins`);
const notifierPlugin = plugins.find(
  (plugin) => plugin.id === "signalk-alert-center",
);
assert.ok(notifierPlugin, "alert center is listed by Signal K");
const configurationWithTestService = {
  ...notifierPlugin.data.configuration,
  notifiers: [
    {
      name: "Acceptance ntfy",
      type: "ntfy",
      server: "http://notifier-mock:8080",
      topic: "manual-test",
    },
  ],
};
await json(`${signalkUrl}/skServer/plugins/signalk-alert-center/config`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...notifierPlugin.data,
    configuration: configurationWithTestService,
  }),
});
await eventually(
  () => json(`${signalkUrl}/plugins/signalk-alert-center/notifiers`),
  (page) => page.items.some((item) => item.id === "Acceptance ntfy"),
  "test notification service was not configured",
);
const occurrencesBeforeTest = await json(
  `${signalkUrl}/plugins/signalk-alert-center/occurrences?limit=100`,
);
const deliveriesBeforeTest = await json(
  `${signalkUrl}/plugins/signalk-alert-center/deliveries?limit=100`,
);
await json(`${mockUrl}/reset`, { method: "POST" });
const serviceTest = await json(
  `${signalkUrl}/plugins/signalk-alert-center/notifiers/${encodeURIComponent("Acceptance ntfy")}/test`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "send" }),
  },
);
assert.equal(serviceTest.status, "success");
assert.equal(serviceTest.category, "success");
assert.equal(serviceTest.service.id, "Acceptance ntfy");
const testRequests = await json(`${mockUrl}/requests`);
assert.equal(testRequests.length, 1);
assert.equal(testRequests[0].url, "/manual-test");
assert.equal(testRequests[0].headers.title, "TEST: Signal K Alert Center");
assert.match(testRequests[0].body, /not a vessel alert/);
const occurrencesAfterTest = await json(
  `${signalkUrl}/plugins/signalk-alert-center/occurrences?limit=100`,
);
const deliveriesAfterTest = await json(
  `${signalkUrl}/plugins/signalk-alert-center/deliveries?limit=100`,
);
assert.deepEqual(
  occurrencesAfterTest.items.map((item) => item.id),
  occurrencesBeforeTest.items.map((item) => item.id),
);
assert.deepEqual(
  deliveriesAfterTest.items.map((item) => item.id),
  deliveriesBeforeTest.items.map((item) => item.id),
);
await json(`${signalkUrl}/skServer/plugins/signalk-alert-center/config`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...notifierPlugin.data,
    configuration: {
      ...configurationWithTestService,
      maintenance: { resetDatabase: true },
    },
  }),
});
await eventually(
  () => json(`${signalkUrl}/skServer/plugins`),
  (items) => {
    const plugin = items.find((item) => item.id === "signalk-alert-center");
    return plugin?.data.configuration?.maintenance?.resetDatabase === false;
  },
  "one-shot database reset setting was not cleared",
);
await eventually(
  () =>
    json(`${signalkUrl}/plugins/signalk-alert-center/occurrences?limit=100`),
  (page) => !page.items.some((item) => item.id === occurrence.id),
  "database reset retained an old occurrence",
);
await eventually(
  () =>
    json(
      `${signalkUrl}/plugins/signalk-alert-center/definitions/${encodeURIComponent(definition.id)}`,
    ),
  (item) => item.policy.activationDelaySeconds === 0,
  "database reset did not restore the default alert policy",
);

console.log("Docker acceptance smoke test passed");
