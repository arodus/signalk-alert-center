import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Synthetic credentials, confined to the test-only Compose network (no host ports).
const secret = "alert-center-isolated-acl-test-secret";
const users = [
  { username: "owner", type: "admin" },
  { username: "restricted-admin", type: "admin" },
  { username: "crew", type: "readwrite" },
  { username: "demo", type: "readwrite" },
  { username: "viewer", type: "readonly" },
];

if (process.argv[2] === "setup") {
  const directory =
    process.env.SIGNALK_NODE_CONFIG_DIR ?? join(homedir(), ".signalk");
  mkdirSync(join(directory, "plugin-config-data"), { recursive: true });
  writeFileSync(
    join(directory, "security.json"),
    JSON.stringify({
      secretKey: secret,
      allow_readonly: true,
      users,
      devices: [],
      acls: [
        {
          context: "vessels.self",
          resources: [
            {
              paths: ["notifications.electrical.*"],
              permissions: [
                { subject: "owner", permission: "put" },
                { subject: "crew", permission: "put" },
                { subject: "any", permission: "read" },
              ],
            },
            {
              paths: ["*"],
              permissions: [
                { subject: "owner", permission: "put" },
                { subject: "any", permission: "read" },
              ],
            },
          ],
        },
      ],
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(directory, "plugin-config-data/signalk-alert-center.json"),
    JSON.stringify({
      enabled: true,
      configuration: {
        storage: { path: join(directory, "alert-center.sqlite") },
        connectivity: { enabled: false },
        defaults: { notifiers: ["Mock"] },
        notifiers: [
          {
            name: "Mock",
            type: "ntfy",
            server: "http://notifier-mock:8080",
            topic: "acl-test",
          },
        ],
      },
    }),
  );
} else {
  await testAuthorization();
}

function token(username) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ id: username, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

async function testAuthorization() {
  const base = process.env.SIGNALK_URL ?? "http://signalk:3000";
  const mock = process.env.NOTIFIER_MOCK_URL ?? "http://notifier-mock:8080";
  const api = "/plugins/signalk-alert-center";
  async function request(
    path,
    user = "owner",
    method = "GET",
    body,
    expected = 200,
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(user ? { Cookie: `JAUTHENTICATION=${token(user)}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(
      response.status,
      expected,
      `${method} ${path} as ${user ?? "anonymous"}: ${response.status} ${text}`,
    );
    return expected === 200 && text ? JSON.parse(text) : undefined;
  }
  async function eventually(load, predicate, label) {
    let value;
    for (let attempt = 0; attempt < 60; attempt++) {
      value = await load();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  }
  async function mockRequest(path, method = "GET", body) {
    const response = await fetch(`${mock}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.ok, true);
    return response.json();
  }

  await eventually(
    () => request(`${api}/status`),
    (state) => state.reconciliation?.state === "complete",
    "plugin startup",
  );
  // Force terminal failures so denied retries/deletions can be checked against stable work.
  await mockRequest("/reset", "POST");
  await mockRequest("/outcomes", "PUT", [{ status: 400 }, { status: 400 }]);
  const targets = [];
  for (const path of [
    "notifications.electrical.aclTest",
    "notifications.navigation.aclTest",
  ]) {
    const raised = await request(
      "/signalk/v2/api/notifications",
      "owner",
      "POST",
      { path, state: "alarm", message: `ACL test ${path}` },
    );
    const page = await eventually(
      () => request(`${api}/occurrences?path=${encodeURIComponent(path)}`),
      (page) => page.items.some((item) => item.notificationId === raised.id),
      "occurrence ingestion",
    );
    targets.push(page.items.find((item) => item.notificationId === raised.id));
  }
  const deliveries = await eventually(
    () => request(`${api}/deliveries`),
    (page) =>
      page.items.filter((item) => item.state === "failed_terminal").length ===
      2,
    "failed delivery fixtures",
  );
  const electrical = targets[0];
  const navigation = targets[1];
  const definitionId = encodeURIComponent(electrical.definitionId);
  const deliveryId = encodeURIComponent(deliveries.items[0].id);
  const reads = [
    "/status",
    "/alerts",
    "/definitions",
    "/occurrences",
    "/alert-history",
    "/deliveries",
    "/notifiers",
    "/snooze",
  ];
  for (const user of [null, "viewer", "demo"]) {
    for (const path of reads) await request(`${api}${path}`, user);
  }
  const before = await Promise.all(
    targets.map((item) => request(`${api}/occurrences/${item.id}`)),
  );
  const historyBefore = await request(`${api}/alert-history`);
  const policyBefore = await request(`${api}/definitions/${definitionId}`);
  const requestsBefore = await mockRequest("/requests");

  for (const user of [null, "viewer", "demo", "restricted-admin"]) {
    for (const occurrence of targets) {
      for (const prefix of ["alerts", "occurrences"]) {
        for (const action of ["acknowledge", "silence"]) {
          await request(
            `${api}/${prefix}/${occurrence.id}/${action}`,
            user,
            "POST",
            undefined,
            user === null || user === "viewer" ? 401 : 403,
          );
        }
      }
    }
  }
  // Having PUT on electrical alerts must not grant navigation alarm control.
  for (const prefix of ["alerts", "occurrences"]) {
    for (const action of ["acknowledge", "silence"]) {
      await request(
        `${api}/${prefix}/${navigation.id}/${action}`,
        "crew",
        "POST",
        undefined,
        403,
      );
    }
  }
  const adminWrites = [
    ["PATCH", `/definitions/${definitionId}/policy`, { enabled: false }],
    ["DELETE", `/definitions/${definitionId}/policy`],
    ["DELETE", `/definitions/${definitionId}`],
    ["DELETE", "/deliveries"],
    ["DELETE", `/deliveries/${deliveryId}`],
    ["POST", `/deliveries/${deliveryId}/retry`],
    ["POST", "/retry"],
    ["POST", "/notifiers/Mock/test", { operation: "send" }],
    ["POST", "/snooze", { durationSeconds: 60 }],
    ["DELETE", "/snooze"],
  ];
  for (const user of [null, "viewer", "demo", "crew"]) {
    for (const [method, path, body] of adminWrites)
      await request(`${api}${path}`, user, method, body, 401);
  }
  assert.deepEqual(
    await Promise.all(
      targets.map((item) => request(`${api}/occurrences/${item.id}`)),
    ),
    before,
  );
  assert.deepEqual(await request(`${api}/alert-history`), historyBefore);
  assert.deepEqual(
    await request(`${api}/definitions/${definitionId}`),
    policyBefore,
  );
  assert.deepEqual(await request(`${api}/deliveries`), deliveries);
  assert.deepEqual(await mockRequest("/requests"), requestsBefore);
  assert.equal((await request(`${api}/snooze`)).active, false);
  for (const occurrence of targets) {
    const upstream = await request(
      `/signalk/v2/api/notifications/${occurrence.notificationId}`,
    );
    assert.equal(upstream.value.status.acknowledged, false);
    assert.equal(upstream.value.status.silenced, false);
  }

  // Exercise all four action routes successfully with a path-authorized crew login.
  for (const prefix of ["occurrences", "alerts"]) {
    for (const action of ["silence", "acknowledge"]) {
      await request(
        `${api}/${prefix}/${electrical.id}/${action}`,
        "crew",
        "POST",
      );
    }
  }
  const upstream = await request(
    `/signalk/v2/api/notifications/${electrical.notificationId}`,
  );
  assert.equal(upstream.value.status.acknowledged, true);
  assert.equal(upstream.value.status.silenced, true);
  await request(
    `${api}/occurrences/missing/acknowledge`,
    "crew",
    "POST",
    undefined,
    404,
  );
  await request(
    `${api}/alerts/missing/silence`,
    "crew",
    "POST",
    undefined,
    404,
  );
  await request(`${api}/definitions/${definitionId}/policy`, "owner", "PATCH", {
    enabled: false,
  });
  assert.equal(
    (await request(`${api}/definitions/${definitionId}`)).policy.enabled,
    false,
  );
  await request(`${api}/definitions/${definitionId}/policy`, "owner", "DELETE");
  await request(`${api}/snooze`, "owner", "POST", { durationSeconds: 60 });
  assert.equal((await request(`${api}/snooze`)).active, true);
  await request(`${api}/snooze`, "owner", "DELETE");
  await request(`${api}/notifiers/Mock/test`, "owner", "POST", {
    operation: "send",
  });
  await request(`${api}/deliveries`, "owner", "DELETE");
  console.log(
    "Signal K ACL acceptance passed: scoped alert actions, admin mutations, read-only access, and denied-write durability",
  );
}
