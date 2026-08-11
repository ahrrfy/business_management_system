import { describe, expect, it } from "vitest";
import { receptionCheckoutReceiptMeta } from "./receptionReceiptMeta";

describe("receptionCheckoutReceiptMeta", () => {
  it("يجمع العرابين التي وزّعها الخادم على أوامر الشغل", () => {
    const meta = receptionCheckoutReceiptMeta(
      {
        workOrders: [{ deposit: "12500.25" }, { deposit: "7499.75" }],
      },
      9,
    );

    expect(meta.heldDeposits).toBe("20000.00");
  });

  it("يفضّل وردية الفاتورة المحفوظة على الوردية الحية عند الإعادة", () => {
    expect(
      receptionCheckoutReceiptMeta(
        {
          regularSale: { shiftId: 41 },
          workOrders: [],
        },
        99,
      ).shiftId,
    ).toBe(41);

    expect(
      receptionCheckoutReceiptMeta(
        {
          printSale: { shiftId: 42 },
          workOrders: [],
        },
        99,
      ).shiftId,
    ).toBe(42);
  });

  it("يستعمل الوردية الحية فقط لمسار أوامر الشغل الخالص ويخفي العربون الصفري", () => {
    expect(
      receptionCheckoutReceiptMeta(
        {
          workOrders: [{ deposit: "0.00" }],
        },
        77,
      ),
    ).toEqual({ shiftId: 77, heldDeposits: null });
  });
});
