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
  definitionId?: string;
  occurrenceNumber?: number;
  sourceKey: string;
  path: string;
  firstSeenAt: Date;
  /** Timestamp supplied by Signal K for the latest meaningful source update. */
  sourceTimestamp?: Date;
  /** Local receipt time of the first update that opened this occurrence. */
  receivedAt?: Date;
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
  notificationId?: string;
  acknowledgedAt?: Date;
  silencedAt?: Date;
  dismissedAt?: Date;
  activationDueAt?: Date;
  activationState?: ActivationState;
}

export type ActivationState = "pending" | "eligible" | "suppressed";

export interface AlertEventRecord {
  id: number;
  alertId: string;
  eventType: string;
  occurredAt: Date;
  payload?: unknown;
}

export interface AlertDefinitionRecord {
  id: string;
  sourceType: "rule" | "zone" | "recognized";
  pathPattern: string;
  name: string;
  metadata?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertPolicyRecord {
  definitionId: string;
  enabled?: boolean;
  minimumSeverity?: Severity;
  connectivity?: ConnectivityMode;
  oneTime?: boolean;
  activationDelaySeconds?: number;
  rearmAfterSeconds?: number;
  notifierIds: string[];
  updatedAt: Date;
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

export interface DeliveryAttemptRecord {
  id: number;
  deliveryId: string;
  attemptNumber: number;
  startedAt: Date;
  finishedAt?: Date;
  outcome:
    | "sending"
    | "delivered"
    | "failed_retryable"
    | "failed_terminal"
    | "interrupted";
  errorCode?: string;
  errorMessage?: string;
  remoteId?: string;
}

export interface IngestOptions {
  activationDelaySeconds?: number;
  definitionId?: string;
  rearmAfterSeconds?: number;
}

export interface OccurrenceQuery {
  definitionId?: string;
  state?: AlertState;
  severity?: Severity;
  dismissed?: boolean;
  /** Exclusive occurrence id cursor in reverse chronological order. */
  cursor?: string;
  limit?: number;
}

export interface OccurrencePage {
  items: AlertRecord[];
  nextCursor?: string;
}

export interface NormalizedAlert {
  sourceKey: string;
  path: string;
  severity: Severity;
  state: AlertState;
  message?: string;
  sourcePayload?: unknown;
  notificationId?: string;
  sourceTimestamp?: Date;
}

export const severityRank = (severity: Severity): number =>
  severities.indexOf(severity);
