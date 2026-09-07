const DEFAULT_PATH =
  "notifications.environment.inside.refrigerator.temperature";
const ZONE_PATH = "environment.inside.refrigerator.temperature";
const SWITCH_PATH = "electrical.switches.fixture.state";

module.exports = function fixturePlugin(app) {
  const events = [];
  let switchValue = 0;

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

  return {
    id: "signalk-test-fixture",
    name: "Signal K acceptance fixture",
    description: "Publishes deterministic test-only zones and notifications",
    schema: { type: "object", properties: {} },
    start() {
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
    },
  };
};
