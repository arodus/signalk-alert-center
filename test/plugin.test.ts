import { ServerAPI } from "@signalk/server-api";
import { describe, expect, it, vi } from "vitest";
import { CommandAudioPlayer } from "../src/audio/player";
import persistentNotifier from "../src/plugin";

describe("plugin one-shot maintenance actions", () => {
  it("plays a safe test sound and clears the checkbox before restart", async () => {
    const play = vi
      .spyOn(CommandAudioPlayer.prototype, "play")
      .mockResolvedValue({ backend: "fake" });
    const restart = vi.fn();
    const app = {
      debug: vi.fn(),
      error: vi.fn(),
      getDataDirPath: () => "/tmp/signalk-audio-test",
    } as unknown as ServerAPI;
    const plugin = persistentNotifier(app);

    plugin.start?.(
      {
        audio: {
          testSoundOnSave: true,
          backend: "auto",
          masterVolume: 60,
        },
      },
      restart,
    );

    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
    expect(play).toHaveBeenCalledWith("chime");
    expect(restart).toHaveBeenCalledWith({
      audio: {
        testSoundOnSave: false,
        backend: "auto",
        masterVolume: 60,
      },
    });
  });
});
