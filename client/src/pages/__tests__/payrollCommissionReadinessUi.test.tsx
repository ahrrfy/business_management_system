import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * كانت شاشة الرواتب تعرض حجب اعتماد العمولة عبر رسالة خادمٍ كثيفة تظهر توستاً عابراً (٦ث)
 * فقط عند فشل «اعتماد الاستحقاق» — بلا زرّ ولا توضيح أنّ الاعتماد يلزمه حسابٌ آخر غير من
 * احتسب الكشف أو طلب اعتماده (فصل مهام). هذا الاختبار يحرس البانر الدائم البديل: يجب أن
 * يبقى مبنيّاً على جاهزيةٍ استباقية (لا انتظار فشل)، وأن يفصح صراحةً عن حالة «أنت من طلبه/
 * احتسبه فلا تملك اعتماده بنفسك»، وأن يقدّم رابطاً مباشراً لتبويب تشغيلات العمولة.
 */
const page = readFileSync(new URL("../Payroll.tsx", import.meta.url), "utf8");

describe("بانر جاهزية العمولة في شاشة الرواتب", () => {
  it("يستبدل انتظار فشل الاعتماد بجاهزيةٍ استباقية عبر commissionReadiness", () => {
    expect(page).toContain("trpc.payroll.commissionReadiness.useQuery");
    expect(page).toContain("commissionBlocking");
    expect(page).toContain("describeCommissionBlock");
  });

  it("يفصح عن حالة فصل المهام حين يكون المستخدم نفسه من احتسب أو طلب", () => {
    expect(page).toContain("r.pendingCompanyRequest.requestedBy === myUserId");
    expect(page).toContain("r.runCreatedBy === myUserId");
    expect(page).toContain("لا يمكنك اعتماد طلبك بنفسك");
  });

  it("يعرض بانراً دائماً (Card) لا توستاً عابراً، مع رابطٍ مباشر لتشغيلات العمولة", () => {
    expect(page).toContain("commissionBlock && (");
    expect(page).toContain('href="/hr?tab=commission-runs"');
    expect(page).toContain("فتح تشغيلات العمولة");
  });

  it("يحجب زرّ اعتماد الاستحقاق فعلياً حين تكون العمولة غير جاهزة، مع سبب في tooltip", () => {
    expect(page).toContain("disabled={busy || !independentOwner || commissionBlocking}");
    expect(page).toContain("commissionBlock.title} — ${commissionBlock.body}");
  });

  it("يغطّي الحالات الثلاث: لا كشف بعد / مسوّدة بلا طلب / معتمدة غير ملتقطة", () => {
    expect(page).toContain('r.status === "approved"');
    expect(page).toContain('r.status === "draft"');
    expect(page).toContain("لم يُحتسب كشف عمولات");
    expect(page).toContain("لم يُطلب اعتمادها بعد");
    expect(page).toContain("غير مُلتقطة في هذا المسيّر");
  });
});
