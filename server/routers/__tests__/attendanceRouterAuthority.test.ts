import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * updateSettings يبوّب عمداً على settings/FULL لا hr/FULL (attendanceRouter.ts:65) — قرارٌ
 * موثَّق في الكود: مدير الفرع يملك hr=FULL فيكتب حضور موظّفيه، لكن هذا المفتاح شركيّ (يشمل
 * كل الفروع: تفعيل الأجر بالحضور، سقف الساعة اليومية، الوردية الليلية) فيُقصَر على الأدمن
 * (settings=FULL) وحده — manager=READ في خريطة الصلاحيات. بلا اختبارٍ سلوكيّ، تبديل هذا
 * السطر إلى hrWrite لا يُسقط أيّ اختبار قائم فيمنح كل مدير فرعٍ سلطة قلب سياسة الأجر لكل
 * الشركة بضغطة زر.
 */
const mocks = vi.hoisted(() => ({
  updateAttendanceSettings: vi.fn(async () => ({
    id: 1,
    attendancePayEnabled: true,
    attendancePayFrom: "2026-01-01",
    maxDailyHours: 12,
    nightShiftEnabled: false,
    nightShiftCutoffHour: 0,
  })),
  audit: vi.fn(async () => undefined),
}));

vi.mock("../../services/attendanceService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/attendanceService")>()),
  updateAttendanceSettings: mocks.updateAttendanceSettings,
}));
vi.mock("../../services/auditService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/auditService")>()),
  logAudit: mocks.audit,
}));

import { attendanceRouter } from "../attendanceRouter";

function caller(user: { id: number; role: string; branchId: number | null; isOwner?: boolean }) {
  return attendanceRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: { ...user, totpEnabledAt: new Date() },
  } as never);
}

describe("attendanceRouter.updateSettings — سياسة أجرٍ شركيّة تُقصَر على الأدمن", () => {
  beforeEach(() => vi.clearAllMocks());

  it("مدير الفرع (hr=FULL لكن settings=READ) يُرفض ولا يبلغ الخدمة", async () => {
    const manager = caller({ id: 7, role: "manager", branchId: 3 });
    await expect(
      manager.updateSettings({ attendancePayEnabled: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateAttendanceSettings).not.toHaveBeenCalled();
  });

  it("الأدمن (settings=FULL) يعدّل السياسة وتُدقَّق العملية", async () => {
    const admin = caller({ id: 1, role: "admin", branchId: null });
    await admin.updateSettings({ attendancePayEnabled: true, maxDailyHours: 10 });
    expect(mocks.updateAttendanceSettings).toHaveBeenCalledWith(
      { attendancePayEnabled: true, maxDailyHours: 10 },
      1,
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "attendance.updateSettings" }),
    );
  });

  it("كاشير (hr=NONE) يُرفض قبل بوّابة settings أصلاً", async () => {
    const cashier = caller({ id: 9, role: "cashier", branchId: 3 });
    await expect(
      cashier.updateSettings({ attendancePayEnabled: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateAttendanceSettings).not.toHaveBeenCalled();
  });
});
