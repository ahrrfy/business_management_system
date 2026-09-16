import { describe, expect, it } from "vitest";
import {
  computeOrderLifecycleTiming,
  deriveOrderStoppedAt,
  formatOrderDuration,
  parseDateSafe,
} from "./workOrderTimer";

describe("workOrderTimer — تنسيق المدة بالعربية الموجزة", () => {
  it("أقل من دقيقة أو صفر", () => {
    expect(formatOrderDuration(0)).toBe("0د");
  });

  it("أقل من ساعة بالدقائق الصرفة", () => {
    expect(formatOrderDuration(15)).toBe("15د");
    expect(formatOrderDuration(59)).toBe("59د");
  });

  it("ساعات كاملة", () => {
    expect(formatOrderDuration(60)).toBe("1س");
    expect(formatOrderDuration(120)).toBe("2س");
  });

  it("ساعات ودقائق", () => {
    expect(formatOrderDuration(90)).toBe("1س 30د");
    expect(formatOrderDuration(145)).toBe("2س 25د");
  });

  it("أيام كاملة", () => {
    expect(formatOrderDuration(1440)).toBe("1ي");
    expect(formatOrderDuration(2880)).toBe("2ي");
  });

  it("أيام وساعات متبقية", () => {
    expect(formatOrderDuration(1500)).toBe("1ي 1س");
    expect(formatOrderDuration(2940)).toBe("2ي 1س");
  });

  it("قيمة غير معرفة أو فارغة", () => {
    expect(formatOrderDuration(null)).toBe("—");
    expect(formatOrderDuration(-5)).toBe("—");
  });
});

describe("workOrderTimer — اشتقاق لحظة التوقف deriveOrderStoppedAt", () => {
  it("يشتق لحظة الجاهزية من workStartedAt + workSeconds", () => {
    const started = new Date("2026-09-13T10:00:00.000Z");
    const stopped = deriveOrderStoppedAt({
      workStartedAt: started,
      workSeconds: 3600, // ساعة
    });
    expect(stopped?.toISOString()).toBe("2026-09-13T11:00:00.000Z");
  });

  it("يسقط على deliveredAt أو updatedAt حين يغيب workStartedAt", () => {
    const delivered = new Date("2026-09-13T12:00:00.000Z");
    const stopped = deriveOrderStoppedAt({
      workStartedAt: null,
      workSeconds: null,
      deliveredAt: delivered,
    });
    expect(stopped?.toISOString()).toBe("2026-09-13T12:00:00.000Z");
  });
});

describe("workOrderTimer — حساب دورة حياة المؤقت computeOrderLifecycleTiming", () => {
  const baseCreated = new Date("2026-09-13T08:00:00.000Z");

  it("طلب بلا تاريخ إنشاء يعود كـ UNKNOWN", () => {
    const r = computeOrderLifecycleTiming({ status: "RECEIVED", createdAt: null });
    expect(r.state).toBe("UNKNOWN");
    expect(r.formattedDuration).toBe("—");
  });

  it("طلب في مرحلة «مُستلَم» RECEIVED — العداد نشط RUNNING", () => {
    const now = new Date("2026-09-13T08:45:00.000Z"); // بعد 45 دقيقة
    const r = computeOrderLifecycleTiming({ status: "RECEIVED", createdAt: baseCreated }, now);
    expect(r.state).toBe("RUNNING");
    expect(r.durationMinutes).toBe(45);
    expect(r.formattedDuration).toBe("45د");
    expect(r.badgeLabel).toBe("45د");
    expect(r.tooltip).toContain("العداد نشط");
  });

  it("طلب في مرحلة «قيد التنفيذ» IN_PROGRESS — العداد نشط RUNNING", () => {
    const now = new Date("2026-09-13T09:30:00.000Z"); // بعد ساعة ونصف
    const r = computeOrderLifecycleTiming({
      status: "IN_PROGRESS",
      createdAt: baseCreated,
      workStartedAt: new Date("2026-09-13T08:30:00.000Z"),
    }, now);
    expect(r.state).toBe("RUNNING");
    expect(r.durationMinutes).toBe(90);
    expect(r.formattedDuration).toBe("1س 30د");
    expect(r.badgeLabel).toBe("1س 30د");
  });

  it("طلب وصل إلى «جاهز للتسليم» READY — العداد يتوقف STOPPED عند لحظة الجاهزية", () => {
    const workStartedAt = new Date("2026-09-13T08:15:00.000Z");
    const workSeconds = 2700; // 45 دقيقة تنفيذ
    // لحظة الجاهزية المشتقة: 08:15 + 45د = 09:00 (بعد ساعة من الاستلام)
    // حتى لو كانت الساعة الحالية 12:00 ظهراً، العداد يجب أن يتوقف عند 09:00 (ساعة واحدة)
    const now = new Date("2026-09-13T12:00:00.000Z");

    const r = computeOrderLifecycleTiming({
      status: "READY",
      createdAt: baseCreated,
      workStartedAt,
      workSeconds,
    }, now);

    expect(r.state).toBe("STOPPED");
    expect(r.durationMinutes).toBe(60); // ساعة واحدة من 08:00 إلى 09:00
    expect(r.formattedDuration).toBe("1س");
    expect(r.badgeLabel).toBe("استغرق: 1س");
    expect(r.tooltip).toContain("توقف العداد عند الجاهزية للتسليم");
  });

  it("طلب مسلَّم DELIVERED — العداد متوقف STOPPED", () => {
    const deliveredAt = new Date("2026-09-13T10:00:00.000Z"); // بعد ساعتين
    const now = new Date("2026-09-13T15:00:00.000Z");

    const r = computeOrderLifecycleTiming({
      status: "DELIVERED",
      createdAt: baseCreated,
      deliveredAt,
    }, now);

    expect(r.state).toBe("STOPPED");
    expect(r.durationMinutes).toBe(120);
    expect(r.badgeLabel).toBe("استغرق: 2س");
  });
});
