export type InternetAvailabilityState = "unknown" | "online" | "offline";

export interface InternetAvailabilityStatus {
  state: InternetAvailabilityState;
  lastCheckedAt?: Date;
}

type InternetProbe = (signal?: AbortSignal) => Promise<boolean>;

/**
 * Runs the configured Internet probe only while offline work is waiting.
 * A successful delivery may also mark the connection online immediately.
 */
export class InternetAvailabilityMonitor {
  state: InternetAvailabilityState = "unknown";
  lastCheckedAt?: Date;

  private timer?: ReturnType<typeof setTimeout>;
  private activeCheck?: Promise<boolean>;
  private stopped = false;
  private controller = new AbortController();

  constructor(
    private readonly probe: InternetProbe,
    private readonly intervalMs: number,
    private readonly onChange: (status: InternetAvailabilityStatus) => void,
  ) {}

  record(online: boolean, checkedAt = new Date()): void {
    if (this.stopped) return;
    const previous = this.state;
    this.state = online ? "online" : "offline";
    this.lastCheckedAt = checkedAt;
    if (online && this.timer) clearTimeout(this.timer);
    if (online) this.timer = undefined;
    if (previous !== this.state) this.onChange(this.status());
  }

  status(): InternetAvailabilityStatus {
    return {
      state: this.state,
      lastCheckedAt: this.lastCheckedAt,
    };
  }

  checkNow(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.activeCheck) return this.activeCheck;
    const running = this.probe(this.controller.signal)
      .then((online) => {
        this.record(online);
        return online;
      })
      .catch(() => {
        this.record(false);
        return false;
      })
      .finally(() => {
        if (this.activeCheck === running) this.activeCheck = undefined;
      });
    this.activeCheck = running;
    return running;
  }

  watchOffline(): void {
    if (this.stopped || this.state !== "offline" || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.checkNow().then((online) => {
        if (!online) this.watchOffline();
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
