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
type InternetAvailabilityCheck = (signal?: AbortSignal) => Promise<boolean>;

export interface ConnectivitySessionSnapshot {
  startedAt?: Date;
  startedByPlugin: boolean;
  state: ConnectivityState;
  observedSwitchOn?: boolean;
  wakeDueAt?: Date;
  lastError?: string;
  updatedAt: Date;
}

export interface ConnectivityObservers {
  onSessionChange?: (session: ConnectivitySessionSnapshot) => void;
}

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
  lastInternetCheckAt?: Date;
  lastInternetAvailable?: boolean;
  lastInternetCheckError?: string;
  private sessionStartedAt?: Date;
  private cooldownTimer?: ReturnType<typeof setTimeout>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private wakeDueAt?: Date;
  private activeWake?: Promise<void>;
  private stopped = false;
  private stopController = new AbortController();

  constructor(
    private readonly adapter: SwitchAdapter,
    private readonly cooldownMs = 300_000,
    private readonly internetAvailable: InternetAvailabilityCheck = async () =>
      true,
    private readonly bootTimeoutMs = 240_000,
    private readonly checkIntervalMs = 5_000,
    private readonly safetyCheck: ConnectivitySafetyCheck = safeToRelease,
    private readonly mayWake: () => boolean = () => true,
    private readonly observers: ConnectivityObservers = {},
  ) {}

  get scheduledWakeAt(): Date | undefined {
    return this.wakeDueAt;
  }

  private transition(next: ConnectivityState): void {
    if (this.state === next) return;
    this.lastTransitionFrom = this.state;
    this.state = next;
    this.lastTransitionAt = new Date();
    this.persist();
  }

  private persist(): void {
    this.observers.onSessionChange?.({
      startedAt: this.sessionStartedAt,
      startedByPlugin: this.ownedByPlugin,
      state: this.state,
      observedSwitchOn: this.switchOn,
      wakeDueAt: this.wakeDueAt,
      lastError: this.lastError,
      updatedAt: new Date(),
    });
  }

  /** Reconcile durable ownership with the observed switch before scheduling. */
  async recover(session?: ConnectivitySessionSnapshot): Promise<void> {
    let observed: boolean | undefined;
    try {
      observed = await this.adapter.getState();
    } catch (error) {
      if (this.stopped) return;
      this.switchOn = undefined;
      this.ownedByPlugin = false;
      this.sessionStartedAt = undefined;
      this.lastError = `Could not read switch state after restart: ${error instanceof Error ? error.message : String(error)}`;
      this.transition("FAULT");
      this.persist();
      return;
    }
    if (this.stopped) return;
    this.switchOn = observed;
    if (observed === false) {
      this.ownedByPlugin = false;
      this.sessionStartedAt = undefined;
      this.lastError = undefined;
      this.transition("OFF");
      this.persist();
      return;
    }
    if (observed !== true) {
      this.ownedByPlugin = false;
      this.sessionStartedAt = undefined;
      this.lastError =
        "Switch state is unknown after restart; leaving connectivity untouched";
      this.transition("FAULT");
      this.persist();
      return;
    }
    this.ownedByPlugin = Boolean(
      session?.startedByPlugin &&
      session.observedSwitchOn !== false &&
      session.state !== "OFF",
    );
    this.sessionStartedAt = this.ownedByPlugin ? session?.startedAt : undefined;
    this.lastError = undefined;
    this.transition("POWERED");
    this.persist();
    await this.waitForInternet();
  }

  async requestWake(): Promise<void> {
    if (this.stopped || !this.mayWake()) return;
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
    let observed: boolean | undefined;
    try {
      observed = await this.adapter.getState();
    } catch (error) {
      if (this.stopped) return;
      this.switchOn = undefined;
      this.ownedByPlugin = false;
      this.sessionStartedAt = undefined;
      this.transition("FAULT");
      this.lastError = `Could not read switch state: ${error instanceof Error ? error.message : String(error)}`;
      this.persist();
      return;
    }
    if (this.stopped || !this.mayWake()) return;
    this.switchOn = observed;
    if (observed === true) {
      // A retry after an Internet boot timeout must not discard ownership.
      this.transition("POWERED");
      return this.waitForInternet();
    }
    if (observed !== false) {
      this.ownedByPlugin = false;
      this.sessionStartedAt = undefined;
      this.transition("FAULT");
      this.lastError =
        "Switch state is unknown; leaving connectivity untouched";
      this.persist();
      return;
    }
    this.ownedByPlugin = false;
    this.sessionStartedAt = new Date();
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
      this.persist();
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
      this.persist();
      void this.requestWake();
    }, delay);
    this.wakeTimer.unref?.();
    this.persist();
  }

  cancelScheduledWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.wakeDueAt = undefined;
    this.persist();
  }

  private async waitForInternet(): Promise<void> {
    this.transition("WAITING_FOR_INTERNET");
    const deadline = Date.now() + this.bootTimeoutMs;
    while (!this.stopped && Date.now() <= deadline) {
      let ready = false;
      try {
        ready = await this.internetAvailable(this.stopController.signal);
        this.lastInternetCheckError = undefined;
      } catch (error) {
        this.lastInternetCheckError =
          error instanceof Error ? error.message : String(error);
      }
      this.lastInternetCheckAt = new Date();
      this.lastInternetAvailable = ready;
      this.persist();
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
    this.lastError = this.lastInternetCheckError
      ? `Internet state check failed: ${this.lastInternetCheckError}`
      : "Internet state did not become available before the timeout";
    this.persist();
  }

  beginCooldown(): void {
    if (
      !this.ownedByPlugin ||
      this.switchOn !== true ||
      (this.state !== "ONLINE" &&
        this.state !== "IDLE_COOLDOWN" &&
        this.state !== "FAULT")
    )
      return;
    this.transition("IDLE_COOLDOWN");
    this.lastShutdownDeferredReason = undefined;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      void this.releaseIfSafe();
    }, this.cooldownMs);
    this.cooldownTimer.unref?.();
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
      this.sessionStartedAt = undefined;
      this.transition("OFF");
    } catch (error) {
      this.transition("FAULT");
      this.lastError = error instanceof Error ? error.message : String(error);
      this.persist();
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
