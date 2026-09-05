export const severities = [
  "normal",
  "warn",
  "alert",
  "alarm",
  "emergency",
] as const;
export type Severity = (typeof severities)[number];

export type AlertState = "active" | "cleared";
export type ConnectivityMode =
  | { mode: "queue" }
  | { mode: "wake" }
  | { mode: "wake_after"; delaySeconds: number };

export interface AlertRecord {
  id: string;
  sourceKey: string;
  path: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  clearedAt?: Date;
  lastFiredAt?: Date;
  fireCount: number;
  removedAt?: Date;
  currentState: AlertState;
  currentSeverity: Severity;
  maxSeverity: Severity;
  message?: string;
  sourcePayload?: unknown;
}

export type DeliveryState =
  | "pending"
  | "waiting_connectivity"
  | "sending"
  | "delivered"
  | "failed_retryable"
  | "failed_terminal";

export interface DeliveryRecord {
  id: string;
  alertId: string;
  transportInstanceId: string;
  state: DeliveryState;
  attemptCount: number;
  nextAttemptAt?: Date;
  lastAttemptAt?: Date;
  deliveredAt?: Date;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  remoteId?: string;
}

export interface NormalizedAlert {
  sourceKey: string;
  path: string;
  severity: Severity;
  state: AlertState;
  message?: string;
  sourcePayload?: unknown;
}

export const severityRank = (severity: Severity): number =>
  severities.indexOf(severity);
