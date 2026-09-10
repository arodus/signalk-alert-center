export type ConnectivityState =
  | "OFF"
  | "REQUESTING_ON"
  | "POWERED"
  | "WAITING_FOR_INTERNET"
  | "ONLINE"
  | "IDLE_COOLDOWN"
  | "REQUESTING_OFF"
  | "FAULT";
export interface SwitchAdapter {
  getState(): Promise<boolean | undefined>;
  setState(on: boolean): Promise<void>;
}
export interface ConnectivitySafetyState {
  pendingDelivery: boolean;
  activeWakeAlert: boolean;
  scheduledWake: boolean;
  sendInFlight: boolean;
}
type ConnectivitySafetyCheck = () =>
  ConnectivitySafetyState | Promise<ConnectivitySafetyState>;
type InternetReadyCheck = (signal?: AbortSignal) => Promise<boolean>;

const safeToRelease: ConnectivitySafetyCheck = () => ({
  pendingDelivery: false,
  activeWakeAlert: false,
  scheduledWake: false,
  sendInFlight: false,
});

export class ConnectivityManager {
  state: ConnectivityState = "OFF";
  switchOn?: boolean;
  ownedByPlugin = false;
  lastError?: string;
  lastShutdownDeferredReason?: string;
  lastTransitionAt = new Date();
  lastTransitionFrom?: ConnectivityState;
  lastProbeAt?: Date;
  lastProbeSucceeded?: boolean;
  lastProbeError?: string;
  private cooldownTimer?: ReturnType<typeof setTimeout>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private wakeDueAt?: Date;
  private activeWake?: Promise<void>;
  private stopped = false;
  private stopController = new AbortController();

  constructor(
    private readonly adapter: SwitchAdapter,
    private readonly cooldownMs = 300_000,
    private readonly internetReady: InternetReadyCheck = async () => true,
    private readonly bootTimeoutMs = 240_000,
    private readonly checkIntervalMs = 5_000,
    private readonly safetyCheck: ConnectivitySafetyCheck = safeToRelease,
  ) {}

  get scheduledWakeAt(): Date | undefined {
    return this.wakeDueAt;
  }

  private transition(next: ConnectivityState): void {
    if (this.state === next) return;
    this.lastTransitionFrom = this.state;
    this.state = next;
    this.lastTransitionAt = new Date();
  }

  async requestWake(): Promise<void> {
    if (this.stopped) return;
    if (this.activeWake) return this.activeWake;
    const running = this.performWake();
    this.activeWake = running;
    try {
      await running;
    } finally {
      if (this.activeWake === running) this.activeWake = undefined;
    }
  }

  private async performWake(): Promise<void> {
    this.lastError = undefined;
    if (
      this.switchOn === true &&
      (this.state === "POWERED" ||
        this.state === "WAITING_FOR_INTERNET" ||
        this.state === "ONLINE" ||
        this.state === "IDLE_COOLDOWN")
    ) {
      this.cancelCooldown();
      return;
    }
    const observed = await this.adapter.getState();
    this.switchOn = observed;
    if (observed === true) {
      this.ownedByPlugin = false;
      this.transition("POWERED");
      return this.waitForInternet();
    }
    if (observed !== false) {
      this.ownedByPlugin = false;
      this.transition("FAULT");
      this.lastError =
        "Switch state is unknown; leaving connectivity untouched";
      return;
    }
    this.transition("REQUESTING_ON");
    try {
      await this.adapter.setState(true);
      this.ownedByPlugin = true;
      this.switchOn = true;
      this.transition("POWERED");
      await this.waitForInternet();
    } catch (error) {
      this.transition("FAULT");
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  scheduleWakeAt(dueAt: Date): void {
    if (this.wakeDueAt && this.wakeDueAt <= dueAt) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeDueAt = dueAt;
    const delay = Math.max(0, dueAt.getTime() - Date.now());
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.wakeDueAt = undefined;
      void this.requestWake();
    }, delay);
  }

  cancelScheduledWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.wakeDueAt = undefined;
  }

  private async waitForInternet(): Promise<void> {
    this.transition("WAITING_FOR_INTERNET");
    const deadline = Date.now() + this.bootTimeoutMs;
    while (!this.stopped && Date.now() <= deadline) {
      let ready = false;
      try {
        ready = await this.internetReady(this.stopController.signal);
        this.lastProbeError = undefined;
      } catch (error) {
        this.lastProbeError =
          error instanceof Error ? error.message : String(error);
      }
      this.lastProbeAt = new Date();
      this.lastProbeSucceeded = ready;
      if (ready) {
        this.transition("ONLINE");
        return;
      }
      if (this.stopped) return;
      if (Date.now() + this.checkIntervalMs > deadline) break;
      await abortableDelay(this.checkIntervalMs, this.stopController.signal);
    }
    if (this.stopped) return;
    this.transition("FAULT");
    this.lastError = this.lastProbeError
      ? `Internet readiness probe failed: ${this.lastProbeError}`
      : "Internet readiness probe timed out";
  }

  beginCooldown(): void {
    if (
      !this.ownedByPlugin ||
      (this.state !== "ONLINE" && this.state !== "IDLE_COOLDOWN")
    )
      return;
    this.transition("IDLE_COOLDOWN");
    this.lastShutdownDeferredReason = undefined;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      void this.releaseIfSafe();
    }, this.cooldownMs);
  }

  cancelCooldown(): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined;
    if (this.state === "IDLE_COOLDOWN") this.transition("ONLINE");
  }
  async releaseIfSafe(): Promise<void> {
    const safety = await this.safetyCheck();
    const blockers = [
      safety.pendingDelivery ? "pending delivery" : undefined,
      safety.activeWakeAlert ? "active wake alert" : undefined,
      safety.scheduledWake ? "scheduled wake request" : undefined,
      safety.sendInFlight ? "delivery in flight" : undefined,
    ].filter((value): value is string => Boolean(value));
    if (blockers.length) {
      this.lastShutdownDeferredReason = blockers.join(", ");
      return;
    }
    if (!this.ownedByPlugin || this.state !== "IDLE_COOLDOWN") return;
    this.lastShutdownDeferredReason = undefined;
    this.transition("REQUESTING_OFF");
    try {
      await this.adapter.setState(false);
      this.switchOn = false;
      this.ownedByPlugin = false;
      this.transition("OFF");
    } catch (error) {
      this.transition("FAULT");
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopController.abort();
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cancelScheduledWake();
  }
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
