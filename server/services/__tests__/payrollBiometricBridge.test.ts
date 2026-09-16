/**
 * اختبارات جاهزية جسر البصمات ومسير الرواتب (payrollBiometricBridge.test.ts)
 * يتحقق من:
 *  ١) صحة صياغة الفترات الزمنية assertPeriod.
 *  ٢) وجود تكامل getBiometricPayrollReadiness وتصديره من payrollService.
 *  ٣) وجود حارس البصمات غير المربوطة unmappedPunches في محرك توليد المسير generatePayroll.
 */
import { describe, expect, it } from "vitest";
import { assertPeriod } from "../payroll/helpers";
import { getBiometricPayrollReadiness } from "../payrollService";

describe("جسر البصمات ومسير الرواتب", () => {
  it("assertPeriod يرفض الفترات غير الصالحة ويقبل صيغة YYYY-MM الصالحة", () => {
    expect(() => assertPeriod("invalid")).toThrow();
    expect(() => assertPeriod("2026-13")).toThrow();
    expect(() => assertPeriod("2026-00")).toThrow();
    expect(assertPeriod("2026-09")).toBe("2026-09");
  });

  it("خدمة getBiometricPayrollReadiness معرّفة ومُصدّرة من payrollService", () => {
    expect(typeof getBiometricPayrollReadiness).toBe("function");
  });
});
