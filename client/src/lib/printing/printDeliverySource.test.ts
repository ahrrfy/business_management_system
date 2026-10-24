import { describe, expect, it, vi } from "vitest";
vi.mock("./print", () => ({ printDoc: vi.fn() }));
import {
  buildDeliveryDispatchSlipDoc,
  type DispatchSlipData,
} from "./printDeliveryDispatchSlip";

const aftercare: DispatchSlipData = {
  consignmentNumber: "AC-19",
  orderNumber: "19",
  orderKind: "aftercare",
  sourceType: "AFTERCARE_EXECUTION",
  aftercareExecutionId: 19,
  invoiceId: null,
  partyName: "شركة التوصيل",
  recipientName: "عميل",
  recipientPhone: "07701234567",
  deliveryAddress: "بغداد",
  salePrice: "0.00",
  codAmount: "0.00",
  deliveryFee: "5000.00",
  feeCollection: "SHOP",
  dispatchedAt: "2026-10-23T12:00:00Z",
};

describe("source-aware delivery slip", () => {
  it("prints a zero-collection aftercare slip without a fictitious invoice", () => {
    const doc = buildDeliveryDispatchSlipDoc(aftercare);
    expect(doc.title).toContain("استكمال نقص");
    expect(doc.meta?.join(" ")).toContain("لا يُطلب مبلغ من العميل");
    expect(doc.meta?.join(" ")).not.toContain("الفاتورة");
    expect(doc.totals?.at(-1)?.value).toBe("0 د.ع");
  });
  it("rejects an aftercare print payload that would demand customer money", () => {
    expect(() =>
      buildDeliveryDispatchSlipDoc({ ...aftercare, codAmount: "1.00" }),
    ).toThrow(/تحصيلاً صفرياً/);
    expect(() =>
      buildDeliveryDispatchSlipDoc({ ...aftercare, feeCollection: "COURIER" }),
    ).toThrow(/أجرة على المكتبة/);
  });
  it("preserves the ordinary invoice slip", () => {
    expect(
      buildDeliveryDispatchSlipDoc({
        ...aftercare,
        sourceType: "INVOICE",
        invoiceId: 4,
        invoiceNumber: "INV-4",
        orderKind: "invoice",
        codAmount: "10000.00",
        feeCollection: "COURIER",
      }).title,
    ).toBe("بوليصة إسناد وتوصيل");
  });
});
