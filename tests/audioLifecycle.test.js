import { describe, expect, it, vi } from "vitest";
import { Audio } from "../src/game/Audio.js";

function harness() {
  const audio = new Audio();
  const menu = { play: vi.fn(() => Promise.resolve()), pause: vi.fn() };
  const level = { play: vi.fn(() => Promise.resolve()), pause: vi.fn() };
  audio.ctx = {
    state: "running",
    suspend: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
  };
  audio._ambientEls = {
    menu: { el: menu, gain: {} },
    level: { el: level, gain: {} },
  };
  audio._ambientPhase = "LEVEL";
  audio._startDrum = vi.fn();
  return { audio, menu, level };
}

describe("Audio app lifecycle", () => {
  it("pauses streamed music and suspends Web Audio in the background", async () => {
    const { audio, menu, level } = harness();

    await audio.setBackgrounded(true);

    expect(menu.pause).toHaveBeenCalledOnce();
    expect(level.pause).toHaveBeenCalledOnce();
    expect(audio.ctx.suspend).toHaveBeenCalledOnce();
    expect(audio._ok()).toBe(false);
  });

  it("remembers phase changes while hidden and restores only that ambience", async () => {
    const { audio, menu, level } = harness();
    await audio.setBackgrounded(true);
    audio.setAmbient("HUB");

    await audio.setBackgrounded(false);

    expect(audio.ctx.resume).toHaveBeenCalledOnce();
    expect(menu.play).toHaveBeenCalledOnce();
    expect(level.play).not.toHaveBeenCalled();
  });
});
