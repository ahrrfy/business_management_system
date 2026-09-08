import { describe, it, expect, vi } from "vitest";
import { playAnnouncementChime, playReadyBeep } from "../notifyBeep";

describe("notifyBeep audio synthesizer contracts", () => {
  it("does not throw when AudioContext is undefined", () => {
    expect(() => playAnnouncementChime("NORMAL")).not.toThrow();
    expect(() => playAnnouncementChime("IMPORTANT")).not.toThrow();
    expect(() => playAnnouncementChime("CRITICAL")).not.toThrow();
    expect(() => playReadyBeep()).not.toThrow();
  });

  it("synthesizes multi-tone chime when AudioContext is present", () => {
    const createdOscillators: Array<{
      frequency: { value: number };
      type: string;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }> = [];

    const mockCtx = {
      currentTime: 0,
      createOscillator: vi.fn(() => {
        const osc = {
          frequency: { value: 0 },
          type: "sine",
          connect: vi.fn().mockReturnThis(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        createdOscillators.push(osc);
        return osc;
      }),
      createGain: vi.fn(() => ({
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn().mockReturnThis(),
      })),
      destination: {},
      close: vi.fn(),
    };

    const originalAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    // Vitest 4 invokes constructor mocks with `new`; a regular function keeps
    // this browser API double constructable (an arrow function is not).
    (globalThis as unknown as { AudioContext?: unknown }).AudioContext = vi.fn(
      function MockAudioContext() {
        return mockCtx;
      },
    );

    try {
      playAnnouncementChime("CRITICAL");
      expect(mockCtx.createOscillator).toHaveBeenCalledTimes(3);
      expect(createdOscillators[0].frequency.value).toBeCloseTo(523.25);
      expect(createdOscillators[1].frequency.value).toBeCloseTo(659.25);
      expect(createdOscillators[2].frequency.value).toBeCloseTo(783.99);

      createdOscillators.length = 0;
      mockCtx.createOscillator.mockClear();

      playAnnouncementChime("IMPORTANT");
      expect(mockCtx.createOscillator).toHaveBeenCalledTimes(2);

      createdOscillators.length = 0;
      mockCtx.createOscillator.mockClear();

      playAnnouncementChime("NORMAL");
      expect(mockCtx.createOscillator).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as unknown as { AudioContext?: unknown }).AudioContext = originalAudioContext;
    }
  });
});
