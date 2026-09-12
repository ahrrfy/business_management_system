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

  it("تسلسل وإعادة استخدام الطلبات المتزامنة In-Flight Request Serialization", async () => {
    let resolveLock: (val: any) => void;
    const pendingPromise = new Promise((resolve) => {
      resolveLock = resolve;
    });

    const mockSentinel = {
      released: false,
      release: vi.fn().mockImplementation(async () => {
        mockSentinel.released = true;
      }),
      addEventListener: vi.fn(),
    };

    const requestMock = vi.fn().mockImplementation(() => pendingPromise);

    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(() => ({ fillRect: vi.fn() })),
        captureStream: vi.fn(() => ({})),
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        setAttribute: vi.fn(),
        style: {},
      })),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    vi.stubGlobal("navigator", {
      wakeLock: {
        request: requestMock,
      },
    });

    // استدعاءان متزامنان
    const p1 = requestScreenWakeLock();
    const p2 = requestScreenWakeLock();

    // التأكد من أن wakeLock.request لم يُستدعَ إلا مرة واحدة
    expect(requestMock).toHaveBeenCalledTimes(1);

    resolveLock!(mockSentinel);
    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1).toBe(true);
    expect(res2).toBe(true);

    await releaseScreenWakeLock();
    expect(mockSentinel.release).toHaveBeenCalled();
  });

  it("الإبلاغ عن الفشل بدقة عند رفض المتصفح لكل من WakeLock والفيديو التلقائي", async () => {
    vi.stubGlobal("navigator", {}); // لا يدعم wakeLock

    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(() => ({ fillRect: vi.fn() })),
        captureStream: vi.fn(() => ({})),
        play: vi.fn().mockRejectedValue(new Error("AutoplayDenied")),
        pause: vi.fn(),
        setAttribute: vi.fn(),
        style: {},
      })),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const result = await requestScreenWakeLock();
    expect(result).toBe(false);
  });
});
