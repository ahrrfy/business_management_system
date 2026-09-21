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
const contexts: FakeAudioContext[] = [];
let nextAudioState: AudioContextState = "running";

class FakeAudioParam {
  setValueAtTime(value: number) {
    frequencies.push(value);
  }
  exponentialRampToValueAtTime() {}
}

class FakeAudioContext {
  state: AudioContextState;
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {});

  constructor() {
    this.state = nextAudioState;
    contexts.push(this);
  }

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
    contexts.forEach((context) => {
      context.state = "closed";
    });
    contexts.length = 0;
    nextAudioState = "running";
    frequencies.length = 0;
    vi.restoreAllMocks();
    setAudioFeedbackEnabled(true, null);
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

  it("يحفظ الكتم في الذاكرة عندما يتعذر التخزين المحلي", () => {
    const blockedStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };

    setAudioFeedbackEnabled(false, blockedStorage);

    expect(isAudioFeedbackEnabled(blockedStorage)).toBe(false);
    expect(isAudioFeedbackEnabled(null)).toBe(false);
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

  it("يستخدم ساعةً رتيبةً فلا يكتم الصوت عند رجوع ساعة النظام", () => {
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000);

    expect(playAudioFeedback("warning")).toBe(true);
    vi.setSystemTime(new Date(0));
    expect(playAudioFeedback("warning")).toBe(true);
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("يسقط النغمة إذا بقي سياق الصوت معلّقاً", () => {
    nextAudioState = "suspended";

    // نوع غير مستخدم في الاختبارات السابقة لتجنّب تداخل مهلة التهدئة.
    expect(playAudioFeedback("confirm")).toBe(false);
  });
});
