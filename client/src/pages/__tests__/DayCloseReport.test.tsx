import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { moduleAccessAllowed } from "@shared/permissions";

const readPage = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("عقد صلاحيات وحالات تحميل المطابقة اليومية والعهد", () => {
  it("يعرض الحل بسند تصحيح كحالة تاريخية صادقة لا كمطابقة", () => {
    const source = readPage("DayCloseReport.tsx");
    expect(source).toContain('saved.status === "RESOLVED_WITH_ADJUSTMENT"');
    expect(source).toContain("محلول بسند تصحيح");
    expect(source).toContain("رقم قضية فرق النقد");
  });

  it("يطابق زر إدارة المطابقة بوابة الخادم ويدعم المنح الصريح", () => {
    const source = readPage("DayCloseReport.tsx");

    expect(source).toContain("const canManageDaily = moduleAccessAllowed(");
    expect(source).toContain('["manager", "accountant"]');
    expect(
      moduleAccessAllowed(
        "auditor",
        { treasury: "FULL" },
        "treasury",
        "FULL",
        ["manager", "accountant"],
      ),
    ).toBe(true);
    expect(
      moduleAccessAllowed(
        "accountant",
        { treasury: "NONE" },
        "treasury",
        "FULL",
        ["manager", "accountant"],
      ),
    ).toBe(false);
  });

  it("لا يخفي فشل تحميل طابور العهد أو العهد الشخصية أو قائمة المستلمين", () => {
    const source = readPage("Treasury.tsx");

    for (const query of ["pendingQueue", "pendingHandovers", "handoverRecipients"]) {
      expect(source).toContain(`${query}.isLoading`);
      expect(source).toContain(`${query}.isError`);
      expect(source).toContain(`${query}.refetch()`);
    }
    expect(source).toContain("لا يمكن افتراض عدم وجود عهد");
    expect(source).toContain("أُوقفت إعادة الإسناد لحين نجاح التحميل");
    expect(source).toContain("const canGovernHandovers = moduleAccessAllowed(");
    expect(source).toContain("enabled: canGovernHandovers");
    expect(source).not.toContain("enabled: isAdmin || isManager");
  });
});
