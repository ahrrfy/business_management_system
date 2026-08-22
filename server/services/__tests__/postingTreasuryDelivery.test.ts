import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { money } from "../money";
import {
  deliveryCustomerCollectionIntent,
  deliveryCustomerRefundIntent,
  deliveryDispatchMemoIntent,
  deliveryFeeAccrualIntent,
  deliveryFeeHeldPayoutIntent,
  deliveryFeeHeldReceiptIntent,
  deliveryFeeSettlementIntent,
  deliveryRemitIntent,
  deliveryReturnSaleIntent,
  deliveryWorkOrderSaleIntent,
  deliveryWriteoffIntent,
  paymentAccountRole,
} from "../delivery/posting";

function linesOf(intent: { lines: unknown[] }) {
  return intent.lines;
}

describe("P2/Sh2 — treasury and delivery posting contracts", () => {
  it("routes drawer, treasury and bank instruments to distinct asset roles", () => {
    expect(paymentAccountRole("CASH", "DRAWER", "IN")).toBe("CASH");
    expect(paymentAccountRole("CASH", "TREASURY", "IN")).toBe("TREASURY_CASH");
    expect(paymentAccountRole("CARD", null, "IN")).toBe("CARD_BANK");
    expect(paymentAccountRole("TRANSFER", null, "IN")).toBe("CARD_BANK");
    expect(paymentAccountRole("CHECK", null, "IN")).toBe("CHECKS_RECEIVABLE");
    expect(paymentAccountRole("CHECK", null, "OUT")).toBe("CARD_BANK");
    expect(() => paymentAccountRole("WALLET", null, "IN")).toThrow(
      /تعذّر تحديد حساب الدفع/,
    );
    expect(() => paymentAccountRole("CASH", null, "IN")).toThrow(
      /تعذّر تحديد حساب الدفع/,
    );
  });

  it("moves a customer COD collection to courier custody exactly once", () => {
    const collection = deliveryCustomerCollectionIntent(money("125000"));
    const dispatch = deliveryDispatchMemoIntent();

    expect(collection.profile).toBe("PAYMENT_IN_COURIER");
    expect(linesOf(collection)).toEqual([
      { role: "DELIVERY_FLOAT", debit: "125000.00", credit: "0.00" },
      { role: "AR", debit: "0.00", credit: "125000.00" },
    ]);
    expect(dispatch).toEqual({
      profile: "DELIVERY_DISPATCH_COD",
      entryType: "DELIVERY_DISPATCH",
      lines: [],
    });
  });

  it("posts remittance to the physical cash bucket, never to customer AR", () => {
    expect(linesOf(deliveryRemitIntent(money("90000"), "DRAWER"))).toEqual([
      { role: "CASH", debit: "90000.00", credit: "0.00" },
      { role: "DELIVERY_FLOAT", debit: "0.00", credit: "90000.00" },
    ]);
    expect(linesOf(deliveryRemitIntent(money("90000"), "TREASURY"))).toEqual([
      { role: "TREASURY_CASH", debit: "90000.00", credit: "0.00" },
      { role: "DELIVERY_FLOAT", debit: "0.00", credit: "90000.00" },
    ]);
  });

  it("accrues a SHOP delivery fee, then settles the payable without a second expense", () => {
    const accrual = deliveryFeeAccrualIntent(money("5000"));
    expect(accrual.profile).toBe("DELIVERY_FEE_ACCRUAL");
    expect(linesOf(accrual)).toEqual([
      { role: "DELIVERY_EXPENSE", debit: "5000.00", credit: "0.00" },
      { role: "COURIER_PAYABLE", debit: "0.00", credit: "5000.00" },
    ]);
    const drawer = deliveryFeeSettlementIntent(money("5000"), "DRAWER");
    expect(drawer.profile).toBe("DELIVERY_FEE_SETTLEMENT");
    expect(linesOf(drawer)).toEqual([
      { role: "COURIER_PAYABLE", debit: "5000.00", credit: "0.00" },
      { role: "CASH", debit: "0.00", credit: "5000.00" },
    ]);
    expect(
      linesOf(deliveryFeeSettlementIntent(money("5000"), "TREASURY")),
    ).toEqual([
      { role: "COURIER_PAYABLE", debit: "5000.00", credit: "0.00" },
      { role: "TREASURY_CASH", debit: "0.00", credit: "5000.00" },
    ]);
  });

  it("holds a collected delivery fee as payable then reverses it on payout/refund", () => {
    const receipt = deliveryFeeHeldReceiptIntent(
      money("7500"),
      "CASH",
      "DRAWER",
    );
    expect(receipt.profile).toBe("DELIVERY_FEE_HELD_RECEIPT");
    expect(linesOf(receipt)).toEqual([
      { role: "CASH", debit: "7500.00", credit: "0.00" },
      { role: "COURIER_PAYABLE", debit: "0.00", credit: "7500.00" },
    ]);
    expect(
      linesOf(deliveryFeeHeldReceiptIntent(money("7500"), "CARD", null)),
    ).toEqual([
      { role: "CARD_BANK", debit: "7500.00", credit: "0.00" },
      { role: "COURIER_PAYABLE", debit: "0.00", credit: "7500.00" },
    ]);

    const intent = deliveryFeeHeldPayoutIntent(money("-7500"), "DRAWER");
    expect(intent.profile).toBe("DELIVERY_FEE_HELD_PAYOUT");
    expect(linesOf(intent)).toEqual([
      { role: "COURIER_PAYABLE", debit: "7500.00", credit: "0.00" },
      { role: "CASH", debit: "0.00", credit: "7500.00" },
    ]);
  });

  it("posts delivery write-off and recovery as signed mirror entries", () => {
    expect(linesOf(deliveryWriteoffIntent(money("3000")))).toEqual([
      { role: "LOSSES", debit: "3000.00", credit: "0.00" },
      { role: "DELIVERY_FLOAT", debit: "0.00", credit: "3000.00" },
    ]);
    expect(linesOf(deliveryWriteoffIntent(money("-3000")))).toEqual([
      { role: "DELIVERY_FLOAT", debit: "3000.00", credit: "0.00" },
      { role: "LOSSES", debit: "0.00", credit: "3000.00" },
    ]);
  });

  it("posts a refunded customer deposit against AR and the actual drawer", () => {
    const intent = deliveryCustomerRefundIntent(money("20000"), "DRAWER");
    expect(intent.profile).toBe("PAYMENT_OUT_CUSTOMER_REFUND");
    expect(linesOf(intent)).toEqual([
      { role: "AR", debit: "20000.00", credit: "0.00" },
      { role: "CASH", debit: "0.00", credit: "20000.00" },
    ]);
  });

  it("posts work-order dispatch/return as service and releases materials from WIP", () => {
    expect(
      linesOf(
        deliveryWorkOrderSaleIntent(
          money("100000"),
          money("30000"),
          money("45000"),
        ),
      ),
    ).toEqual([
      { role: "AR", debit: "100000.00", credit: "0.00" },
      { role: "SALES_FLEX", debit: "0.00", credit: "100000.00" },
      { role: "COGS", debit: "45000.00", credit: "0.00" },
      { role: "WORK_IN_PROGRESS", debit: "0.00", credit: "45000.00" },
      { role: "OTHER_LIABILITY", debit: "30000.00", credit: "0.00" },
      { role: "AR", debit: "0.00", credit: "30000.00" },
    ]);
    const returned = deliveryReturnSaleIntent({
      kind: "WORK_ORDER_SERVICE",
      sectorRevenue: money("100000"),
      deliveryRevenue: money(0),
      tax: money(0),
      total: money("100000"),
      ownedInventoryCost: money("45000"),
    });
    expect(returned.profile).toBe("RETURN_SALE_FLEX");
    expect(linesOf(returned)).toEqual([
      { role: "SALES_FLEX", debit: "100000.00", credit: "0.00" },
      { role: "AR", debit: "0.00", credit: "100000.00" },
    ]);
  });

  it("reverses an inventory delivery sale with its owned cost and exact revenue split", () => {
    const returned = deliveryReturnSaleIntent({
      kind: "INVENTORY",
      sectorRevenue: money("100000"),
      deliveryRevenue: money("5000"),
      tax: money(0),
      total: money("105000"),
      ownedInventoryCost: money("60000"),
    });
    expect(returned.profile).toBe("RETURN_SALE_INVENTORY");
    expect(linesOf(returned)).toEqual([
      { role: "SALES_STATIONERY", debit: "100000.00", credit: "0.00" },
      { role: "DELIVERY_REVENUE", debit: "5000.00", credit: "0.00" },
      { role: "AR", debit: "0.00", credit: "105000.00" },
      { role: "INVENTORY", debit: "60000.00", credit: "0.00" },
      { role: "COGS", debit: "0.00", credit: "60000.00" },
    ]);
  });

  it("reverses mixed delivery revenue by original source role", () => {
    const returned = deliveryReturnSaleIntent({
      kind: "MIXED",
      sectorRevenue: money("100000"),
      revenueByRole: [
        { role: "SALES_PRINT", amount: money("40000") },
        { role: "SALES_STATIONERY", amount: money("60000") },
      ],
      deliveryRevenue: money(0),
      tax: money("5000"),
      total: money("105000"),
      ownedInventoryCost: money("25000"),
    });
    expect(returned.profile).toBe("RETURN_SALE_MIXED");
    expect(linesOf(returned)).toEqual([
      { role: "SALES_PRINT", debit: "40000.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "60000.00", credit: "0.00" },
      { role: "TAX_PAYABLE", debit: "5000.00", credit: "0.00" },
      { role: "AR", debit: "0.00", credit: "105000.00" },
      { role: "INVENTORY", debit: "25000.00", credit: "0.00" },
      { role: "COGS", debit: "0.00", credit: "25000.00" },
    ]);
  });

  it("wires every treasury movement to its approved explicit profile", () => {
    const expectedByFile: Record<string, string[]> = {
      "cashHandoverService.ts": [
        "CASH_HANDOVER_TO_TREASURY",
        "TREASURY_CASH",
        "CASH",
      ],
      "cashDropService.ts": ["CASH_DROP_TO_TRANSIT", "CASH_IN_TRANSIT", "CASH"],
      "treasury/pendingReceipts.ts": [
        "CASH_TRANSFER_IN_FROM_TRANSIT",
        "TREASURY_CASH",
        "CASH_IN_TRANSIT",
      ],
      "cashTransferService.ts": [
        "CASH_TRANSFER_OUT_IN_TRANSIT",
        "CASH_TRANSFER_IN_FROM_TRANSIT",
        "CASH_IN_TRANSIT",
        "TREASURY_CASH",
      ],
      "shiftService.ts": ["SHIFT_FLOAT_FROM_TREASURY", "CASH", "TREASURY_CASH"],
      "treasuryFundingService.ts": [
        "TREASURY_FUNDING_CAPITAL",
        "TREASURY_CASH",
        "CAPITAL",
      ],
    };

    for (const [file, needles] of Object.entries(expectedByFile)) {
      const source = readFileSync(
        new URL(`../${file}`, import.meta.url),
        "utf8",
      );
      for (const needle of needles)
        expect(source, `${file}: ${needle}`).toContain(needle);
    }
  });

  it("wires every delivery money path and keeps dispatch as a memo", () => {
    const expectedByFile: Record<string, string[]> = {
      "delivery/courier.ts": [
        "deliveryCustomerCollectionIntent",
        "deliveryDispatchMemoIntent",
        "deliveryFeeAccrualIntent",
      ],
      "delivery/dispatch.ts": ["deliveryWorkOrderSaleIntent"],
      "delivery/remittance.ts": [
        "deliveryCustomerCollectionIntent",
        "deliveryRemitIntent",
        "deliveryFeeSettlementIntent",
        "deliveryFeeHeldPayoutIntent",
      ],
      "delivery/fees.ts": [
        "deliveryFeeSettlementIntent",
        "deliveryFeeHeldPayoutIntent",
      ],
      "delivery/returns.ts": [
        "deliveryCustomerRefundIntent",
        "deliveryFeeHeldPayoutIntent",
        "deliveryReturnSaleIntent",
        "inventoryMovements.referenceType",
      ],
      "delivery/settle.ts": [
        "deliveryCustomerCollectionIntent",
        "deliveryRemitIntent",
        "deliveryWriteoffIntent",
      ],
    };

    for (const [file, needles] of Object.entries(expectedByFile)) {
      const source = readFileSync(
        new URL(`../${file}`, import.meta.url),
        "utf8",
      );
      for (const needle of needles)
        expect(source, `${file}: ${needle}`).toContain(needle);
    }

    const courier = readFileSync(
      new URL("../delivery/courier.ts", import.meta.url),
      "utf8",
    );
    // ٢٢/٨: صار ٣ بعد إضافة `recordSupplementaryStatementCollection` — كشفٌ متمِّم لطردٍ
    // سبق ختمُه (Codex P1 #3) يكتب DELIVERY_DISPATCH بدلتا التحصيل بنفس عقد نظيره في
    // `confirmConsignmentDelivery` (نفس intent، dedupeKey مغاير لكل كشف).
    expect(courier.match(/entryType: "DELIVERY_DISPATCH"/g)).toHaveLength(3);
    expect(
      courier.match(/postingIntent: deliveryDispatchMemoIntent\(\)/g),
    ).toHaveLength(3);
  });
});
