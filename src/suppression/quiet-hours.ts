import { Severity, severities } from "../alerts/types";

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
  timeZone: string;
  minimumSeverity: Severity;
}
export interface QuietHoursWindow {
  enabled: boolean;
  active: boolean;
  startedAt?: string;
  endsAt?: string;
  nextChangeAt?: string;
  minimumSeverity?: Severity;
  timeZone?: string;
}
export function validateQuietHours(value: QuietHours | undefined): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || typeof value.enabled !== "boolean")
    throw new Error("Quiet hours must include a boolean enabled setting");
  if (!value.enabled) return;
  if (
    ![value.start, value.end].every(
      (time) =>
        typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time),
    ) ||
    value.start === value.end
  )
    throw new Error(
      "Quiet hours need different start and end times in HH:mm format",
    );
  if (!severities.includes(value.minimumSeverity))
    throw new Error("Quiet hours minimum severity is invalid");
  if (!value.timeZone || typeof value.timeZone !== "string")
    throw new Error("Quiet hours need a timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format();
  } catch {
    throw new Error("Quiet hours timezone is invalid");
  }
}

/** Wall-clock schedule. Walking UTC minutes handles skipped/repeated DST hours.
 * Results are cached until the next boundary, not recomputed per alert.
 */
export class QuietHoursClock {
  private readonly cache = new Map<
    string,
    { key: string; at: number; until: number; value: QuietHoursWindow }
  >();
  window(
    service: string,
    config: QuietHours | undefined,
    now = new Date(),
  ): QuietHoursWindow {
    if (!config?.enabled) {
      this.cache.delete(service);
      return { enabled: false, active: false };
    }
    const key = JSON.stringify(config);
    const timestamp = now.getTime();
    const cached = this.cache.get(service);
    if (
      cached?.key === key &&
      timestamp >= cached.at &&
      timestamp < cached.until
    )
      return cached.value;
    validateQuietHours(config);
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const minute = (time: string) =>
      Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const start = minute(config.start),
      end = minute(config.end);
    const isActive = (at: number) => {
      const parts = formatter.formatToParts(at);
      const hour = Number(parts.find((p) => p.type === "hour")!.value);
      const minutes =
        hour * 60 + Number(parts.find((p) => p.type === "minute")!.value);
      return start < end
        ? minutes >= start && minutes < end
        : minutes >= start || minutes < end;
    };
    const floor = Math.floor(timestamp / 60000) * 60000;
    const active = isActive(timestamp);
    let next = floor + 60000;
    // Covers even historical full-day timezone jumps without an unbounded scan.
    const limit = timestamp + 4 * 86400000;
    while (next < limit && isActive(next) === active) next += 60000;
    let started = floor;
    if (active) {
      while (started > timestamp - 4 * 86400000 && isActive(started - 60000))
        started -= 60000;
    }
    const value: QuietHoursWindow = {
      enabled: true,
      active,
      timeZone: config.timeZone,
      minimumSeverity: config.minimumSeverity,
      nextChangeAt: new Date(next).toISOString(),
      ...(active
        ? {
            startedAt: new Date(started).toISOString(),
            endsAt: new Date(next).toISOString(),
          }
        : {}),
    };
    this.cache.set(service, { key, at: timestamp, until: next, value });
    return value;
  }
  clear(): void {
    this.cache.clear();
  }
}
