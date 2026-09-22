// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    promise: vi.fn(),
  });
  return { toast, playAudioFeedback: vi.fn() };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/audioFeedback", () => ({
  playAudioFeedback: mocks.playAudioFeedback,
}));

import { notify } from "./notify";

describe("notify audio routing", () => {
  beforeEach(() => {
    mocks.toast.mockClear();
    mocks.toast.success.mockClear();
    mocks.toast.error.mockClear();
    mocks.toast.warning.mockClear();
    mocks.toast.promise.mockClear();
    mocks.playAudioFeedback.mockClear();
  });

  it("يربط دلالة التنبيه بالنغمة المطابقة", () => {
    notify.ok("تم");
    notify.err("فشل");
    notify.warn("انتبه");
    notify.info("معلومة");

    expect(mocks.playAudioFeedback.mock.calls.map(([kind]) => kind)).toEqual([
      "success",
      "error",
      "warning",
      "notification",
    ]);
  });

  it("لا يصوّت الوعد عند التحميل ويصوّت نتيجته النهائية", async () => {
    const operation = Promise.resolve("ok");
    notify.promise(operation, { loading: "تحميل", success: "تم" });

    expect(mocks.playAudioFeedback).not.toHaveBeenCalled();
    await operation;
    await Promise.resolve();
    expect(mocks.playAudioFeedback).toHaveBeenCalledWith("success");
  });
});
