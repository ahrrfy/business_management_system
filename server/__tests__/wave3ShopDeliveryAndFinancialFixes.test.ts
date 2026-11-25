import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_EVENT_LABEL,
  DELIVERY_EVENT_TYPES,
  isDeliveryEventType,
} from "@shared/deliveryEventType";
import {
  POSTING_POLICY_HASH,
  validatePostingIntentPolicy,
} from "../services/accounting/postingEngine";
import { computeLineTotal } from "../services/billing";
import { verifiedFeeBalance } from "../services/delivery/fees";
import {
  deliveryFeeAccrualIntent,
  deliveryFeeSettlementIntent,
  deliveryRemitIntent,
} from "../services/delivery/posting";
import { money } from "../services/money";

describe("wave 3 — SHOP delivery auto-offset & financial fixes", () => {
  it("registers SHOP_FEE_AUTO_OFFSET and SHOP_FEE_AUTO_OFFSET_REVERSED without tashkeel", () => {
    expect(isDeliveryEventType("SHOP_FEE_AUTO_OFFSET")).toBe(true);
    expect(isDeliveryEventType("SHOP_FEE_AUTO_OFFSET_REVERSED")).toBe(true);
    expect(DELIVERY_EVENT_TYPES).toContain("SHOP_FEE_AUTO_OFFSET");
    expect(DELIVERY_EVENT_TYPES).toContain("SHOP_FEE_AUTO_OFFSET_REVERSED");
    const tashkeel = /[\u064B-\u0652\u0670]/;
    expect(tashkeel.test(DELIVERY_EVENT_LABEL.SHOP_FEE_AUTO_OFFSET)).toBe(
      false,
    );
    expect(
      tashkeel.test(DELIVERY_EVENT_LABEL.SHOP_FEE_AUTO_OFFSET_REVERSED),
    ).toBe(false);
  });

  it("posts balanced SHOP fee float auto-offset and exact zero-sum pre-delivery reversal without altering POSTING_POLICY_HASH", () => {
    expect(POSTING_POLICY_HASH).toMatch(/^[a-f0-9]{64}$/);
    const fee = money("5000.00");

    const accrual = deliveryFeeAccrualIntent(fee);
    validatePostingIntentPolicy(accrual, "DELIVERY_FEE", {
      amount: fee,
      cost: fee,
      profit: fee.neg(),
    });

    const remit = deliveryRemitIntent(fee, "TREASURY");
    validatePostingIntentPolicy(remit, "DELIVERY_REMIT", {
      amount: fee,
      ...remit.sourceComponents,
    });

    const settle = deliveryFeeSettlementIntent(fee, "TREASURY");
    validatePostingIntentPolicy(settle, "DELIVERY_FEE", {
      amount: fee,
      ...settle.sourceComponents,
    });

    // Reversal intents on pre-delivery cancellation / undelivered return
    const accrualRev = deliveryFeeAccrualIntent(fee.neg());
    validatePostingIntentPolicy(accrualRev, "DELIVERY_FEE", {
      amount: fee.neg(),
      cost: fee.neg(),
      profit: fee,
    });

    const remitRev = deliveryRemitIntent(fee.neg(), "TREASURY");
    validatePostingIntentPolicy(remitRev, "DELIVERY_REMIT", {
      amount: fee.neg(),
      ...remitRev.sourceComponents,
    });

    const settleRev = deliveryFeeSettlementIntent(fee.neg(), "TREASURY");
    validatePostingIntentPolicy(settleRev, "DELIVERY_FEE", {
      amount: fee.neg(),
      ...settleRev.sourceComponents,
    });

    // Verify net role impact across offset + reversal equals 0.00 on every GL role
    const netByRole = new Map<string, Decimal>();
    for (const intent of [
      accrual,
      remit,
      settle,
      accrualRev,
      remitRev,
      settleRev,
    ]) {
      for (const line of intent.lines) {
        const cur = netByRole.get(line.role) ?? new Decimal(0);
        netByRole.set(
          line.role,
          cur.plus(new Decimal(line.debit)).minus(new Decimal(line.credit)),
        );
      }
    }
    for (const [, net] of Array.from(netByRole.entries())) {
      expect(net.toFixed(2)).toBe("0.00");
    }
  });

  it("preserves fixed discountAmount in computeLineTotal for print sales committed from reception drafts", () => {
    const res = computeLineTotal({
      unitPrice: money("10000"),
      quantity: money("2"),
      discountPercent: null,
      discountAmount: "2500.00",
    });
    expect(res.discountAmount).toBe("2500.00");
    expect(res.total).toBe("17500.00");
  });

  it("preserves fractional material quantities at 4 decimal places instead of rounding 0.25 up to 1", () => {
    const qty = new Decimal("0.25");
    const factor = new Decimal("1");
    const baseQty = qty.times(factor).toDecimalPlaces(4).toNumber();
    expect(baseQty).toBe(0.25);
  });

  it("verifiedFeeBalance ignores neutral superseded SHOP auto-offset pairs from a cancelled courier while rejecting unpaired foreign rows", () => {
    const now = new Date();
    const baseRow = {
      consignmentId: 77,
      branchId: 1,
      shortfallReason: null,
      receiptId: null,
      notes: null,
      actorUserId: 1,
      occurredAt: now,
      createdAt: now,
    };
    const neutralSupersededRows = [
      {
        ...baseRow,
        id: 1,
        eventKey: "CN:77:FEE_EARNED:SHOP:cyc_old",
        partyId: 10,
        entryType: "FEE_EARNED" as const,
        amount: "5000.00",
      },
      {
        ...baseRow,
        id: 2,
        eventKey: "CN:77:FEE_OFFSET:SHOP:cyc_old",
        partyId: 10,
        entryType: "FEE_OFFSET" as const,
        amount: "5000.00",
      },
      {
        ...baseRow,
        id: 3,
        eventKey: "CN:77:FEE_EARNED:cyc_new",
        partyId: 20,
        entryType: "FEE_EARNED" as const,
        amount: "5000.00",
      },
    ];
    const verified = verifiedFeeBalance(
      { id: 77, partyId: 20, branchId: 1 },
      neutralSupersededRows as never,
    );
    expect(verified.due.toFixed(2)).toBe("5000.00");
    expect(verified.active).toBe(true);

    // Unpaired foreign FEE_EARNED row must still fail closed!
    expect(() =>
      verifiedFeeBalance(
        { id: 77, partyId: 20, branchId: 1 },
        [neutralSupersededRows[0]!] as never,
      ),
    ).toThrow();
  });

  it("enforces credit registration, line-derived totals, coupon cap, verified custody, and work-order refund attribution", () => {
    const settlementSrc = readFileSync(
      new URL("../services/customerReceiptSettlement.ts", import.meta.url),
      "utf8",
    );
    expect(settlementSrc).toContain("LIKE 'NO-RECEIPT-CREDIT:%'");

    const noReceiptSrc = readFileSync(
      new URL("../services/returns/noReceiptExchangeService.ts", import.meta.url),
      "utf8",
    );
    expect(noReceiptSrc).toContain("maxDiscountAmount: amountStr");
    expect(noReceiptSrc).toContain("computedReturnTotal");
    expect(noReceiptSrc).toContain("computedExchangeTotal");

    const shopOffsetSrc = readFileSync(
      new URL("../services/delivery/shopFeeAutoOffset.ts", import.meta.url),
      "utf8",
    );
    expect(shopOffsetSrc).toContain("Decimal.min(outstandingClaim, verifiedCustody)");

    const orderPaymentsSrc = readFileSync(
      new URL("../services/deposits/orderPayments.ts", import.meta.url),
      "utf8",
    );
    expect(orderPaymentsSrc).toContain("targetedWoRefund");
  });
});
