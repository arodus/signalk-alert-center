// Evaluate arithmetic unit formulas without executing metadata as JavaScript.
function convertDisplayValue(formula, value) {
  if (typeof formula !== "string" || formula.length > 256)
    throw new Error("Invalid unit formula");
  const tokens =
    formula.match(/value|pi|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[()+*/-]|\S/gi) ??
    [];
  let cursor = 0;
  function primary() {
    const token = tokens[cursor++];
    if (token === "+") return primary();
    if (token === "-") return -primary();
    if (token === "(") {
      const result = expression();
      if (tokens[cursor++] !== ")") throw new Error("Invalid unit formula");
      return result;
    }
    if (token === "value") return value;
    if (token === "pi") return Math.PI;
    if (!token || !/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token))
      throw new Error("Unsupported unit formula");
    return Number(token);
  }
  function product() {
    let result = primary();
    while (tokens[cursor] === "*" || tokens[cursor] === "/") {
      const operator = tokens[cursor++];
      const right = primary();
      result = operator === "*" ? result * right : result / right;
    }
    return result;
  }
  function expression() {
    let result = product();
    while (tokens[cursor] === "+" || tokens[cursor] === "-") {
      const operator = tokens[cursor++];
      const right = product();
      result = operator === "+" ? result + right : result - right;
    }
    return result;
  }
  const result = expression();
  if (cursor !== tokens.length || !Number.isFinite(result))
    throw new Error("Invalid unit conversion");
  return result;
}

function displayZone(zone, metadata = {}) {
  const display =
    metadata.displayUnits ??
    (metadata.units === "K"
      ? { formula: "value - 273.15", symbol: "°C" }
      : undefined);
  if (!display) return { zone, units: metadata.units };
  try {
    const symbol = display.symbol || display.targetUnit;
    if (!symbol) throw new Error("Missing display unit");
    return {
      zone: {
        ...zone,
        lower: Number.isFinite(zone.lower)
          ? convertDisplayValue(display.formula, zone.lower)
          : undefined,
        upper: Number.isFinite(zone.upper)
          ? convertDisplayValue(display.formula, zone.upper)
          : undefined,
      },
      units: symbol,
    };
  } catch {
    // Unsupported formulas retain both the original bounds and original unit.
    return { zone, units: metadata.units };
  }
}

const zoneNumber = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
function isZoneMessage(message) {
  return (
    typeof message === "string" &&
    new RegExp(
      `^(undefined|${zoneNumber}) < value < (undefined|${zoneNumber})$`,
    ).test(message)
  );
}

function convertAlertMessage(message, metadata = {}, value) {
  if (!message) return message;
  const format = (number) => String(Number(number.toFixed(3)));
  const quantity = (number, units) =>
    `${format(number)}${units ? ` ${units}` : ""}`;
  if (isZoneMessage(message)) {
    const [low, , , , high] = message.split(" ");
    const lower = low === "undefined" ? undefined : Number(low);
    const upper = high === "undefined" ? undefined : Number(high);
    const converted = displayZone({ lower, upper }, metadata);
    const reading = Number.isFinite(value)
      ? displayZone({ lower: value }, metadata)
      : undefined;
    return [
      converted.zone.lower === undefined
        ? undefined
        : `${quantity(converted.zone.lower, converted.units)} ≤`,
      reading ? quantity(reading.zone.lower, reading.units) : "value",
      converted.zone.upper === undefined
        ? undefined
        : `< ${quantity(converted.zone.upper, converted.units)}`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (!metadata.units) return message;
  const unit = metadata.units.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(
    new RegExp(`(^|[^\\w.])(${zoneNumber})\\s*${unit}(?![\\w/])`, "g"),
    (match, prefix, raw) => {
      const converted = displayZone({ lower: Number(raw) }, metadata);
      return converted.units &&
        converted.units !== metadata.units &&
        converted.zone.lower !== undefined
        ? `${prefix}${quantity(converted.zone.lower, converted.units)}`
        : match;
    },
  );
}

// The server and browser share exactly the same conversion implementation.
if (typeof module !== "undefined" && module.exports)
  module.exports = {
    convertDisplayValue,
    displayZone,
    convertAlertMessage,
    isZoneMessage,
  };
