import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiscordTransport } from "../src/transports/discord";
import { NtfyTransport } from "../src/transports/ntfy";
import { PagerDutyTransport } from "../src/transports/pagerduty";
import { AlertRecord, DeliveryRecord } from "../src/alerts/types";
import { createInternetProbe } from "../src/connectivity/internet";

const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const enabled = process.env.RUN_DOCKER_INTEGRATION === "1" && dockerAvailable;
const baseUrl = "http://127.0.0.1:18080";
const alert: AlertRecord = {
  id: "integration-alert",
  sourceKey: "notifications.integration.test",
  path: "notifications.integration.test",
  firstSeenAt: new Date("2026-09-05T10:00:00.000Z"),
  lastSeenAt: new Date("2026-09-05T10:00:00.000Z"),
  currentState: "active",
  currentSeverity: "alarm",
  maxSeverity: "alarm",
  message: "Integration test",
};
const delivery: DeliveryRecord = {
  id: "integration-delivery",
  alertId: alert.id,
  transportInstanceId: "integration",
  state: "sending",
  attemptCount: 1,
};
const context = {
  rendered: {
    title: "ALARM: notifications.integration.test",
    body: "Integration test",
    severity: "alarm" as const,
    occurredAt: alert.firstSeenAt,
  },
  now: alert.firstSeenAt,
};

describe.skipIf(!enabled)("Docker HTTP transport integration", () => {
  beforeAll(() => {
    execFileSync(
      "docker",
      [
        "compose",
        "-f",
        "docker-compose.integration.yml",
        "up",
        "-d",
        "--build",
        "--wait",
      ],
      { stdio: "inherit" },
    );
  });

  afterAll(() => {
    execFileSync(
      "docker",
      ["compose", "-f", "docker-compose.integration.yml", "down", "-v"],
      { stdio: "inherit" },
    );
  });

  it("delivers ntfy, PagerDuty, and Discord payloads over HTTP", async () => {
    await expect(
      createInternetProbe({ url: `${baseUrl}/health` })(),
    ).resolves.toBe(true);
    const transports = [
      new NtfyTransport({ server: baseUrl, topic: "ntfy-topic" }),
      new PagerDutyTransport("routing-key", `${baseUrl}/pagerduty`),
      new DiscordTransport(`${baseUrl}/discord`),
    ];
    for (const transport of transports) {
      expect((await transport.send(alert, delivery, context)).kind).toBe(
        "success",
      );
    }
    const requests = await (await fetch(`${baseUrl}/requests`)).json();
    expect(requests).toHaveLength(3);
    expect(requests.map((request: { url: string }) => request.url)).toEqual([
      "/ntfy-topic",
      "/pagerduty",
      "/discord",
    ]);
  });
});
