import { describe, expect, it, vi } from "vitest";
import { ServerAPI } from "@signalk/server-api";
import { captureMessageSample } from "../src/signalk/message-sample";

describe("notification receipt readings", () => {
  const entry = {
    path: "notifications.environment.depth.belowKeel",
    value: { message: "undefined < value < 2", state: "alarm" },
  };
  it("captures a priority-resolved zero without changing the original notification", () => {
    const node = { value: 0, meta: { units: "m" } };
    const app = { getSelfPath: vi.fn(() => node) } as unknown as ServerAPI;
    const sample = captureMessageSample(app, entry);
    node.value = 4;
    expect(sample).toMatchObject({
      message: entry.value.message,
      value: 0,
      units: "m",
    });
    expect(app.getSelfPath).toHaveBeenCalledWith("environment.depth.belowKeel");
    expect(entry.value).toEqual({
      message: "undefined < value < 2",
      state: "alarm",
    });
  });
  it("does not guess absent, null, nonnumeric, or nonfinite readings", () => {
    for (const value of [undefined, null, "3", NaN, Infinity]) {
      const app = {
        getSelfPath: () => ({ value }),
        getMetadata: () => ({ units: "m" }),
      } as unknown as ServerAPI;
      expect(captureMessageSample(app, entry)).toMatchObject({
        message: entry.value.message,
        units: "m",
      });
      expect(captureMessageSample(app, entry)?.value).toBeUndefined();
    }
    expect(
      captureMessageSample(
        {
          getSelfPath: () => {
            throw Error("missing");
          },
        } as unknown as ServerAPI,
        entry,
      )?.value,
    ).toBeUndefined();
    expect(
      captureMessageSample({} as ServerAPI, {
        ...entry,
        value: { message: "Sensor value is high" },
      }),
    ).toBeUndefined();
  });
});
