import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { terminationSettlementHtml } from "@/lib/printing/printTerminationSettlement";

const pageSource = readFileSync(new URL("./Promotions.tsx", import.meta.url), "utf8");
const printSource = readFileSync(
  new URL("../lib/printing/printTerminationSettlement.ts", import.meta.url),
  "utf8",
);

describe("termination settlement vertical UI contract", () => {
  it("forces the explicit gross-to-net classifications and derives a read-only total", () => {
    for (const id of [
      "t-earned-gross",
      "t-wage-reductions",
      "t-advance-recovery",
      "t-income-tax",
      "t-ss-employee",
      "t-ss-employer",
      "t-leave",
      "t-notice",
      "t-eos",
      "t-other",
      "t-other-label",
      "t-evidence",
    ]) {
      expect(pageSource).toContain(`id="${id}"`);
    }
    expect(pageSource).toContain("لا يحسب النظام نسبة أو استحقاقاً قانونياً تلقائياً");
    expect(pageSource).toMatch(/id="t-settle"[\s\S]*disabled/);
    expect(pageSource).toContain("validateTerminationSettlement(tBreakdown)");
    expect(pageSource).toContain("جميع القيم، بما فيها الأصفار");
    expect(pageSource).toContain("trpc.payroll.advanceBalance.useQuery");
    expect(pageSource).toContain("يبقى غير المسترد ذمةً على الموظف");
  });

  it("exposes governed print, payment return, accrual reversal, and reissue actions", () => {
    expect(pageSource).toContain("printTerminationSettlement({");
    expect(pageSource).toContain("reverseTerminationPayment.useMutation");
    expect(pageSource).toContain("reverseTerminationRecognition.useMutation");
    expect(pageSource).toContain("reissueTerminationPayment.useMutation");
    expect(pageSource).toContain('key: "reissue-payment"');
    expect(pageSource).toContain("me.data?.isOwner !== true");
    expect(pageSource).toContain('latestSettlementPaymentEventKind === "SALARY_PAYMENT"');
    expect(pageSource).toMatch(
      /t\.recognitionEventId[\s\S]*key: "reverse-recognition"/,
    );
  });

  it("prints pending data only as a visible draft and formats money without Number coercion", () => {
    const html = terminationSettlementHtml({
      id: 7,
      employeeName: "موظف اختبار",
      terminationType: "استقالة",
      lastDay: "2026-08-15",
      earnedGrossWages: "1000000000000.25",
      wageReductions: "0",
      advanceRecovery: "0",
      incomeTax: "0",
      employeeSocialSecurity: "0",
      employerSocialSecurity: "0",
      leaveCompensation: "0",
      noticeCompensation: "0",
      eosBenefit: "0",
      otherSettlement: "0",
      remainingAdvanceAtRecognition: "600.00",
      evidenceNote: "مراجعة بشرية موثقة للاختبار",
      total: "1000000000000.25",
      paymentMethod: "تحويل مصرفي",
      status: "قيد التنفيذ",
    });
    expect(html).toContain("مسودة غير معتمدة — لا تصلح سنداً للصرف");
    expect(html).toContain("1,000,000,000,000.25 د.ع");
    expect(html).toContain("رصيد السلفة بعد هذه التسوية — لقطة الاعتماد");
    expect(html).toContain("لا يتغيّر بسدادٍ لاحق");
    expect(printSource).not.toMatch(/Number\s*\(/);
  });
});
