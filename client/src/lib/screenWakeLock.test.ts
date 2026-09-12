import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isWakeLockSupported,
  requestScreenWakeLock,
  releaseScreenWakeLock,
} from "./screenWakeLock";

describe("screenWakeLock", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    await releaseScreenWakeLock();
    vi.unstubAllGlobals();
  });

  it("كشف دعم قفل الاستيقاظ في المتصفح بشكل صحيح", () => {
    vi.stubGlobal("navigator", { wakeLock: {} });
    expect(isWakeLockSupported()).toBe(true);

    vi.stubGlobal("navigator", {});
    expect(isWakeLockSupported()).toBe(false);
  });

  it("طلب وتفعيل قفل الاستيقاظ بنجاح عند توفر الواجهة", async () => {
    const mockSentinel = {
      released: false,
      release: vi.fn().mockImplementation(async () => {
        mockSentinel.released = true;
      }),
      addEventListener: vi.fn(),
    };

    const requestMock = vi.fn().mockResolvedValue(mockSentinel);

    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(() => ({ fillRect: vi.fn() })),
        captureStream: vi.fn(() => ({})),
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        setAttribute: vi.fn(),
        style: {},
      })),
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    vi.stubGlobal("navigator", {
      wakeLock: {
        request: requestMock,
      },
    });

    const result = await requestScreenWakeLock();
    expect(result).toBe(true);
    expect(requestMock).toHaveBeenCalledWith("screen");

    // تحرير القفل
    await releaseScreenWakeLock();
    expect(mockSentinel.release).toHaveBeenCalled();
  });

  it("التعامل بأمان مع رفض أو استثناء قفل الاستيقاظ دون انهيار التطبيق", async () => {
    const requestMock = vi.fn().mockRejectedValue(new Error("NotAllowedError"));

    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(() => ({ fillRect: vi.fn() })),
        captureStream: vi.fn(() => null),
      })),
      body: {
        appendChild: vi.fn(),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    vi.stubGlobal("navigator", {
      wakeLock: {
        request: requestMock,
      },
    });

    const result = await requestScreenWakeLock();
    expect(result).toBe(false);
  });
});
