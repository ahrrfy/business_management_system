import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INBOUND_ENABLED_PAYMENT_METHODS,
  isInboundPaymentMethodEnabled,
} from "@shared/inboundPaymentPolicy";
import { isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

/**
 * العقد الحاكم للدفع غير النقدي في نقاط البيع:
 *   البوّابة = **محاولة دفع خارجية مؤكَّدة خادمياً** (`externalPaymentAttempts`)، لا إقفالُ الطريقة.
 * وهذه الاختبارات تحرس ضدّ الانتكاسة التي حدثت في #596: إقفالٌ شامل مبثوثٌ في الشاشات
 * أوقف بيع البطاقة كلّياً. لذلك: لا شاشة تُقفل طريقةً بنصٍّ ثابت — الإقفال من السياسة وحدها.
 */
describe("عقد الدفع غير النقدي في نقاط البيع", () => {
  it("السياسة تسمح بالطرق المدعومة وترفض المجهول ورصيد زين (fail-closed)", () => {
    for (const method of INBOUND_ENABLED_PAYMENT_METHODS) {
      expect(isPosPaymentMethodEnabled(method)).toBe(true);
    }
    expect(isPosPaymentMethodEnabled("CASH")).toBe(true);
    expect(isPosPaymentMethodEnabled("CARD")).toBe(true);
    // رصيد زين لا يُقبض على الفاتورة — مساره شاشة البطاقات الرقمية.
    expect(isPosPaymentMethodEnabled("TELECOM")).toBe(false);
    expect(isPosPaymentMethodEnabled("FUTURE_PROVIDER")).toBe(false);
    expect(isPosPaymentMethodEnabled(null)).toBe(false);
    expect(isPosPaymentMethodEnabled(undefined)).toBe(false);
    expect(isInboundPaymentMethodEnabled("CARD")).toBe(true);
  });

  it("الكاشير يُتيح البطاقة/التحويل/المحفظة ولا يفتح الإتمام قبل التأكيد الخادميّ", () => {
    const source = readPage("POS.tsx");

    expect(source).toContain('onClick={() => setMethod("CARD")}');
    expect(source).toContain('onClick={() => setMethod("TRANSFER")}');
    expect(source).toContain('onClick={() => setMethod("WALLET")}');
    // البوّابة الحقيقية: المحاولة المؤكَّدة تُرسَل مع البيع، وحقل المرجع يحكم فتح الإتمام.
    expect(source).toContain("initiateExternalPayment");
    expect(source).toContain("confirmExternalPaymentMutation");
    expect(source).toContain("externalPaymentAttemptId");
    expect(source).toContain("PaymentReferenceField");
    // لا إقفال مبثوث: لا زرّ طريقةٍ مُعطَّلٌ بنصٍّ ثابت في الشاشة.
    expect(source).not.toContain('disabled aria-describedby="pos-external-payment-disabled"');
  });

  it("شاشة المطبعة (PrintPOS) تتبع العقد نفسه", () => {
    const source = readPage("PrintPOS.tsx");

    expect(source).toContain('<Method m="CARD" Icon={CreditCard} label="بطاقة" />');
    expect(source).toContain('<Method m="TRANSFER" Icon={RefreshCw} label="تحويل" />');
    expect(source).toContain("externalPaymentConfirmed");
    expect(source).toContain("PaymentReferenceField");
  });

  it("تحصيل دفعة لاحقة على فاتورة يشتقّ طرقه من السياسة لا من نصٍّ ثابت", () => {
    const source = readPage("InvoiceDetail.tsx");

    expect(source).toContain(
      "const ENABLED_COLLECTION_METHODS = METHODS.filter((method) => isPosPaymentMethodEnabled(method.v))",
    );
    expect(source).toContain("ENABLED_COLLECTION_METHODS.map");
    expect(source).toContain("if (!isPosPaymentMethodEnabled(payMethod))");
    expect(source).not.toContain('if (payMethod !== "CASH") return setError(');
  });
});
