import { describe, expect, it } from "vitest";
import { resolvePriorReceipt } from "../priorReceipt";

describe("resolvePriorReceipt — استنتاج المستلَم فعلاً من مقبوض الأصل", () => {
  it("بلا مقبوض على الأصل ⇒ لا يُرسَل شيء", () => {
    expect(resolvePriorReceipt({ recordedPaid: "0", originalTerms: "CREDIT", targetTerms: "CREDIT", mode: "AUTO" }))
      .toEqual({ amount: null, inferredNotReceived: false });
    expect(resolvePriorReceipt({ recordedPaid: "", originalTerms: "CASH", targetTerms: "CREDIT", mode: "NOT_RECEIVED" }).amount).toBeNull();
  });

  it("نقديّ صار آجلاً ⇒ لم يُستلم (حالة الفاتورة 22873)", () => {
    expect(resolvePriorReceipt({ recordedPaid: "289750", originalTerms: "CASH", targetTerms: "CREDIT", mode: "AUTO" }))
      .toEqual({ amount: "0.00", inferredNotReceived: true });
  });

  it("بقي نقدياً (ولو تغيّر العميل) ⇒ استُلم كاملاً ويُحمَل", () => {
    expect(resolvePriorReceipt({ recordedPaid: "289750", originalTerms: "CASH", targetTerms: "CASH", mode: "AUTO" }).amount).toBe("289750.00");
  });

  it("الأصل مسدَّد جزئياً (يُشتقّ آجلاً) وبقي آجلاً ⇒ لا يُفترَض عدم الاستلام", () => {
    expect(resolvePriorReceipt({ recordedPaid: "100", originalTerms: "CREDIT", targetTerms: "CREDIT", mode: "AUTO" }))
      .toEqual({ amount: "100.00", inferredNotReceived: false });
  });

  it("المفتاح الصريح يغلب الاستنتاج في الاتجاهين", () => {
    expect(resolvePriorReceipt({ recordedPaid: "50", originalTerms: "CASH", targetTerms: "CREDIT", mode: "RECEIVED" }).amount).toBe("50.00");
    expect(resolvePriorReceipt({ recordedPaid: "50", originalTerms: "CASH", targetTerms: "CASH", mode: "NOT_RECEIVED" }).amount).toBe("0.00");
  });
});
