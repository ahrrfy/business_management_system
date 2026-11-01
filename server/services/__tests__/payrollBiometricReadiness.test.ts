import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getBiometricPayrollReadiness } from "../payroll/biometricReadiness";

const OWNER = { userId: 1, branchId: 1, isOwner: true, role: "admin" };
const MANAGER = { userId: 2, branchId: 1, role: "manager" };
function db() {
  const database = getDb();
  if (!database) throw new Error("Test database is missing");
  return database;
}

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.employees)
    .values([
      {
        id: 10,
        branchId: 1,
        firstName: "علي",
        fatherName: "أحمد",
        lastName: "الجبوري",
        payType: "hourly",
      },
      {
        id: 20,
        branchId: 2,
        firstName: "زين",
        lastName: "محمد",
        payType: "hourly",
      },
    ]);
  await db()
    .insert(s.hrFingerprintDevices)
    .values([
      {
        id: 1,
        name: "جهاز الرئيسي",
        serialNumber: "READINESS-1",
        branchId: 1,
        enabled: true,
        status: "online",
      },
      {
        id: 2,
        name: "جهاز المبيعات",
        serialNumber: "READINESS-2",
        branchId: 2,
        enabled: true,
        status: "offline",
      },
    ]);
});

describe("payroll biometric readiness details and scope", () => {
  it("counts only the selected wall-clock month and scopes mapped/unmapped punches to the authorized branch", async () => {
    await db()
      .insert(s.hrAttendancePunches)
      .values([
        {
          serialNumber: "READINESS-2",
          enrollId: 10,
          deviceId: 2,
          employeeId: 10,
          punchAt: "2026-10-01 00:00:00",
        },
        {
          serialNumber: "READINESS-1",
          enrollId: 10,
          deviceId: 1,
          employeeId: 10,
          punchAt: "2026-10-31 23:59:59",
        },
        {
          serialNumber: "READINESS-1",
          enrollId: 10,
          deviceId: 1,
          employeeId: 10,
          punchAt: "2026-11-01 00:00:00",
        },
        {
          serialNumber: "READINESS-1",
          enrollId: 10,
          deviceId: 1,
          employeeId: 10,
          punchAt: "2026-09-30 23:59:59",
        },
        {
          serialNumber: "READINESS-1",
          enrollId: 99,
          deviceId: 1,
          employeeId: null,
          punchAt: "2026-10-02 08:00:00",
        },
        {
          serialNumber: "READINESS-2",
          enrollId: 99,
          deviceId: 2,
          employeeId: null,
          punchAt: "2026-10-02 08:00:00",
          processedAt: new Date("2026-10-02T08:01:00Z"),
        },
        {
          serialNumber: "READINESS-1",
          enrollId: 20,
          deviceId: 1,
          employeeId: 20,
          punchAt: "2026-10-03 08:00:00",
        },
        {
          serialNumber: "UNSCOPED",
          enrollId: 99,
          deviceId: null,
          employeeId: null,
          punchAt: "2026-10-04 08:00:00",
        },
      ]);
    const manager = await getBiometricPayrollReadiness("2026-10", MANAGER);
    expect(manager.pendingPunchesCount).toBe(3);
    expect(manager.unmappedPunchesCount).toBe(1);
    expect(manager.totalDevicesCount).toBe(1);
    expect(manager.connectedDevicesCount).toBe(1);

    const owner = await getBiometricPayrollReadiness("2026-10", OWNER);
    expect(owner.pendingPunchesCount).toBe(5);
    expect(owner.unmappedPunchesCount).toBe(3);
    expect(owner.totalDevicesCount).toBe(2);
  });

  it("returns full employee names and every open date, including an unclosed second work session", async () => {
    await db()
      .insert(s.attendance)
      .values([
        {
          id: 1,
          employeeId: 10,
          branchId: 1,
          attendanceDate: "2026-10-04",
          checkIn: new Date("2026-10-04T08:00:00Z"),
          checkOut: null,
          hours: "0.00",
          status: "PRESENT",
        },
        {
          id: 2,
          employeeId: 10,
          branchId: 1,
          attendanceDate: "2026-10-06",
          checkIn: new Date("2026-10-06T08:00:00Z"),
          checkOut: new Date("2026-10-06T12:00:00Z"),
          hours: "4.00",
          status: "LATE",
          needsReview: true,
          reviewReason: "فترة دوام مفتوحة",
          notes: "[فترات الدوام: 08:00-12:00، 13:00-؟]",
        },
        {
          id: 3,
          employeeId: 20,
          branchId: 2,
          attendanceDate: "2026-10-20",
          checkIn: new Date("2026-10-20T08:00:00Z"),
          checkOut: null,
          hours: "0.00",
          status: "PRESENT",
        },
        {
          id: 4,
          employeeId: 10,
          branchId: 1,
          attendanceDate: "2026-09-30",
          checkIn: new Date("2026-09-30T08:00:00Z"),
          checkOut: null,
          hours: "0.00",
          status: "PRESENT",
        },
        {
          id: 5,
          employeeId: 10,
          branchId: 1,
          attendanceDate: "2026-10-10",
          checkIn: new Date("2026-10-10T08:00:00Z"),
          checkOut: new Date("2026-10-10T14:00:00Z"),
          hours: "6.00",
          status: "PRESENT",
          needsReview: true,
          reviewReason: "تجاوز الحد اليومي",
        },
        // Positive manually recorded hours are accepted by the payroll engine even without checkOut.
        {
          id: 6,
          employeeId: 10,
          branchId: 1,
          attendanceDate: "2026-10-12",
          checkIn: new Date("2026-10-12T08:00:00Z"),
          checkOut: null,
          hours: "4.00",
          status: "PRESENT",
          source: "manual",
        },
      ]);
    const owner = await getBiometricPayrollReadiness("2026-10", OWNER);
    expect(owner.openDaysCount).toBe(3);
    expect(owner.openEmployeesCount).toBe(2);
    expect(owner.openDays).toEqual([
      {
        attendanceId: 1,
        employeeId: 10,
        employeeName: "علي أحمد الجبوري",
        date: "2026-10-04",
        reason: "دخول بلا انصراف",
      },
      {
        attendanceId: 2,
        employeeId: 10,
        employeeName: "علي أحمد الجبوري",
        date: "2026-10-06",
        reason: "فترة دوام مفتوحة بلا انصراف",
      },
      {
        attendanceId: 3,
        employeeId: 20,
        employeeName: "زين محمد",
        date: "2026-10-20",
        reason: "دخول بلا انصراف",
      },
    ]);
    const manager = await getBiometricPayrollReadiness("2026-10", MANAGER);
    expect(manager.openDaysCount).toBe(2);
    expect(manager.openEmployeesCount).toBe(1);
    expect(manager.openDays.map((day) => day.employeeId)).toEqual([10, 10]);
  });

  it("does not call a month unready because a different month has pending punches", async () => {
    await db()
      .insert(s.hrAttendancePunches)
      .values({
        serialNumber: "READINESS-1",
        enrollId: 10,
        deviceId: 1,
        employeeId: 10,
        punchAt: "2026-09-30 08:00:00",
      });
    const readiness = await getBiometricPayrollReadiness("2026-10", OWNER);
    expect(readiness).toMatchObject({
      ready: true,
      pendingPunchesCount: 0,
      unmappedPunchesCount: 0,
      openDaysCount: 0,
      openEmployeesCount: 0,
      openDays: [],
    });
  });

  it("rejects a branchless non-owner instead of leaking other employees", async () => {
    await expect(
      getBiometricPayrollReadiness("2026-10", {
        userId: 2,
        role: "manager",
        branchId: 0,
      }),
    ).rejects.toThrow();
  });
});
