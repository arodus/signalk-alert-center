import { describe, expect, it } from "vitest";
import { getAlertCenterOpenApi } from "../src/api/openapi";

describe("OpenAPI coverage", () => {
  it("documents the registered legacy alert routes", () => {
    const paths = getAlertCenterOpenApi().paths;

    expect(paths["/alerts"]?.get).toBeDefined();
    expect(paths["/alerts/{id}/acknowledge"]?.post).toBeDefined();
    expect(paths["/alerts/{id}/silence"]?.post).toBeDefined();
  });

  it("exposes whether a notifier requires Internet access", () => {
    const schemas = getAlertCenterOpenApi().components.schemas;

    expect(schemas.Notifier.properties.requiresInternet).toMatchObject({
      type: "boolean",
    });
  });
});
