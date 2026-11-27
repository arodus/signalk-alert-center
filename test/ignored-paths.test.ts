import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerAPI } from "@signalk/server-api";
import { describe, expect, it, vi } from "vitest";
import { PluginConfig, validateConfig } from "../src/config";
import { pluginConfigSchema } from "../src/config-schema";
import { AlertCenterRuntime } from "../src/runtime";
import { ignoredPathMatcher } from "../src/signalk/ignored-paths";
import { AlertDatabase } from "../src/storage/db";

const collision =
  "notifications.navigation.closestApproach.urn:mrn:imo:mmsi:244954000";
const coursePaths = [
  "notifications.navigation.course.arrivalCircleEntered",
  "notifications.navigation.course.perpendicularPassed",
];
const accessRequests = [
  "notifications.security.accessRequest.a",
  "notifications.security.accessRequest.client.request-id",
];
const battery = "notifications.electrical.batteries.house.voltage";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("ignored notification paths", () => {
  it("matches complete literal paths and non-empty wildcards across segments", () => {
    const ignored = ignoredPathMatcher(["navigation.closestApproach.*"]);
    expect(ignored(collision)).toBe(true);
    expect(
      ignored("notifications.navigation.closestApproach.radar:bridge:1"),
    ).toBe(true);
    expect(
      ignored("notifications.navigation.closestApproach.radar.bridge.1"),
    ).toBe(true);
    expect(ignored("notifications.navigation.closestApproach.")).toBe(false);
    expect(ignored("notifications.navigation.closestApproach")).toBe(false);
    expect(ignored(battery)).toBe(false);
    expect(
      ignored("notifications.other.navigation.closestApproach.target"),
    ).toBe(false);
    const exact = ignoredPathMatcher([
      " notifications.electrical.batteries.house.voltage ",
    ]);
    expect(exact(battery)).toBe(true);
    expect(exact(`${battery}.extra`)).toBe(false);
    expect(ignoredPathMatcher(["electrical.*.voltage"])(battery)).toBe(true);
    const literal = "notifications.test.a+b(c)[d]?$^{}|\\value";
    expect(ignoredPathMatcher([literal])(literal)).toBe(true);
    expect(ignoredPathMatcher([literal])("notifications.test.abcvalue")).toBe(
      false,
    );
    expect(ignoredPathMatcher()(collision)).toBe(true);
    expect(ignoredPathMatcher([])(collision)).toBe(false);
  });

  it("keeps other course paths and honors explicit lists without adding defaults", () => {
    const ignored = ignoredPathMatcher();
    for (const path of coursePaths) {
      expect(ignored(path)).toBe(true);
      expect(ignored(path.replace(/^notifications\./, ""))).toBe(true);
      expect(ignored(`${path}.extra`)).toBe(false);
      expect(ignoredPathMatcher([])(path)).toBe(false);
      expect(ignoredPathMatcher(["navigation.closestApproach.*"])(path)).toBe(
        false,
      );
      expect(ignoredPathMatcher([coursePaths[0]])(path)).toBe(
        path === coursePaths[0],
      );
    }
    expect(ignored("notifications.navigation.course.offCourse")).toBe(false);
  });

  it("ignores access-request descendants by default while preserving other security alerts and explicit lists", () => {
    for (const path of accessRequests) {
      expect(ignoredPathMatcher()(path)).toBe(true);
      expect(ignoredPathMatcher()(path.replace(/^notifications\./, ""))).toBe(
        true,
      );
      expect(ignoredPathMatcher([])(path)).toBe(false);
      expect(ignoredPathMatcher(["navigation.closestApproach.*"])(path)).toBe(
        false,
      );
    }
    for (const path of [
      "notifications.security.accessRequest",
      "notifications.security.accessRequest.",
      "notifications.security.accessRequests.client",
      "notifications.security.intrusion.cabin",
      "notifications.other.security.accessRequest.client",
    ])
      expect(ignoredPathMatcher()(path)).toBe(false);
  });

  it("defaults to ignoring collision, waypoint and access-request paths and rejects malformed configuration", () => {
    expect(pluginConfigSchema.properties.ignoredPaths.default).toEqual([
      "navigation.closestApproach.*",
      "navigation.course.arrivalCircleEntered",
      "navigation.course.perpendicularPassed",
      "security.accessRequest.*",
    ]);
    for (const config of [
      {},
      { ignoredPaths: [] },
      { ignoredPaths: ["navigation.closestApproach.*"] },
    ]) {
      expect(() => validateConfig(config)).not.toThrow();
    }
    for (const ignoredPaths of [
      null,
      "navigation.*",
      [12],
      [null],
      [""],
      ["  "],
      ["notifications."],
    ]) {
      expect(() => validateConfig({ ignoredPaths } as PluginConfig)).toThrow(
        "ignoredPaths",
      );
    }
  });

  it.each([collision, ...coursePaths, ...accessRequests])(
    "filters %s live updates and snapshots, preserving stored work across restart",
    async (ignoredPath) => {
      const directory = mkdtempSync(join(tmpdir(), "ignored-paths-"));
      let subscriber: (delta: unknown) => void = () => {};
      const self = {
        navigation: {
          closestApproach: {
            zoned: { meta: { zones: [{ state: "alarm", upper: 100 }] } },
          },
        },
        electrical: {
          batteries: {
            house: {
              voltage: { meta: { zones: [{ state: "alarm", upper: 12 }] } },
            },
          },
        },
        notifications: ignoredPath
          .replace(/^notifications\./, "")
          .split(".")
          .reduceRight<Record<string, unknown>>(
            (value, segment) => ({ [segment]: value }),
            {
              value: { state: "alert", message: "Ignored snapshot" },
              $source: "fixture",
            },
          ),
      };
      const app = {
        debug: vi.fn(),
        error: vi.fn(),
        handleMessage: vi.fn(),
        setPluginStatus: vi.fn(),
        getDataDirPath: () => directory,
        selfContext: "vessels.self",
        getPath: (path: string) =>
          path === "vessels.self.notifications" ? self.notifications : self,
        getSelfPath: (path: string) =>
          path === "network.internet.state" ? "offline" : undefined,
        subscriptionmanager: {
          subscribe: (
            command: { subscribe: Array<{ path: string }> },
            unsubscribes: Array<() => void>,
            _error: unknown,
            callback: (delta: unknown) => void,
          ) => {
            if (
              command.subscribe.some(({ path }) => path === "notifications.*")
            )
              subscriber = callback;
            unsubscribes.push(vi.fn());
          },
        },
      } as unknown as ServerAPI;
      const runtime = new AlertCenterRuntime(app);
      const config: PluginConfig = {
        defaults: {
          minSeverity: "alert",
          notifiers: ["Crew"],
          connectivity: { mode: "wake" },
        },
        notifiers: [
          {
            name: "Crew",
            type: "ntfy",
            server: "http://notifier.invalid",
            topic: "test",
          },
        ],
      };
      const db = () =>
        (runtime as unknown as { database: AlertDatabase }).database;
      const send = (path: string, value: unknown) =>
        subscriber({
          updates: [{ $source: "fixture", values: [{ path, value }] }],
        });
      try {
        runtime.start(config);
        // The filter runs before queueing, even during startup reconciliation.
        for (let i = 0; i < 100; i += 1)
          send(`${collision}.${i}`, { state: "alarm" });
        send(battery, { state: "alarm", message: "Low voltage" });
        await vi.waitFor(() => expect(db().listOccurrences()).toHaveLength(1));
        expect(runtime.status().ingestion.received).toBe(1);
        expect(
          db()
            .listDefinitions()
            .map((item) => item.pathPattern),
        ).toEqual([battery]);
        expect(db().listOccurrences()[0].path).toBe(battery);
        expect(db().listDeliveries()).toHaveLength(1);
        expect(db().listWakeRequests()).toHaveLength(1);
        expect(
          db()
            .listAlertEvents()
            .every((event) => event.alertId === db().listOccurrences()[0].id),
        ).toBe(true);
        send(ignoredPath, { state: "emergency" });
        send(ignoredPath, null);
        // Exercise the same discovery method used by the periodic refresh.
        (runtime as unknown as { seedDefinitions(): void }).seedDefinitions();
        await flush();
        expect(db().listDefinitions()).toHaveLength(1);
        expect(runtime.status().ingestion.received).toBe(1);
        await runtime.stop();

        // Removing the filter resumes discovery and ingests the current snapshot.
        runtime.start({ ...config, ignoredPaths: [] });
        await vi.waitFor(() => expect(db().listOccurrences()).toHaveLength(2));
        const previous = db()
          .listOccurrences()
          .find((item) => item.path === ignoredPath)!;
        const definition = db().getDefinition(previous.definitionId!);
        const policy = db().setPolicy(definition.id, {
          enabled: false,
          notifierIds: [],
          notifierRepeatOverrides: {},
          overrideFields: ["enabled"],
        });
        const events = db().listAlertEvents(previous.id);
        await vi.waitFor(() =>
          expect(
            db()
              .listDeliveries()
              .every((item) => item.state === "waiting_connectivity"),
          ).toBe(true),
        );
        const deliveries = db().listDeliveries();
        expect(deliveries).toHaveLength(2);
        await runtime.stop();

        runtime.start(config);
        await vi.waitFor(() =>
          expect(runtime.status().reconciliation.state).toBe("complete"),
        );
        send(ignoredPath, null);
        await flush();
        expect(db().getDefinition(definition.id)).toEqual(definition);
        expect(db().getPolicy(definition.id)).toEqual(policy);
        expect(
          db()
            .listOccurrences()
            .find((item) => item.id === previous.id),
        ).toEqual(previous);
        expect(db().listAlertEvents(previous.id)).toEqual(events);
        expect(db().listDeliveries()).toEqual(deliveries);
      } finally {
        await runtime.stop();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
