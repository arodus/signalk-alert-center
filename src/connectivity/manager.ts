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

export class ConnectivityManager {
  state: ConnectivityState = "OFF";
  switchOn?: boolean;
  ownedByPlugin = false;
  lastError?: string;
  private cooldownTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly adapter: SwitchAdapter,
    private readonly cooldownMs = 300_000,
    private readonly internetReady: () => Promise<boolean> = async () => true,
  ) {}

  async requestWake(): Promise<void> {
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

  private async waitForInternet(): Promise<void> {
    this.state = "WAITING_FOR_INTERNET";
    if (await this.internetReady()) this.state = "ONLINE";
  }

  beginCooldown(): void {
    if (!this.ownedByPlugin || this.state !== "ONLINE") return;
    this.state = "IDLE_COOLDOWN";
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
  async releaseIfSafe(
    hasPending = false,
    hasActiveWakeAlert = false,
    sendInFlight = false,
  ): Promise<void> {
    if (
      !this.ownedByPlugin ||
      hasPending ||
      hasActiveWakeAlert ||
      sendInFlight ||
      this.state !== "IDLE_COOLDOWN"
    )
      return;
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
  }
}
