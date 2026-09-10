export const severities = [
  "normal",
  "warn",
  "alert",
  "alarm",
  "emergency",
] as const;
export type Severity = (typeof severities)[number];

export const audioSounds = ["chime", "warning", "alarm", "emergency"] as const;
export type AudioSound = (typeof audioSounds)[number];
export type AudioPlaybackMode = "once" | "repeat";

export interface AudioStopPolicy {
  clear: boolean;
  acknowledge: boolean;
  silence: boolean;
  dismiss: boolean;
}

export interface AlertAudioPolicy {
  enabled: boolean;
  sound: AudioSound;
  minimumSeverity: Severity;
  mode: AudioPlaybackMode;
  repeatIntervalSeconds: number;
  stopOn: AudioStopPolicy;
}

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
  /** Policy snapshot: whether this occurrence remains until dismissed. */
  oneTime: boolean;
  minimumSeverity: Severity;
  activationDelaySeconds: number;
  rearmAfterSeconds?: number;
  connectivity: ConnectivityMode;
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
  rearmAfterSeconds?: number;
  notifierIds: string[];
  audio?: AlertAudioPolicy;
  updatedAt: Date;
}

export type AudioPlaybackState =
  | "queued"
  | "waiting_severity"
  | "playing"
  | "completed"
  | "cancelled"
  | "failed_retryable"
  | "failed_terminal";

export interface AudioPlaybackRecord {
  id: string;
  alertId: string;
  state: AudioPlaybackState;
  sound: AudioSound;
  minimumSeverity: Severity;
  mode: AudioPlaybackMode;
  repeatIntervalSeconds: number;
  stopOn: AudioStopPolicy;
  attemptCount: number;
  playCount: number;
  nextPlayAt?: Date;
  lastStartedAt?: Date;
  lastFinishedAt?: Date;
  lastErrorCode?: string;
  lastErrorMessage?: string;
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
  connectivity?: ConnectivityMode;
  definitionId?: string;
  minimumSeverity?: Severity;
  oneTime?: boolean;
  rearmAfterSeconds?: number;
  notifierMinimumSeverities?: Record<string, Severity>;
}

export interface OccurrenceQuery {
  definitionId?: string;
  path?: string;
  source?: string;
  state?: AlertState;
  severity?: Severity;
  dismissed?: boolean;
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
  sourceTimestamp?: Date;
}

export const severityRank = (severity: Severity): number =>
  severities.indexOf(severity);
