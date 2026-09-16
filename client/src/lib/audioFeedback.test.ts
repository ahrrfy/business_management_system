// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_FEEDBACK_CHANGE_EVENT,
  AUDIO_FEEDBACK_STORAGE_KEY,
  installGlobalInteractionAudio,
  isAudioFeedbackEnabled,
  playAudioFeedback,
  setAudioFeedbackEnabled,
} from "./audioFeedback";

const frequencies: number[] = [];

class FakeAudioParam {
  setValueAtTime(value: number) {
    frequencies.push(value);
  }
  exponentialRampToValueAtTime() {}
}

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {});

  createOscillator() {
    return {
      type: "sine" as OscillatorType,
      frequency: new FakeAudioParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
  }

  createGain() {
    return {
      gain: new FakeAudioParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
}

describe("audioFeedback", () => {
  beforeEach(() => {
    frequencies.length = 0;
    localStorage.clear();
    document.body.innerHTML = "";
    vi.setSystemTime(new Date(Date.now() + 1_000));
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
  });

  it("يبدأ مفعّلاً ويحفظ الكتم محلياً ويبثّ تغيّر التفضيل", () => {
    const changed = vi.fn();
    window.addEventListener(AUDIO_FEEDBACK_CHANGE_EVENT, changed, {
      once: true,
    });

    expect(isAudioFeedbackEnabled()).toBe(true);
    setAudioFeedbackEnabled(false);

    expect(localStorage.getItem(AUDIO_FEEDBACK_STORAGE_KEY)).toBe("0");
    expect(isAudioFeedbackEnabled()).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("يكتم التوليد فعلياً ولا يكتفي بتغيير شكل زر الإعداد", () => {
    setAudioFeedbackEnabled(false);
    expect(playAudioFeedback("scan")).toBe(false);
    expect(frequencies).toEqual([]);
  });

  it("يولّد صفير مسح منفرداً ونجاحاً صاعداً بنغمتين", () => {
    expect(playAudioFeedback("scan")).toBe(true);
    expect(frequencies).toContain(1_080);

    frequencies.length = 0;
    expect(playAudioFeedback("success")).toBe(true);
    expect(frequencies).toEqual(expect.arrayContaining([660, 880]));
  });

  it("يصوّت العناصر التفاعلية ويحترم data-audio-feedback=none", () => {
    const cleanup = installGlobalInteractionAudio();
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.click();
    expect(frequencies).toContain(540);

    frequencies.length = 0;
    button.dataset.audioFeedback = "none";
    button.click();
    expect(frequencies).toEqual([]);
    cleanup();
  });
});
