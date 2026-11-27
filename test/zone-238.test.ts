import { describe, expect, it } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { convertAlertMessage, generatedZoneMessage } from "../public/units";
import { captureMessageSample } from "../src/signalk/message-sample";
import { AlertPolicyResolver, pathDefinitionId } from "../src/alerts/policy";
import { AlertDatabase } from "../src/storage/db";

describe("Signal K 2.38 generated zone messages", () => {
  const path = "environment.inside.refrigerator.temperature";
  const metadata = {
    units: "K",
    path,
    displayName: "Fridge",
    zones: [{ lower: 273.15, upper: 283.15, state: "alarm" }],
  };
  it("uses structured thresholds and captures the receipt reading for later history", () => {
    const message = "Fridge between 273.15 and 283.15";
    const sample = captureMessageSample(
      {
        getSelfPath: () => ({ value: 278.15, meta: metadata }),
      } as unknown as ServerAPI,
      { path: `notifications.${path}`, value: { state: "alarm", message } },
    );
    expect(sample).toMatchObject({
      value: 278.15,
      units: "K",
      generatedZone: { name: "Fridge", lower: 273.15, upper: 283.15 },
    });
    // Later metadata can have entirely different zones and display names.
    expect(
      convertAlertMessage(
        message,
        { units: "K", generatedZone: sample?.generatedZone },
        sample?.value,
      ),
    ).toBe("Fridge between 0 °C and 10 °C (reading 5 °C)");
    expect(convertAlertMessage(message, metadata, 283.15)).toBe(
      "Fridge between 0 °C and 10 °C (reading 10 °C)",
    );
  });
  it.each([
    [{ upper: 273.15 }, "Fridge at or below 273.15", "Fridge at or below 0 °C"],
    [{ lower: 273.15 }, "Fridge at or above 273.15", "Fridge at or above 0 °C"],
    [{ lower: 273.15, upper: 273.15 }, "Fridge at 273.15", "Fridge at 0 °C"],
    [{}, "Fridge", "Fridge"],
  ])(
    "formats open and single-value zones without changing their boundary meaning",
    (zone, message, expected) => {
      expect(convertAlertMessage(message, { ...metadata, zones: [zone] })).toBe(
        expected,
      );
    },
  );
  it("does not reinterpret custom prose or another zone's message", () => {
    expect(
      generatedZoneMessage("Fridge between 273.15 and 283.15", {
        ...metadata,
        zones: [
          { ...metadata.zones[0], message: "Fridge between 273.15 and 283.15" },
        ],
      }),
    ).toBeUndefined();
    expect(convertAlertMessage("Fridge between 273.15 and 290", metadata)).toBe(
      "Fridge between 273.15 and 290",
    );
    expect(convertAlertMessage("Cabin at 273.15", metadata)).toBe(
      "Cabin at 273.15",
    );
  });
  it("removes deleted thresholds while preserving identity and policy", () => {
    const database = new AlertDatabase();
    try {
      const resolver = new AlertPolicyResolver(database, {});
      resolver.seedDefinitions([metadata]);
      const id = pathDefinitionId(`notifications.${path}`);
      database.setPolicy(id, { enabled: false });
      const occurrence = database.ingest(
        {
          sourceKey: `notifications.${path}`,
          path: `notifications.${path}`,
          state: "active",
          severity: "alarm",
          message: "Historical zone alert",
        },
        ["mock"],
        new Date(),
        { definitionId: id },
      )!;
      const original = database.getDefinition(id);
      resolver.seedDefinitions([]);
      expect(database.getDefinition(id)).toMatchObject({
        id,
        name: original.name,
        sourceType: "zone",
        metadata: { zones: [] },
      });
      expect(database.getPolicy(id)?.enabled).toBe(false);
      expect(database.getAlert(occurrence.id).message).toBe(
        "Historical zone alert",
      );
      expect(database.listDeliveries()).toHaveLength(1);
      resolver.seedDefinitions([metadata]);
      expect(database.getDefinition(id).metadata).toMatchObject({
        zones: metadata.zones,
      });
    } finally {
      database.close();
    }
  });
});
