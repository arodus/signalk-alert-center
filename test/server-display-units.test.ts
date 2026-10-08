import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerDisplayUnits } from "../src/signalk/display-units";

describe("server unit settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("fetches and caches global preferences, respects path overrides, and survives refresh failure", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/active")
              ? {
                  categories: {
                    temperature: { baseUnit: "K", targetUnit: "F" },
                  },
                }
              : url.endsWith("/definitions")
                ? {
                    K: {
                      conversions: {
                        F: {
                          formula: "(value - 273.15) * 9 / 5 + 32",
                          symbol: "°F",
                        },
                        C: { formula: "value - 273.15", symbol: "°C" },
                      },
                    },
                  }
                : { category: "temperature" },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const report = vi.fn();
    const settings = new ServerDisplayUnits("http://127.0.0.1:3000", report);
    expect(
      (await settings.resolve("environment.temperature", { units: "K" }))
        .displayUnits?.symbol,
    ).toBe("°F");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      (await settings.resolve("environment.temperature", { units: "K" }))
        .displayUnits?.symbol,
    ).toBe("°F");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      (
        await settings.resolve("environment.temperature", {
          units: "K",
          displayUnits: { targetUnit: "C" },
        })
      ).displayUnits?.symbol,
    ).toBe("°C");
    now = 300_001;
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(
      (await settings.resolve("environment.temperature", { units: "K" }))
        .displayUnits?.symbol,
    ).toBe("°F");
    expect(report).toHaveBeenCalledOnce();
  });
  it("retains raw metadata on unavailable servers and backs off failed settings reads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const settings = new ServerDisplayUnits("http://127.0.0.1:3000", vi.fn());
    expect(await settings.resolve("x", { units: "K" })).toEqual({ units: "K" });
    expect(await settings.resolve("x", { units: "K" })).toEqual({ units: "K" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
