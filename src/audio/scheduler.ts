import {
  AlertAudioPolicy,
  AlertRecord,
  AudioSound,
  AudioSoundSelection,
  Severity,
  severityRank,
} from "../alerts/types";
import { AlertDatabase } from "../storage/db";
import { AudioPlayer } from "./player";

export interface AudioSchedulerOptions {
  queueLimit: number;
  failureRetrySeconds: number;
  maxAttempts: number;
  quietHours?: { enabled?: boolean; start?: string; end?: string };
  onError?: (message: string) => void;
}

export interface AudioSchedulerStatus {
  running: boolean;
  lastRunCompletedAt?: Date;
  lastPlayedAt?: Date;
  lastError?: string;
}

export class AudioScheduler {
  private running = false;
  private stopped = false;
  private activeRun?: Promise<void>;
  private active?: { alertId: string; controller: AbortController };
  private lastRunCompletedAt?: Date;
  private lastPlayedAt?: Date;
  private lastError?: string;

  constructor(
    private readonly database: AlertDatabase,
    private readonly player: AudioPlayer,
    private readonly options: AudioSchedulerOptions,
  ) {
    this.database.recoverPlayingAudio();
  }

  status(): AudioSchedulerStatus {
    return {
      running: this.running,
      lastRunCompletedAt: this.lastRunCompletedAt,
      lastPlayedAt: this.lastPlayedAt,
      lastError: this.lastError,
    };
  }

  queue(
    occurrence: AlertRecord,
    policy: AlertAudioPolicy,
    activationDelaySeconds: number,
    now = new Date(),
  ): void {
    if (
      occurrence.currentState !== "active" ||
      !policy.enabled ||
      severityRank(occurrence.currentSeverity) <
        severityRank(policy.minimumSeverity)
    )
      return;
    const delayedUntil = new Date(
      occurrence.firstSeenAt.getTime() + activationDelaySeconds * 1000,
    );
    this.database.ensureAudioPlayback(
      occurrence.id,
      policy,
      delayedUntil > now ? delayedUntil : now,
      now,
    );
  }

  cancel(
    alertId: string,
    trigger: keyof AlertAudioPolicy["stopOn"],
    now = new Date(),
  ): boolean {
    const cancelled = this.database.cancelAudioPlaybackForAlert(
      alertId,
      trigger,
      now,
    );
    if (cancelled && this.active?.alertId === alertId)
      this.active.controller.abort();
    return cancelled;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.stopped || this.running) return this.activeRun;
    this.running = true;
    const run = (async () => {
      const quietUntil = quietHoursEnd(now, this.options.quietHours);
      const playbacks = this.database.listDueAudioPlaybacks(
        now,
        this.options.queueLimit,
      );
      for (const playback of playbacks) {
        if (this.stopped) break;
        if (quietUntil) {
          this.database.postponeAudioPlayback(playback.id, quietUntil, now);
          continue;
        }
        const alert = this.database.getAlert(playback.alertId);
        const stopTrigger = playbackStopTrigger(alert, playback.stopOn);
        if (stopTrigger) {
          this.cancel(playback.alertId, stopTrigger, now);
          continue;
        }
        if (
          alert.currentState === "active" &&
          severityRank(alert.currentSeverity) <
            severityRank(playback.minimumSeverity)
        ) {
          this.database.waitAudioForSeverity(playback.id, now);
          continue;
        }
        if (!this.database.claimAudioPlayback(playback.id, now)) continue;
        const controller = new AbortController();
        this.active = { alertId: playback.alertId, controller };
        try {
          const sound = resolveAudioSound(
            playback.sound,
            alert.currentSeverity,
          );
          const result = await this.player.play(sound, controller.signal);
          const refreshed = this.database.getAlert(playback.alertId);
          const repeat =
            playback.mode === "repeat" &&
            refreshed.currentState === "active" &&
            !playbackStopTrigger(refreshed, playback.stopOn);
          const nextPlayAt = repeat
            ? new Date(Date.now() + playback.repeatIntervalSeconds * 1000)
            : undefined;
          this.database.recordAudioSuccess(
            playback.id,
            nextPlayAt,
            result.backend,
            sound,
            new Date(),
          );
          this.lastPlayedAt = new Date();
          this.lastError = undefined;
        } catch (error) {
          const current = this.database.getAudioPlaybackForAlert(
            playback.alertId,
          );
          if (this.stopped || current?.state === "cancelled") continue;
          const attempt = playback.attemptCount + 1;
          const retryAt =
            attempt < this.options.maxAttempts
              ? new Date(Date.now() + this.options.failureRetrySeconds * 1000)
              : undefined;
          const message =
            error instanceof Error ? error.message : String(error);
          const code =
            typeof (error as NodeJS.ErrnoException).code === "string"
              ? String((error as NodeJS.ErrnoException).code)
              : "PLAYBACK_ERROR";
          this.database.recordAudioFailure(
            playback.id,
            code,
            message,
            retryAt,
            new Date(),
          );
          this.lastError = message;
          this.options.onError?.(message);
        } finally {
          if (this.active?.alertId === playback.alertId)
            this.active = undefined;
        }
      }
    })();
    this.activeRun = run;
    try {
      await run;
      this.lastRunCompletedAt = new Date();
    } finally {
      this.running = false;
      this.activeRun = undefined;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.active?.controller.abort();
    await this.activeRun;
    this.database.recoverPlayingAudio();
  }
}

export function resolveAudioSound(
  selection: AudioSoundSelection,
  severity: Severity,
): AudioSound {
  if (selection !== "severity") return selection;
  if (severity === "emergency") return "emergency";
  if (severity === "alarm") return "alarm";
  if (severity === "alert") return "warning";
  return "chime";
}

function playbackStopTrigger(
  alert: AlertRecord,
  stopOn: AlertAudioPolicy["stopOn"],
): keyof AlertAudioPolicy["stopOn"] | undefined {
  if (alert.currentState === "cleared" && stopOn.clear) return "clear";
  if (alert.acknowledgedAt && stopOn.acknowledge) return "acknowledge";
  if (alert.silencedAt && stopOn.silence) return "silence";
  if (alert.dismissedAt && stopOn.dismiss) return "dismiss";
  return undefined;
}

export function quietHoursEnd(
  now: Date,
  quiet?: { enabled?: boolean; start?: string; end?: string },
): Date | undefined {
  if (!quiet?.enabled || !quiet.start || !quiet.end) return undefined;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = clockMinutes(quiet.start);
  const end = clockMinutes(quiet.end);
  const overnight = start > end;
  const inside = overnight
    ? minutes >= start || minutes < end
    : minutes >= start && minutes < end;
  if (!inside) return undefined;
  const result = new Date(now);
  result.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (overnight && minutes >= start) result.setDate(result.getDate() + 1);
  return result;
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}
