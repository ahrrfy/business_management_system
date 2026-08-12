import { describe, expect, it } from "vitest";
import { buildAttendanceNotification } from "../hrDevices/attendanceNotification";

describe("physical attendance notification contract", () => {
  it("builds a safe check-in summary and hides workplace by default", () => {
    const value = buildAttendanceNotification({
      employeeId: 91,
      attendanceDate: "2026-08-08",
      movement: "ATTENDANCE_CHECK_IN",
      clock: "08:05",
      needsReview: false,
      branchName: "فرع الكرادة",
      deviceName: "جهاز البوابة",
    });
    expect(value).toMatchObject({
      eventKey: "attendance:91:2026-08-08:ATTENDANCE_CHECK_IN",
      title: "تم تسجيل الحضور",
      body: "08:05 • مسجّل",
      requiresAction: false,
    });
    expect(value.body).not.toContain("الكرادة");
    expect(value.body).not.toContain("البوابة");
  });

  it("includes only explicitly allowed, bounded workplace labels", () => {
    const value = buildAttendanceNotification({
      employeeId: 91,
      attendanceDate: "2026-08-08",
      movement: "ATTENDANCE_CHECK_OUT",
      clock: "16:42",
      needsReview: true,
      branchName: "  الرئيسي\n ",
      deviceName: `البوابة ${"س".repeat(80)}`,
      includeWorkplace: true,
    });
    expect(value.title).toBe("تم تسجيل الانصراف");
    expect(value.body).toContain("16:42 • بانتظار المراجعة • الرئيسي • البوابة");
    expect(value.body.length).toBeLessThanOrEqual(180);
    expect(value.body).not.toContain("\n");
  });

  it("rejects malformed dates and times before creating an event key", () => {
    expect(() =>
      buildAttendanceNotification({
        employeeId: 91,
        attendanceDate: "08/08/2026",
        movement: "ATTENDANCE_CHECK_IN",
        clock: "8:5",
        needsReview: false,
      }),
    ).toThrow("INVALID_ATTENDANCE_DATE");
  });
});
