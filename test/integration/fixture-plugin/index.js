const DEFAULT_PATH =
  "notifications.environment.inside.refrigerator.temperature";
const ZONE_PATH = "environment.inside.refrigerator.temperature";
const SWITCH_PATH = "electrical.switches.fixture.state";

module.exports = function fixturePlugin(app) {
  const events = [];
  let switchValue = 0;
  let seedTimer;

  function publish(path, value, source = "fixture.default") {
    const timestamp = new Date().toISOString();
    const delta = {
      context: "vessels.self",
      updates: [{ $source: source, timestamp, values: [{ path, value }] }],
    };
    events.push({ path, value, source, timestamp });
    app.handleMessage("signalk-test-fixture", delta);
    return delta;
  }

  function seedDemoData() {
    const seeded = [
      publish(
        "notifications.environment.inside.refrigerator.temperature",
        {
          state: "alarm",
          message: "Refrigerator temperature is high (9.8 °C)",
          method: ["visual", "sound"],
          id: "demo-fridge-warm",
        },
        "demo.fridge.sensor",
      ),
      publish(
        "notifications.bilge.highWater",
        {
          state: "emergency",
          message: "High water detected in the port bilge",
          method: ["visual", "sound"],
          id: "demo-bilge-port",
        },
        "demo.bilge.port",
      ),
      publish(
        "notifications.bilge.highWater",
        {
          state: "alarm",
          message: "High water detected in the starboard bilge",
          method: ["visual"],
          id: "demo-bilge-starboard",
        },
        "demo.bilge.starboard",
      ),
      publish(
        "notifications.electrical.batteries.house.lowVoltage",
        {
          state: "warn",
          message: "House battery voltage is low (11.8 V)",
          method: ["visual"],
          id: "demo-house-battery",
        },
        "demo.battery.monitor",
      ),
      publish(
        "notifications.electrical.shorePower.lost",
        {
          state: "alarm",
          message: "Shore power disconnected",
          method: ["visual", "sound"],
          id: "demo-shore-power",
        },
        "demo.shore.power",
      ),
      publish(
        "notifications.electrical.shorePower.lost",
        null,
        "demo.shore.power",
      ),
      publish(
        "notifications.propulsion.mainEngine.temperature",
        {
          state: "alarm",
          message: "Main engine temperature reached 101 °C",
          id: "demo-engine-temperature-1",
        },
        "demo.engine.ecu",
      ),
      publish(
        "notifications.propulsion.mainEngine.temperature",
        null,
        "demo.engine.ecu",
      ),
      publish(
        "notifications.propulsion.mainEngine.temperature",
        {
          state: "warn",
          message: "Main engine temperature is rising again (94 °C)",
          id: "demo-engine-temperature-2",
        },
        "demo.engine.ecu",
      ),
      publish(
        "notifications.navigation.anchor.dragging",
        {
          state: "warn",
          message: "Anchor distance exceeded 35 m",
          id: "demo-anchor-dragging",
        },
        "demo.anchor.watch",
      ),
      publish(
        "notifications.navigation.anchor.dragging",
        {
          state: "alarm",
          message: "Anchor distance exceeded 55 m and is increasing",
          id: "demo-anchor-dragging",
        },
        "demo.anchor.watch",
      ),
      publish(
        "notifications.security.companionway.open",
        {
          state: "alert",
          message: "Companionway opened while vessel is unattended",
          method: ["visual"],
          id: "demo-companionway",
        },
        "demo.security.contact",
      ),
    ];
    return { published: seeded.length, deltas: seeded };
  }

  return {
    id: "signalk-test-fixture",
    name: "Signal K acceptance fixture",
    description: "Publishes deterministic test-only zones and notifications",
    schema: {
      type: "object",
      properties: {
        seedOnStart: {
          type: "boolean",
          title: "Publish demo notification deltas on startup",
          default: false,
        },
      },
    },
    start(options = {}) {
      if (typeof app.registerPutHandler === "function") {
        app.registerPutHandler(
          "vessels.self",
          SWITCH_PATH,
          (_context, _path, value, callback) => {
            switchValue = value;
            publish(SWITCH_PATH, value, "fixture.switch");
            callback?.({ state: "COMPLETED", statusCode: 200 });
          },
        );
      }
      publish(SWITCH_PATH, switchValue, "fixture.switch");
      // Signal K attaches metadata to an existing model path, so publish a
      // deterministic value before the zone definition.
      publish(ZONE_PATH, 280, "fixture.zones");
      app.handleMessage("signalk-test-fixture", {
        context: "vessels.self",
        updates: [
          {
            $source: "fixture.zones",
            timestamp: new Date().toISOString(),
            meta: [
              {
                path: ZONE_PATH,
                value: {
                  displayName: "Refrigerator temperature",
                  zones: [
                    { lower: 278.15, upper: 281.15, state: "normal" },
                    { lower: 281.15, state: "alarm" },
                  ],
                },
              },
            ],
          },
        ],
      });
      if (options.seedOnStart)
        seedTimer = setTimeout(() => seedDemoData(), 250);
    },
    registerWithRouter(router) {
      const reads = router.access?.("readonly") ?? router;
      const writes = router.access?.("readwrite") ?? router;
      reads.get("/state", (_request, response) => {
        response.json({
          events,
          switchValue,
          zonePath: ZONE_PATH,
          selfContext: app.selfContext,
        });
      });
      writes.post("/reset", (_request, response) => {
        events.length = 0;
        switchValue = 0;
        publish(SWITCH_PATH, switchValue, "fixture.switch");
        response.json({ reset: true });
      });
      writes.post("/raise", (request, response) => {
        const body = request.body ?? {};
        response.json(
          publish(
            body.path ?? DEFAULT_PATH,
            {
              state: body.state ?? "alarm",
              method: body.method ?? ["visual", "sound"],
              message: body.message ?? "Fixture alert",
              ...(body.id ? { id: body.id } : {}),
            },
            body.source,
          ),
        );
      });
      writes.post("/clear", (request, response) => {
        const body = request.body ?? {};
        response.json(publish(body.path ?? DEFAULT_PATH, null, body.source));
      });
      writes.post("/switch", (request, response) => {
        switchValue = request.body?.value ?? 0;
        response.json(publish(SWITCH_PATH, switchValue, "fixture.switch"));
      });
      writes.post("/seed", (_request, response) => {
        response.json(seedDemoData());
      });
    },
    stop() {
      if (seedTimer) clearTimeout(seedTimer);
    },
  };
};
