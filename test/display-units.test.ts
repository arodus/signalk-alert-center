import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const { displayZone } = runInNewContext(
  `${readFileSync("public/units.js", "utf8")}\n({ displayZone })`,
);

describe("zone display units", () => {
  it("converts Kelvin bounds to Celsius without changing stored thresholds", () => {
    const zone = { lower: 283.15, upper: 373.15 };
    expect(displayZone(zone, { units: "K" })).toEqual({
      zone: { lower: 10, upper: 100 },
      units: "°C",
    });
    expect(zone).toEqual({ lower: 283.15, upper: 373.15 });
  });
  it("honors preferred Fahrenheit units and open bounds", () => {
    const result = displayZone(
      { lower: 283.15 },
      {
        units: "K",
        displayUnits: {
          formula: "(value - 273.15) * 9 / 5 + 32",
          symbol: "°F",
        },
      },
    );
    expect(result.zone.lower).toBeCloseTo(50);
    expect(result.zone.upper).toBeUndefined();
    expect(result.units).toBe("°F");
  });
  it("supports metadata conversions for other units", () => {
    expect(
      displayZone(
        { upper: Math.PI },
        {
          units: "rad",
          displayUnits: { formula: "value * 180 / pi", symbol: "°" },
        },
      ),
    ).toEqual({ zone: { lower: undefined, upper: 180 }, units: "°" });
  });
  it.each(["value / 0", "process.exit()", "value ** 2", "value +"])(
    "retains raw units and bounds for unsupported formulas: %s",
    (formula) => {
      const zone = { upper: 10 };
      expect(
        displayZone(zone, {
          units: "m",
          displayUnits: { formula, symbol: "ft" },
        }),
      ).toEqual({ zone, units: "m" });
    },
  );
});
