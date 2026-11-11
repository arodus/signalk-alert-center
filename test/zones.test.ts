import { describe, expect, it } from "vitest";
import { listConfiguredZones } from "../src/alerts/zones";

describe("zone display names", () => {
  it.each(["Fridge temperature", "", "  ", undefined, null, 42])(
    "reads displayName independently of description (%j)",
    (displayName) => {
      const zones = listConfiguredZones({
        getPath: () => ({
          environment: {
            temperature: {
              meta: {
                displayName,
                description: "Data should be of type number.",
                zones: [{ state: "alarm", lower: 281.15 }],
              },
            },
          },
        }),
      });
      expect(zones).toEqual([
        {
          path: "environment.temperature",
          displayName:
            typeof displayName === "string" ? displayName : undefined,
          description: "Data should be of type number.",
          zones: [{ state: "alarm", lower: 281.15 }],
        },
      ]);
    },
  );
});
