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

  it("إعادة الإصدار تستهلك محاولة مستقلة لدفعة فرق التصحيح", () => {
    const source = page("SalesInvoiceNew.tsx");
    expect(source).toContain(
      'const externalChannel = isCorrection ? "SALES_COLLECTION"',
    );
    expect(source).toContain(
      "externalPaymentAttemptId: externalAttempt?.attemptId ?? undefined",
    );
    expect(source).toContain(
      "externalPaymentDeviceId: externalAttempt?.deviceId ?? undefined",
    );
    expect(source).toContain("confirmed={externalConfirmed}");
  });
});
