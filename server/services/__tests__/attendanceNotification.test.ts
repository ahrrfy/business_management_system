import { describe, expect, it } from "vitest";
import {
  buildAttendanceNotification,
  buildAttendanceSupervisorNotification,
} from "../hrDevices/attendanceNotification";
import { selectAttendanceSupervisorRecipientIds } from "../hrDevices/attendanceRecipients";

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

  it("builds the explicit supervisor message with employee identity and a per-recipient key", () => {
    const value = buildAttendanceSupervisorNotification({
      recipientUserId: 22,
      employeeId: 91,
      employeeName: "  أحمد\nعلي الجبوري  ",
      attendanceDate: "2026-08-08",
      movement: "ATTENDANCE_CHECK_IN",
      clock: "08:05",
      needsReview: false,
      branchName: "فرع الكرادة",
      deviceName: "جهاز البوابة",
    });
    expect(value).toEqual({
      eventKey: "attendance:supervisor:22:91:2026-08-08:ATTENDANCE_CHECK_IN",
      title: "أحمد علي الجبوري سجّل الحضور",
      body: "08:05 • فرع الكرادة • جهاز البوابة",
      requiresAction: false,
    });
  });

  it("selects only active HR supervisors in the employee branch while owners cross branches", () => {
    const now = new Date("2026-08-08T08:00:00.000Z");
    const base = {
      role: "manager" as const,
      isOwner: false,
      isActive: true,
      accessExpiresAt: null,
      permissionsOverride: null,
      customRoleId: null,
      customRoleBaseRole: null,
      customRolePermissions: null,
    };
    const recipients = selectAttendanceSupervisorRecipientIds(
      [
        { ...base, id: 10, branchId: 1 },
        { ...base, id: 11, branchId: 2 },
        { ...base, id: 12, branchId: 1, permissionsOverride: { hr: "NONE" as const } },
        { ...base, id: 13, branchId: 1, isActive: false },
        { ...base, id: 14, branchId: 1, accessExpiresAt: new Date("2026-08-08T07:59:59.000Z") },
        { ...base, id: 15, branchId: 1 },
        { ...base, id: 16, branchId: null, role: "user" as const, isOwner: true },
        {
          ...base,
          id: 17,
          branchId: 1,
          customRoleId: 7,
          customRoleBaseRole: "manager" as const,
          customRolePermissions: { hr: "NONE" as const },
        },
        {
          ...base,
          id: 18,
          branchId: 1,
          customRoleId: 8,
          customRoleBaseRole: null,
          customRolePermissions: null,
        },
      ],
      { employeeUserId: 15, branchId: 1, now },
    );
    expect(recipients).toEqual([10, 16]);
  });
});
