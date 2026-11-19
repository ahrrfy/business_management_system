import { describe, expect, it } from "vitest";
import {
  formatPurchaseEventActor,
  formatPurchaseRevisionHeadValue,
  purchaseOrderEventLabel,
} from "./purchaseOrderEventType";

describe("purchaseOrderEventType", () => {
  it("translates known PO lifecycle event types into Arabic without exposing raw enum codes", () => {
    expect(purchaseOrderEventLabel("ORDER_CREATED")).toBe("إنشاء أمر شراء");
    expect(purchaseOrderEventLabel("ORDER_SUBMITTED")).toBe("إرسال للاعتماد");
    expect(purchaseOrderEventLabel("APPROVE_REVISION_REQUESTED")).toBe("طلب اعتماد النسخة");
    expect(purchaseOrderEventLabel("APPROVE_REVISION_APPROVED")).toBe("اعتماد أمر الشراء");
    expect(purchaseOrderEventLabel("UNKNOWN_FUTURE_EVENT")).toBe("تحديث أمر شراء");
  });

  it("formats revision diff head values and actors cleanly", () => {
    expect(formatPurchaseRevisionHeadValue("settlementType", "CREDIT")).toBe("آجل — ذمة مورد");
    expect(formatPurchaseRevisionHeadValue("settlementType", "CASH")).toBe("نقدي — دفع فوري");
    expect(formatPurchaseRevisionHeadValue("agreedCurrency", "USD")).toBe("دولار أمريكي (USD)");
    expect(formatPurchaseEventActor("مروة خليل", 7)).toBe("مروة خليل");
    expect(formatPurchaseEventActor(null, 7)).toBe("حساب #7");
    expect(formatPurchaseEventActor(null, null)).toBe("النظام");
  });
});
