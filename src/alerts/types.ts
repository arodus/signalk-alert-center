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
  source?: string;
  firstSeenAt: Date;
  /** Timestamp supplied by Signal K for the latest meaningful source update. */
  sourceTimestamp?: Date;
  /** Local receipt time of the first update that opened this occurrence. */
  receivedAt?: Date;
  lastSeenAt: Date;
  clearedAt?: Date;
  lastFiredAt?: Date;
  fireCount: number;
  currentState: AlertState;
  currentSeverity: Severity;
  maxSeverity: Severity;
  message?: string;
  sourcePayload?: unknown;
  notificationId?: string;
  acknowledgedAt?: Date;
  silencedAt?: Date;
  /** Policy snapshot controlling one-time notification behavior. */
  oneTime: boolean;
  minimumSeverity: Severity;
  activationDelaySeconds: number;
  connectivity: ConnectivityMode;
  activationDueAt?: Date;
  activationState?: ActivationState;
  /** Template snapshotted for Wyoming speech deliveries. */
  speechTemplate?: string;
  /** Wyoming playback policy snapshotted when this occurrence starts. */
  soundEnabled?: boolean;
  soundId?: string;
  speechEnabled?: boolean;
  speechMinimumSeverity?: Severity;
}

export type ActivationState = "pending" | "eligible" | "suppressed";

export interface AlertEventRecord {
  id: number;
  alertId: string;
  eventType: string;
  occurredAt: Date;
  payload?: unknown;
}

export interface AlertHistoryRecord extends AlertEventRecord {
  definitionId: string;
  occurrenceNumber: number;
  name: string;
  path: string;
  sourceKey: string;
  source?: string;
  state: AlertState;
  severity: Severity;
  message?: string;
  startedAt: Date;
  clearedAt?: Date;
}

export interface AlertHistoryQuery {
  definitionId?: string;
  path?: string;
  source?: string;
  state?: AlertState;
  severity?: Severity;
  eventType?: string;
  from?: Date;
  to?: Date;
  /** Exclusive event id cursor in reverse chronological order. */
  cursor?: string;
  limit?: number;
}

export interface AlertHistoryPage {
  items: AlertHistoryRecord[];
  nextCursor?: string;
}

export interface AlertDefinitionRecord {
  id: string;
  sourceType: "zone" | "recognized";
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
  notifierIds: string[];
  /** Per-service values explicitly overriding the global repeat interval. */
  notifierRepeatOverrides: Record<string, number>;
  soundEnabled?: boolean;
  soundId?: string;
  speechEnabled?: boolean;
  speechMinimumSeverity?: Severity;
  speechTemplate?: string;
  speechAnnounceClear?: boolean;
  overrideFields: AlertPolicyField[];
  updatedAt: Date;
}

export const alertPolicyFields = [
  "enabled",
  "oneTime",
  "minimumSeverity",
  "activationDelaySeconds",
  "connectivity",
  "notifierIds",
  "soundEnabled",
  "soundId",
  "speechEnabled",
  "speechMinimumSeverity",
  "speechTemplate",
  "speechAnnounceClear",
] as const;

export type AlertPolicyField = (typeof alertPolicyFields)[number];

export type DeliveryState =
  | "pending"
  | "waiting_connectivity"
  | "sending"
  | "delivered"
  | "failed_retryable"
  | "failed_terminal";

export type DeliveryOperation =
  "notify" | "trigger" | "acknowledge" | "resolve";

export interface DeliveryRecord {
  id: string;
  alertId: string;
  transportInstanceId: string;
  operation: DeliveryOperation;
  state: DeliveryState;
  attemptCount: number;
  /** One-based send cycle for repeated notify/trigger deliveries. */
  cycle: number;
  nextAttemptAt?: Date;
  lastAttemptAt?: Date;
  deliveredAt?: Date;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  remoteId?: string;
  createdAt: Date;
  updatedAt: Date;
  alert?: {
    occurrenceId: string;
    occurrenceNumber?: number;
    definitionId?: string;
    name: string;
    path: string;
    message?: string;
    severity: Severity;
    startedAt: Date;
  };
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

export type WyomingPlaybackState =
  | "queued"
  | "playing"
  | "played"
  | "suppressed"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "unknown"
  | "partial";

export interface WyomingPlaybackTargetRecord {
  state: Exclude<WyomingPlaybackState, "partial">;
  queuedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  error?: string;
}

/** Playback confirmation is distinct from notifier delivery acceptance. */
export interface WyomingPlaybackRecord {
  announcementId: string;
  deliveryId: string;
  kind: "sound" | "speech";
  requestId?: string;
  state: WyomingPlaybackState;
  targets: Record<string, WyomingPlaybackTargetRecord>;
  createdAt: Date;
  updatedAt: Date;
  terminalAt?: Date;
}

export interface DeliveryPage {
  items: DeliveryRecord[];
  nextCursor?: string;
}

export interface DeliveryAttemptPage {
  items: DeliveryAttemptRecord[];
  nextCursor?: string;
}

export interface IngestOptions {
  activationDelaySeconds?: number;
  connectivity?: ConnectivityMode;
  definitionId?: string;
  minimumSeverity?: Severity;
  oneTime?: boolean;
  notifierMinimumSeverities?: Record<string, Severity>;
  notifierRepeatIntervals?: Record<string, number>;
  /** Notifiers, such as PagerDuty, that require a trigger followed by resolve. */
  resolvingNotifierIds?: string[];
  /** Notifiers, such as PagerDuty, that accept an acknowledgement action. */
  acknowledgingNotifierIds?: string[];
  /** Spoken-alert template resolved when this occurrence starts. */
  speechTemplate?: string;
  soundEnabled?: boolean;
  soundId?: string;
  speechEnabled?: boolean;
  speechMinimumSeverity?: Severity;
}

export interface OccurrenceQuery {
  definitionId?: string;
  path?: string;
  source?: string;
  state?: AlertState;
  severity?: Severity;
  from?: Date;
  to?: Date;
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
  source?: string;
  severity: Severity;
  state: AlertState;
  message?: string;
  sourcePayload?: unknown;
  notificationId?: string;
  acknowledged?: boolean;
  sourceTimestamp?: Date;
}

export const severityRank = (severity: Severity): number =>
  severities.indexOf(severity);
