import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Synthetic identities and signing key, used only by the isolated loopback server.
export const coreSecurity = {
  secretKey: "alert-center-core-acl-test-secret",
  allow_readonly: true,
  users: [
    { username: "owner", type: "admin" },
    { username: "restricted-admin", type: "admin" },
    { username: "crew", type: "readwrite" },
    { username: "legacy", type: "readwrite" },
    { username: "namespace", type: "readwrite" },
    { username: "demo", type: "readwrite" },
    { username: "viewer", type: "readonly" },
  ],
  devices: [],
  acls: [
    {
      context: "vessels.self",
      resources: [
        { paths: ["alerts.electrical.*"], permissions: grants("crew") },
        {
          paths: ["notifications.electrical.*"],
          permissions: grants("legacy"),
        },
        { paths: ["alerts", "electrical.*"], permissions: grants("namespace") },
        { paths: ["*"], permissions: grants() },
      ],
    },
  ],
};
function grants(user) {
  return [
    { subject: "owner", permission: "put" },
    ...(user ? [{ subject: user, permission: "put" }] : []),
    { subject: "any", permission: "read" },
  ];
}
export function coreCookie(user = "owner") {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ id: user, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `JAUTHENTICATION=${unsigned}.${createHmac("sha256", coreSecurity.secretKey).update(unsigned).digest("base64url")}`;
}

export async function testCoreAuthorization({
  base,
  json,
  until,
  occurrence,
  requests,
  withoutACLs,
}) {
  const api = "/plugins/signalk-alert-center";
  const core = "/signalk/v2/api/alerts";
  async function request(route, user, method = "GET", body, expected = 200) {
    const response = await fetch(base + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(user ? { Cookie: coreCookie(user) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    const text = await response.text();
    assert.equal(
      response.status,
      expected,
      `${method} ${route} as ${user ?? "anonymous"}: ${response.status} ${text}`,
    );
    const result =
      text && response.headers.get("content-type")?.includes("application/json")
        ? JSON.parse(text)
        : undefined;
    if (expected === 403) {
      assert.equal(result.error.code, "FORBIDDEN");
      assert.match(result.error.message, /permission.*Signal K administrator/);
      assert.doesNotMatch(result.error.message, /sign in/i);
    }
    return result;
  }
  const targets = [];
  // Distinct instances under a wildcard prove that the stored concrete path is checked.
  for (const path of [
    "electrical.batteries.house.low",
    "electrical.batteries.engine.low",
    "navigation.aclTest",
  ]) {
    const raised = await json(core, "POST", {
      path,
      priority: "alarm",
      message: `Core ACL test ${path}`,
    });
    targets.push(
      await until(() => occurrence(raised.id), "core ACL occurrence ingestion"),
    );
  }
  const legacyRaised = await json("/signalk/v2/api/notifications", "POST", {
    path: "notifications.electrical.aclTest",
    state: "alarm",
    message: "Legacy ACL test",
  });
  const legacy = await until(
    async () =>
      (await json(`${api}/occurrences?limit=100`)).items.find(
        (item) => item.notificationId === legacyRaised.id,
      ),
    "legacy ACL occurrence ingestion",
  );
  const all = [...targets, legacy];
  const deliveries = await until(async () => {
    const page = await json(`${api}/deliveries`);
    return (
      page.items.length === all.length * 2 &&
      page.items.every((item) => item.state === "failed_terminal") &&
      page
    );
  }, "terminal mock deliveries");
  const definition = encodeURIComponent(targets[0].definitionId);
  const delivery = encodeURIComponent(deliveries.items[0].id);
  async function snapshot() {
    return {
      occurrences: await Promise.all(
        all.map((item) => json(`${api}/occurrences/${item.id}`)),
      ),
      history: await json(`${api}/alert-history`),
      definitions: await Promise.all(
        all.map((item) =>
          json(`${api}/definitions/${encodeURIComponent(item.definitionId)}`),
        ),
      ),
      deliveries: await json(`${api}/deliveries`),
      snooze: await json(`${api}/snooze`),
      upstream: await Promise.all(
        targets.map((item) => json(`${core}/${item.coreAlert.id}`)),
      ),
      legacy: await json(`/signalk/v2/api/notifications/${legacyRaised.id}`),
      requests: structuredClone(requests),
    };
  }
  const before = await snapshot();
  for (const user of [
    null,
    "viewer",
    "demo",
    "restricted-admin",
    "legacy",
    "namespace",
  ]) {
    for (const route of [
      "/status",
      "/definitions",
      "/occurrences",
      "/alert-history",
      "/deliveries",
      "/snooze",
    ])
      await request(api + route, user);
    for (const target of targets)
      for (const prefix of ["occurrences", "alerts"])
        for (const action of ["acknowledge", "silence"])
          await request(
            `${api}/${prefix}/${target.id}/${action}`,
            user,
            "POST",
            {},
            user === null || user === "viewer" ? 401 : 403,
          );
  }
  // Core-only grants cannot control legacy notifications or another core path.
  for (const target of [targets[2], legacy])
    for (const prefix of ["occurrences", "alerts"])
      for (const action of ["acknowledge", "silence"])
        await request(
          `${api}/${prefix}/${target.id}/${action}`,
          "crew",
          "POST",
          {},
          403,
        );
  const adminWrites = [
    ["PATCH", `/definitions/${definition}/policy`, { enabled: false }],
    ["DELETE", `/definitions/${definition}/policy`],
    ["DELETE", `/definitions/${definition}`],
    ["DELETE", "/deliveries"],
    ["DELETE", `/deliveries/${delivery}`],
    ["POST", `/deliveries/${delivery}/retry`],
    ["POST", "/retry"],
    ["POST", "/notifiers/success/test", { operation: "send" }],
    ["POST", "/snooze", { durationSeconds: 60 }],
    ["DELETE", "/snooze"],
  ];
  for (const user of [null, "viewer", "demo", "crew"])
    for (const [method, route, body] of adminWrites)
      await request(api + route, user, method, body, 401);
  assert.deepEqual(
    await snapshot(),
    before,
    "Denied writes must not change upstream state, durable history, policies, deliveries or mock traffic",
  );

  // Each route family successfully controls a different concrete wildcard instance.
  for (const [index, prefix] of ["occurrences", "alerts"].entries()) {
    for (const action of ["silence", "acknowledge"]) {
      await request(
        `${api}/${prefix}/${targets[index].id}/${action}`,
        "crew",
        "POST",
        {},
      );
      const upstream = await json(`${core}/${targets[index].coreAlert.id}`);
      const local = await json(`${api}/occurrences/${targets[index].id}`);
      // Core acknowledgment supersedes silence and clears it.
      assert.equal(upstream.silenced, action === "silence");
      assert.equal(local.coreAlert.silenced, action === "silence");
      if (action === "acknowledge") {
        assert.equal(upstream.state, "acknowledged");
        assert.equal(upstream.acknowledgedBy, "signalk-alert-center");
        assert.equal(local.coreAlert.state, "acknowledged");
      }
    }
  }
  await request(
    `${api}/occurrences/${legacy.id}/acknowledge`,
    "legacy",
    "POST",
    {},
  );
  await request(`${api}/snooze`, "owner", "POST", { durationSeconds: 60 });
  assert.equal((await json(`${api}/snooze`)).active, true);
  await request(`${api}/snooze`, "owner", "DELETE");
  for (const prefix of ["occurrences", "alerts"])
    for (const action of ["acknowledge", "silence"])
      await request(
        `${api}/${prefix}/missing/${action}`,
        "crew",
        "POST",
        {},
        404,
      );

  // Removing ACLs does not remove login-role enforcement or require admin for alert actions.
  await withoutACLs();
  for (const prefix of ["occurrences", "alerts"])
    for (const action of ["acknowledge", "silence"]) {
      for (const user of [null, "viewer"])
        await request(
          `${api}/${prefix}/${targets[2].id}/${action}`,
          user,
          "POST",
          {},
          401,
        );
      await request(
        `${api}/${prefix}/${targets[2].id}/${action}`,
        "demo",
        "POST",
        {},
      );
    }
  for (const [method, route, body] of adminWrites)
    await request(api + route, "demo", method, body, 401);
  const upstream = await json(`${core}/${targets[2].coreAlert.id}`);
  assert.equal(upstream.state, "acknowledged");
  assert.equal(upstream.silenced, true);
  console.log(
    "Core ACL acceptance passed: scoped core/legacy grants, both action routes, restricted admins, unchanged denied-write state, admin snooze, and readwrite access without ACLs.",
  );
}
