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

// The server and browser share exactly the same conversion implementation.
if (typeof module !== "undefined" && module.exports)
  module.exports = { convertDisplayValue, displayZone };
