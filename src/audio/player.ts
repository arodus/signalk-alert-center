import { spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AudioSound,
  CustomAudioSound,
  PlayableAudioSound,
} from "../alerts/types";

export type AudioBackend = "auto" | "aplay" | "paplay" | "afplay";

export interface AudioPlayer {
  play(
    sound: PlayableAudioSound,
    signal?: AbortSignal,
  ): Promise<{ backend: string }>;
}

export interface AudioCommand {
  executable: string;
  arguments?: string[];
}

export interface HookedAudioPlayerOptions {
  before?: AudioCommand;
  after?: AudioCommand;
  timeoutSeconds: number;
  onCommandError?: (stage: "before" | "after", message: string) => void;
}

export interface CommandAudioPlayerOptions {
  backend: AudioBackend;
  outputDevice?: string;
  masterVolume: number;
  timeoutSeconds: number;
  assetDirectory: string;
  customSounds?: ReadonlyMap<CustomAudioSound, string>;
}

const soundPatterns: Record<AudioSound, Array<[number, number]>> = {
  chime: [
    [880, 0.14],
    [0, 0.06],
    [1175, 0.22],
  ],
  warning: [
    [740, 0.2],
    [0, 0.12],
    [740, 0.2],
  ],
  alarm: [
    [880, 0.22],
    [0, 0.1],
    [660, 0.22],
    [0, 0.1],
    [880, 0.22],
  ],
  emergency: [
    [980, 0.25],
    [620, 0.25],
    [980, 0.25],
    [620, 0.25],
  ],
};

export function audioCommand(
  backend: Exclude<AudioBackend, "auto">,
  outputDevice: string | undefined,
  filename: string,
): { command: string; args: string[] } {
  if (backend === "aplay")
    return {
      command: "aplay",
      args: ["-q", ...(outputDevice ? ["-D", outputDevice] : []), filename],
    };
  if (backend === "paplay")
    return {
      command: "paplay",
      args: [...(outputDevice ? [`--device=${outputDevice}`] : []), filename],
    };
  return { command: "afplay", args: [filename] };
}

export class CommandAudioPlayer implements AudioPlayer {
  constructor(private readonly options: CommandAudioPlayerOptions) {}

  async play(
    sound: PlayableAudioSound,
    signal?: AbortSignal,
  ): Promise<{ backend: string }> {
    const filename = this.ensureSound(sound);
    const candidates: Array<Exclude<AudioBackend, "auto">> =
      this.options.backend === "auto"
        ? process.platform === "darwin"
          ? ["afplay"]
          : ["paplay", "aplay"]
        : [this.options.backend];
    let missing: Error | undefined;
    for (const backend of candidates) {
      try {
        await this.run(backend, filename, signal);
        return { backend };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (this.options.backend !== "auto" || code === "ABORTED") throw error;
        missing = error as Error;
      }
    }
    throw missing ?? new Error("No supported local audio player was found");
  }

  private ensureSound(sound: PlayableAudioSound): string {
    if (sound.startsWith("custom:")) {
      const filename = this.options.customSounds?.get(
        sound as CustomAudioSound,
      );
      if (!filename) {
        const error = new Error(`Custom sound is not configured: ${sound}`);
        Object.assign(error, { code: "CUSTOM_SOUND_NOT_CONFIGURED" });
        throw error;
      }
      let validFile = false;
      try {
        validFile = statSync(filename).isFile();
      } catch {}
      if (!validFile) {
        const error = new Error(
          `Custom sound file is not readable: ${filename}`,
        );
        Object.assign(error, { code: "CUSTOM_SOUND_UNAVAILABLE" });
        throw error;
      }
      return filename;
    }
    const volume = Math.round(
      Math.max(0, Math.min(100, this.options.masterVolume)),
    );
    const filename = join(
      this.options.assetDirectory,
      `${sound}-${volume}.wav`,
    );
    mkdirSync(this.options.assetDirectory, { recursive: true });
    try {
      writeFileSync(
        filename,
        synthesizeWave(soundPatterns[sound as AudioSound], volume),
        {
          flag: "wx",
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return filename;
  }

  private run(
    backend: Exclude<AudioBackend, "auto">,
    filename: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortedError());
    const { command, args } = audioCommand(
      backend,
      this.options.outputDevice,
      filename,
    );
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        child.kill("SIGTERM");
        finish(abortedError());
      };
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        const error = new Error("Local audio playback timed out");
        Object.assign(error, { code: "TIMEOUT" });
        finish(error);
      }, this.options.timeoutSeconds * 1000);
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => finish(error));
      child.once("exit", (code, childSignal) => {
        if (code === 0) finish();
        else {
          const error = new Error(
            `Local audio player exited with ${childSignal ?? `code ${code ?? "unknown"}`}`,
          );
          Object.assign(error, { code: "PLAYER_EXIT" });
          finish(error);
        }
      });
    });
  }
}

export class HookedAudioPlayer implements AudioPlayer {
  constructor(
    private readonly player: AudioPlayer,
    private readonly options: HookedAudioPlayerOptions,
  ) {}

  async play(
    sound: PlayableAudioSound,
    signal?: AbortSignal,
  ): Promise<{ backend: string }> {
    if (this.options.before) {
      try {
        await runAudioCommand(
          this.options.before,
          this.options.timeoutSeconds,
          signal,
        );
      } catch (error) {
        const message = commandErrorMessage("Before-play", error);
        const wrapped = new Error(message, { cause: error });
        Object.assign(wrapped, { code: "BEFORE_COMMAND_FAILED" });
        throw wrapped;
      }
    }

    try {
      return await this.player.play(sound, signal);
    } finally {
      if (this.options.after) {
        try {
          // Cleanup hooks must still run after a stopped or failed sound.
          await runAudioCommand(
            this.options.after,
            this.options.timeoutSeconds,
          );
        } catch (error) {
          this.options.onCommandError?.(
            "after",
            commandErrorMessage("After-play", error),
          );
        }
      }
    }
  }
}

export function runAudioCommand(
  command: AudioCommand,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.arguments ?? [], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(abortedError());
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error("Configured audio command timed out");
      Object.assign(error, { code: "COMMAND_TIMEOUT" });
      finish(error);
    }, timeoutSeconds * 1000);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, childSignal) => {
      if (code === 0) finish();
      else {
        const error = new Error(
          `Configured audio command exited with ${childSignal ?? `code ${code ?? "unknown"}`}`,
        );
        Object.assign(error, { code: "COMMAND_EXIT" });
        finish(error);
      }
    });
  });
}

function abortedError(): Error {
  const error = new Error("Local audio playback was stopped");
  Object.assign(error, { code: "ABORTED" });
  return error;
}

function commandErrorMessage(stage: string, error: unknown): string {
  return `${stage} command failed: ${error instanceof Error ? error.message : String(error)}`;
}

function synthesizeWave(
  pattern: Array<[number, number]>,
  volumePercent: number,
): Buffer {
  const sampleRate = 44_100;
  const samples = pattern.flatMap(([frequency, seconds]) => {
    const count = Math.round(sampleRate * seconds);
    const amplitude = 0.28 * (volumePercent / 100) * 32_767;
    return Array.from({ length: count }, (_, index) =>
      frequency === 0
        ? 0
        : Math.round(
            amplitude *
              Math.sin((2 * Math.PI * frequency * index) / sampleRate),
          ),
    );
  });
  const dataSize = samples.length * 2;
  const result = Buffer.alloc(44 + dataSize);
  result.write("RIFF", 0);
  result.writeUInt32LE(36 + dataSize, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(dataSize, 40);
  samples.forEach((sample, index) =>
    result.writeInt16LE(sample, 44 + index * 2),
  );
  return result;
}
