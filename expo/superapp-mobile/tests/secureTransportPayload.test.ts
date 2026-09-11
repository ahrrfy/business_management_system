import { describe, expect, it } from "vitest";

import {
  parseMobileAttendanceHistory,
  parseMobileCommandCenter,
  parseMobileExpoPushCommand,
  parseMobileExpoPushStatus,
  parseMobileLeaveCommand,
  parseMobilePayslip,
  parseMobileTaskCommand,
  parseMobileToday,
  parseNativeLoginResult,
} from "../lib/secureTransportPayload";

describe("native transport payload boundary", () => {
  it("keeps only the explicitly approved personal fields", () => {
    const result = parseMobileToday(JSON.stringify({
      date: "2026-09-10",
      navigation: { ownerCenter: false, personal: true, work: true },
      personal: {
        state: "READY",
        employee: { displayName: "موظف", position: "محاسب", department: null },
        attendance: { state: "CHECKED_IN", checkIn: "2026-09-10T06:00:00.000Z", checkOut: null, action: { destination: "SELF_ATTENDANCE", requiresStepUp: false } },
        focus: null,
        leave: null,
        payroll: { period: "2026-09", status: "paid", gross: 9999999, action: { destination: "SELF_PAYROLL", requiresStepUp: true } },
      },
    }));

    expect(result.personal.payroll).toEqual({
      period: "2026-09",
      status: "paid",
      action: { destination: "SELF_PAYROLL", requiresStepUp: true },
    });
    expect(result.navigation).toEqual({ ownerCenter: false, personal: true, work: true });
    expect(JSON.stringify(result)).not.toContain("gross");
  });

  it("rejects a forged destination or malformed two-factor response", () => {
    expect(() => parseMobileToday(JSON.stringify({
      date: "2026-09-10",
      navigation: { ownerCenter: false, personal: true, work: true },
      personal: {
        state: "READY",
        employee: { displayName: "موظف", position: null, department: null },
        attendance: null,
        focus: null,
        leave: null,
        payroll: { period: "2026-09", status: "paid", action: { destination: "ADMIN_PAYROLL", requiresStepUp: false } },
      },
    }))).toThrow("وصلت استجابة غير مكتملة");
    expect(() => parseMobileToday(JSON.stringify({
      date: "2026-09-10",
      navigation: { ownerCenter: false, personal: false, work: true },
      personal: {
        state: "NOT_LINKED",
        employee: null,
        attendance: null,
        focus: null,
        leave: null,
        payroll: null,
      },
    }))).toThrow("وصلت استجابة غير مكتملة");
    expect(() => parseNativeLoginResult(JSON.stringify({ requiresTwoFactor: true, ticket: null }))).toThrow("وصلت استجابة غير مكتملة");
  });

  it("keeps the native owner projection read-only and strips server action arguments", () => {
    const result = parseMobileCommandCenter(JSON.stringify({
      asOf: "2026-09-10T06:00:00.000Z",
      scope: "ALL_BRANCHES",
      health: { status: "ok", partialErrors: [] },
      decisions: [{
        id: "stock-low",
        severity: "warning",
        title: "أصناف قليلة",
        actionLabel: "مراجعة المخزون",
        action: { destinationKey: "PRODUCTS", args: { branchId: 99 } },
      }],
      metrics: {
        lowStockCount: 4,
        overdueReceivables: { count: 2, total: "1200.00" },
        salesToday: { total: "450.00", invoiceCount: 3 },
        treasury: { balance: "780.00", openShiftsCount: 1 },
      },
    }));

    expect(result.decisions[0]).toEqual({
      id: "stock-low",
      severity: "warning",
      title: "أصناف قليلة",
      actionLabel: "مراجعة المخزون",
    });
    expect(JSON.stringify(result)).not.toContain("branchId");
    expect(() => parseMobileCommandCenter(JSON.stringify({
      asOf: "2026-09-10T06:00:00.000Z",
      scope: "ALL_BRANCHES",
      health: { status: "ok", partialErrors: [] },
      decisions: [],
      metrics: { lowStockCount: -1, overdueReceivables: null, salesToday: null, treasury: null },
    }))).toThrow("وصلت استجابة غير مكتملة");
  });

  it("keeps only a bounded personal attendance projection", () => {
    const result = parseMobileAttendanceHistory(JSON.stringify({
      range: { from: "2026-08-11", to: "2026-09-10" },
      personal: {
        state: "READY",
        entries: [{
          date: "2026-09-10",
          checkIn: "2026-09-10T06:00:00.000Z",
          checkOut: null,
          status: "PRESENT",
          hours: "8.00",
          state: "NEEDS_REVIEW",
          employeeId: 999,
          hourlyRate: "10000.00",
          amount: "80000.00",
          notes: "لا تُعرض",
          source: "fingerprint",
        }],
      },
    }));

    expect(result.personal.entries).toEqual([{
      date: "2026-09-10",
      checkIn: "2026-09-10T06:00:00.000Z",
      checkOut: null,
      status: "PRESENT",
      hours: "8.00",
      state: "NEEDS_REVIEW",
    }]);
    expect(JSON.stringify(result)).not.toMatch(/employeeId|hourlyRate|amount|notes|source/);
    expect(() => parseMobileAttendanceHistory(JSON.stringify({
      range: { from: "2026-08-11", to: "2026-09-10" },
      personal: {
        state: "READY",
        entries: [{
          date: "2026-09-11",
          checkIn: null,
          checkOut: null,
          status: "PRESENT",
          hours: "25.00",
          state: "RECORDED",
        }],
      },
    }))).toThrow("وصلت استجابة غير مكتملة");
  });

  it("accepts only the reviewed personal payslip fields after step-up", () => {
    const result = parseMobilePayslip(JSON.stringify({
      personal: {
        state: "READY",
        payslip: {
          period: "2026-09",
          status: "paid",
          paidAt: "2026-09-30T09:00:00.000Z",
          payType: "monthly",
          hours: "176.00",
          gross: "1000000.00",
          allowances: "20000.00",
          overtime: "0.00",
          commission: "0.00",
          deductions: "10000.00",
          advanceDeduction: "0.00",
          socialSecurityEmployee: "0.00",
          incomeTax: "0.00",
          net: "1010000.00",
          payrollItemId: 200,
          branchId: 1,
          note: "HR-only",
          socialSecurityEmployer: "0.00",
        },
      },
    }));

    expect(result.personal.payslip).toEqual(expect.objectContaining({
      period: "2026-09",
      hours: "176.00",
      net: "1010000.00",
    }));
    expect(JSON.stringify(result)).not.toMatch(/payrollItemId|branchId|note|Employer/);
    expect(() => parseMobilePayslip(JSON.stringify({
      personal: {
        state: "READY",
        payslip: {
          period: "2026-09",
          status: "paid",
          paidAt: null,
          payType: "monthly",
          hours: "745.00",
          gross: "1.00",
          allowances: "0.00",
          overtime: "0.00",
          commission: "0.00",
          deductions: "0.00",
          advanceDeduction: "0.00",
          socialSecurityEmployee: "0.00",
          incomeTax: "0.00",
          net: "1.00",
        },
      },
    }))).toThrow("وصلت استجابة غير مكتملة");
  });

  it("keeps native leave results free of target identifiers and rejects malformed ranges", () => {
    expect(parseMobileLeaveCommand(JSON.stringify({
      leave: {
        status: "pending",
        fromDate: "2026-09-14",
        toDate: "2026-09-15",
        employeeId: 20,
        branchId: 1,
      },
      idempotent: false,
    }))).toEqual({
      leave: { status: "pending", fromDate: "2026-09-14", toDate: "2026-09-15" },
      idempotent: false,
    });
    expect(() => parseMobileLeaveCommand(JSON.stringify({
      leave: { status: "pending", fromDate: "2026-09-16", toDate: "2026-09-15" },
      idempotent: false,
    }))).toThrow("وصلت استجابة غير مكتملة");
  });

  it("accepts only a closed task transition result", () => {
    expect(parseMobileTaskCommand(JSON.stringify({
      status: "RESOLVED",
      idempotent: true,
      taskId: 500,
      branchId: 1,
    }))).toEqual({ status: "RESOLVED", idempotent: true });
    expect(() => parseMobileTaskCommand(JSON.stringify({
      status: "CANCELLED",
      idempotent: false,
    }))).toThrow("وصلت استجابة غير مكتملة");
  });

  it("accepts only a minimal Expo push status or command", () => {
    expect(parseMobileExpoPushStatus(JSON.stringify({ activeCount: 1, token: "not-rendered" }))).toEqual({ activeCount: 1 });
    expect(parseMobileExpoPushCommand(JSON.stringify({ registered: true, id: 4 }), "registered")).toEqual({ registered: true });
    expect(parseMobileExpoPushCommand(JSON.stringify({ revoked: true, devicePublicKeyHash: "not-rendered" }), "revoked")).toEqual({ revoked: true });
    expect(() => parseMobileExpoPushStatus(JSON.stringify({ activeCount: -1 }))).toThrow("وصلت استجابة غير مكتملة");
    expect(() => parseMobileExpoPushCommand(JSON.stringify({ registered: false }), "registered")).toThrow("وصلت استجابة غير مكتملة");
  });
});
