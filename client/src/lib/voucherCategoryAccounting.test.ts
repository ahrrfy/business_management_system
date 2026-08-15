import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  isVoucherCategoryRoleCompatible,
  voucherCategoryRoleLabel,
  voucherCategoryRoleOptionsFor,
} from "@shared/voucherCategoryAccounting";

describe("voucher category accounting UI contract", () => {
  it("يعرض أسماء عربية ولا يعرض حساب مصروف ضمن فئة قبض", () => {
    const inbound = voucherCategoryRoleOptionsFor("IN");
    expect(inbound.map((option) => option.role)).toContain("OTHER_REVENUE");
    expect(inbound.map((option) => option.role)).not.toContain("RENT");
    expect(voucherCategoryRoleLabel("OTHER_REVENUE")).toBe("إيراد — إيرادات أخرى");
  });

  it("لا يعتبر الفئة جاهزة إلا إذا كان الدور متوافقاً مع اتجاهها", () => {
    expect(isVoucherCategoryRoleCompatible("OUT", null)).toBe(false);
    expect(isVoucherCategoryRoleCompatible("OUT", "RENT")).toBe(true);
    expect(isVoucherCategoryRoleCompatible("BOTH", "RENT")).toBe(false);
  });

  it("يثبت منتقي الحساب العربي وحارس OTHER في الشاشتين", () => {
    const categoriesPage = readFileSync(
      new URL("../pages/VoucherCategories.tsx", import.meta.url),
      "utf8",
    );
    const voucherForm = readFileSync(
      new URL("../pages/_VoucherFormShared.tsx", import.meta.url),
      "utf8",
    );
    expect(categoriesPage).toContain("الحساب المحاسبي المقابل *");
    expect(categoriesPage).toContain("تحتاج مساراً تخصصياً");
    expect(categoriesPage).toContain("معالجة سندات OTHER التاريخية غير المصنفة");
    expect(categoriesPage).toContain("usedReceiptCount");
    expect(categoriesPage).toContain("voucherCategoryRoleOptionsFor(direction)");
    expect(voucherForm).toContain("فئة محاسبية معيّنة إلزامية لسندات «أخرى»");
    expect(voucherForm).toContain("disabled={!isVoucherCategoryRoleCompatible");
    expect(voucherForm).toContain("تحدد الحساب المقابل الذي سيظهر في دفتر الأستاذ");
  });
});
