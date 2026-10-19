import {
  internetStateAvailability,
  InternetStateObservation,
  SignalKInternetState,
} from "../signalk/internet-state";

export type InternetAvailabilityState = "unknown" | SignalKInternetState;

export interface InternetAvailabilityStatus {
  state: InternetAvailabilityState;
  available?: boolean;
  source?: string;
  lastUpdatedAt?: Date;
}

/**
 * Tracks the preferred Signal K `network.internet.state` value. The dedicated
 * signalk-internet plugin owns active probing and hardware-aware detection;
 * Alert Center only consumes its resolved state.
 */
export class InternetAvailabilityMonitor {
  state: InternetAvailabilityState = "unknown";
  available?: boolean;
  source?: string;
  lastUpdatedAt?: Date;

  private stopped = false;

  constructor(
    private readonly onChange: (status: InternetAvailabilityStatus) => void,
  ) {}

  observe(observation: InternetStateObservation): void {
    if (this.stopped) return;
    const previous = this.status();
    this.state = observation.value ?? "unknown";
    this.available = internetStateAvailability(observation.value);
    this.source = observation.source;
    this.lastUpdatedAt = observation.updatedAt;
    const current = this.status();
    if (
      previous.state !== current.state ||
      previous.source !== current.source ||
      previous.lastUpdatedAt?.getTime() !== current.lastUpdatedAt?.getTime()
    )
      this.onChange(current);
  }

  status(): InternetAvailabilityStatus {
    return {
      state: this.state,
      ...(this.available === undefined ? {} : { available: this.available }),
      ...(this.source ? { source: this.source } : {}),
      ...(this.lastUpdatedAt ? { lastUpdatedAt: this.lastUpdatedAt } : {}),
    };
  }

  checkNow(): Promise<boolean> {
    return Promise.resolve(!this.stopped && this.available === true);
  }

  stop(): void {
    this.stopped = true;
  }
}
