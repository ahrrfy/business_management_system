import { describe, expect, it } from "vitest";
import { money } from "../money";
import { voucherPostingPlan } from "../voucher/posting";
import {
  ASSET_CATEGORIES,
  categoryDefaultLife,
} from "../../../shared/assets";
import {
  VOUCHER_CATEGORY_POSTING_ROLES,
  isVoucherCategoryRoleCompatible,
  voucherCategoryRoleLabel,
} from "../../../shared/voucherCategoryAccounting";
import { computeDepreciation } from "../assets/depreciation";
import { CHART_ACCOUNTS } from "../accounting/chartSeed";
import {
  IRAQI_UNIFIED_ACCOUNTS,
  SYSTEM_ROLE_TO_IRAQI_UNIFIED_CODE,
} from "../accounting/iraqiUnifiedChartSeed";
import {
  validatePostingIntentAgainstSource,
} from "../accounting/postingEngine";

describe("التحقق الأصولي للعمليات الست (خزينة، أصول، قروض، استثمار)", () => {
  // ========================================================
  // ١. فحص فئات الأصول وإهلاك الأراضي وفق IAS 16
  // ========================================================
  describe("فئات الأصول الثابتة وإهلاك الأراضي وفق معيار IAS 16", () => {
    it("تتضمن فئات الأصول: الأراضي (عمر 0) والمباني (عمر 25)", () => {
      const land = ASSET_CATEGORIES.find((c) => c.key === "land");
      const bld = ASSET_CATEGORIES.find((c) => c.key === "buildings");
      expect(land).toBeDefined();
      expect(bld).toBeDefined();
      expect(categoryDefaultLife("land")).toBe(0);
      expect(categoryDefaultLife("buildings")).toBe(25);
    });

    it("تمنع الأراضي من أي إهلاك سنوي وتحفظ كامل القيمة الدفترية 100% عبر السنوات", () => {
      const dep = computeDepreciation(
        {
          purchaseValue: "75000000",
          salvageValue: "0",
          usefulLifeYears: 0,
          depreciationMethod: "sl",
          purchaseDate: "2018-05-15",
          status: "active",
        },
        new Date("2026-09-26"),
      );

      expect(dep.annualDep).toBe(0);
      expect(dep.accumulated).toBe(0);
      expect(dep.depPct).toBe(0);
      expect(dep.depRate).toBe(0);
      expect(dep.schedule).toEqual([]);
      expect(dep.bookValue).toBe(75000000);
      expect(dep.ageYears).toBeGreaterThan(8);
    });

    it("تحسب إهلاك المباني والإنشاءات بشكل منتظم بالقسط الثابت", () => {
      const dep = computeDepreciation(
        {
          purchaseValue: "120000000",
          salvageValue: "20000000",
          usefulLifeYears: 25,
          depreciationMethod: "sl",
          purchaseDate: "2025-01-01",
          status: "active",
        },
        new Date("2026-01-01"),
      );

      // الأساس القابل للإهلاك = 120م - 20م = 100م
      // القسط السنوي = 100م ÷ 25 = 4,000,000
      expect(dep.annualDep).toBe(4000000);
      expect(dep.bookValue).toBeLessThan(120000000);
    });
  });

  // ========================================================
  // ٢. فحص أدوار السندات وتوافق الاتجاهات
  // ========================================================
  describe("أدوار السندات وتوافق الاتجاهات (IN / OUT / BOTH)", () => {
    it("يتضمن النظام دور LOAN_RECEIVABLE و INVESTMENT_PAYABLE", () => {
      expect(VOUCHER_CATEGORY_POSTING_ROLES).toContain("LOAN_RECEIVABLE");
      expect(VOUCHER_CATEGORY_POSTING_ROLES).toContain("INVESTMENT_PAYABLE");
    });

    it("يتوافق دور LOAN_RECEIVABLE مع سند الصرف والقبض و BOTH", () => {
      expect(isVoucherCategoryRoleCompatible("IN", "LOAN_RECEIVABLE")).toBe(true);
      expect(isVoucherCategoryRoleCompatible("OUT", "LOAN_RECEIVABLE")).toBe(true);
      expect(isVoucherCategoryRoleCompatible("BOTH", "LOAN_RECEIVABLE")).toBe(true);
      expect(voucherCategoryRoleLabel("LOAN_RECEIVABLE")).toContain("قروض وسلف حسنة");
    });

    it("يتوافق دور INVESTMENT_PAYABLE مع سند القبض والصرف و BOTH", () => {
      expect(isVoucherCategoryRoleCompatible("IN", "INVESTMENT_PAYABLE")).toBe(true);
      expect(isVoucherCategoryRoleCompatible("OUT", "INVESTMENT_PAYABLE")).toBe(true);
      expect(isVoucherCategoryRoleCompatible("BOTH", "INVESTMENT_PAYABLE")).toBe(true);
      expect(voucherCategoryRoleLabel("INVESTMENT_PAYABLE")).toContain("أموال تشغيل واستثمار");
    });
  });

  // ========================================================
  // ٣. فحص خطط وترحيل سندات الخزينة (Posting Plans)
  // ========================================================
  describe("توليد قيود اليومية لسندات الخزينة (Double-Entry Verification)", () => {
    it("يولد قيد صرف سلفة/قرضة حسنة للغير من الخزينة (مدين: LOAN_RECEIVABLE، دائن: TREASURY_CASH)", () => {
      const plan = voucherPostingPlan({
        entryType: "PAYMENT_OUT",
        partyType: "OTHER",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        amount: money("5000000"),
        categoryPostingRole: "LOAN_RECEIVABLE",
      });

      expect(plan).toBeDefined();
      expect(plan?.intent.profile).toBe("PAYMENT_OUT_CATEGORY");
      expect(plan?.intent.lines).toEqual([
        { role: "LOAN_RECEIVABLE", debit: "5000000.00", credit: "0.00" },
        { role: "TREASURY_CASH", debit: "0.00", credit: "5000000.00" },
      ]);
      expect(() =>
        validatePostingIntentAgainstSource(plan!.intent, {
          amount: money("5000000"),
          ...plan!.sourceComponents,
        }),
      ).not.toThrow();
    });

    it("يولد قيد قبض واسترداد قرضة حسنة من الغير إلى الخزينة (مدين: TREASURY_CASH، دائن: LOAN_RECEIVABLE)", () => {
      const plan = voucherPostingPlan({
        entryType: "PAYMENT_IN",
        partyType: "OTHER",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        amount: money("5000000"),
        categoryPostingRole: "LOAN_RECEIVABLE",
      });

      expect(plan).toBeDefined();
      expect(plan?.intent.profile).toBe("PAYMENT_IN_CATEGORY");
      expect(plan?.intent.lines).toEqual([
        { role: "TREASURY_CASH", debit: "5000000.00", credit: "0.00" },
        { role: "LOAN_RECEIVABLE", debit: "0.00", credit: "5000000.00" },
      ]);
      expect(() =>
        validatePostingIntentAgainstSource(plan!.intent, {
          amount: money("5000000"),
          ...plan!.sourceComponents,
        }),
      ).not.toThrow();
    });

    it("يولد قيد استلام أموال تشغيل واستثمار بالمشاركة في الخزينة (مدين: TREASURY_CASH، دائن: INVESTMENT_PAYABLE)", () => {
      const plan = voucherPostingPlan({
        entryType: "PAYMENT_IN",
        partyType: "OTHER",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        amount: money("25000000"),
        categoryPostingRole: "INVESTMENT_PAYABLE",
      });

      expect(plan).toBeDefined();
      expect(plan?.intent.profile).toBe("PAYMENT_IN_CATEGORY");
      expect(plan?.intent.lines).toEqual([
        { role: "TREASURY_CASH", debit: "25000000.00", credit: "0.00" },
        { role: "INVESTMENT_PAYABLE", debit: "0.00", credit: "25000000.00" },
      ]);
      expect(() =>
        validatePostingIntentAgainstSource(plan!.intent, {
          amount: money("25000000"),
          ...plan!.sourceComponents,
        }),
      ).not.toThrow();
    });

    it("يولد قيد رد أموال تشغيل واستثمار بالمشاركة من الخزينة (مدين: INVESTMENT_PAYABLE، دائن: TREASURY_CASH)", () => {
      const plan = voucherPostingPlan({
        entryType: "PAYMENT_OUT",
        partyType: "OTHER",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        amount: money("25000000"),
        categoryPostingRole: "INVESTMENT_PAYABLE",
      });

      expect(plan).toBeDefined();
      expect(plan?.intent.profile).toBe("PAYMENT_OUT_CATEGORY");
      expect(plan?.intent.lines).toEqual([
        { role: "INVESTMENT_PAYABLE", debit: "25000000.00", credit: "0.00" },
        { role: "TREASURY_CASH", debit: "0.00", credit: "25000000.00" },
      ]);
      expect(() =>
        validatePostingIntentAgainstSource(plan!.intent, {
          amount: money("25000000"),
          ...plan!.sourceComponents,
        }),
      ).not.toThrow();
    });

    it("يولد قيد استلام قرضة حسنة من الغير (مدين: TREASURY_CASH، دائن: LOAN_PAYABLE)", () => {
      const plan = voucherPostingPlan({
        entryType: "PAYMENT_IN",
        partyType: "OTHER",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        amount: money("10000000"),
        categoryPostingRole: "LOAN_PAYABLE",
      });

      expect(plan).toBeDefined();
      expect(plan?.intent.profile).toBe("PAYMENT_IN_CATEGORY");
      expect(plan?.intent.lines).toEqual([
        { role: "TREASURY_CASH", debit: "10000000.00", credit: "0.00" },
        { role: "LOAN_PAYABLE", debit: "0.00", credit: "10000000.00" },
      ]);
    });
  });

  // ========================================================
  // ٤. فحص شجرة الحسابات والنظام المحاسبي الموحد العراقي
  // ========================================================
  describe("تكامل دليل الحسابات ودليل النظام المحاسبي الموحد العراقي", () => {
    it("يحتوي دليل الحسابات القياسي على الحسابين 1195 و 2195", () => {
      const loanAcc = CHART_ACCOUNTS.find((a) => a.code === "1195");
      const invAcc = CHART_ACCOUNTS.find((a) => a.code === "2195");
      expect(loanAcc?.systemRole).toBe("LOAN_RECEIVABLE");
      expect(loanAcc?.type).toBe("ASSET");
      expect(invAcc?.systemRole).toBe("INVESTMENT_PAYABLE");
      expect(invAcc?.type).toBe("LIABILITY");
    });

    it("يحتوي دليل النظام العراقي الموحد على الحسابات 111 و 112 و 1584 و 228", () => {
      const u111 = IRAQI_UNIFIED_ACCOUNTS.find((a) => a.code === "111");
      const u112 = IRAQI_UNIFIED_ACCOUNTS.find((a) => a.code === "112");
      const u1584 = IRAQI_UNIFIED_ACCOUNTS.find((a) => a.code === "1584");
      const u228 = IRAQI_UNIFIED_ACCOUNTS.find((a) => a.code === "228");

      expect(u111?.name).toContain("الأراضي");
      expect(u112?.name).toContain("المباني");
      expect(u1584?.name).toContain("سلف وقروض حسنة");
      expect(u228?.name).toContain("أموال تشغيل واستثمار");

      expect(SYSTEM_ROLE_TO_IRAQI_UNIFIED_CODE.LOAN_RECEIVABLE).toBe("1584");
      expect(SYSTEM_ROLE_TO_IRAQI_UNIFIED_CODE.INVESTMENT_PAYABLE).toBe("228");
    });
  });
});
