import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Shifts — واجهة معالجة السالب الموروث", () => {
  it("تعرض المسار للمالك وتطلب الدليل وتأكيد العد ولا تسمح بإدخال مبلغ التمويل", () => {
    const source = readFileSync(path.resolve(process.cwd(), "client/src/pages/Shifts.tsx"), "utf8");
    expect(source).toContain("معالجة رصيد سالب موروث — للمالك فقط");
    expect(source).toContain("legacyEvidenceNote");
    expect(source).toContain("legacyConfirmedZero");
    expect(source).toContain("confirmDrawerCountedZero: true");
    expect(source).toContain("expectedCash: closeExpected.toFixed(2)");
    expect(source).not.toMatch(/legacyNegativeRemediation:\s*\{[^}]*amount:/s);
    expect(source).toContain("لا يملك حق تمويلها وتصفيرها وإغلاقها إلا حساب المالك");
  });
});

