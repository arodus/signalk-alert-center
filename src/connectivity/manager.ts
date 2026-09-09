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
  private cooldownTimer?: ReturnType<typeof setTimeout>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private wakeDueAt?: Date;

  constructor(
    private readonly adapter: SwitchAdapter,
    private readonly cooldownMs = 300_000,
    private readonly internetReady: () => Promise<boolean> = async () => true,
    private readonly bootTimeoutMs = 240_000,
    private readonly checkIntervalMs = 5_000,
    private readonly safetyCheck: ConnectivitySafetyCheck = safeToRelease,
  ) {}

  async requestWake(): Promise<void> {
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
      this.state = "POWERED";
      return this.waitForInternet();
    }
    if (observed !== false) {
      this.ownedByPlugin = false;
      this.state = "FAULT";
      this.lastError =
        "Switch state is unknown; leaving connectivity untouched";
      return;
    }
    this.state = "REQUESTING_ON";
    try {
      await this.adapter.setState(true);
      this.ownedByPlugin = true;
      this.switchOn = true;
      this.state = "POWERED";
      await this.waitForInternet();
    } catch (error) {
      this.state = "FAULT";
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
    this.state = "WAITING_FOR_INTERNET";
    const deadline = Date.now() + this.bootTimeoutMs;
    while (Date.now() <= deadline) {
      if (await this.internetReady()) {
        this.state = "ONLINE";
        return;
      }
      if (Date.now() + this.checkIntervalMs > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, this.checkIntervalMs));
    }
    this.state = "FAULT";
    this.lastError = "Internet readiness probe timed out";
  }

  beginCooldown(): void {
    if (
      !this.ownedByPlugin ||
      (this.state !== "ONLINE" && this.state !== "IDLE_COOLDOWN")
    )
      return;
    this.state = "IDLE_COOLDOWN";
    this.lastShutdownDeferredReason = undefined;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      void this.releaseIfSafe();
    }, this.cooldownMs);
  }

  cancelCooldown(): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined;
    if (this.state === "IDLE_COOLDOWN") this.state = "ONLINE";
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
    this.state = "REQUESTING_OFF";
    try {
      await this.adapter.setState(false);
      this.switchOn = false;
      this.ownedByPlugin = false;
      this.state = "OFF";
    } catch (error) {
      this.state = "FAULT";
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  stop(): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cancelScheduledWake();
  }
}
