import { describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertAudioPolicy } from "../src/alerts/types";
import {
  audioCommand,
  AudioPlayer,
  HookedAudioPlayer,
} from "../src/audio/player";
import {
  AudioScheduler,
  quietHoursEnd,
  resolveAudioSound,
} from "../src/audio/scheduler";
import { DeliveryScheduler } from "../src/delivery/scheduler";
import { AlertDatabase } from "../src/storage/db";

const policy = (
  overrides: Partial<AlertAudioPolicy> = {},
): AlertAudioPolicy => ({
  enabled: true,
  sound: "warning",
  minimumSeverity: "warn",
  mode: "once",
  repeatIntervalSeconds: 60,
  stopOn: {
    clear: true,
    acknowledge: true,
    silence: true,
    dismiss: true,
  },
  ...overrides,
});

const activeOccurrence = (database: AlertDatabase, now: Date) =>
  database.ingest(
    {
      sourceKey: "notifications.audio.test",
      path: "notifications.audio.test",
      state: "active",
      severity: "alarm",
      message: "Audio test",
    },
    [],
    now,
  )!;

const schedulerOptions = {
  queueLimit: 25,
  failureRetrySeconds: 30,
  maxAttempts: 3,
};

describe("local audio playback", () => {
  it("plays a durable one-shot once and does not replay it after restart", async () => {
    const database = new AlertDatabase();
    const now = new Date("2026-01-01T12:00:00Z");
    const occurrence = activeOccurrence(database, now);
    const player: AudioPlayer = {
      play: vi.fn(async () => ({ backend: "fake" })),
    };
    const first = new AudioScheduler(database, player, schedulerOptions);
    first.queue(occurrence, policy(), 0, now);

    await first.runOnce(now);
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(database.getAudioPlaybackForAlert(occurrence.id)).toMatchObject({
      state: "completed",
      playCount: 1,
      attemptCount: 1,
    });

    const restarted = new AudioScheduler(database, player, schedulerOptions);
    await restarted.runOnce(new Date("2026-01-01T12:05:00Z"));
    expect(player.play).toHaveBeenCalledTimes(1);
    database.close();
  });

  it.each(["clear", "acknowledge", "silence", "dismiss"] as const)(
    "cancels repeating playback on %s",
    async (trigger) => {
      const database = new AlertDatabase();
      const now = new Date("2026-01-01T12:00:00Z");
      const occurrence = activeOccurrence(database, now);
      const player: AudioPlayer = {
        play: vi.fn(async () => ({ backend: "fake" })),
      };
      const scheduler = new AudioScheduler(database, player, schedulerOptions);
      scheduler.queue(occurrence, policy({ mode: "repeat" }), 0, now);
      await scheduler.runOnce(now);
      expect(database.getAudioPlaybackForAlert(occurrence.id)?.state).toBe(
        "queued",
      );

      expect(scheduler.cancel(occurrence.id, trigger, now)).toBe(true);
      expect(database.getAudioPlaybackForAlert(occurrence.id)?.state).toBe(
        "cancelled",
      );
      const events = database.listAlertEvents(occurrence.id);
      expect(
        events.find((event) => event.eventType === "audio_cancelled"),
      ).toMatchObject({
        eventType: "audio_cancelled",
        payload: { trigger },
      });
      database.close();
    },
  );

  it("records playback failure without blocking a remote delivery", async () => {
    const database = new AlertDatabase();
    const now = new Date("2026-01-01T12:00:00Z");
    const occurrence = database.ingest(
      {
        sourceKey: "notifications.audio.independent",
        path: "notifications.audio.independent",
        state: "active",
        severity: "alarm",
      },
      ["remote"],
      now,
    )!;
    const logFailure = vi.fn();
    const audio = new AudioScheduler(
      database,
      {
        play: vi.fn(async () => {
          throw Object.assign(new Error("speaker missing"), { code: "ENOENT" });
        }),
      },
      { ...schedulerOptions, maxAttempts: 1, onError: logFailure },
    );
    audio.queue(occurrence, policy(), 0, now);
    const delivery = new DeliveryScheduler(
      database,
      new Map([
        [
          "remote",
          {
            type: "fake",
            send: vi.fn(async () => ({ kind: "success" as const })),
          },
        ],
      ]),
    );

    await audio.runOnce(now);
    await delivery.runOnce(now);
    expect(database.getAudioPlaybackForAlert(occurrence.id)).toMatchObject({
      state: "failed_terminal",
      lastErrorCode: "ENOENT",
    });
    expect(database.listDeliveries()[0].state).toBe("delivered");
    expect(logFailure).toHaveBeenCalledWith("speaker missing");
    database.close();
  });

  it("waits through a severity drop and plays when the threshold is reached again", async () => {
    const database = new AlertDatabase();
    const now = new Date("2026-01-01T12:00:00Z");
    const occurrence = activeOccurrence(database, now);
    const player: AudioPlayer = {
      play: vi.fn(async () => ({ backend: "fake" })),
    };
    const scheduler = new AudioScheduler(database, player, schedulerOptions);
    scheduler.queue(occurrence, policy({ minimumSeverity: "alarm" }), 0, now);
    database.ingest(
      {
        sourceKey: occurrence.sourceKey,
        path: occurrence.path,
        state: "active",
        severity: "warn",
      },
      [],
      new Date("2026-01-01T12:00:01Z"),
    );

    await scheduler.runOnce(new Date("2026-01-01T12:00:01Z"));
    expect(database.getAudioPlaybackForAlert(occurrence.id)?.state).toBe(
      "waiting_severity",
    );
    expect(player.play).not.toHaveBeenCalled();

    const raised = database.ingest(
      {
        sourceKey: occurrence.sourceKey,
        path: occurrence.path,
        state: "active",
        severity: "alarm",
      },
      [],
      new Date("2026-01-01T12:00:02Z"),
    )!;
    scheduler.queue(
      raised,
      policy({ minimumSeverity: "alarm" }),
      0,
      new Date("2026-01-01T12:00:02Z"),
    );
    await scheduler.runOnce(new Date("2026-01-01T12:00:02Z"));
    expect(player.play).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("stops an in-flight player immediately when the alert is silenced", async () => {
    const database = new AlertDatabase();
    const now = new Date("2026-01-01T12:00:00Z");
    const occurrence = activeOccurrence(database, now);
    let started!: () => void;
    const playing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const player: AudioPlayer = {
      play: vi.fn(
        (_sound, signal) =>
          new Promise((resolve, reject) => {
            started();
            signal?.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("stopped"), { code: "ABORTED" }),
                ),
              { once: true },
            );
          }),
      ),
    };
    const scheduler = new AudioScheduler(database, player, schedulerOptions);
    scheduler.queue(occurrence, policy({ mode: "repeat" }), 0, now);

    const run = scheduler.runOnce(now);
    await playing;
    expect(scheduler.cancel(occurrence.id, "silence", now)).toBe(true);
    await run;
    expect(database.getAudioPlaybackForAlert(occurrence.id)?.state).toBe(
      "cancelled",
    );
    database.close();
  });

  it("does not replay an interrupted one-shot after plugin shutdown", async () => {
    const database = new AlertDatabase();
    const now = new Date("2026-01-01T12:00:00Z");
    const occurrence = activeOccurrence(database, now);
    let started!: () => void;
    const playing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const player: AudioPlayer = {
      play: (_sound, signal) =>
        new Promise((resolve, reject) => {
          started();
          signal?.addEventListener(
            "abort",
            () =>
              reject(Object.assign(new Error("stopped"), { code: "ABORTED" })),
            { once: true },
          );
        }),
    };
    const scheduler = new AudioScheduler(database, player, schedulerOptions);
    scheduler.queue(occurrence, policy(), 0, now);
    const run = scheduler.runOnce(now);
    await playing;

    await scheduler.stop();
    await run;
    expect(database.getAudioPlaybackForAlert(occurrence.id)?.state).toBe(
      "completed",
    );
    database.close();
  });

  it("passes device names as one argument without shell interpretation", () => {
    expect(
      audioCommand("aplay", "hw:1; touch /tmp/never", "/safe/alarm.wav"),
    ).toEqual({
      command: "aplay",
      args: ["-q", "-D", "hw:1; touch /tmp/never", "/safe/alarm.wav"],
    });
  });

  it("selects a distinct built-in sound from the current alert severity", () => {
    expect(resolveAudioSound("severity", "warn")).toBe("chime");
    expect(resolveAudioSound("severity", "alert")).toBe("warning");
    expect(resolveAudioSound("severity", "alarm")).toBe("alarm");
    expect(resolveAudioSound("severity", "emergency")).toBe("emergency");
    expect(resolveAudioSound("alarm", "warn")).toBe("alarm");
  });

  it("runs configured commands in order around each sound", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notifier-audio-hooks-"));
    const marker = join(directory, "order.txt");
    const appendCommand = (value: string) => ({
      executable: process.execPath,
      arguments: [
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], process.argv[2])",
        marker,
        `${value}\n`,
      ],
    });
    const base: AudioPlayer = {
      play: vi.fn(async () => {
        appendFileSync(marker, "sound\n");
        return { backend: "fake" };
      }),
    };
    try {
      const player = new HookedAudioPlayer(base, {
        before: appendCommand("before"),
        after: appendCommand("after"),
        timeoutSeconds: 5,
      });
      await player.play("warning");
      expect(readFileSync(marker, "utf8")).toBe("before\nsound\nafter\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not replay a successful sound when the after command fails", async () => {
    const commandError = vi.fn();
    const base: AudioPlayer = {
      play: vi.fn(async () => ({ backend: "fake" })),
    };
    const player = new HookedAudioPlayer(base, {
      after: {
        executable: process.execPath,
        arguments: ["-e", "process.exit(7)"],
      },
      timeoutSeconds: 5,
      onCommandError: commandError,
    });

    await expect(player.play("warning")).resolves.toEqual({ backend: "fake" });
    expect(base.play).toHaveBeenCalledTimes(1);
    expect(commandError).toHaveBeenCalledWith(
      "after",
      expect.stringContaining("code 7"),
    );
  });

  it("blocks playback when the before command fails", async () => {
    const base: AudioPlayer = {
      play: vi.fn(async () => ({ backend: "fake" })),
    };
    const player = new HookedAudioPlayer(base, {
      before: {
        executable: process.execPath,
        arguments: ["-e", "process.exit(4)"],
      },
      timeoutSeconds: 5,
    });

    await expect(player.play("alarm")).rejects.toMatchObject({
      code: "BEFORE_COMMAND_FAILED",
    });
    expect(base.play).not.toHaveBeenCalled();
  });

  it("calculates the end of overnight quiet hours in local time", () => {
    const now = new Date(2026, 0, 1, 23, 30);
    expect(
      quietHoursEnd(now, { enabled: true, start: "22:00", end: "07:00" }),
    ).toEqual(new Date(2026, 0, 2, 7, 0));
  });
});
