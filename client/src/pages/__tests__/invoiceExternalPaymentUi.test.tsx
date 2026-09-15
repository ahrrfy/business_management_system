import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function page(name: string) {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

describe("إثبات القبض غير النقدي في شاشات المبيعات", () => {
  it("InvoiceDetail لا يرسل sales.pay قبل محاولة SALES_COLLECTION مؤكدة", () => {
    const source = page("InvoiceDetail.tsx");
    expect(source).toContain('channel: "SALES_COLLECTION"');
    expect(source).toContain("confirmExternal.mutateAsync");
    expect(source).toContain(
      "externalPaymentAttemptId: externalAttempt!.attemptId!",
    );
    expect(source).toContain(
      "externalPaymentDeviceId: externalAttempt!.deviceId",
    );
    expect(source).toContain("ثبّت تأكيد الدفع غير النقدي قبل تسجيل الدفعة");
  });

  it("تحويل العرض يمرر المحاولة والجهاز ولا يكتفي بالمرجع النصي", () => {
    const source = page("QuotationDetail.tsx");
    expect(source).toContain('channel: "SALES_COLLECTION"');
    expect(source).toContain("confirmQuotationExternalPayment");
    expect(source).toContain(
      "externalPaymentAttemptId: externalAttempt!.attemptId!",
    );
    expect(source).toContain(
      "externalPaymentDeviceId: externalAttempt!.deviceId",
    );
  });

  it("فرق إعادة الإصدار يُحجز ويُثبَت عند المراجع لا عند منشئ الطلب", () => {
    const editor = page("SalesInvoiceNew.tsx");
    const approvals = page("SalesControlApprovals.tsx");
    expect(editor).toContain("فرق التصحيح يُنفّذه المراجع عند الاعتماد");
    expect(approvals).toContain("claimCorrectionPayment");
    expect(approvals).toContain("reference: referenceOverride");
    expect(approvals).toContain("deviceId");
  });
});
