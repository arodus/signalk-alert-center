import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";

describe("validateConfig", () => {
  it("rejects invalid notifier credentials and rule references", () => {
    expect(() =>
      validateConfig({
        notifiers: {
          "ntfy-main": { type: "ntfy", server: "http://localhost", topic: "" },
        },
        rules: [
          {
            match: "notifications.*",
            minSeverity: "warn",
            connectivity: { mode: "queue" },
            notifiers: ["missing"],
          },
        ],
      }),
    ).toThrow("requires topic");
  });

  it("rejects invalid retry ranges and incomplete connectivity config", () => {
    expect(() =>
      validateConfig({ retry: { initialSeconds: 20, maxSeconds: 10 } }),
    ).toThrow("maxSeconds");
    expect(() => validateConfig({ connectivity: { enabled: true } })).toThrow(
      "switch configuration",
    );
  });
});
