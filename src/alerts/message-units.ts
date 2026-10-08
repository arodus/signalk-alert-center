import { displayZone, UnitMetadata } from "../../public/units";

/** Convert explicit SI quantities and Signal K's generated zone-range message.
 * Unlabelled numbers in custom prose may be IDs, times, or already converted.
 */
export function convertAlertMessage(
  message: string | undefined,
  metadata: UnitMetadata,
): string | undefined {
  if (!message || !metadata.units) return message;
  const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
  const format = (value: number) => String(Number(value.toFixed(3)));
  const range = message.match(
    new RegExp(`^(undefined|${number}) < value < (undefined|${number})$`),
  );
  if (range) {
    const lower = range[1] === "undefined" ? undefined : Number(range[1]);
    const upper = range[2] === "undefined" ? undefined : Number(range[2]);
    const converted = displayZone({ lower, upper }, metadata);
    if (!converted.units || converted.units === metadata.units) return message;
    return [
      converted.zone.lower === undefined
        ? undefined
        : `${format(converted.zone.lower)} ${converted.units} ≤`,
      "value",
      converted.zone.upper === undefined
        ? undefined
        : `< ${format(converted.zone.upper)} ${converted.units}`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const unit = metadata.units.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(
    new RegExp(`(^|[^\\w.])(${number})\\s*${unit}(?![\\w/])`, "g"),
    (match, prefix: string, raw: string) => {
      const converted = displayZone({ lower: Number(raw) }, metadata);
      return converted.units &&
        converted.units !== metadata.units &&
        converted.zone.lower !== undefined
        ? `${prefix}${format(converted.zone.lower)} ${converted.units}`
        : match;
    },
  );
}
