import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  isVoucherCategoryRoleCompatible,
  voucherCategoryAccountingGuidance,
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
      new URL("../components/vouchers/VoucherFormShared.tsx", import.meta.url),
      "utf8",
    );
    expect(categoriesPage).toContain("الحساب المحاسبي المقابل *");
    expect(categoriesPage).toContain("تحتاج مساراً تخصصياً");
    expect(categoriesPage).toContain("معالجة سندات OTHER التاريخية غير المصنفة");
    expect(categoriesPage).toContain("usedReceiptCount");
    expect(categoriesPage).toContain("voucherCategoryRoleOptionsFor(direction)");
    expect(categoriesPage).toContain("مزامنة فئات المصروفات");
    expect(categoriesPage).toContain("قاعدة الفئات ثنائية الاتجاه (قبض وصرف)");
    expect(voucherForm).toContain("فئة محاسبية معيّنة إلزامية لسندات «أخرى»");
    expect(voucherForm).toMatch(
      /disabled=\{\s*!isVoucherCategoryRoleCompatible\(/,
    );
    expect(voucherForm).toContain("تحدد الحساب المقابل الذي سيظهر في دفتر الأستاذ");
    expect(voucherForm).toContain("توجيه محاسبي للطرف (أخرى)");
  });

  it("شرح التوجيه المحاسبي يميّز فئات الاستثمار بدقة عن الفئات العامة المتشابهة في الدور", () => {
    // 1. فئات الاستثمار
    const principalOut = voucherCategoryAccountingGuidance("OUT", {
      name: "رد مبالغ استثمار",
      postingRole: "OTHER_LIABILITY",
    });
    expect(principalOut).toContain("تخفيض التزام المستثمر (مدين)");
    expect(principalOut).toContain("دون احتساب كمصروف تشغيلي");

    const dividendOut = voucherCategoryAccountingGuidance("OUT", {
      name: "توزيع أرباح وعوائد استثمار",
      postingRole: "OTHER_EXPENSE",
    });
    expect(dividendOut).toContain("إثبات توزيع أرباح وعوائد الاستثمار (مدين)");

    const investIn = voucherCategoryAccountingGuidance("IN", {
      name: "استلام مبالغ استثمار",
      postingRole: "OTHER_LIABILITY",
    });
    expect(investIn).toContain("إيداع مبالغ الاستثمار بالصندوق/البنك (مدين)");
    expect(investIn).toContain("الالتزام المالي للمستثمر (دائن)");

    // 2. فئات عامة بنفس الدور المحاسبي (لا يجوز أن تنسب للمستثمر أو الأرباح)
    const generalExpense = voucherCategoryAccountingGuidance("OUT", {
      name: "مصروفات أخرى",
      postingRole: "OTHER_EXPENSE",
    });
    expect(generalExpense).not.toContain("استثمار");
    expect(generalExpense).not.toContain("أرباح");
    expect(generalExpense).toBe("إثبات المصروف (مدين) مقابل حساب النقد المعتمد (دائن).");

    const securityDepositOut = voucherCategoryAccountingGuidance("OUT", {
      name: "ردّ أمانات وتأمينات",
      postingRole: "OTHER_LIABILITY",
    });
    expect(securityDepositOut).not.toContain("مستثمر");
    expect(securityDepositOut).toBe("تخفيض الالتزام المالي أو الأمانة (مدين) مقابل حساب النقد المعتمد (دائن).");

    const securityDepositIn = voucherCategoryAccountingGuidance("IN", {
      name: "أمانات وتأمينات مستلمة",
      postingRole: "OTHER_LIABILITY",
    });
    expect(securityDepositIn).not.toContain("مستثمر");
    expect(securityDepositIn).toBe("إيداع المبالغ بحساب النقد المعتمد (مدين) مقابل إثبات الالتزام المالي أو الأمانة (دائن).");

    // 3. فئة بحساب عادي واتجاه BOTH يتبع اتجاه السند المختار (OUT vs IN)
    const rentGuidanceOut = voucherCategoryAccountingGuidance("OUT", {
      name: "إيجار",
      postingRole: "RENT",
    });
    expect(rentGuidanceOut).toBe("مدين: مصروف — الإيجار / دائن: حساب النقد المعتمد.");

    const revenueGuidanceIn = voucherCategoryAccountingGuidance("IN", {
      name: "إيرادات متفرّقة",
      postingRole: "OTHER_REVENUE",
    });
    expect(revenueGuidanceIn).toBe("مدين: حساب النقد المعتمد / دائن: إيراد — إيرادات أخرى.");
  });
});

