import {
  AlertRecord,
  DeliveryRecord,
  Severity,
  severityRank,
} from "../alerts/types";
import {
  NotificationTransport,
  TransportContext,
  TransportResult,
} from "./transport";

export type WyomingAnnouncementContent =
  | { kind: "sound"; soundId: string }
  | { kind: "speech"; text: string; voice?: string };

export type WyomingTargetPlaybackState =
  | "queued"
  | "playing"
  | "played"
  | "suppressed"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "unknown";

export interface WyomingAnnouncementSnapshot {
  id: string;
  requestId?: string;
  state:
    | "queued"
    | "playing"
    | "played"
    | "suppressed"
    | "cancelled"
    | "interrupted"
    | "failed"
    | "unknown"
    | "partial";
  createdAt?: number;
  updatedAt?: number;
  targets?: Record<
    string,
    {
      state: WyomingTargetPlaybackState;
      queuedAt?: number;
      startedAt?: number;
      finishedAt?: number;
      error?: string;
    }
  >;
}

export interface WyomingAnnouncementEvent {
  sequence: number;
  at: number;
  announcementId: string;
  satellite?: string;
  state: WyomingAnnouncementSnapshot["state"];
  targetState?: WyomingTargetPlaybackState;
}

export interface WyomingAnnouncementApi {
  version: number;
  announce(options: {
    requestId?: string;
    content: WyomingAnnouncementContent;
    targets?: string[];
    priority?: "normal" | "urgent";
  }): Promise<WyomingAnnouncementSnapshot>;
  getAnnouncement?(id: string): WyomingAnnouncementSnapshot | undefined;
  onAnnouncementEvent?(
    listener: (event: WyomingAnnouncementEvent) => void,
  ): () => void;
}

export interface WyomingTransportOptions {
  api: () => WyomingAnnouncementApi | undefined;
  targets?: string[];
  voice?: string;
  urgentAt?: Severity;
  sounds?: Partial<Record<Severity, string>>;
  definitionName?: (definitionId: string | undefined) => string | undefined;
  onAnnouncement?: (
    deliveryId: string,
    kind: WyomingAnnouncementContent["kind"],
    snapshot: WyomingAnnouncementSnapshot,
  ) => void;
}

const DEFAULT_TEMPLATE = "{name}. {severity}. {message}";
const DEFAULT_SOUNDS: Record<Severity, string> = {
  normal: "chime",
  warn: "warning",
  alert: "warning",
  alarm: "alarm",
  emergency: "alarm",
};
const acceptedStates = new Set([
  "queued",
  "playing",
  "played",
  "suppressed",
  "partial",
]);

export function renderSpeechText(
  alert: AlertRecord,
  name: string,
  operation: DeliveryRecord["operation"],
): string {
  if (operation === "resolve") return `Cleared. ${name}.`;
  const values: Record<string, string> = {
    name,
    severity: alert.maxSeverity,
    message: alert.message?.trim() || name,
    path: alert.path,
    state: alert.currentState,
  };
  const template = alert.speechTemplate?.trim() || DEFAULT_TEMPLATE;
  const rendered = template.replace(
    /\{(name|severity|message|path|state)\}/g,
    (_match, token: string) => values[token] ?? "",
  );
  return rendered.replace(/\s+/g, " ").trim().slice(0, 500);
}

export class WyomingTransport implements NotificationTransport {
  readonly type = "wyoming";

  constructor(private readonly options: WyomingTransportOptions) {}

  private async queue(
    content: WyomingAnnouncementContent,
    priority: "normal" | "urgent",
    signal: AbortSignal,
    requestId?: string,
    tracking?: {
      deliveryId: string;
      kind: WyomingAnnouncementContent["kind"];
    },
  ): Promise<TransportResult> {
    if (signal.aborted)
      return {
        kind: "retryable",
        code: "DELIVERY_ABORTED",
        message: "Wyoming announcement was cancelled before it was queued",
      };
    const api = this.options.api();
    if (!api || api.version !== 1)
      return {
        kind: "retryable",
        code: "WYOMING_UNAVAILABLE",
        message:
          "signalk-wyoming is not running or has not published a compatible announcement API",
      };
    try {
      let rejectOnAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(new Error("WYOMING_ABORTED"));
        signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
      const request = api.announce({
        ...(requestId ? { requestId } : {}),
        content,
        priority,
        ...(this.options.targets?.length
          ? { targets: [...new Set(this.options.targets)] }
          : {}),
      });
      const snapshot = await Promise.race([request, aborted]).finally(() => {
        if (rejectOnAbort) signal.removeEventListener("abort", rejectOnAbort);
      });
      if (tracking)
        this.options.onAnnouncement?.(
          tracking.deliveryId,
          tracking.kind,
          snapshot,
        );
      if (acceptedStates.has(snapshot.state))
        return { kind: "success", remoteId: snapshot.id };
      const errors = Object.entries(snapshot.targets ?? {})
        .filter(([, target]) => target.error)
        .map(([satellite, target]) => `${satellite}: ${target.error}`)
        .join("; ");
      return {
        kind: "retryable",
        code: `WYOMING_${snapshot.state.toUpperCase()}`,
        message:
          errors || `signalk-wyoming reported announcement ${snapshot.state}`,
      };
    } catch (error) {
      if (signal.aborted)
        return {
          kind: "retryable",
          code: "DELIVERY_ABORTED",
          message:
            "The Wyoming request timed out before queuing was confirmed; the remote queue cannot be cancelled",
        };
      return {
        kind: "retryable",
        code: "WYOMING_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  announce(
    text: string,
    priority: "normal" | "urgent",
    signal: AbortSignal,
    requestId?: string,
    tracking?: {
      deliveryId: string;
      kind: WyomingAnnouncementContent["kind"];
    },
  ): Promise<TransportResult> {
    return this.queue(
      {
        kind: "speech",
        text: text.slice(0, 500),
        ...(this.options.voice?.trim()
          ? { voice: this.options.voice.trim() }
          : {}),
      },
      priority,
      signal,
      requestId,
      tracking,
    );
  }

  async send(
    alert: AlertRecord,
    delivery: DeliveryRecord,
    context: TransportContext,
  ): Promise<TransportResult> {
    if (delivery.operation === "acknowledge") return { kind: "success" };
    const name =
      this.options.definitionName?.(alert.definitionId) ?? alert.path;
    const priority =
      severityRank(alert.maxSeverity) >=
      severityRank(this.options.urgentAt ?? "alarm")
        ? "urgent"
        : "normal";
    const soundId =
      alert.soundId?.trim() ||
      this.options.sounds?.[alert.maxSeverity]?.trim() ||
      DEFAULT_SOUNDS[alert.maxSeverity];
    const shouldPlaySound = alert.soundEnabled !== false && soundId;
    const shouldSpeak =
      alert.speechEnabled !== false &&
      (delivery.operation === "resolve" ||
        severityRank(alert.maxSeverity) >=
          severityRank(alert.speechMinimumSeverity ?? "warn"));
    const remoteIds: string[] = [];

    // Queue in this order. signalk-wyoming preserves FIFO order per satellite,
    // so the notification sound always precedes its spoken text.
    if (shouldPlaySound) {
      const sound = await this.queue(
        { kind: "sound", soundId },
        priority,
        context.signal,
        `${delivery.id}:sound`,
        { deliveryId: delivery.id, kind: "sound" },
      );
      if (sound.kind !== "success") return sound;
      if (sound.remoteId) remoteIds.push(`sound:${sound.remoteId}`);
    }
    if (shouldSpeak) {
      const speech = await this.announce(
        renderSpeechText(alert, name, delivery.operation),
        priority,
        context.signal,
        `${delivery.id}:speech`,
        { deliveryId: delivery.id, kind: "speech" },
      );
      if (speech.kind !== "success") return speech;
      if (speech.remoteId) remoteIds.push(`speech:${speech.remoteId}`);
    }
    return {
      kind: "success",
      remoteId: remoteIds.join(",") || "suppressed:policy",
    };
  }
}
