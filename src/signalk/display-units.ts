import { UnitMetadata } from "../../public/units";

type Conversion = NonNullable<UnitMetadata["displayUnits"]>;
interface Settings {
  categories: Record<string, Conversion & { baseUnit?: string }>;
  definitions: Record<string, { conversions?: Record<string, Conversion> }>;
}

/** Fetch server-global preferences without depending on server internals. */
export class ServerDisplayUnits {
  private settings?: Settings;
  private refresh?: Promise<void>;
  private expires = 0;
  private categories = new Map<string, string | undefined>();
  constructor(
    private baseUrl: string,
    private report: (message: string) => void,
  ) {}

  private async json(path: string): Promise<unknown> {
    const response = await fetch(
      this.baseUrl + "/signalk/v1/unitpreferences/" + path,
      {
        signal: AbortSignal.timeout(2000),
        redirect: "error",
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok)
      throw new Error("Unit settings request failed (" + response.status + ")");
    return response.json();
  }

  async resolve(path: string, metadata: UnitMetadata): Promise<UnitMetadata> {
    if (!metadata.units) return metadata;
    if (Date.now() >= this.expires) {
      this.refresh ??= (async () => {
        try {
          const [active, definitions] = await Promise.all([
            this.json("active"),
            this.json("definitions"),
          ]);
          const categories = (active as Partial<Settings>)?.categories;
          if (
            !categories ||
            typeof categories !== "object" ||
            !definitions ||
            typeof definitions !== "object"
          )
            throw new Error("Invalid unit settings response");
          this.settings = {
            categories,
            definitions: definitions as Settings["definitions"],
          };
          this.categories.clear();
        } catch (error) {
          this.report(
            (error instanceof Error
              ? error.message
              : "Unit settings unavailable") +
              "; retaining cached preferences or metadata defaults",
          );
        } finally {
          this.expires = Date.now() + 300_000;
        }
      })();
      await this.refresh;
      this.refresh = undefined;
    }
    const stored = metadata.displayUnits;
    if (stored?.formula || !this.settings) return metadata;
    try {
      let category = stored?.category;
      if (!category) {
        if (!this.categories.has(path)) {
          const result = (await this.json(
            "default-category/" + encodeURIComponent(path),
          )) as { category?: string };
          if (this.categories.size >= 256)
            this.categories.delete(this.categories.keys().next().value!);
          this.categories.set(
            path,
            typeof result.category === "string" ? result.category : undefined,
          );
        }
        category = this.categories.get(path);
      }
      if (category === "base")
        return {
          ...metadata,
          displayUnits: { formula: "value", symbol: metadata.units },
        };
      const preset = category ? this.settings.categories[category] : undefined;
      const target = stored?.targetUnit ?? preset?.targetUnit;
      const units = metadata.units;
      if (!target || !units) return metadata;
      const conversion =
        target === units
          ? { formula: "value", symbol: units }
          : this.settings.definitions[units]?.conversions?.[target];
      return conversion
        ? { ...metadata, displayUnits: { ...conversion, targetUnit: target } }
        : metadata;
    } catch {
      return metadata;
    }
  }
}
