import { describe, expect, it } from "vitest";
import {
  assessUnitCostAnomaly,
  assessUsdRateSanity,
  balanceDirectionLabel,
  buildBalanceTrailSnapshot,
} from "../../../shared/balanceTrail";
import { buildSupplierBookFifo } from "../purchase/supplierBookSettlement";
import { boundedSupplierUsdDelta } from "../purchase/supplierVoucherCurrency";

describe("قواعد المحاسبة الموحدة ومسار كروان وكاشف الشذوذ (وحدة خالصة)", () => {
  it("تحقق الدوال الصافية لحدود USD وفحص سعر الصرف ولقطة الرصيد وFIFO", () => {
    expect(boundedSupplierUsdDelta("52786.00", "10.00")).toBe("10.00");
    expect(boundedSupplierUsdDelta("5.00", "10.00")).toBe("5.00");
    expect(boundedSupplierUsdDelta("0.00", "10.00")).toBe("0.00");
    expect(boundedSupplierUsdDelta("-50.00", "10.00")).toBe("0.00");

    expect(assessUsdRateSanity("1500.00", "1490.00").status).toBe("OK");
    expect(assessUsdRateSanity("169.00", "1500.00")).toMatchObject({
      status: "ANOMALOUS",
      suggestedRate: "1690",
    });
    expect(assessUsdRateSanity("2100.00", "1500.00").status).toBe("WARN");
    expect(assessUnitCostAnomaly("304200", "3042000", "كابسة").kind).toBe("SHARP_DROP");

    expect(balanceDirectionLabel("SUPPLIER", "4707834.00")).toBe("له علينا");
    expect(balanceDirectionLabel("SUPPLIER", "-150.00")).toBe("لنا عليه");
    expect(balanceDirectionLabel("CUSTOMER", "500.00")).toBe("لنا عليه");
    expect(balanceDirectionLabel("CUSTOMER", "-200.00")).toBe("له علينا");

    const snap = buildBalanceTrailSnapshot({
      partyType: "SUPPLIER",
      before: "4707834.00",
      debit: "3055000.00",
    });
    expect(snap.beforeDirectionLabel).toBe("له علينا");
    expect(snap.afterDirectionLabel).toBe("له علينا");
    expect(snap.after).toBe("1652834.00");

    const fifo = buildSupplierBookFifo(
      [
        {
          supplierInvoiceId: 10,
          openingEntryId: null,
          date: "2026-11-15",
          order: 1,
          amount: "470834.00",
          currencyTotal: "470834.00",
          currencyUsed: "0.00",
          total: "470834.00",
          snapshot: { supplierInvoiceId: 10 },
        },
        {
          supplierInvoiceId: null,
          openingEntryId: null,
          date: "2026-11-18",
          order: 2,
          amount: "4237000.00",
          currencyTotal: "0.00",
          currencyUsed: "0.00",
          total: "4237000.00",
          snapshot: { voucherNumber: "RV-1-20261118-00003" },
        },
      ],
      [
        {
          entryId: 1,
          receiptId: 101,
          exchangeId: null,
          kind: "PAYMENT",
          date: "2026-11-18",
          allowUnallocated: true,
          ignoreTargetDate: true,
          amount: "3055000.00",
          snapshot: { entryId: 1 },
        },
      ],
    );
    expect(fifo.sources[0]?.allocations[0]?.supplierInvoiceId).toBe(10);
    expect(fifo.sources[0]?.allocations[0]?.amount).toBe("470834.00");
    // الجزء المتبقي يغطي مستحق RV ويغلق الـ 3,055,000 بالكامل بلا رفض
    expect(fifo.sources[0]?.allocations[1]?.amount).toBe("2584166.00");
    expect(fifo.sources[0]?.unallocatedAmount).toBe("0.00");

    // استنفاد رصيد الفواتير وترك الفائض غير المخصص مع بقاء الدلتا موجبة فقط
    const overpayFifo = buildSupplierBookFifo(
      [
        {
          supplierInvoiceId: 20,
          openingEntryId: null,
          date: "2026-11-18",
          order: 1,
          amount: "100000.00",
          currencyTotal: "100.00",
          currencyUsed: "0.00",
          total: "100000.00",
          snapshot: { supplierInvoiceId: 20 },
        },
      ],
      [
        {
          entryId: 2,
          receiptId: 202,
          exchangeId: null,
          kind: "PAYMENT",
          date: "2026-11-18",
          allowUnallocated: true,
          ignoreTargetDate: true,
          amount: "250000.00",
          snapshot: { entryId: 2 },
        },
      ],
    );
    expect(overpayFifo.sources[0]?.allocations[0]?.amount).toBe("100000.00");
    expect(overpayFifo.sources[0]?.unallocatedAmount).toBe("150000.00");
  });
});
