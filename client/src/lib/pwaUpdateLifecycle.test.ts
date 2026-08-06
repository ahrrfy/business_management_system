import { describe, expect, it } from "vitest";
import { decidePwaUpdateAction } from "./pwaUpdateLifecycle";

describe("PWA update lifecycle", () => {
  it("يفعّل العامل المنتظر عندما يبقى التحديث في waiting", () => {
    expect(decidePwaUpdateAction({
      hasRegistration: true,
      hasWaitingWorker: true,
      hasActiveWorker: true,
      updateWasSignaled: true,
    })).toBe("ACTIVATE_WAITING");
  });

  it("يعيد التحميل عندما أُعلن التحديث لكنه أصبح active بلا waiting", () => {
    expect(decidePwaUpdateAction({
      hasRegistration: true,
      hasWaitingWorker: false,
      hasActiveWorker: true,
      updateWasSignaled: true,
    })).toBe("RELOAD_ACTIVE");
  });

  it("لا يعيد تحميل صفحة بلا إشارة تحديث لمجرد وجود العامل الفعّال", () => {
    expect(decidePwaUpdateAction({
      hasRegistration: true,
      hasWaitingWorker: false,
      hasActiveWorker: true,
      updateWasSignaled: false,
    })).toBe("CHECK_AGAIN");
  });

  it("يفشل بوضوح عندما لا يوجد تسجيل Service Worker", () => {
    expect(decidePwaUpdateAction({
      hasRegistration: false,
      hasWaitingWorker: false,
      hasActiveWorker: false,
      updateWasSignaled: true,
    })).toBe("UNAVAILABLE");
  });
});
